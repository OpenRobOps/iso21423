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
