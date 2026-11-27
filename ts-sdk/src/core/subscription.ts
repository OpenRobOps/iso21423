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

/** Lifetime token: `unsubscribe()` or `await using` (D-19). */
export interface Subscription extends AsyncDisposable {
  unsubscribe(): Promise<void>;
  readonly active: boolean;
  readonly topicFilters: readonly string[];
}

/** Bundle N session subscriptions (one per compiled MQTT filter) into one token. */
export function composeSubscription(
  topicFilters: string[],
  parts: Array<{ unsubscribe(): Promise<void> }>,
): Subscription {
  let live = true;
  const sub: Subscription = {
    topicFilters: Object.freeze([...topicFilters]),
    get active() { return live; },
    async unsubscribe() {
      if (!live) return;              // idempotent
      live = false;
      await Promise.all(parts.map((p) => p.unsubscribe()));
    },
    async [Symbol.asyncDispose]() {
      await sub.unsubscribe();
    },
  };
  return sub;
}
