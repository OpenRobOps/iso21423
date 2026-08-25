import type { EntityContext } from './entityHandle.js';
import { requestStatusTopic, requestTopic } from '../topics/topics.js';
import { RESOURCE_CONFIG } from '../topics/resources.js';
import type { TopicMeta, SessionSubscription } from '../session/session.js';
import type { Request, RequestStatus } from '../types/requests.js';
import { validateMessage } from '../schema/validators.js';
import { isTerminalRequestState } from '../requests/stateMachine.js';
import { toTimestamp } from './types.js';
import { IncomingRequest, type StatusSink } from './incomingRequest.js';
import type { RequestAcceptanceFilter } from './filters.js';
import { DEFAULT_PRIORITY, type ExecutionPolicy } from './policies.js';
import { resolveCancelRequest, type ActionExecutor } from './executor.js';
import type { EntityHandle } from './entityHandle.js';

interface Registration { filter: RequestAcceptanceFilter; handler: (req: IncomingRequest) => void }

/** @internal — FleetGateway dispatch seam (ND-12): resolves an empty-destination request to a
 *  managed handle's executor, or null to reject it. */
export interface DispatchTarget { executor: ActionExecutor; entity: EntityHandle }
export type DispatchInterceptor = (request: Request) => DispatchTarget | null;

interface PendingRequest {
  request: Request;
  req: IncomingRequest;
}

interface ActiveRequestData {
  req: IncomingRequest;
  status: RequestStatus;
  priority?: number;
  /** true = admitted (handed to handler); false = buffered/pending (admission gate only).
   *  Admission logic sees only admitted=true; wire activeRequestsStatus includes all non-terminal.
   *  (Distinction: admission control vs. protocol observation.) */
  admitted: boolean;
}

/**
 * One `RequestServer` per `EntityHandle`, created lazily on the first `acceptRequests` call.
 * Owns the `request/+` subscription, D-12/D-13 handling, duplicate suppression and the
 * `activeRequestsStatus` aggregation. See task-5-brief.md Step 4 for the 8-point behavior spec.
 */
export class RequestServer {
  private sessionSub?: SessionSubscription;
  private registrations: Registration[] = [];
  // ponytail: in-memory only — a process restart re-executes requests still retained on the
  // broker; persist the key set alongside the sequence seed if that ever bites.
  private readonly seen = new Set<string>();
  private readonly activeStatuses = new Map<string, ActiveRequestData>();
  private readonly pendingRequests: PendingRequest[] = [];
  private readonly sink: StatusSink;
  // Task 7: the executor is the fallback consumer once no acceptRequests filter matches — see
  // handleAcceptedRequest / the cancelRequest branch of handleInbound below.
  private executor?: { executor: ActionExecutor; entity: EntityHandle };
  // Task 8 (FleetGateway) seams — both optional, set only by EntityHandle.setDispatchInterceptor /
  // onRequestSettled when a gateway wires them; a plain client never touches either.
  private dispatchInterceptor?: DispatchInterceptor;
  private requestSettledHook?: (requestTopic: string) => void;
  // ND-12 cancel-resolution seam: every managed handle's executor, consulted when a cancelRequest
  // doesn't name a run in this server's own executor — a dispatched request actually runs in the
  // target robot's executor, not the IMRFM's own.
  private managedExecutorsHook?: () => Iterable<ActionExecutor>;

  constructor(private readonly ctx: EntityContext) {
    this.sink = {
      ownerUuid: ctx.ref.entityUuid,
      nextStatusSequenceId: () => ctx.sequence.next(), // D-15: same SequenceCounter as sendRequest
      publishStatus: (req, status) => this.publishStatus(req, status),
    };
  }

  /** Idempotent: a second acceptRequests() on the same handle reuses the live subscription. */
  async ensureStarted(): Promise<void> {
    if (this.sessionSub) return;
    const filter = `${this.ctx.session.topicFor(this.ctx.ref, 'request')}/+`;
    // kind: null (point 1) — a schema-routed subscription would divert malformed payloads to
    // 'validation-warning' and no rejection would ever be published (D-13).
    this.sessionSub = await this.ctx.session.subscribeTopic(
      filter, null, (msg, meta) => {
        this.handleInbound(msg as string, meta)
          .catch((err) => this.ctx.diagnostic('dispatch-rejected', { reason: 'GENERAL_FAILURE', error: err }));
      }, { qos: 2 });
  }

  /** @internal — EntityHandle.onRequest wires the executor in here once, the first time it's used. */
  setExecutor(executor: ActionExecutor, entity: EntityHandle): void {
    this.executor = { executor, entity };
  }

  /** @internal — EntityHandle.setDispatchInterceptor (ND-12, IMRFM handle only). */
  setDispatchInterceptor(cb: DispatchInterceptor): void {
    this.dispatchInterceptor = cb;
  }

  /** @internal — EntityHandle.setManagedExecutorsHook (ND-12 cancel resolution, IMRFM handle
   *  only). */
  setManagedExecutorsHook(cb: () => Iterable<ActionExecutor>): void {
    this.managedExecutorsHook = cb;
  }

  /** @internal — EntityHandle.onRequestSettled (ND-10 janitor feed). */
  setRequestSettledHook(cb: (requestTopic: string) => void): void {
    this.requestSettledHook = cb;
  }

  /** Adds a low-level request handler for `filter`; returns a deregistration function (not itself async — callers unsubscribe/teardown separately once `handlerCount` hits 0). */
  register(filter: RequestAcceptanceFilter, handler: (req: IncomingRequest) => void): () => void {
    const reg: Registration = { filter, handler };
    this.registrations.push(reg);
    return () => { this.registrations = this.registrations.filter((r) => r !== reg); };
  }

  get handlerCount(): number { return this.registrations.length; }

  /** ND-18: count of admitted (handed to a handler), still-non-terminal requests — what
   *  ClientHealth.activeRequests.serving sums across every handle. */
  get servingCount(): number {
    let n = 0;
    for (const data of this.activeStatuses.values()) if (data.admitted) n++;
    return n;
  }

  async teardown(): Promise<void> {
    await this.sessionSub?.unsubscribe();
    this.sessionSub = undefined;
  }

  /**
   * Top-level inbound message handler for this entity's `request/+` subscription: parses and
   * schema-validates the payload (rejecting/warning on failure), drops retained clears and
   * already-seen duplicates, publishes RECEIVED, then routes the request — dispatch interception
   * (ND-12) first, then cancelRequest resolution, then normal admission-policy handling.
   */
  private async handleInbound(text: string, meta: TopicMeta): Promise<void> {
    if (text === '') return;                              // point 2: retained clear, ignore
    const requestUuid = meta.requestUuid;
    if (!requestUuid) return;                              // filter guarantees this, but be safe

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await this.rejectOrWarn(meta.topic, text, undefined, ['invalid JSON'], requestUuid);
      return;
    }
    const result = validateMessage('request', parsed);
    if (!result.ok) {
      await this.rejectOrWarn(meta.topic, text, result.value, result.errors ?? [], requestUuid);
      return;                                              // point 3: never call the app handler
    }

    const request = result.value as Request;
    const dupKey = `${request.source}:${request.sequenceId}`;
    if (this.seen.has(dupKey)) {
      this.ctx.diagnostic('duplicate-request-ignored', { source: request.source, sequenceId: request.sequenceId });
      this.requestSettledHook?.(meta.topic);                // ND-10: this retained topic will
      return;                                               // never terminate on its own — point 4
    }
    this.seen.add(dupKey);

    const req = new IncomingRequest(request, requestUuid, this.sink);
    await req.publishReceived();                            // point 5 — D-12, before any handler

    // publishReceived() has already entered this request in activeStatuses (admitted: false), so
    // it is on the wire in activeRequestsStatus but invisible to the admission view below — a
    // request never sees itself, or any other buffered request, as active.

    // ND-12: the IMRFM's dispatch callback intercepts an empty-destination request before
    // admission/cancellation semantics ever apply — a dispatched request is either handed
    // straight to a managed handle's executor, or rejected outright.
    if (this.dispatchInterceptor && request.destination === '') {
      const target = this.dispatchInterceptor(request);
      if (target) {
        void target.executor.run(req, target.entity)
          .catch((err) => this.ctx.diagnostic('dispatch-rejected', { reason: 'GENERAL_FAILURE', error: err }));
      } else {
        this.ctx.diagnostic('dispatch-rejected', { reason: 'REJECTED' });
        await req.reject('REJECTED');
      }
      return;
    }

    // D-02: a legacy `type: 'cancel'` detail is normalized to `cancelRequest` before anything
    // else inspects it.
    const firstDetail = request.details[0];
    if (firstDetail && firstDetail.type === 'cancel') {
      this.ctx.diagnostic('legacy-cancel-normalized', { source: request.source, sequenceId: request.sequenceId });
      firstDetail.type = 'cancelRequest';
    }

    // Task 6: apply the execution policy. A cancelRequest bypasses admission entirely: the whole
    // point of a cancel is to reach a busy entity. Only the *first* detail is inspected — bundled
    // cancels (a cancel riding along with other details) go through normal admission by design.
    const isCancelRequest = request.details.length > 0 && request.details[0]!.type === 'cancelRequest';
    if (isCancelRequest) {
      // Handed straight to the handlers, and left admitted:false — a cancel is not work, so it
      // must not block or preempt anything through a later admission check either.
      const matching = this.registrations.filter((r) => r.filter.matches(request));
      if (matching.length > 0) {
        for (const r of matching) r.handler(req);
      } else {
        const executors = this.cancelExecutors();
        if (executors.length > 0) {
          // ND-11.1/ND-12: the executor resolves cancelRequest itself, never an app handler — a
          // dispatched request may have run in a managed handle's executor instead of this
          // server's own, so every candidate is searched before giving up.
          await resolveCancelRequest(req, executors);
        } else {
          this.ctx.diagnostic('dispatch-rejected', { reason: 'ACTION_NOT_IMPLEMENTED' });
          await req.reject('ACTION_NOT_IMPLEMENTED');
        }
      }
      return;
    }

    const policy = this.ctx.getExecutionPolicy();
    const decision = policy.admit(request, this.buildActiveStatuses());

    await this.applyAdmissionDecision(request, req, decision, policy);
  }

  /** Controller ruling R2: build a minimal one-detail IncomingRequest and reject it with
   *  MALFORMED_REQUEST when (source, sequenceId) can still be read; otherwise surface the usual
   *  'validation-warning' event and drop, same as any other schema-routed subscription would. */
  private async rejectOrWarn(
    topic: string, raw: string, parsed: unknown, errors: unknown[], requestUuid: string,
  ): Promise<void> {
    const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
    const source = typeof obj?.source === 'string' ? obj.source : undefined;
    const sequenceId = typeof obj?.sequenceId === 'number' ? obj.sequenceId : undefined;
    if (source === undefined || sequenceId === undefined) {
      this.ctx.session.reportValidationWarning({ topic, payload: raw, errors });
      this.requestSettledHook?.(topic);                     // ND-10: an unroutable retained
      return;                                               // request can never terminate either
    }
    const minimal: Request = {
      destination: this.ctx.ref.entityUuid,
      source,
      sequenceId,
      timestamp: toTimestamp(),
      details: [{ type: this.inferDetailType(obj!), version: '1.0' }],
    };
    const req = new IncomingRequest(minimal, requestUuid, this.sink);
    this.ctx.diagnostic('dispatch-rejected', { reason: 'MALFORMED_REQUEST' });
    await req.reject('MALFORMED_REQUEST');
  }

  private inferDetailType(obj: Record<string, unknown>): string {
    const details = obj.details;
    if (Array.isArray(details) && details.length > 0) {
      const first = details[0] as unknown;
      if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).type === 'string') {
        return (first as Record<string, unknown>).type as string;
      }
    }
    return 'unknown';
  }

  /** The StatusSink: publish the requestStatus, then republish activeRequestsStatus (point 7). */
  private async publishStatus(req: IncomingRequest, status: RequestStatus): Promise<void> {
    const topic = requestStatusTopic(this.ctx.ref, req.requestUuid);
    const { qos, retain } = RESOURCE_CONFIG.requestStatus!;
    await this.ctx.session.publishTopic(topic, 'requestStatus', status, { qos, retain });
    this.ctx.countPublish();
    // Terminal requests leave the active map first, then the array is republished.
    if (isTerminalRequestState(status.status)) {
      this.activeStatuses.delete(req.requestUuid);
      this.requestSettledHook?.(requestTopic(this.ctx.ref, req.requestUuid));
      // Re-admit pending requests after a terminal transition (async to avoid blocking publishStatus)
      // ponytail: async re-admit means buffered requests may see slight delay before handling;
      // upgrade to sync if buffering causes QoS issues under load.
      setImmediate(() => {
        this.reAdmitPending()
          .catch((err) => this.ctx.diagnostic('dispatch-rejected', { reason: 'GENERAL_FAILURE', error: err }));
      });
    } else {
      // Priority is recorded from the validated Request itself, so it is fixed at RECEIVED time.
      this.activeStatuses.set(req.requestUuid, {
        req, status, priority: req.request.priority,
        admitted: this.activeStatuses.get(req.requestUuid)?.admitted ?? false,
      });
    }
    // Protocol view: activeRequestsStatus carries EVERY non-terminal request, buffered ones
    // included — it is what the entity is serving, not what the policy currently admits.
    const statusArray = [...this.activeStatuses.values()].map((data) => data.status);
    await this.ctx.session.publishResource(
      this.ctx.ref, 'activeRequestsStatus', 'requestStatusArray', statusArray);
    this.ctx.countPublish();
  }

  /** The admission view (R7: augmented with priority): only requests a policy decision has
   *  already admitted. Buffered requests — and the pending request itself, which is entered as
   *  admitted:false by its own RECEIVED — never appear here. */
  private buildActiveStatuses(): (RequestStatus & { priority?: number })[] {
    return [...this.activeStatuses.values()]
      .filter((data) => data.admitted)
      .map((data) => ({
        ...data.status,
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
      }));
  }

  /** Apply an admission decision: accept, reject, buffer, or preempt. */
  private async applyAdmissionDecision(
    request: Request, req: IncomingRequest,
    decision: ReturnType<ExecutionPolicy['admit']>, policy: ExecutionPolicy,
  ): Promise<void> {
    if (decision.action === 'reject') {
      this.ctx.diagnostic('dispatch-rejected', { reason: decision.reason });
      await req.reject(decision.reason);
    } else if (decision.action === 'buffer') {
      this.pendingRequests.push({ request, req });
      await this.enforceBufferLimit(policy);
    } else {
      if (decision.action === 'preempt') {
        for (const key of decision.preempt) {
          for (const data of this.activeStatuses.values()) {
            // admitted-only: the keys came from the admission view, and a buffered request must
            // never be cancelled by a preemption aimed at running work.
            if (!data.admitted) continue;
            // key.source names the ORIGINAL sender (RequestKey convention, policies.ts) —
            // data.status.destination is that same sender mirrored back onto this request's
            // own status, not data.status.source (this handle's own uuid, constant here).
            if (data.status.destination === key.source && data.status.requestSequenceId === key.sequenceId) {
              // Task 7 seam: an executor-run request owns its own completion once its
              // AbortSignal fires (run() detects cancelRequested and ends it CANCELED itself);
              // ending it directly here too would race a second, illegal transition. A
              // low-level acceptRequests handler gets no such signal, so it is still ended here.
              const executorOwned = this.executor?.executor.cancel(key) ?? false;
              if (!executorOwned) await data.req.complete({ status: 'CANCELED', reason: 'PREEMPTED' });
            }
          }
        }
      }
      await this.handleAcceptedRequest(request, req);
    }
  }

  /** Handle an accepted request: mark as admitted, route to matching handlers. */
  private async handleAcceptedRequest(request: Request, req: IncomingRequest): Promise<void> {
    // Admitted from here on: this is what makes the request visible to later admission checks.
    const existing = this.activeStatuses.get(req.requestUuid);
    if (existing) existing.admitted = true;

    const matching = this.registrations.filter((r) => r.filter.matches(request));
    if (matching.length > 0) {
      for (const r of matching) r.handler(req);
      return;
    }
    // Task 7: low-level acceptRequests handlers win when their filter matches; otherwise, if any
    // onRequest handler is registered, the executor runs the request.
    if (this.executor && this.executor.executor.hasHandlers()) {
      void this.executor.executor.run(req, this.executor.entity)
        .catch((err) => this.ctx.diagnostic('dispatch-rejected', { reason: 'GENERAL_FAILURE', error: err }));
      return;
    }
    this.ctx.diagnostic('dispatch-rejected', { reason: 'ACTION_NOT_IMPLEMENTED' });
    await req.reject('ACTION_NOT_IMPLEMENTED');
  }

  /** Every executor a cancelRequest should be resolved against: this server's own first (if any),
   *  then every managed handle's (ND-12, IMRFM only). */
  private cancelExecutors(): ActionExecutor[] {
    const list: ActionExecutor[] = [];
    if (this.executor) list.push(this.executor.executor);
    if (this.managedExecutorsHook) list.push(...this.managedExecutorsHook());
    return list;
  }

  /** Enforce bufferLimit: if the buffer exceeds the limit, displace the oldest request with REJECTED. */
  private async enforceBufferLimit(policy: ExecutionPolicy): Promise<void> {
    const limit = policy.bufferLimit ?? Number.POSITIVE_INFINITY;
    while (this.pendingRequests.length > limit) {
      const displaced = this.pendingRequests.shift()!;
      this.ctx.diagnostic('dispatch-rejected', { reason: 'REJECTED' });
      await displaced.req.reject('REJECTED');
    }
  }

  /** Re-admit buffered requests after a terminal transition, one at a time: each admitted request
   *  is marked admitted before the next decision is taken, so the drain stops as soon as the
   *  policy buffers again. Removal from the queue happens before any await, so two overlapping
   *  drains can never hand the same request to a handler twice. */
  private async reAdmitPending(): Promise<void> {
    while (this.pendingRequests.length > 0) {
      const policy = this.ctx.getExecutionPolicy();
      const index = this.selectNextPending(policy);
      const pending = this.pendingRequests[index]!;
      const decision = policy.admit(pending.request, this.buildActiveStatuses());
      if (decision.action === 'buffer') break;             // still blocked: leave the queue as is
      this.pendingRequests.splice(index, 1);
      await this.applyAdmissionDecision(pending.request, pending.req, decision, policy);
    }
  }

  /** Next buffered request to drain: lowest numeric priority first when the policy asks for a
   *  priority drain (arrival order breaking ties), plain FIFO otherwise. */
  private selectNextPending(policy: ExecutionPolicy): number {
    if (!policy.drainByPriority) return 0;
    const pri = (i: number): number => this.pendingRequests[i]!.request.priority ?? DEFAULT_PRIORITY;
    let best = 0;
    for (let i = 1; i < this.pendingRequests.length; i++) if (pri(i) < pri(best)) best = i;
    return best;
  }
}
