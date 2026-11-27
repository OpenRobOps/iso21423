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

import { FleetGateway, Iso21423Client } from '../../src/index.js';
import { MemoryBroker } from '../../src/testing/index.js';

export const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
export const target = (x = 1, y = 2) => ({ location: { ccsId: CCS, x, y, z: 0 } });

export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

export async function waitFor(
  pred: () => boolean, opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 1000);
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${opts.label ?? 'condition'}`);
    await new Promise((r) => setImmediate(r));
  }
}

export function deployment() {
  const broker = new MemoryBroker();
  return {
    broker,
    async client(over: Record<string, unknown> = {}) {
      return Iso21423Client.connect({
        transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 500, ...over,
      });
    },
    async gateway(imrfm: { id: string; manufacturerName: string; accepts?: string[] },
                  over: Record<string, unknown> = {}) {
      return FleetGateway.connect({
        transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 500,
        security: { selfCheck: false }, janitor: { graceMs: 10 }, imrfm, ...over,
      });
    },
  };
}

export function statusSequence(
  broker: MemoryBroker, entityType: string, entityUuid: string, requestUuid: string,
): string[] {
  return broker
    .messagesOn(`/ISO_21423/v1/${entityType}/${entityUuid}/request/${requestUuid}/status`)
    .map((m) => (JSON.parse(m.payload.toString()) as { status: string }).status);
}

export function lastStatus(
  broker: MemoryBroker, entityType: string, entityUuid: string, requestUuid: string,
): {
  status: string;
  detailStatuses: Array<{ type: string; status: { code: string; reason?: string } }>;
  recoveryStatuses?: Array<{ type: string; status: { code: string; reason?: string } }>;
} {
  const msgs = broker.messagesOn(
    `/ISO_21423/v1/${entityType}/${entityUuid}/request/${requestUuid}/status`);
  return JSON.parse(msgs.at(-1)!.payload.toString()) as never;
}
