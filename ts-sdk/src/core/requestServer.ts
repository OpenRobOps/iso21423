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

interface Registration { filter: RequestAcceptanceFilter; handler: (req: IncomingRequest) => void }

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
  private readonly activeStatuses = new Map<string, RequestStatus>();
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

    const matching = this.registrations.filter((r) => r.filter.matches(request));
    if (matching.length > 0) {
      for (const r of matching) r.handler(req);
      return;
    }
    // Point 6, this task's slice: admission (Task 6) and the per-action executor (Task 7) do not
    // exist yet, so "no matching low-level handler" already means "no executor either".
    this.ctx.diagnostic('dispatch-rejected', { reason: 'ACTION_NOT_IMPLEMENTED' });
    await req.reject('ACTION_NOT_IMPLEMENTED');
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
    } else {
      this.activeStatuses.set(req.requestUuid, status);
    }
    await this.ctx.session.publishResource(
      this.ctx.ref, 'activeRequestsStatus', 'requestStatusArray', [...this.activeStatuses.values()]);
    this.ctx.countPublish();
  }
}
