import { describe, it, expect } from 'vitest';
import { Iso21423Client, EntityFilter, Iso21423Error } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const IMR_UUID = '91403a21-7534-4467-99a6-79c46a130fe8';
const FLEET_UUID = '42177726-26f7-4f5c-b735-a12a427bb96d';
const ns = (t: string, u: string, r: string) => `/ISO_21423/v1/${t}/${u}/${r}`;
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

const registration = {
  entityUuid: IMR_UUID,
  entityType: 'IMR',
  manufacturerName: 'Acme Robotics',
  details: { imrModel: 'AR-2', imrSerialNumber: 'SN-0042' },
  capabilities: { provides: ['status', 'odometry'], accepts: ['move', 'cancelRequest'] },
};

async function client(broker: MemoryBroker) {
  return Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
}

describe('registration', () => {
  it('publishes a retained identity with capabilities wrapped per the schema', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    expect(imr.entityUuid).toBe(IMR_UUID);
    expect(imr.ownershipMode).toBe('self');
    const retained = broker.retainedOn(ns('IMR', IMR_UUID, 'identity'));
    const identity = JSON.parse(retained!.toString()) as {
      id: string; entityType: string; capabilities: { accepts: { requests: string[] } };
    };
    expect(identity.id).toBe(IMR_UUID);
    expect(identity.entityType).toBe('IMR');
    expect(identity.capabilities.accepts).toEqual({ requests: ['move', 'cancelRequest'] });
  });

  it('arms the B.4 will for the first registered self entity (P-4, decision 1)', async () => {
    const broker = new MemoryBroker();
    const transport = broker.createTransport();
    const c = await Iso21423Client.connect({ transport, sequenceStore: null });
    await c.registerSelfEntity(registration);
    transport.dropConnection();
    // Checked before any tick: the will fires synchronously inside dropConnection(), and
    // MemoryTransport's auto-reconnect (next setImmediate) would otherwise immediately clear
    // this same topic (the session's own stale-will-clear on reconnect).
    expect(broker.retainedOn(ns('IMR', IMR_UUID, 'disconnection'))?.toString())
      .toBe('{"states":["LOST_CONNECTION"]}');
  });

  it('refuses a self registration after the session opened identity-less', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await c.subscribeEntities(EntityFilter.all(), () => {});
    await expect(c.registerSelfEntity(registration)).rejects.toThrow(/register.*before/i);
  });

  it('links managed entities both ways (D-11)', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await c.registerSelfEntity({
      entityUuid: FLEET_UUID, entityType: 'IMRFM', manufacturerName: 'Acme Fleet',
    });
    const imr = await c.registerManagedEntity(FLEET_UUID, registration);
    expect(imr.ownershipMode).toBe('managed');
    const managed = JSON.parse(broker.retainedOn(ns('IMR', IMR_UUID, 'identity'))!.toString()) as {
      capabilities: { managedBy?: string };
    };
    const manager = JSON.parse(broker.retainedOn(ns('IMRFM', FLEET_UUID, 'identity'))!.toString()) as {
      capabilities: { manages?: string[] };
    };
    expect(managed.capabilities.managedBy).toBe(FLEET_UUID);
    expect(manager.capabilities.manages).toEqual([IMR_UUID]);
    expect(c.listManagedEntities(FLEET_UUID).map((h) => h.entityUuid)).toEqual([IMR_UUID]);
  });

  it('rejects a managed entity whose manager is not a registered self entity', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await expect(c.registerManagedEntity(FLEET_UUID, registration)).rejects.toThrow(Iso21423Error);
  });
});

describe('resource publication', () => {
  it('fills entityId/timestamp and applies Table B.1 qos/retain', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    await imr.publishStatus({ states: ['MODE_AUTO', 'IDLE'] });
    const [msg] = broker.messagesOn(ns('IMR', IMR_UUID, 'status'));
    const body = JSON.parse(msg!.payload.toString()) as { entityId: string; timestamp: string };
    expect(msg!.qos).toBe(1);
    expect(msg!.retain).toBe(true);
    expect(body.entityId).toBe(IMR_UUID);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('maps localTrajectory points onto the schema field name', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    await imr.publishLocalTrajectory({
      points: [{
        timestamp: '2025-04-08T12:34:56.789Z',
        locationPoint: { ccsId: FLEET_UUID, x: 1, y: 2, z: 0 },
      }],
    });
    const [msg] = broker.messagesOn(ns('IMR', IMR_UUID, 'localTrajectory'));
    expect(Object.keys(JSON.parse(msg!.payload.toString()) as object)).toEqual(
      ['timestamp', 'localTrajectory']);
  });

  it('updateIdentity republishes the merged retained identity', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    await imr.updateIdentity({ manufacturerName: 'Acme Robotics GmbH' });
    const identity = JSON.parse(broker.retainedOn(ns('IMR', IMR_UUID, 'identity'))!.toString()) as {
      manufacturerName: string; capabilities: { accepts: { requests: string[] } };
    };
    expect(identity.manufacturerName).toBe('Acme Robotics GmbH');
    expect(identity.capabilities.accepts.requests).toEqual(['move', 'cancelRequest']);
  });

  it('unregister publishes a final OFFLINE status and clears the other retained topics', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    const imr = await c.registerSelfEntity(registration);
    await imr.publishBatteryStatus({ batterySoc: 0.5 });
    await imr.unregister();
    const status = JSON.parse(broker.retainedOn(ns('IMR', IMR_UUID, 'status'))!.toString()) as {
      states: string[];
    };
    expect(status.states).toEqual(['OFFLINE']);
    expect(broker.retainedOn(ns('IMR', IMR_UUID, 'identity'))).toBeUndefined();
    expect(broker.retainedOn(ns('IMR', IMR_UUID, 'batteryStatus'))).toBeUndefined();
  });
});

describe('observation', () => {
  it('subscribeResource compiles the filter and delivers typed events', async () => {
    const broker = new MemoryBroker();
    const producer = await client(broker);
    const imr = await producer.registerSelfEntity(registration);
    const observer = await client(broker);
    const seen: Array<{ entityUuid: string; states: string[] }> = [];
    const sub = await observer.subscribeResource('status', EntityFilter.ofType('IMR'),
      (ev) => seen.push({ entityUuid: ev.entityUuid, states: (ev.message as { states: string[] }).states }));
    expect(sub.topicFilters).toEqual(['/ISO_21423/v1/IMR/+/status']);
    await imr.publishStatus({ states: ['MODE_AUTO', 'CHARGING'] });
    await flush();
    expect(seen).toEqual([{ entityUuid: IMR_UUID, states: ['MODE_AUTO', 'CHARGING'] }]);
    await sub.unsubscribe();
    expect(sub.active).toBe(false);
  });

  it('subscribeEntities replays retained identities to a late observer (D-18)', async () => {
    const broker = new MemoryBroker();
    const producer = await client(broker);
    await producer.registerSelfEntity(registration);
    const observer = await client(broker);
    const ids: string[] = [];
    await observer.subscribeEntities(EntityFilter.all(), (id) => ids.push(id.id));
    await flush();
    expect(ids).toEqual([IMR_UUID]);
  });

  it('health() reports connection, entities and counters (ND-18)', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await c.registerSelfEntity(registration);
    const h = c.health();
    expect(h.connection).toBe('connected');
    expect(h.entities.self).toEqual([IMR_UUID]);
    expect(h.counters.published).toBeGreaterThan(0);
  });

  it('close() unsubscribes tracked subscriptions and zeroes health().subscriptions', async () => {
    const broker = new MemoryBroker();
    const c = await client(broker);
    await c.registerSelfEntity(registration);
    await c.subscribeResource('status', EntityFilter.ofType('IMR'), () => {});
    expect(c.health().subscriptions).toBeGreaterThan(0);
    await c.close();
    expect(c.health().subscriptions).toBe(0);
  });
});
