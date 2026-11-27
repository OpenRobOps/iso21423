/**
 * Copyright 2026 InOrbit, Inc.
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

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

  /** Schedules `requestTopic` to be force-cleared after the grace period; the clear itself is idempotent, so overlapping/duplicate `note()` calls are harmless. */
  note(requestTopic: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.session.clearRetained(requestTopic).then(() => this.onCleared(requestTopic))
        // Idempotent retry: the next note() (or the sender's own ND-10 clear) will catch it up,
        // so a failed clear here is silently swallowed rather than an unhandled rejection.
        .catch(() => {});
    }, this.graceMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
