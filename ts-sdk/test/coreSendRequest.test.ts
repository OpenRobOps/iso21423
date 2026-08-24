import { describe, it, expect } from 'vitest';
import {
  Iso21423Client, NotCapableError, RequestFailed, RequestTimeout, move, nowTimestamp,
} from '../src/index.js';
import { MemoryBroker, type MemoryTransport } from '../src/testing/index.js';

const SRC = '42177726-26f7-4f5c-b735-a12a427bb96d';
const DST = '91403a21-7534-4467-99a6-79c46a130fe8';
const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
const IMRFM = '5a35c6c1-6b60-4c2e-9f2c-4c1a7f7a9a11';
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const target = { location: { ccsId: CCS, x: 1, y: 2, z: 0 } };

async function requester(broker: MemoryBroker) {
  const c = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 50,
  });
  const handle = await c.registerSelfEntity({
    entityUuid: SRC, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
  return { client: c, handle };
}

/** Publish an identity for the destination so type + capabilities are discoverable. */
async function fakeRobot(broker: MemoryBroker, accepts: string[]) {
  const c = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
  await c.registerSelfEntity({
    entityUuid: DST, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts },
  });
  return c;
}

/** Minimal executor stand-in: publishes raw status messages on the request's status topic. */
function statusPublisher(broker: MemoryBroker) {
  const t: MemoryTransport = broker.createTransport();
  const ready = t.connect({ clientId: 'exec', cleanSession: false, keepalive: 60 });
  return async (requestUuid: string, status: string, extra: Record<string, unknown> = {}) => {
    await ready;
    await t.publish(
      `/ISO_21423/v1/IMR/${DST}/request/${requestUuid}/status`,
      JSON.stringify({
        source: DST, destination: SRC, sequenceId: 1, requestSequenceId: 1,
        timestamp: nowTimestamp(), status, detailStatuses: [], ...extra,
      }),
      { qos: 2, retain: true },
    );
  };
}

describe('sendRequest', () => {
  it('publishes a conformant retained request at QoS 2 with an SDK-assigned sequenceId', async () => {
    const broker = new MemoryBroker();
    await fakeRobot(broker, ['move']);
    const { handle } = await requester(broker);
    await flush();
    const req = await handle.sendRequest({ destination: DST, details: [move(target)] });
    const topic = `/ISO_21423/v1/IMR/${DST}/request/${req.requestUuid}`;
    const [msg] = broker.messagesOn(topic);
    const body = JSON.parse(msg!.payload.toString()) as {
      source: string; destination: string; sequenceId: number; details: Array<{ type: string }>;
    };
    expect(msg!.qos).toBe(2);
    expect(msg!.retain).toBe(true);
    expect(body.source).toBe(SRC);
    expect(body.destination).toBe(DST);
    expect(body.sequenceId).toBe(req.sequenceId);
    expect(body.details[0]!.type).toBe('move');
  });

  it('increments sequenceId per request from the same handle (D-15)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await requester(broker);
    const a = await handle.sendRequest({ destination: DST, destinationType: 'IMR', details: [move(target)] });
    const b = await handle.sendRequest({ destination: DST, destinationType: 'IMR', details: [move(target)] });
    expect(b.sequenceId).toBe(a.sequenceId + 1);
  });

  it('throws NotCapableError only when the destination is known not to accept the action', async () => {
    const broker = new MemoryBroker();
    await fakeRobot(broker, ['dock']);
    const { handle } = await requester(broker);
    await flush();
    await expect(handle.sendRequest({ destination: DST, details: [move(target)] }))
      .rejects.toThrow(NotCapableError);
    await expect(handle.sendRequest({
      destination: DST, details: [move(target)], requireCapability: false,
    })).resolves.toBeDefined();
    await expect(handle.sendRequest({
      destination: '11111111-1111-4111-8111-111111111111', destinationType: 'Door',
      details: [{ type: 'openDoor', version: '1.0', properties: {} }],
    })).resolves.toBeDefined();          // unknown entity → no claim, no throw
  });

  it('streams status and resolves completion() on SUCCEEDED (D-16)', async () => {
    const broker = new MemoryBroker();
    const publish = statusPublisher(broker);
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)],
    });
    const seen: string[] = [];
    req.onStatus((s) => seen.push(s.status));
    await publish(req.requestUuid, 'RECEIVED');
    await publish(req.requestUuid, 'ACCEPTED');
    await publish(req.requestUuid, 'EXECUTING');
    await publish(req.requestUuid, 'SUCCEEDED');
    const final = await req.completion();
    expect(seen).toEqual(['RECEIVED', 'ACCEPTED', 'EXECUTING', 'SUCCEEDED']);
    expect(final.status).toBe('SUCCEEDED');
    expect(req.latestStatus()!.status).toBe('SUCCEEDED');
  });

  it('rejects completion() with RequestFailed on ABORTED', async () => {
    const broker = new MemoryBroker();
    const publish = statusPublisher(broker);
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)],
    });
    await publish(req.requestUuid, 'RECEIVED');
    await publish(req.requestUuid, 'ABORTED');
    await expect(req.completion()).rejects.toThrow(RequestFailed);
  });

  it('zero-byte-clears the retained request on a terminal status (ND-10, B.5.3)', async () => {
    const broker = new MemoryBroker();
    const publish = statusPublisher(broker);
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)],
    });
    const topic = `/ISO_21423/v1/IMR/${DST}/request/${req.requestUuid}`;
    expect(broker.retainedOn(topic)).toBeDefined();
    await publish(req.requestUuid, 'RECEIVED');
    await publish(req.requestUuid, 'SUCCEEDED');
    await req.completion();
    expect(broker.retainedOn(topic)).toBeUndefined();
  });

  it('raises a local-only RequestTimeout when no RECEIVED arrives (D-14)', async () => {
    const broker = new MemoryBroker();
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)], timeoutMs: 20,
    });
    await expect(req.completion()).rejects.toThrow(RequestTimeout);
    // Never published as a protocol state change:
    expect(broker.messagesOn(`/ISO_21423/v1/IMR/${DST}/request/${req.requestUuid}/status`))
      .toHaveLength(0);
  });

  it('cancel() sends a cancelRequest naming (source, requestId) — D-02, Table C.4', async () => {
    const broker = new MemoryBroker();
    const { handle } = await requester(broker);
    const req = await handle.sendRequest({
      destination: DST, destinationType: 'IMR', details: [move(target)],
    });
    await req.cancel();
    const cancelMsg = broker.messagesUnder(`/ISO_21423/v1/IMR/${DST}/request/`)
      .find((m) => m.payload.toString().includes('cancelRequest'));
    const body = JSON.parse(cancelMsg!.payload.toString()) as {
      source: string; sequenceId: number; details: Array<{ type: string; properties: unknown }>;
    };
    expect(body.details[0]!.type).toBe('cancelRequest');
    expect(body.details[0]!.properties).toEqual({ source: SRC, requestId: req.sequenceId });
    expect(body.sequenceId).toBe(req.sequenceId + 1);       // the cancel is its own request
  });

  // Controller ruling R3: empty destination resolves the target from the identity catalog.
  it('resolves an empty destination via the identity catalog (spec §3.1 IMRFM)', async () => {
    const broker = new MemoryBroker();
    const fm = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
    await fm.registerSelfEntity({
      entityUuid: IMRFM, entityType: 'IMRFM', manufacturerName: 'Acme Fleet Manager',
    });
    const { handle } = await requester(broker);
    await flush();
    const req = await handle.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target)],
    });
    const topic = `/ISO_21423/v1/IMRFM/${IMRFM}/request/${req.requestUuid}`;
    const [msg] = broker.messagesOn(topic);
    const body = JSON.parse(msg!.payload.toString()) as { destination: string };
    expect(msg).toBeDefined();
    expect(body.destination).toBe('');
  });

  it('throws when an empty destination cannot resolve to exactly one candidate', async () => {
    const broker = new MemoryBroker();
    const { handle } = await requester(broker);
    await expect(handle.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target)],
    })).rejects.toThrow(/IMRFM/);
  });
});
