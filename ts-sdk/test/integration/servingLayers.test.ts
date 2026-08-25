// test/integration/servingLayers.test.ts — ND-11: both serving layers on one handle.
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  IllegalTransition, RequestAcceptanceFilter, move, nowTimestamp, pauseImr,
} from '../../src/index.js';
import { deployment, flush, lastStatus, statusSequence, target } from './harness.js';

const ROBOT = '91403a21-7534-4467-99a6-79c46a130fe8';
const SENDER = '42177726-26f7-4f5c-b735-a12a427bb96d';

async function scene() {
  const d = deployment();
  const robotClient = await d.client();
  const robot = await robotClient.registerSelfEntity({
    entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move', 'pauseImr'] },
  });
  const senderClient = await d.client();
  const sender = await senderClient.registerSelfEntity({
    entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
  await flush();
  return { ...d, robot, sender };
}

describe('per-action layer and acceptRequests on the same handle', () => {
  it('routes a low-level-filter match to acceptRequests and everything else to the executor', async () => {
    const { robot, sender } = await scene();
    const seenByAcceptRequests: string[] = [];
    const seenByExecutor: string[] = [];
    await robot.acceptRequests(RequestAcceptanceFilter.actions(['pauseImr']), async (req) => {
      seenByAcceptRequests.push(req.request.details[0]!.type);
      await req.accept();
      await req.updateStatus({ status: 'EXECUTING' });
      await req.complete({ status: 'SUCCEEDED' });
    });
    robot.onRequest('move', async (_a, ctx) => { seenByExecutor.push('move'); return ctx.succeeded(); });

    const viaAcceptRequests = await sender.sendRequest({ destination: ROBOT, details: [pauseImr()] });
    const viaExecutor = await sender.sendRequest({ destination: ROBOT, details: [move(target())] });

    expect((await viaAcceptRequests.completion()).status).toBe('SUCCEEDED');
    expect((await viaExecutor.completion()).status).toBe('SUCCEEDED');
    expect(seenByAcceptRequests).toEqual(['pauseImr']);
    expect(seenByExecutor).toEqual(['move']);
  });
});

describe('IncomingRequest driving a full lifecycle by hand', () => {
  it('matches the exact wire sequence: accept → EXECUTING → detail update → SUCCEEDED', async () => {
    const { broker, robot, sender } = await scene();
    await robot.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      await req.accept();
      await req.updateStatus({ status: 'EXECUTING' });
      await req.updateDetailStatus({ index: 0, status: 'EXECUTING', properties: { pct: 50 } });
      await req.complete({ status: 'SUCCEEDED' });
    });
    const request = await sender.sendRequest({ destination: ROBOT, details: [move(target())] });
    await request.completion();
    expect(statusSequence(broker, 'IMR', ROBOT, request.requestUuid))
      .toEqual(['RECEIVED', 'ACCEPTED', 'EXECUTING', 'EXECUTING', 'SUCCEEDED']);
  });
});

describe('illegal transition', () => {
  it('complete(SUCCEEDED) straight from RECEIVED throws and publishes nothing beyond RECEIVED', async () => {
    const { broker, robot, sender } = await scene();
    let caught: unknown;
    await robot.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      try {
        await req.complete({ status: 'SUCCEEDED' });
      } catch (e) {
        caught = e;
      }
    });
    const request = await sender.sendRequest({ destination: ROBOT, details: [move(target())] });
    await flush();
    expect(caught).toBeInstanceOf(IllegalTransition);
    expect(statusSequence(broker, 'IMR', ROBOT, request.requestUuid)).toEqual(['RECEIVED']);
  });
});

describe('RECEIVED is on the wire before any handler runs (D-12)', () => {
  it('is visible from inside the handler itself', async () => {
    const { broker, robot, sender } = await scene();
    let seenInsideHandler: string[] = [];
    await robot.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      seenInsideHandler = statusSequence(broker, 'IMR', ROBOT, req.requestUuid);
      await req.accept();
      await req.updateStatus({ status: 'EXECUTING' });
      await req.complete({ status: 'SUCCEEDED' });
    });
    const request = await sender.sendRequest({ destination: ROBOT, details: [move(target())] });
    await request.completion();
    expect(seenInsideHandler).toEqual(['RECEIVED']);
  });
});

describe('schema-invalid inbound (D-13)', () => {
  it('never reaches acceptRequests or onRequest, and is auto-rejected', async () => {
    const { broker, robot, sender } = await scene();
    const acceptRequestsCalls: unknown[] = [];
    const executorCalls: unknown[] = [];
    await robot.acceptRequests(RequestAcceptanceFilter.all(), (req) => acceptRequestsCalls.push(req));
    robot.onRequest('move', async (_a, ctx) => { executorCalls.push(1); return ctx.succeeded(); });
    await flush();

    const requestUuid = randomUUID();
    const injector = broker.createTransport();
    await injector.connect({ clientId: 'injector', cleanSession: false, keepalive: 60 });
    await injector.publish(
      `/ISO_21423/v1/IMR/${ROBOT}/request/${requestUuid}`,
      JSON.stringify({
        destination: ROBOT, source: sender.entityUuid, sequenceId: 4242,
        timestamp: nowTimestamp(), details: 'not-an-array',
      }),
      { qos: 2, retain: true },
    );
    await flush();

    expect(acceptRequestsCalls).toEqual([]);
    expect(executorCalls).toEqual([]);
    const final = lastStatus(broker, 'IMR', ROBOT, requestUuid);
    expect(final.status).toBe('ABORTED');
    expect(final.detailStatuses[0]!.status.reason).toBe('MALFORMED_REQUEST');
  });
});
