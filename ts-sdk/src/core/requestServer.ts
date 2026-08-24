import type { EntityContext } from './entityHandle.js';
import { requestStatusTopic } from '../topics/topics.js';
import { RESOURCE_CONFIG } from '../topics/resources.js';
import type { TopicMeta, SessionSubscription } from '../session/session.js';
import type { Request, RequestStatus } from '../types/requests.js';
import { validateMessage } from '../schema/validators.js';
import { isTerminalRequestState } from '../requests/stateMachine.js';
import { toTimestamp } from './types.js';
import { IncomingRequest, type StatusSink } from './incomingRequest.js';
import type { RequestAcceptanceFilter } from './filters.js';
import type { ExecutionPolicy } from './policies.js';

interface Registration { filter: RequestAcceptanceFilter; handler: (req: IncomingRequest) => void }

interface PendingRequest {
  request: Request;
  req: IncomingRequest;
}

interface ActiveRequestData {
  req: IncomingRequest;
  status: RequestStatus;
  priority?: number;
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
  private readonly requestPriorities = new Map<string, number>();  // requestUuid -> priority
  private readonly pendingRequests: PendingRequest[] = [];
  private readonly sink: StatusSink;

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
      filter, null, (msg, meta) => { void this.handleInbound(msg as string, meta); }, { qos: 2 });
  }

  register(filter: RequestAcceptanceFilter, handler: (req: IncomingRequest) => void): () => void {
    const reg: Registration = { filter, handler };
    this.registrations.push(reg);
    return () => { this.registrations = this.registrations.filter((r) => r !== reg); };
  }

  get handlerCount(): number { return this.registrations.length; }

  async teardown(): Promise<void> {
    await this.sessionSub?.unsubscribe();
    this.sessionSub = undefined;
  }

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
      return;                                              // point 4
    }
    this.seen.add(dupKey);

    const req = new IncomingRequest(request, requestUuid, this.sink);
    await req.publishReceived();                            // point 5 — D-12, before any handler

    // Note: publishReceived() has already called sink.publishStatus(), which added RECEIVED
    // status to activeStatuses. The request is now in activeStatuses with just {status, priority},
    // but needs the req field for preemption. However, we exclude it from the active array
    // passed to policy.admit() so it doesn't see itself as active (see buildActiveStatuses).

    // Task 6: Apply execution policy admission
    // Check if this is a cancelRequest (bypass admission per brief)
    const isCancelRequest = request.details.length > 0 && request.details[0]!.type === 'cancelRequest';
    if (isCancelRequest) {
      // cancelRequest bypasses admission — hand to handlers directly
      const matching = this.registrations.filter((r) => r.filter.matches(request));
      if (matching.length > 0) {
        for (const r of matching) r.handler(req);
      } else {
        this.ctx.diagnostic('dispatch-rejected', { reason: 'ACTION_NOT_IMPLEMENTED' });
        await req.reject('ACTION_NOT_IMPLEMENTED');
      }
      return;
    }

    // Build active array excluding this pending request (bug fix #1)
    const policy = this.ctx.getExecutionPolicy();
    const active = this.buildActiveStatuses(requestUuid);
    const decision = policy.admit(request, active);

    await this.applyAdmissionDecision(request, req, requestUuid, decision, policy);
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
      return;
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
      this.requestPriorities.delete(req.requestUuid);
      // Re-admit pending requests after a terminal transition (async to avoid blocking publishStatus)
      // ponytail: async re-admit means buffered requests may see slight delay before handling;
      // upgrade to sync if buffering causes QoS issues under load.
      setImmediate(() => { void this.reAdmitPending(); });
    } else {
      const priority = this.requestPriorities.get(req.requestUuid);
      this.activeStatuses.set(req.requestUuid, { req, status, priority });
    }
    const statusArray = [...this.activeStatuses.values()].map((data) => data.status);
    await this.ctx.session.publishResource(
      this.ctx.ref, 'activeRequestsStatus', 'requestStatusArray', statusArray);
    this.ctx.countPublish();
  }

  /** Build active statuses augmented with priority (R7), excluding a specific request. */
  private buildActiveStatuses(excludeUuid?: string): (RequestStatus & { priority?: number })[] {
    return [...this.activeStatuses.entries()]
      .filter(([uuid]) => uuid !== excludeUuid)
      .map(([, data]) => ({
        ...data.status,
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
      }));
  }

  /** Apply an admission decision: accept, reject, buffer, or preempt. */
  private async applyAdmissionDecision(
    request: Request, req: IncomingRequest, requestUuid: string,
    decision: ReturnType<ExecutionPolicy['admit']>, policy: ExecutionPolicy,
  ): Promise<void> {
    if (decision.action === 'reject') {
      this.ctx.diagnostic('dispatch-rejected', { reason: decision.reason });
      await req.reject(decision.reason);
    } else if (decision.action === 'buffer') {
      this.pendingRequests.push({ request, req });
      await this.enforceBufferLimit(policy);
    } else if (decision.action === 'preempt') {
      // Preempt active requests: cancel them CANCELED, then accept the pending one
      for (const key of decision.preempt) {
        for (const [, data] of this.activeStatuses.entries()) {
          if (data.status.source === key.source && data.status.requestSequenceId === key.sequenceId) {
            // Task 7 seam: executor runs will hook AbortSignal here; for now, end directly.
            await data.req.complete({ status: 'CANCELED', reason: 'PREEMPTED' });
          }
        }
      }
      // Now accept the pending request
      if (request.priority !== undefined) {
        this.requestPriorities.set(requestUuid, request.priority);
      }
      await this.handleAcceptedRequest(request, req);
    } else if (decision.action === 'accept') {
      if (request.priority !== undefined) {
        this.requestPriorities.set(requestUuid, request.priority);
      }
      await this.handleAcceptedRequest(request, req);
    }
  }

  /** Handle an accepted request: route to matching handlers. */
  private async handleAcceptedRequest(request: Request, req: IncomingRequest): Promise<void> {
    const matching = this.registrations.filter((r) => r.filter.matches(request));
    if (matching.length > 0) {
      for (const r of matching) r.handler(req);
      return;
    }
    // Point 6: no matching low-level handler = no executor either
    this.ctx.diagnostic('dispatch-rejected', { reason: 'ACTION_NOT_IMPLEMENTED' });
    await req.reject('ACTION_NOT_IMPLEMENTED');
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

  /** Re-admit pending requests after a terminal request transition. */
  private async reAdmitPending(): Promise<void> {
    while (this.pendingRequests.length > 0) {
      const policy = this.ctx.getExecutionPolicy();
      const active = this.buildActiveStatuses();

      // Select next pending request: if policy supports priority draining (priority() has a marker),
      // pick the highest-priority (lowest numeric value), else FIFO.
      // Simplest: if all pending have priority field, assume priority drain; else FIFO.
      const index = this.selectNextPending();
      if (index === -1) break;                             // no progress possible
      const pending = this.pendingRequests[index]!;

      const decision = policy.admit(pending.request, active);
      this.pendingRequests.splice(index, 1);

      if (decision.action === 'reject') {
        this.ctx.diagnostic('dispatch-rejected', { reason: decision.reason });
        await pending.req.reject(decision.reason);
      } else if (decision.action === 'accept' || decision.action === 'preempt') {
        await this.applyAdmissionDecision(
          pending.request, pending.req, pending.req.requestUuid, decision, policy);
      } else {
        // action === 'buffer': re-buffering, stop trying
        this.pendingRequests.splice(index, 0, pending);  // put it back
        break;
      }
    }
  }

  /** Select the next pending request to re-admit: by priority if all have it, else FIFO. */
  private selectNextPending(): number {
    if (this.pendingRequests.length === 0) return -1;
    // Detect priority-based drain: if policy has no bufferLimit marker (implicit infinity),
    // and request priorities exist, use priority order. Otherwise FIFO.
    const hasPriorities = this.pendingRequests.every((p) => p.request.priority !== undefined);
    if (!hasPriorities) return 0;                         // FIFO
    // Priority drain: select lowest numeric priority (highest priority), arrival order tiebreak
    let best = 0;
    for (let i = 1; i < this.pendingRequests.length; i++) {
      const bestPri = this.pendingRequests[best]!.request.priority ?? 100;
      const thisPri = this.pendingRequests[i]!.request.priority ?? 100;
      if (thisPri < bestPri) best = i;
    }
    return best;
  }
}
