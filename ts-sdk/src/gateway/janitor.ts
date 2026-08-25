import type { Iso21423Session } from '../session/session.js';

/**
 * ND-10: the sender clears its own retained request at terminal state. The gateway additionally
 * clears requests in its own namespaces that are still retained a grace period after the terminal
 * status it published — protection against crashed senders. Clearing an already-cleared topic is a
 * harmless no-op, so no "is it still retained?" probe is needed.
 */
export class RetainedRequestJanitor {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly session: Iso21423Session,
    private readonly graceMs: number,
    private readonly onCleared: (topic: string) => void,
  ) {}

  note(requestTopic: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.session.clearRetained(requestTopic).then(() => this.onCleared(requestTopic));
    }, this.graceMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
