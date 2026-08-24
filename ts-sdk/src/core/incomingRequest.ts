import type { Uuid } from '../types/common.js';
import type { Request, RequestDetailStatus, RequestStatus } from '../types/requests.js';
import type { DetailState, RequestState } from '../types/constants.js';
import { DetailLifecycle, RequestLifecycle } from '../requests/stateMachine.js';
import { IllegalTransition } from '../errors.js';
import { toTimestamp, type RequestDetailStatusUpdate, type RequestStatusUpdate,
  type RequestTerminalUpdate, type StatusReason } from './types.js';

export interface StatusSink {
  /** Publishes one requestStatus message (QoS 2, retained) and refreshes activeRequestsStatus. */
  publishStatus(req: IncomingRequest, status: RequestStatus): Promise<void>;
  ownerUuid: Uuid;
  nextStatusSequenceId(): Promise<number>;
}

export class IncomingRequest {
  readonly #lifecycle = new RequestLifecycle();
  readonly #details: DetailLifecycle[];
  readonly #detailStatuses: RequestDetailStatus[];

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

  /** @internal — used by the executor for the RECOVERY phase. */
  async enterRecovery(reason?: StatusReason): Promise<void> {
    await this.transitionTo('RECOVERY', reason);
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
  // updateDetailStatus() for a given detail shouldn't leave it stuck at RECEIVED. Details already
  // at or past `to`, already terminal, or for which `to` has no detail-level equivalent (RECOVERY)
  // are left untouched; explicit updateDetailStatus() calls after this are then no-ops state-wise.
  private cascadeDetails(to: RequestState): void {
    const target = to as unknown as DetailState;
    for (const lifecycle of this.#details) {
      if (lifecycle.isTerminal() || lifecycle.state === target) continue;
      if (lifecycle.canTransition(target)) lifecycle.transition(target);
    }
  }

  private async emit(reason?: StatusReason, message?: string): Promise<void> {
    const status: RequestStatus = {
      source: this.sink.ownerUuid,                       // decision 5
      destination: this.request.source,
      sequenceId: await this.sink.nextStatusSequenceId(),
      requestSequenceId: this.request.sequenceId,
      timestamp: toTimestamp(),
      status: this.#lifecycle.state,
      detailStatuses: this.#detailStatuses.map((d) => ({ ...d })),
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
