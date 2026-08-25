import type { Iso21423Session } from '../session/session.js';
import type { EntityRef } from '../topics/topics.js';
import { AuthorizationDenied } from '../errors.js';

/**
 * ND-15: MQTT 3.1.1 gives no negative acknowledgement for a denied publish, so the only way to
 * detect a missing write grant is to read our own retained identity back.
 */
export async function publishSelfCheck(
  session: Iso21423Session, ref: EntityRef, timeoutMs = 2000,
): Promise<void> {
  const topic = session.topicFor(ref, 'identity');
  let seen = false;
  let resolveEcho: () => void = () => {};
  const echo = new Promise<void>((resolve) => { resolveEcho = resolve; });
  const sub = await session.subscribeTopic(topic, null, (raw) => {
    if (typeof raw === 'string' && raw.length > 0) { seen = true; resolveEcho(); }
  }, { qos: 1 });
  try {
    const timer = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
    });
    await Promise.race([echo, timer]);
    if (!seen) {
      throw new AuthorizationDenied(
        `publish self-check failed: no retained identity echo on ${topic} — the broker ACL ` +
        `probably denies write access to this namespace (ND-15)`, topic);
    }
  } finally {
    await sub.unsubscribe();
  }
}
