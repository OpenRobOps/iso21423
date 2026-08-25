// test/integration/requestLifecycles.test.ts
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { RequestTimeout, move, nowTimestamp, pauseImr } from '../../src/index.js';
import { deployment, flush, lastStatus, statusSequence, target } from './harness.js';

const ROBOT = '91403a21-7534-4467-99a6-79c46a130fe8';
const SENDER = '42177726-26f7-4f5c-b735-a12a427bb96d';

async function scene() {
  const d = deployment();
  const robotClient = await d.client();
  const robot = await robotClient.registerSelfEntity({
    entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move', 'pauseImr', 'cancelRequest'] },
  });
  const senderClient = await d.client();
  const sender = await senderClient.registerSelfEntity({
    entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
  await flush();
  return { ...d, robot, sender };
}

describe('multi-detail happy path', () => {
  it('reports every detail SUCCEEDED and resolves completion()', async () => {
    const { broker, robot, sender } = await scene();
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    robot.onRequest('pauseImr', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: ROBOT, details: [move(target()), pauseImr()],
    });
    const final = await req.completion();
    expect(final.status).toBe('SUCCEEDED');
    const seq = statusSequence(broker, 'IMR', ROBOT, req.requestUuid);
    expect(seq[0]).toBe('RECEIVED');
    expect(seq[1]).toBe('ACCEPTED');
    expect(seq.at(-1)).toBe('SUCCEEDED');
    expect(lastStatus(broker, 'IMR', ROBOT, req.requestUuid).detailStatuses.map((d) => d.status.code))
      .toEqual(['SUCCEEDED', 'SUCCEEDED']);
  });
});

describe('cancel mid-execution', () => {
  it('fires the handler AbortSignal and ends CANCELED', async () => {
    const { broker, robot, sender } = await scene();
    let sawAbort = false;
    robot.onRequest('move', async (_a, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
      sawAbort = true;
      return ctx.aborted('OK', 'canceled');
    });
    robot.onRequest('pauseImr', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: ROBOT, details: [move(target()), pauseImr()],
    });
    await flush();
    await req.cancel();
    await expect(req.completion()).rejects.toThrow();
    expect(sawAbort).toBe(true);
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.status).toBe('CANCELED');
    expect(final.detailStatuses[1]!.status.code).toBe('CANCELED');   // never started
  });
});

describe('cancel of an atomic detail', () => {
  it('defers the cancel until the atomic detail finishes, then ends CANCELED', async () => {
    const { broker, robot, sender } = await scene();
    let abortedBeforeHeld: boolean | undefined;
    let abortedAfterHeld: boolean | undefined;
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    robot.onRequest('move', async (_a, ctx) => {
      abortedBeforeHeld = ctx.signal.aborted;
      await held;
      // Sampled again right before returning — the cancel (sent while this was mid-flight) must
      // still not have touched this atomic detail's own signal.
      abortedAfterHeld = ctx.signal.aborted;
      return ctx.succeeded();
    });
    const req = await sender.sendRequest({
      destination: ROBOT, details: [{ ...move(target()), atomic: true }],
    });
    await flush();
    await req.cancel();
    await flush();
    expect(abortedBeforeHeld).toBe(false);
    release();
    await expect(req.completion()).rejects.toThrow();
    expect(abortedAfterHeld).toBe(false);
    // The cancel takes effect only once the atomic detail has finished on its own.
    expect(lastStatus(broker, 'IMR', ROBOT, req.requestUuid).status).toBe('CANCELED');
  });
});

describe('recovery after abort', () => {
  it('runs the recovery and still ends ABORTED (decision 8)', async () => {
    const { broker, robot, sender } = await scene();
    robot.onRequest('move', async (_a, ctx) => ctx.aborted('GENERAL_FAILURE', 'wheel slip'));
    robot.onRequest('pauseImr', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: ROBOT, details: [move(target())], recoveries: [pauseImr()],
    });
    await expect(req.completion()).rejects.toThrow();
    const seq = statusSequence(broker, 'IMR', ROBOT, req.requestUuid);
    expect(seq).toContain('RECOVERY');
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.recoveryStatuses![0]!.status.code).toBe('SUCCEEDED');
    expect(final.status).toBe('ABORTED');
  });
});

describe('failed recovery', () => {
  it('ends ABORTED with the reason from the failed recovery detail', async () => {
    const { broker, robot, sender } = await scene();
    robot.onRequest('move', async (_a, ctx) => ctx.aborted('GENERAL_FAILURE', 'wheel slip'));
    robot.onRequest('pauseImr', async (_a, ctx) => ctx.aborted('TIMEOUT', 'brake stuck'));
    const req = await sender.sendRequest({
      destination: ROBOT, details: [move(target())], recoveries: [pauseImr()],
    });
    await expect(req.completion()).rejects.toThrow();
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.recoveryStatuses![0]!.status.code).toBe('ABORTED');
    expect(final.status).toBe('ABORTED');
    expect(final.detailStatuses[0]!.status.reason).toBe('TIMEOUT');   // the recovery's reason, not move's
  });
});

describe('recovery after cancel', () => {
  it('ends CANCELED with the recoveries reported', async () => {
    const { broker, robot, sender } = await scene();
    robot.onRequest('move', async (_a, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
      return ctx.aborted('OK', 'canceled by request');
    });
    robot.onRequest('pauseImr', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: ROBOT, details: [move(target())], recoveries: [pauseImr()],
    });
    await flush();
    await req.cancel();
    await expect(req.completion()).rejects.toThrow();
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.status).toBe('CANCELED');
    expect(final.recoveryStatuses![0]!.status.code).toBe('SUCCEEDED');
  });
});

describe('blocking vs non-blocking', () => {
  it('runs blocking details serially and consecutive non-blocking details concurrently', async () => {
    const { robot, sender } = await scene();
    const order: string[] = [];
    let release = () => {};
    const blocked = new Promise<void>((r) => { release = r; });
    robot.onRequest('move', async (_a, ctx) => {
      order.push('move-start'); await blocked; order.push('move-end'); return ctx.succeeded();
    });
    robot.onRequest('pauseImr', async (_a, ctx) => { order.push('pause'); return ctx.succeeded(); });
    const req = await sender.sendRequest({
      destination: ROBOT,
      details: [move(target()), { ...pauseImr(), blocking: false }, { ...move(target()), blocking: false }],
    });
    await flush();
    expect(order).toEqual(['move-start']);        // blocking detail holds the sequence
    release();
    await req.completion();
    expect(order).toEqual(['move-start', 'move-end', 'pause', 'move-start', 'move-end']);
  });
});

describe('ACTION_NOT_IMPLEMENTED', () => {
  it('aborts before any handler runs when no handler is registered for the action', async () => {
    const { broker, robot, sender } = await scene();
    // Only "pauseImr" has a handler (so the executor exists at all) — "move" has none.
    let pauseCalled = false;
    robot.onRequest('pauseImr', async (_a, ctx) => { pauseCalled = true; return ctx.succeeded(); });
    const req = await sender.sendRequest({ destination: ROBOT, details: [move(target())] });
    await expect(req.completion()).rejects.toThrow();
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.status).toBe('ABORTED');
    expect(final.detailStatuses[0]!.status.reason).toBe('ACTION_NOT_IMPLEMENTED');
    expect(pauseCalled).toBe(false);
  });
});

describe('MALFORMED_REQUEST', () => {
  it('rejects a schema-invalid request published directly to the wire (D-13)', async () => {
    const { broker, robot, sender } = await scene();
    let handlerCalled = false;
    robot.onRequest('move', async (_a, ctx) => { handlerCalled = true; return ctx.succeeded(); });
    await flush();

    const requestUuid = randomUUID();
    const injector = broker.createTransport();
    await injector.connect({ clientId: 'injector', cleanSession: false, keepalive: 60 });
    await injector.publish(
      `/ISO_21423/v1/IMR/${ROBOT}/request/${requestUuid}`,
      JSON.stringify({
        destination: ROBOT, source: sender.entityUuid, sequenceId: 999,
        timestamp: nowTimestamp(), details: 'not-an-array',
      }),
      { qos: 2, retain: true },
    );
    await flush();

    expect(handlerCalled).toBe(false);
    const final = lastStatus(broker, 'IMR', ROBOT, requestUuid);
    expect(final.status).toBe('ABORTED');
    expect(final.detailStatuses[0]!.status.reason).toBe('MALFORMED_REQUEST');
  });
});

describe('VERSION_NOT_SUPPORTED', () => {
  it('rejects a detail declaring an unsupported protocol version', async () => {
    const { broker, robot, sender } = await scene();
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: ROBOT, details: [{ ...move(target()), version: '2.0' }],
    });
    await expect(req.completion()).rejects.toThrow();
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.status).toBe('ABORTED');
    expect(final.detailStatuses[0]!.status.reason).toBe('VERSION_NOT_SUPPORTED');
  });
});

describe('FORMAT_NOT_SUPPORTED', () => {
  it('rejects a detail declaring an unsupported vendor format', async () => {
    const { broker, robot, sender } = await scene();
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: ROBOT, details: [{ ...move(target()), format: 'VENDOR-X' }],
    });
    await expect(req.completion()).rejects.toThrow();
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.status).toBe('ABORTED');
    expect(final.detailStatuses[0]!.status.reason).toBe('FORMAT_NOT_SUPPORTED');
  });
});

describe('INVALID_IMR_STATE_FOR_ACTION', () => {
  it('rejects while the robot reports a blocking operating state (decision 7)', async () => {
    const { broker, robot, sender } = await scene();
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    await robot.publishStatus({ states: ['MODE_AUTO', 'STOP_CATEGORY_0'] });
    const req = await sender.sendRequest({ destination: ROBOT, details: [move(target())] });
    await expect(req.completion()).rejects.toThrow();
    const final = lastStatus(broker, 'IMR', ROBOT, req.requestUuid);
    expect(final.status).toBe('ABORTED');
    expect(final.detailStatuses[0]!.status.reason).toBe('INVALID_IMR_STATE_FOR_ACTION');
  });
});

describe('RequestTimeout', () => {
  it('rejects locally with RequestTimeout and no status message ever hits the wire (D-14)', async () => {
    const d = deployment();
    const senderClient = await d.client();
    const sender = await senderClient.registerSelfEntity({
      entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
    });
    // No robot ever registered on this broker for ROBOT — nothing will ever answer.
    const req = await sender.sendRequest({
      destination: ROBOT, destinationType: 'IMR', requireCapability: false,
      details: [move(target())], timeoutMs: 20,
    });
    await expect(req.completion()).rejects.toThrow(RequestTimeout);
    expect(statusSequence(d.broker, 'IMR', ROBOT, req.requestUuid)).toEqual([]);
  });
});
