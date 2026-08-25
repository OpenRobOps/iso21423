import type { Uuid } from '../types/common.js';
import type { Request, RequestDetail, RequestDetailStatus, RequestStatus } from '../types/requests.js';
import type { DetailState, RequestState } from '../types/constants.js';
import { DetailLifecycle, RequestLifecycle } from '../requests/stateMachine.js';
import { IllegalTransition } from '../errors.js';
import { toTimestamp, type RequestDetailStatusUpdate, type RequestStatusUpdate,
  type RequestTerminalUpdate, type StatusReason } from './types.js';

/** What an {@link IncomingRequest} publishes status through; implemented by `RequestServer`. */
export interface StatusSink {
  /** Publishes one requestStatus message (QoS 2, retained) and refreshes activeRequestsStatus. */
  publishStatus(req: IncomingRequest, status: RequestStatus): Promise<void>;
  ownerUuid: Uuid;
  nextStatusSequenceId(): Promise<number>;
}

/**
 * Server-side lifecycle for one received {@link Request}: tracks the overall request state and
 * each detail's state via {@link RequestLifecycle}/{@link DetailLifecycle}, and publishes a
 * requestStatus message on every change. A request-level transition cascades onto any
 * still-in-flight details that legally admit it (see `cascadeDetails`), so callers don't have to
 * individually resolve every detail before completing the request.
 */
export class IncomingRequest {
  readonly #lifecycle = new RequestLifecycle();
  readonly #details: DetailLifecycle[];
  readonly #detailStatuses: RequestDetailStatus[];
  #recoveries?: DetailLifecycle[];
  #recoveryStatuses?: RequestDetailStatus[];

  /** @internal */
  constructor(
    readonly request: Request,
    readonly requestUuid: Uuid,
    private readonly sink: StatusSink,
  ) {
    this.#details = request.details.map(() => new DetailLifecycle());
    this.#detailStatuses = request.details.map((d) => ({
      type: d.type,
      version: d.version,
      ...(d.blocking !== undefined ? { blocking: d.blocking } : {}),
      status: { code: 'RECEIVED' as DetailState },
    }));
  }

  get source(): Uuid { return this.request.source; }
  get sequenceId(): number { return this.request.sequenceId; }
  get state(): RequestState { return this.#lifecycle.state; }
  get isTerminal(): boolean { return this.#lifecycle.isTerminal(); }

  /** @internal — D-12: RECEIVED is published by the server before the handler sees this. */
  async publishReceived(): Promise<void> { await this.emit(); }

  async accept(): Promise<void> { await this.transitionTo('ACCEPTED'); }

  /** Transitions straight to ABORTED with the given reason (e.g. for pre-flight rejections that never reach ACCEPTED). */
  async reject(reason: StatusReason): Promise<void> {
    await this.transitionTo('ABORTED', reason);
  }

  async updateStatus(update: RequestStatusUpdate): Promise<void> {
    await this.transitionTo(update.status, update.reason, update.message);
  }

  async updateDetailStatus(update: RequestDetailStatusUpdate): Promise<void> {
    const lifecycle = this.#details[update.index];
    const entry = this.#detailStatuses[update.index];
    if (!lifecycle || !entry) {
      throw new IllegalTransition(`no request detail at index ${update.index}`);
    }
    // A cascade (see cascadeDetails below) may already have legally advanced this detail to
    // `update.status` — an explicit call agreeing with that is accepted as a no-op, never
    // re-thrown as illegal; only a genuine mismatch goes through the FSM guard.
    if (lifecycle.state !== update.status) lifecycle.transition(update.status);
    entry.status = {
      code: update.status,
      ...(update.reason ? { reason: update.reason } : {}),
      ...(update.message ? { message: update.message } : {}),
    };
    if (update.properties) entry.properties = { ...entry.properties, ...update.properties };
    await this.emit();
  }

  async complete(terminal: RequestTerminalUpdate): Promise<void> {
    await this.transitionTo(terminal.status, terminal.reason, terminal.message);
  }

  /** @internal — used by the executor for the RECOVERY phase: transitions the request to
   *  RECOVERY and seeds `recoveryStatuses` from the request's declared `recoveries`, mirroring
   *  how the constructor seeds `detailStatuses` from `request.details`. */
  async enterRecovery(recoveries: RequestDetail[], reason?: StatusReason): Promise<void> {
    this.#recoveries = recoveries.map(() => new DetailLifecycle());
    this.#recoveryStatuses = recoveries.map((d) => ({
      type: d.type,
      version: d.version,
      ...(d.blocking !== undefined ? { blocking: d.blocking } : {}),
      status: { code: 'RECEIVED' as DetailState },
    }));
    await this.transitionTo('RECOVERY', reason);
  }

  /** @internal — used by the executor to report a recovery detail's progress/outcome. Unlike
   *  `updateDetailStatus`, recovery entries are never cascaded by a terminal request transition
   *  (RECOVERY has no detail-level equivalent — see cascadeDetails), so the executor must call
   *  this for every recovery detail as it finishes, not just the non-last ones. */
  async updateRecoveryStatus(update: RequestDetailStatusUpdate): Promise<void> {
    const lifecycle = this.#recoveries?.[update.index];
    const entry = this.#recoveryStatuses?.[update.index];
    if (!lifecycle || !entry) {
      throw new IllegalTransition(`no recovery detail at index ${update.index}`);
    }
    // Recovery lifecycles are never cascaded by the request (see enterRecovery), so — unlike
    // main details, which arrive at EXECUTING already advanced through ACCEPTED by the cascade —
    // the executor's first update (EXECUTING, starting the recovery detail) must step through
    // ACCEPTED itself here.
    if (update.status === 'EXECUTING' && lifecycle.state === 'RECEIVED') lifecycle.transition('ACCEPTED');
    if (lifecycle.state !== update.status) lifecycle.transition(update.status);
    entry.status = {
      code: update.status,
      ...(update.reason ? { reason: update.reason } : {}),
      ...(update.message ? { message: update.message } : {}),
    };
    if (update.properties) entry.properties = { ...entry.properties, ...update.properties };
    await this.emit();
  }

  private async transitionTo(
    to: RequestState, reason?: StatusReason, message?: string,
  ): Promise<void> {
    this.#lifecycle.transition(to);                      // throws IllegalTransition
    this.cascadeDetails(to);
    await this.emit(reason, message);
  }

  // ponytail: a request-level transition implies at least that much progress on every detail
  // still in flight — an app that only calls accept()/updateStatus()/complete() and never
  // updateDetailStatus() for a given detail shouldn't leave it stuck at RECEIVED (or, worse,
  // publish a dead request with a still-live detail underneath it). Details already at or past
  // `to`, already terminal, or for which `to` has no detail-level equivalent (RECOVERY) are left
  // untouched; explicit updateDetailStatus() calls after this are then no-ops state-wise. Mirrors
  // onto the wire-visible #detailStatuses entry too (preserving any reason/message already set),
  // not just the internal DetailLifecycle guard.
  private cascadeDetails(to: RequestState): void {
    const target = to as unknown as DetailState;
    this.#details.forEach((lifecycle, i) => {
      if (lifecycle.isTerminal() || lifecycle.state === target) return;
      if (!lifecycle.canTransition(target)) return;
      lifecycle.transition(target);
      const entry = this.#detailStatuses[i]!;
      entry.status = { ...entry.status, code: target };
    });
  }

  /**
   * Builds and publishes the current requestStatus snapshot. A `reason`/`message` passed here
   * (from a request-level transition) is attached to the first detail status entry, not stored
   * at the request level — the wire schema carries reason/message per-detail, not on the request.
   */
  private async emit(reason?: StatusReason, message?: string): Promise<void> {
    const status: RequestStatus = {
      source: this.sink.ownerUuid,                       // decision 5
      destination: this.request.source,
      sequenceId: await this.sink.nextStatusSequenceId(),
      requestSequenceId: this.request.sequenceId,
      timestamp: toTimestamp(),
      status: this.#lifecycle.state,
      detailStatuses: this.#detailStatuses.map((d) => ({ ...d })),
      ...(this.#recoveryStatuses
        ? { recoveryStatuses: this.#recoveryStatuses.map((d) => ({ ...d })) }
        : {}),
    };
    if (reason || message) {
      const first = status.detailStatuses[0];
      if (first) {
        first.status = {
          ...first.status,
          ...(reason ? { reason } : {}),
          ...(message ? { message } : {}),
        };
      }
    }
    await this.sink.publishStatus(this, status);
  }
}
