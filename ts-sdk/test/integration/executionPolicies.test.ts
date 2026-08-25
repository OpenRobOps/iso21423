// test/integration/executionPolicies.test.ts — D-17, P-2: two senders interleaving requests
// against one robot, under each C.2.2 preset.
import { describe, it, expect } from 'vitest';
import { move, policies } from '../../src/index.js';
import type { EntityHandle, ExecutionPolicy } from '../../src/index.js';
import { deployment, flush, lastStatus, statusSequence, target } from './harness.js';

const ROBOT = '91403a21-7534-4467-99a6-79c46a130fe8';
const ROBOT_B = '22222222-2222-4222-8222-222222222222';
const SENDER_A = '42177726-26f7-4f5c-b735-a12a427bb96d';
const SENDER_B = '11111111-1111-4111-8111-111111111111';

async function scene(policy?: ExecutionPolicy) {
  const d = deployment();
  const robotClient = await d.client();
  const robot = await robotClient.registerSelfEntity({
    entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move'] }, executionPolicy: policy,
  });
  const aClient = await d.client();
  const a = await aClient.registerSelfEntity({
    entityUuid: SENDER_A, entityType: 'TrafficController', manufacturerName: 'Acme Traffic A',
  });
  const bClient = await d.client();
  const b = await bClient.registerSelfEntity({
    entityUuid: SENDER_B, entityType: 'TrafficController', manufacturerName: 'Acme Traffic B',
  });
  await flush();
  return { ...d, robot, a, b };
}

/** A move handler that blocks on a released promise per invocation (one release per call, in
 *  call order); `order` records start/end labelled by the request's source. */
function setupGatedHandler(robot: EntityHandle, order: string[]): Array<() => void> {
  const releases: Array<() => void> = [];
  robot.onRequest('move', async (_a, ctx) => {
    order.push(`start:${ctx.request.source}`);
    await new Promise<void>((resolve) => releases.push(resolve));
    order.push(`end:${ctx.request.source}`);
    return ctx.succeeded();
  });
  return releases;
}

describe('abortNew()', () => {
  it('rejects a concurrent second request while the first executes', async () => {
    const { broker, robot, a, b } = await scene(policies.abortNew());
    const order: string[] = [];
    const releases = setupGatedHandler(robot, order);

    const req1 = await a.sendRequest({ destination: ROBOT, details: [move(target())] });
    await flush();
    const req2 = await b.sendRequest({ destination: ROBOT, details: [move(target())] });
    await flush();

    expect(lastStatus(broker, 'IMR', ROBOT, req2.requestUuid).status).toBe('ABORTED');
    expect(lastStatus(broker, 'IMR', ROBOT, req2.requestUuid).detailStatuses[0]!.status.reason)
      .toBe('REJECTED');
    await expect(req2.completion()).rejects.toThrow();

    releases[0]!();
    const s1 = await req1.completion();
    expect(s1.status).toBe('SUCCEEDED');
  });
});

describe('queueAfter()', () => {
  it('buffers the second request until the first succeeds, then runs it', async () => {
    const { broker, robot, a, b } = await scene(policies.queueAfter());
    const order: string[] = [];
    const releases = setupGatedHandler(robot, order);

    const req1 = await a.sendRequest({ destination: ROBOT, details: [move(target())] });
    await flush();
    const req2 = await b.sendRequest({ destination: ROBOT, details: [move(target())] });
    await flush();

    // Buffering is an admission decision, not a protocol stall: RECEIVED is on the wire (D-12),
    // but no ACCEPTED until the first request has settled.
    expect(statusSequence(broker, 'IMR', ROBOT, req2.requestUuid)).toEqual(['RECEIVED']);
    expect(order).toEqual([`start:${SENDER_A}`]);

    releases[0]!();
    await req1.completion();
    await flush();
    expect(order).toEqual([`start:${SENDER_A}`, `end:${SENDER_A}`, `start:${SENDER_B}`]);

    releases[1]!();
    const s2 = await req2.completion();
    expect(s2.status).toBe('SUCCEEDED');
    expect(order).toEqual([
      `start:${SENDER_A}`, `end:${SENDER_A}`, `start:${SENDER_B}`, `end:${SENDER_B}`,
    ]);
  });
});

describe('queueReplace()', () => {
  it('displaces the queued (middle) request with ABORTED/REJECTED; the third runs after the first', async () => {
    const { broker, robot, a, b } = await scene(policies.queueReplace());
    const order: string[] = [];
    const releases = setupGatedHandler(robot, order);

    const req1 = await a.sendRequest({ destination: ROBOT, details: [move(target(1))] });
    await flush();
    const req2 = await b.sendRequest({ destination: ROBOT, details: [move(target(2))] });   // takes the buffer slot
    await flush();
    const req3 = await a.sendRequest({ destination: ROBOT, details: [move(target(3))] });   // displaces req2
    await flush();

    expect(lastStatus(broker, 'IMR', ROBOT, req2.requestUuid).status).toBe('ABORTED');
    expect(lastStatus(broker, 'IMR', ROBOT, req2.requestUuid).detailStatuses[0]!.status.reason)
      .toBe('REJECTED');
    await expect(req2.completion()).rejects.toThrow();

    releases[0]!();
    expect((await req1.completion()).status).toBe('SUCCEEDED');
    await flush();
    releases[1]!();
    expect((await req3.completion()).status).toBe('SUCCEEDED');
    expect(order).toEqual([
      `start:${SENDER_A}`, `end:${SENDER_A}`, `start:${SENDER_A}`, `end:${SENDER_A}`,
    ]);
  });
});

describe('parallel(2)', () => {
  it('runs two requests concurrently and buffers the third', async () => {
    const { broker, robot, a, b } = await scene(policies.parallel(2));
    const order: string[] = [];
    const releases = setupGatedHandler(robot, order);

    const req1 = await a.sendRequest({ destination: ROBOT, details: [move(target(1))] });
    await flush();
    const req2 = await b.sendRequest({ destination: ROBOT, details: [move(target(2))] });
    await flush();
    const req3 = await a.sendRequest({ destination: ROBOT, details: [move(target(3))] });
    await flush();

    // Both admitted requests reach EXECUTING before either finishes.
    expect(statusSequence(broker, 'IMR', ROBOT, req1.requestUuid)).toContain('EXECUTING');
    expect(statusSequence(broker, 'IMR', ROBOT, req2.requestUuid)).toContain('EXECUTING');
    expect(statusSequence(broker, 'IMR', ROBOT, req3.requestUuid)).toEqual(['RECEIVED']);
    expect(order.filter((o) => o.startsWith('start'))).toHaveLength(2);

    releases[0]!(); releases[1]!();
    expect((await req1.completion()).status).toBe('SUCCEEDED');
    expect((await req2.completion()).status).toBe('SUCCEEDED');
    await flush();
    releases[2]!();
    expect((await req3.completion()).status).toBe('SUCCEEDED');
  });
});

describe('priority()', () => {
  it('a priority:10 request preempts an executing priority:100 one, then runs', async () => {
    const { broker, robot, a, b } = await scene(policies.priority());
    let sawAbort = false;
    robot.onRequest('move', async (_a, ctx) => {
      if (ctx.request.priority === 100) {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
        sawAbort = true;
        return ctx.aborted('OK', 'preempted');
      }
      return ctx.succeeded();
    });

    const low = await a.sendRequest({ destination: ROBOT, priority: 100, details: [move(target(1))] });
    await flush();
    expect(statusSequence(broker, 'IMR', ROBOT, low.requestUuid)).toContain('EXECUTING');

    const high = await b.sendRequest({ destination: ROBOT, priority: 10, details: [move(target(2))] });
    await expect(low.completion()).rejects.toThrow();
    expect(lastStatus(broker, 'IMR', ROBOT, low.requestUuid).status).toBe('CANCELED');
    expect(sawAbort).toBe(true);

    const s2 = await high.completion();
    expect(s2.status).toBe('SUCCEEDED');
  });
});

describe('client default vs per-handle override (P-2)', () => {
  it('a per-handle override wins over the client-wide default', async () => {
    const d = deployment();
    const client = await d.client();
    client.setDefaultExecutionPolicy(policies.abortNew());
    const handleA = await client.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme A', capabilities: { accepts: ['move'] },
    });
    const handleB = await client.registerManagedEntity(ROBOT, {
      entityUuid: ROBOT_B, entityType: 'IMR', manufacturerName: 'Acme B', capabilities: { accepts: ['move'] },
    });
    handleB.setExecutionPolicy(policies.parallel());

    const orderA: string[] = [];
    const releasesA = setupGatedHandler(handleA, orderA);
    const orderB: string[] = [];
    const releasesB = setupGatedHandler(handleB, orderB);

    const senderClient = await d.client();
    const sender = await senderClient.registerSelfEntity({
      entityUuid: SENDER_A, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
    });
    await flush();

    const a1 = await sender.sendRequest({ destination: ROBOT, details: [move(target(1))] });
    await flush();
    const a2 = await sender.sendRequest({ destination: ROBOT, details: [move(target(2))] });
    await flush();
    expect(lastStatus(d.broker, 'IMR', ROBOT, a2.requestUuid).status).toBe('ABORTED');
    await expect(a2.completion()).rejects.toThrow();
    releasesA[0]!();
    expect((await a1.completion()).status).toBe('SUCCEEDED');

    const b1 = await sender.sendRequest({ destination: ROBOT_B, details: [move(target(3))] });
    await flush();
    const b2 = await sender.sendRequest({ destination: ROBOT_B, details: [move(target(4))] });
    await flush();
    // B accepts concurrent requests — both reach EXECUTING, neither is rejected.
    expect(statusSequence(d.broker, 'IMR', ROBOT_B, b1.requestUuid)).toContain('EXECUTING');
    expect(statusSequence(d.broker, 'IMR', ROBOT_B, b2.requestUuid)).toContain('EXECUTING');
    releasesB[0]!(); releasesB[1]!();
    expect((await b1.completion()).status).toBe('SUCCEEDED');
    expect((await b2.completion()).status).toBe('SUCCEEDED');
  });
});
