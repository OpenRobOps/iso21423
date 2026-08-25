// test/integration/observerSurface.test.ts
import { describe, it, expect } from 'vitest';
import {
  EntityFilter, RequestFilter, RequestStatusFilter, move,
} from '../../src/index.js';
import { deployment, flush, target } from './harness.js';

const ROBOT = '91403a21-7534-4467-99a6-79c46a130fe8';
const SENDER = '42177726-26f7-4f5c-b735-a12a427bb96d';
const FLEET = '5a35c6c1-6b60-4c2e-9f2c-4c1a7f7a9a11';

describe('EntityFilter builders compile to the expected wire subscriptions', () => {
  it('all/ofType/entity/anyOf produce exactly the expected MQTT filters', async () => {
    const d = deployment();
    const c = await d.client();
    await c.subscribeResource('status', EntityFilter.all(), () => {});
    await c.subscribeResource('status', EntityFilter.ofType('IMR'), () => {});
    await c.subscribeResource('status', EntityFilter.entity(ROBOT), () => {});
    await c.subscribeResource('status', EntityFilter.anyOf([ROBOT, EntityFilter.entity(SENDER)]), () => {});

    const filters = d.broker.subscriptions().map((s) => s.filter);
    expect(filters).toContain('/ISO_21423/v1/+/+/status');
    expect(filters).toContain('/ISO_21423/v1/IMR/+/status');
    expect(filters).toContain(`/ISO_21423/v1/+/${ROBOT}/status`);
    expect(filters).toContain(`/ISO_21423/v1/+/${SENDER}/status`);
  });
});

describe('lazy subscribe/unsubscribe (ND-17)', () => {
  it('two subscriptions on the same filter share one broker SUBSCRIBE', async () => {
    const d = deployment();
    const c = await d.client();
    const filter = '/ISO_21423/v1/IMR/+/status';
    const count = () => d.broker.subscriptions().filter((s) => s.filter === filter).length;

    const sub1 = await c.subscribeResource('status', EntityFilter.ofType('IMR'), () => {});
    const sub2 = await c.subscribeResource('status', EntityFilter.ofType('IMR'), () => {});
    expect(count()).toBe(1);

    await sub1.unsubscribe();
    expect(count()).toBe(1);        // sub2 still holds the broker subscription open

    await sub2.unsubscribe();
    expect(count()).toBe(0);
  });
});

describe('await using disposes a subscription at scope exit (D-19)', () => {
  it('the broker subscription is gone once the block exits', async () => {
    const d = deployment();
    const c = await d.client();
    const filter = '/ISO_21423/v1/+/+/status';
    let wasActive: boolean | undefined;
    {
      await using sub = await c.subscribeResource('status', EntityFilter.all(), () => {});
      wasActive = sub.active;
      expect(d.broker.subscriptions().some((s) => s.filter === filter)).toBe(true);
    }
    expect(wasActive).toBe(true);
    expect(d.broker.subscriptions().some((s) => s.filter === filter)).toBe(false);
  });
});

describe('discover() — retained-identity catalog (D-18)', () => {
  it('builds the catalog, including the manages graph, from retained identities only', async () => {
    const d = deployment();
    const g = await d.gateway({ id: FLEET, manufacturerName: 'Acme Fleet' });
    await g.registerImr({ id: ROBOT, manufacturerName: 'Acme', accepts: ['move'] });
    const observer = await d.client();
    const catalog = observer.discover();
    await flush();
    expect(catalog.entities().map((e) => e.entityUuid).sort()).toEqual([ROBOT, FLEET].sort());
    expect(catalog.get(ROBOT)!.managedBy).toBe(FLEET);
    expect(catalog.managedBy(FLEET).map((e) => e.entityUuid)).toEqual([ROBOT]);
  });

  it('a late-joining entity appears without resubscribing', async () => {
    const d = deployment();
    const observer = await d.client();
    const catalog = observer.discover();
    await flush();
    expect(catalog.get(ROBOT)).toBeUndefined();

    const robotClient = await d.client();
    await robotClient.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    });
    await flush();
    expect(catalog.get(ROBOT)).toBeDefined();
  });

  it('lost flips on the retained LWT and clears once the transport reconnects', async () => {
    const d = deployment();
    const transport = d.broker.createTransport();
    const robotClient = await d.client({ transport });
    await robotClient.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    });
    const observer = await d.client();
    const catalog = observer.discover();
    const lost: string[] = [];
    catalog.on('lost', (e) => lost.push(e.entityUuid));
    await flush();

    transport.dropConnection();
    await flush();
    expect(lost).toEqual([ROBOT]);

    // The fired LWT is stale once the transport auto-reconnects; the session clears its own
    // disconnection topic on reconnect, so the catalog un-marks it.
    await flush();
    expect(catalog.get(ROBOT)!.lost).toBe(false);
  });
});

describe('subscribeRequests / subscribeRequestStatus see third-party traffic', () => {
  it('an observer sees requests and statuses addressed to another entity', async () => {
    const d = deployment();
    const robotClient = await d.client();
    const robot = await robotClient.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
      capabilities: { accepts: ['move'] },
    });
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const senderClient = await d.client();
    const sender = await senderClient.registerSelfEntity({
      entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
    });
    await flush();

    const observerClient = await d.client();
    const seenRequests: string[] = [];
    const seenStatuses: string[] = [];
    await observerClient.subscribeRequests(RequestFilter.all(), (ev) => seenRequests.push(ev.entityUuid));
    await observerClient.subscribeRequestStatus(
      RequestStatusFilter.all(), (ev) => seenStatuses.push(ev.message.status));
    await flush();

    const req = await sender.sendRequest({ destination: ROBOT, details: [move(target())] });
    await req.completion();
    await flush();

    expect(seenRequests).toContain(ROBOT);
    expect(seenStatuses).toContain('SUCCEEDED');
  });
});
