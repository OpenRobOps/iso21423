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
