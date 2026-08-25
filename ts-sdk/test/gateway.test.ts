import { describe, it, expect } from 'vitest';
import {
  FleetGateway, Iso21423Client, AuthorizationDenied, move, nowTimestamp, policies,
} from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const FLEET = '42177726-26f7-4f5c-b735-a12a427bb96d';
const IMR_A = '91403a21-7534-4467-99a6-79c46a130fe8';
const IMR_B = '11111111-1111-4111-8111-111111111111';
const SRC = '33333333-3333-4333-8333-333333333333';
const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
const target = { location: { ccsId: CCS, x: 1, y: 2, z: 0 } };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const ns = (t: string, u: string, r: string) => `/ISO_21423/v1/${t}/${u}/${r}`;

async function gateway(broker: MemoryBroker, over: Record<string, unknown> = {}) {
  return FleetGateway.connect({
    transport: broker.createTransport(),
    sequenceStore: null,
    imrfm: { id: FLEET, manufacturerName: 'Acme Fleet', accepts: ['move'] },
    janitor: { graceMs: 5 },
    ...over,
  });
}

async function requester(broker: MemoryBroker) {
  const c = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 500,
  });
  return c.registerSelfEntity({
    entityUuid: SRC, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
}

describe('FleetGateway', () => {
  it('registers the IMRFM and managed robots with manages/managedBy links (D-11)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    const a = await g.registerImr({ id: IMR_A, manufacturerName: 'Acme Robotics', accepts: ['move'] });
    const b = await g.registerImr({ id: IMR_B, manufacturerName: 'Acme Robotics', accepts: ['move'] });
    expect(g.imrs().map((h) => h.entityUuid)).toEqual([IMR_A, IMR_B]);
    expect(a.ownershipMode).toBe('managed');
    const fleetIdentity = JSON.parse(broker.retainedOn(ns('IMRFM', FLEET, 'identity'))!.toString()) as {
      capabilities: { manages: string[] };
    };
    expect(fleetIdentity.capabilities.manages).toEqual([IMR_A, IMR_B]);
    expect(JSON.parse(broker.retainedOn(ns('IMR', IMR_B, 'identity'))!.toString()))
      .toMatchObject({ capabilities: { managedBy: FLEET } });
    void b;
  });

  it('serves fleet-wide handlers with per-robot overrides', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    await g.registerImr({ id: IMR_B, manufacturerName: 'Acme', accepts: ['move'] });
    const served: string[] = [];
    g.onRequest('move', async (_a, ctx) => { served.push(`fleet:${ctx.entity.entityUuid}`); return ctx.succeeded(); });
    g.onRequest('move', async (_a, ctx) => { served.push(`a-only:${ctx.entity.entityUuid}`); return ctx.succeeded(); }, { imr: IMR_A });
    const sender = await requester(broker);
    await flush();
    await (await sender.sendRequest({ destination: IMR_A, details: [move(target)] })).completion();
    await (await sender.sendRequest({ destination: IMR_B, details: [move(target)] })).completion();
    expect(served).toEqual([`a-only:${IMR_A}`, `fleet:${IMR_B}`]);
  });

  it('dispatches empty-destination requests through the callback (ND-12)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    await g.registerImr({ id: IMR_B, manufacturerName: 'Acme', accepts: ['move'] });
    const served: string[] = [];
    g.onRequest('move', async (_a, ctx) => { served.push(ctx.entity.entityUuid); return ctx.succeeded(); });
    g.onDispatch((_req, imrs) => imrs[1]!.entityUuid);
    const sender = await requester(broker);
    await flush();
    const req = await sender.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target)],
    });
    await req.completion();
    expect(served).toEqual([IMR_B]);
  });

  it('rejects empty-destination requests when no callback is registered (ND-12)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    g.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const sender = await requester(broker);
    await flush();
    const req = await sender.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target)],
    });
    await expect(req.completion()).rejects.toThrow();
    // ND-10: the sender's retained-request auto-clear lands after the terminal status; select the status topic explicitly.
    const status = JSON.parse(
      broker.messagesUnder(`/ISO_21423/v1/IMRFM/${FLEET}/request/`)
        .filter((m) => m.topic.endsWith('/status') && m.payload.length > 0).at(-1)!.payload.toString(),
    ) as { status: string; detailStatuses: Array<{ status: { reason?: string } }> };
    expect(status.status).toBe('ABORTED');
    expect(status.detailStatuses[0]!.status.reason).toBe('REJECTED');
  });

  it('cancels a dispatched (ND-12) request in the target robot\'s executor (controller ruling)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    let aborted = false;
    g.onRequest('move', async (_a, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
      aborted = true;
      return ctx.aborted('OK', 'canceled by request');
    });
    g.onDispatch((_req, imrs) => imrs[0]!.entityUuid);
    const sender = await requester(broker);
    await flush();
    const req = await sender.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target)],
    });
    await flush();
    await req.cancel();
    await expect(req.completion()).rejects.toThrow(/CANCELED/);
    expect(aborted).toBe(true);
    // The request arrived (and its status lives) on the IMRFM's own topic — ND-12 dispatch never
    // retargets the wire topic, only which executor actually runs it. Filter by this request's
    // own uuid: the cancelRequest is a second, concurrently-settling request on the same topic
    // prefix and must not be mistaken for the original's status stream.
    const statuses = broker.messagesOn(`/ISO_21423/v1/IMRFM/${FLEET}/request/${req.requestUuid}/status`)
      .map((m) => JSON.parse(m.payload.toString()) as { status: string });
    expect(statuses.at(-1)!.status).toBe('CANCELED');
  });

  it('the janitor clears a retained request a crashed sender left behind (ND-10)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker, { janitor: { graceMs: 5 } });
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    g.onRequest('move', async (_a, ctx) => ctx.succeeded());

    // A "crashed" sender: publishes the retained request itself and never cleans it up.
    const rogue = broker.createTransport();
    await rogue.connect({ clientId: 'rogue', cleanSession: false, keepalive: 60 });
    const requestUuid = 'aa53a1e1-782f-479b-88b3-fd110198be45';
    const topic = ns('IMR', IMR_A, `request/${requestUuid}`);
    await rogue.publish(topic, JSON.stringify({
      destination: IMR_A, source: SRC, sequenceId: 9, timestamp: nowTimestamp(),
      details: [move(target)],
    }), { qos: 2, retain: true });
    await flush();
    expect(broker.retainedOn(topic)).toBeDefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(broker.retainedOn(topic)).toBeUndefined();
  });

  it('fails startup when the broker silently drops the identity publish (ND-15 self-check)', async () => {
    const broker = new MemoryBroker();
    broker.denySubscribe(ns('IMRFM', FLEET, 'identity'));
    await expect(gateway(broker, { security: { selfCheck: true, selfCheckTimeoutMs: 20 } }))
      .rejects.toThrow(AuthorizationDenied);
  });

  it('unregisterImr drops the manages link and clears the robot topics', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    await g.registerImr({ id: IMR_B, manufacturerName: 'Acme', accepts: ['move'] });
    await g.unregisterImr(IMR_B);
    expect(g.imrs().map((h) => h.entityUuid)).toEqual([IMR_A]);
    expect(broker.retainedOn(ns('IMR', IMR_B, 'identity'))).toBeUndefined();
    const fleetIdentity = JSON.parse(broker.retainedOn(ns('IMRFM', FLEET, 'identity'))!.toString()) as {
      capabilities: { manages: string[] };
    };
    expect(fleetIdentity.capabilities.manages).toEqual([IMR_A]);
  });

  it('exposes the underlying client for policies and direct core use (P-2)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    const a = await g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] });
    g.client.setDefaultExecutionPolicy(policies.parallel());
    a.setExecutionPolicy(policies.queueAfter());
    expect(g.imrfm.entityType).toBe('IMRFM');
    expect(typeof g.client.health).toBe('function');
  });

  it('registerImr rolls back when the broker silently drops the robot identity publish (ND-15 self-check)', async () => {
    const broker = new MemoryBroker();
    const g = await gateway(broker);
    broker.denySubscribe(ns('IMR', IMR_A, 'identity'));
    await expect(g.registerImr({ id: IMR_A, manufacturerName: 'Acme', accepts: ['move'] }))
      .rejects.toThrow(AuthorizationDenied);
    expect(g.imrs().map((h) => h.entityUuid)).not.toContain(IMR_A);
    // Rollback also has to drop it from the client's own bookkeeping (ND-18) — otherwise
    // listManagedEntities()/health() keep reporting a robot that was never actually registered.
    expect(g.client.listManagedEntities(FLEET).map((h) => h.entityUuid)).not.toContain(IMR_A);
    expect(g.client.health().entities.managed).not.toContain(IMR_A);
  });
});
