// test/integration/managedEntities.test.ts — the managed-entity / FleetGateway pattern.
import { describe, it, expect } from 'vitest';
import { move } from '../../src/index.js';
import { deployment, flush, statusSequence, target } from './harness.js';

const FLEET = '5a35c6c1-6b60-4c2e-9f2c-4c1a7f7a9a11';
const ROBOT_A = '91403a21-7534-4467-99a6-79c46a130fe8';
const ROBOT_B = '11111111-1111-4111-8111-111111111111';
const SENDER = '42177726-26f7-4f5c-b735-a12a427bb96d';

describe('publishing through a managed handle', () => {
  it('lands under the robot namespace, never under the IMRFM namespace', async () => {
    const d = deployment();
    const g = await d.gateway({ id: FLEET, manufacturerName: 'Acme Fleet' });
    const robot = await g.registerImr({ id: ROBOT_A, manufacturerName: 'Acme', accepts: ['move'] });
    await robot.publishBatteryStatus({ batterySoc: 0.8 });
    expect(d.broker.retainedOn(`/ISO_21423/v1/IMR/${ROBOT_A}/batteryStatus`)).toBeDefined();
    expect(d.broker.retainedOn(`/ISO_21423/v1/IMRFM/${FLEET}/batteryStatus`)).toBeUndefined();
  });
});

describe('manages/managedBy link correctness', () => {
  it('links appear on both retained identities and survive an unrelated unregisterImr', async () => {
    const d = deployment();
    const g = await d.gateway({ id: FLEET, manufacturerName: 'Acme Fleet' });
    await g.registerImr({ id: ROBOT_A, manufacturerName: 'Acme', accepts: ['move'] });
    await g.registerImr({ id: ROBOT_B, manufacturerName: 'Acme', accepts: ['move'] });

    const fleetIdentity = () => JSON.parse(
      d.broker.retainedOn(`/ISO_21423/v1/IMRFM/${FLEET}/identity`)!.toString(),
    ) as { capabilities: { manages: string[] } };
    const robotAIdentity = () => JSON.parse(
      d.broker.retainedOn(`/ISO_21423/v1/IMR/${ROBOT_A}/identity`)!.toString(),
    ) as { capabilities: { managedBy: string } };

    expect(fleetIdentity().capabilities.manages).toEqual([ROBOT_A, ROBOT_B]);
    expect(robotAIdentity().capabilities.managedBy).toBe(FLEET);

    await g.unregisterImr(ROBOT_B);

    // ROBOT_A's link survives the unrelated unregistration of ROBOT_B.
    expect(fleetIdentity().capabilities.manages).toEqual([ROBOT_A]);
    expect(robotAIdentity().capabilities.managedBy).toBe(FLEET);
    expect(d.broker.retainedOn(`/ISO_21423/v1/IMR/${ROBOT_B}/identity`)).toBeUndefined();
  });
});

describe('direct-to-robot and via-IMRFM routing', () => {
  it('both execute, each publishing status on the topic the request arrived on', async () => {
    const d = deployment();
    const g = await d.gateway({ id: FLEET, manufacturerName: 'Acme Fleet', accepts: ['move'] });
    await g.registerImr({ id: ROBOT_A, manufacturerName: 'Acme', accepts: ['move'] });
    const served: string[] = [];
    // Fleet-wide handler: replayed onto every managed robot AND onto the IMRFM's own handle, so
    // an explicit request addressed straight to the IMRFM entity is itself servable (ND-11 R6).
    g.onRequest('move', async (_a, ctx) => { served.push(ctx.entity.entityUuid); return ctx.succeeded(); });

    const senderClient = await d.client();
    const sender = await senderClient.registerSelfEntity({
      entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
    });
    await flush();

    const toRobot = await sender.sendRequest({
      destination: ROBOT_A, destinationType: 'IMR', details: [move(target(1))],
    });
    await toRobot.completion();
    expect(served).toContain(ROBOT_A);
    expect(statusSequence(d.broker, 'IMR', ROBOT_A, toRobot.requestUuid).at(-1)).toBe('SUCCEEDED');

    const toFleet = await sender.sendRequest({
      destination: FLEET, destinationType: 'IMRFM', details: [move(target(2))],
    });
    await toFleet.completion();
    expect(served).toContain(FLEET);
    expect(statusSequence(d.broker, 'IMRFM', FLEET, toFleet.requestUuid).at(-1)).toBe('SUCCEEDED');
  });
});

describe('empty-destination dispatch (ND-12)', () => {
  it('a registered callback selects a robot', async () => {
    const d = deployment();
    const g = await d.gateway({ id: FLEET, manufacturerName: 'Acme Fleet' });
    await g.registerImr({ id: ROBOT_A, manufacturerName: 'Acme', accepts: ['move'] });
    await g.registerImr({ id: ROBOT_B, manufacturerName: 'Acme', accepts: ['move'] });
    const served: string[] = [];
    g.onRequest('move', async (_a, ctx) => { served.push(ctx.entity.entityUuid); return ctx.succeeded(); });
    g.onDispatch((_req, imrs) => imrs[1]!.entityUuid);

    const senderClient = await d.client();
    const sender = await senderClient.registerSelfEntity({
      entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
    });
    await flush();
    const req = await sender.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target())],
    });
    await req.completion();
    expect(served).toEqual([ROBOT_B]);
  });

  it('with no callback registered, the request is ABORTED + REJECTED', async () => {
    const d = deployment();
    const g = await d.gateway({ id: FLEET, manufacturerName: 'Acme Fleet' });
    await g.registerImr({ id: ROBOT_A, manufacturerName: 'Acme', accepts: ['move'] });
    g.onRequest('move', async (_a, ctx) => ctx.succeeded());

    const senderClient = await d.client();
    const sender = await senderClient.registerSelfEntity({
      entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
    });
    await flush();
    const req = await sender.sendRequest({
      destination: '', destinationType: 'IMRFM', requireCapability: false, details: [move(target())],
    });
    await expect(req.completion()).rejects.toThrow();
    // ND-10: the sender's retained-request auto-clear lands after the terminal status; select the
    // status topic explicitly rather than scanning the whole request namespace.
    const status = JSON.parse(
      d.broker.messagesUnder(`/ISO_21423/v1/IMRFM/${FLEET}/request/`)
        .filter((m) => m.topic.endsWith('/status') && m.payload.length > 0).at(-1)!.payload.toString(),
    ) as { status: string; detailStatuses: Array<{ status: { reason?: string } }> };
    expect(status.status).toBe('ABORTED');
    expect(status.detailStatuses[0]!.status.reason).toBe('REJECTED');
  });
});
