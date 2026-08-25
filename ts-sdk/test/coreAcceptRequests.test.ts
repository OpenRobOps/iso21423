import { describe, it, expect, vi } from 'vitest';
import {
  Iso21423Client, RequestAcceptanceFilter, IllegalTransition, move, nowTimestamp,
} from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const SRC = '42177726-26f7-4f5c-b735-a12a427bb96d';
const DST = '91403a21-7534-4467-99a6-79c46a130fe8';
const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
const REQ = 'aa53a1e1-782f-479b-88b3-fd110198be45';
const reqTopic = `/ISO_21423/v1/IMR/${DST}/request/${REQ}`;
const statusTopic = `${reqTopic}/status`;
const activeTopic = `/ISO_21423/v1/IMR/${DST}/activeRequestsStatus`;
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  destination: DST, source: SRC, sequenceId: 1, timestamp: nowTimestamp(),
  details: [move({ location: { ccsId: CCS, x: 1, y: 2, z: 0 } })], ...over,
});

async function robot(broker: MemoryBroker) {
  const c = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
  const h = await c.registerSelfEntity({
    entityUuid: DST, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move'] },
  });
  return { client: c, handle: h };
}

async function inject(broker: MemoryBroker, payload: string, topic = reqTopic) {
  const t = broker.createTransport();
  await t.connect({ clientId: `injector-${Math.random()}`, cleanSession: false, keepalive: 60 });
  await t.publish(topic, payload, { qos: 2, retain: true });
  await flush();
}

const statuses = (broker: MemoryBroker) =>
  broker.messagesOn(statusTopic).map((m) => (JSON.parse(m.payload.toString()) as { status: string }).status);

describe('acceptRequests substrate', () => {
  it('auto-publishes RECEIVED before the handler runs (D-12)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    let seenAtHandler: string[] = [];
    await handle.acceptRequests(RequestAcceptanceFilter.all(), () => {
      seenAtHandler = statuses(broker);
    });
    await inject(broker, body());
    expect(seenAtHandler).toEqual(['RECEIVED']);
  });

  it('auto-rejects schema-invalid requests without invoking the handler (D-13)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    const handler = vi.fn();
    await handle.acceptRequests(RequestAcceptanceFilter.all(), handler);
    await inject(broker, body({ details: 'not-an-array' }));
    expect(handler).not.toHaveBeenCalled();
    const last = JSON.parse(broker.messagesOn(statusTopic).at(-1)!.payload.toString()) as {
      status: string; detailStatuses: Array<{ status: { reason: string } }>;
    };
    expect(last.status).toBe('ABORTED');
    expect(broker.messagesOn(statusTopic).at(-1)!.payload.toString()).toContain('MALFORMED_REQUEST');
  });

  it('drives accept → EXECUTING → complete and aggregates activeRequestsStatus', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    await handle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      expect(req.source).toBe(SRC);
      expect(req.sequenceId).toBe(1);
      await req.accept();
      const active = JSON.parse(broker.retainedOn(activeTopic)!.toString()) as Array<{ status: string }>;
      expect(active).toHaveLength(1);
      await req.updateStatus({ status: 'EXECUTING' });
      await req.updateDetailStatus({ index: 0, status: 'EXECUTING', properties: { pct: 50 } });
      await req.complete({ status: 'SUCCEEDED' });
    });
    await inject(broker, body());
    await flush();
    expect(statuses(broker)).toEqual(['RECEIVED', 'ACCEPTED', 'EXECUTING', 'EXECUTING', 'SUCCEEDED']);
    expect(JSON.parse(broker.retainedOn(activeTopic)!.toString())).toEqual([]);
  });

  it('reject(reason) publishes ABORTED with the reason', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    await handle.acceptRequests(RequestAcceptanceFilter.all(), (req) => void req.reject('REJECTED'));
    await inject(broker, body());
    await flush();
    const last = JSON.parse(broker.messagesOn(statusTopic).at(-1)!.payload.toString()) as {
      status: string; detailStatuses: Array<{ status: { code: string; reason?: string } }>;
    };
    expect(statuses(broker)).toEqual(['RECEIVED', 'ABORTED']);
    expect(last.status).toBe('ABORTED');
    // The wire-visible detail cascades to the request's terminal state too — no live detail left
    // dangling under a dead request.
    expect(last.detailStatuses[0]!.status.code).toBe('ABORTED');
    expect(last.detailStatuses[0]!.status.reason).toBe('REJECTED');
  });

  it('rejects illegal transitions locally (Figure C.3)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    let error: unknown;
    await handle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      try { await req.updateStatus({ status: 'SUCCEEDED' }); } catch (e) { error = e; }
    });
    await inject(broker, body());
    await flush();
    expect(error).toBeInstanceOf(IllegalTransition);
    expect(statuses(broker)).toEqual(['RECEIVED']);
  });

  it('honours the acceptance filter and ignores duplicate retained replays', async () => {
    const broker = new MemoryBroker();
    const { handle } = await robot(broker);
    const seen: number[] = [];
    await handle.acceptRequests(RequestAcceptanceFilter.actions(['move']),
      (req) => seen.push(req.sequenceId));
    await inject(broker, body());
    await inject(broker, body());                                   // same (source, sequenceId)
    await inject(broker, body({ sequenceId: 2, details: [{ type: 'dock', version: '1.0', properties: {} }] }));
    expect(seen).toEqual([1]);
  });
});
