import type { Uuid } from '../types/common.js';
import type { RequestStatus } from '../types/requests.js';
import type { EntityRef } from '../topics/topics.js';
import { requestStatusTopic, requestTopic } from '../topics/topics.js';
import { isTerminalRequestState } from '../requests/stateMachine.js';
import { BrokerUnavailable, RequestFailed, RequestTimeout } from '../errors.js';
import { composeSubscription, type Subscription } from './subscription.js';
import type { EntityContext } from './entityHandle.js';

export class RequestHandle {
  readonly createdAt = new Date();
  #latest?: RequestStatus;
  #listeners: Array<(s: RequestStatus) => void> = [];
  #settled = false;
  #resolve!: (s: RequestStatus) => void;
  #reject!: (e: Error) => void;
  #completion: Promise<RequestStatus>;
  #timer?: ReturnType<typeof setTimeout>;
  #statusSub?: { unsubscribe(): Promise<void> };

  /** @internal */
  constructor(
    private readonly ctx: EntityContext,
    private readonly destRef: EntityRef,
    readonly requestUuid: Uuid,
    readonly sourceUuid: Uuid,
    readonly sequenceId: number,
    readonly destination: Uuid | '',
    private readonly timeoutMs: number,
  ) {
    this.#completion = new Promise<RequestStatus>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // Never surfaces as an unhandled rejection if the caller only uses onStatus().
    this.#completion.catch(() => undefined);
  }

  /** @internal — called by sendRequest once the status subscription is live. */
  armTimeout(sub: { unsubscribe(): Promise<void> }): void {
    this.#statusSub = sub;
    this.#timer = setTimeout(() => {
      this.settle(new RequestTimeout(
        `no RECEIVED for request ${this.requestUuid} within ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    this.#timer.unref?.();
  }

  /** @internal — one inbound requestStatus message. */
  ingest(status: RequestStatus): void {
    // Correlate by requestSequenceId (decision 5), not arrival timing: a retained status from a
    // prior use of this requestUuid (or a foreign one) must never drive this handle.
    if (status.requestSequenceId !== this.sequenceId) return;
    this.#latest = status;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    for (const cb of this.#listeners) cb(status);
    if (!isTerminalRequestState(status.status)) return;
    void this.clearRetainedRequest();
    if (status.status === 'SUCCEEDED') this.settle(undefined, status);
    else this.settle(new RequestFailed(`request ${this.requestUuid} ended ${status.status}`, status));
  }

  /** @internal — connection lost while in flight (nodejs_api.md §12). */
  failFast(): void {
    this.settle(new BrokerUnavailable(`broker unavailable during request ${this.requestUuid}`));
  }

  latestStatus(): RequestStatus | undefined { return this.#latest; }

  /** @internal — the resolved topic ref (post R3 empty-destination resolution), for sendCancel. */
  internalDestRef(): EntityRef { return this.destRef; }

  onStatus(handler: (s: RequestStatus) => void): Subscription {
    this.#listeners.push(handler);
    return composeSubscription([requestStatusTopic(this.destRef, this.requestUuid)], [{
      unsubscribe: async () => {
        this.#listeners = this.#listeners.filter((h) => h !== handler);
      },
    }]);
  }

  completion(): Promise<RequestStatus> { return this.#completion; }

  async cancel(opts: { actionId?: number } = {}): Promise<void> {
    if (this.#settled) return;      // no-op: nothing left to cancel
    await this.ctx.sendCancel(this, opts.actionId);
  }

  private settle(error?: Error, status?: RequestStatus): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    // Drop the status subscription on every outcome (success, failure, timeout, failFast) —
    // only ingest()'s terminal path used to do this, leaking it on timeout/failFast. The
    // retained request itself is untouched here: on timeout/failFast the true outcome is
    // unknown to us, so ND-10's janitor (Task 8) or the other party owns clearing it.
    // unsubscribe() is idempotent, so a prior clearRetainedRequest() call racing this is fine.
    void this.#statusSub?.unsubscribe().catch(() => {});
    if (error) this.#reject(error);
    else this.#resolve(status!);
  }

  /** Sender duty: clear the retained request on a terminal status (ND-10). Never throws — if the
   *  broker publish fails, Task 8's janitor is the backstop that eventually clears stale
   *  retained requests. */
  private async clearRetainedRequest(): Promise<void> {
    try {
      await this.ctx.session.clearRetained(requestTopic(this.destRef, this.requestUuid));
    } catch {
      // swallow — see comment above
    }
  }
}
