// test/coreExecutor.test.ts
import { describe, it, expect } from 'vitest';
import { Iso21423Client, move, pauseImr } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const SRC = '42177726-26f7-4f5c-b735-a12a427bb96d';
const DST = '91403a21-7534-4467-99a6-79c46a130fe8';
const CCS = '2385eed2-86ca-4dc9-8f17-dac062ce9a08';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const target = { location: { ccsId: CCS, x: 1, y: 2, z: 0 } };

async function pair(broker: MemoryBroker) {
  const robotClient = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null,
  });
  const robot = await robotClient.registerSelfEntity({
    entityUuid: DST, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    capabilities: { accepts: ['move', 'pauseImr', 'cancelRequest'] },
  });
  const senderClient = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null, requestTimeoutMs: 500,
  });
  const sender = await senderClient.registerSelfEntity({
    entityUuid: SRC, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
  });
  await flush();
  return { robot, sender };
}

const statusesFor = (broker: MemoryBroker, requestUuid: string) =>
  broker.messagesOn(`/ISO_21423/v1/IMR/${DST}/request/${requestUuid}/status`)
    .map((m) => JSON.parse(m.payload.toString()) as {
      status: string;
      detailStatuses: Array<{ type: string; status: { code: string; reason?: string } }>;
      recoveryStatuses?: Array<{ status: { code: string } }>;
    });

describe('per-action executor (ND-11.1)', () => {
  it('drives RECEIVED → ACCEPTED → EXECUTING → SUCCEEDED around the handler', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async (action, ctx) => {
      expect(action.properties).toMatchObject(target);
      expect(ctx.entity.entityUuid).toBe(DST);
      ctx.progress({ distanceRemaining: 3 });
      return ctx.succeeded({ arrived: true });
    });
    const req = await sender.sendRequest({ destination: DST, details: [move(target)] });
    await req.completion();
    expect(statusesFor(broker, req.requestUuid).map((s) => s.status))
      .toEqual(['RECEIVED', 'ACCEPTED', 'EXECUTING', 'EXECUTING', 'EXECUTING', 'SUCCEEDED']);
  });

  it('rejects unknown actions with ACTION_NOT_IMPLEMENTED before ACCEPTED', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const req = await sender.sendRequest({
      destination: DST, requireCapability: false,
      details: [{ type: 'teleport', version: '1.0', properties: {} }],
    });
    await expect(req.completion()).rejects.toThrow(/ABORTED/);
    const last = statusesFor(broker, req.requestUuid).at(-1)!;
    expect(last.status).toBe('ABORTED');
    expect(last.detailStatuses[0]!.status.reason).toBe('ACTION_NOT_IMPLEMENTED');
  });

  it('rejects unsupported versions and formats', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const bad = await sender.sendRequest({
      destination: DST, requireCapability: false,
      details: [{ ...move(target), version: '2.0' }],
    });
    await expect(bad.completion()).rejects.toThrow();
    expect(statusesFor(broker, bad.requestUuid).at(-1)!.detailStatuses[0]!.status.reason)
      .toBe('VERSION_NOT_SUPPORTED');

    const wrongFormat = await sender.sendRequest({
      destination: DST, requireCapability: false,
      details: [{ ...move(target), format: 'VENDOR-X' }],
    });
    await expect(wrongFormat.completion()).rejects.toThrow();
    expect(statusesFor(broker, wrongFormat.requestUuid).at(-1)!.detailStatuses[0]!.status.reason)
      .toBe('FORMAT_NOT_SUPPORTED');
  });

  it('rejects with INVALID_IMR_STATE_FOR_ACTION while the robot is stopped (decision 7)', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    await robot.publishStatus({ states: ['MODE_AUTO', 'STOP_CATEGORY_0'] });
    const req = await sender.sendRequest({ destination: DST, details: [move(target)] });
    await expect(req.completion()).rejects.toThrow();
    expect(statusesFor(broker, req.requestUuid).at(-1)!.detailStatuses[0]!.status.reason)
      .toBe('INVALID_IMR_STATE_FOR_ACTION');
  });

  it('runs blocking details serially and consecutive non-blocking details concurrently', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    const order: string[] = [];
    const gate = { release: () => {} };
    const blocked = new Promise<void>((r) => { gate.release = r; });
    robot.onRequest('move', async (_a, ctx) => { order.push('move-start'); await blocked; order.push('move-end'); return ctx.succeeded(); });
    robot.onRequest('pauseImr', async (_a, ctx) => { order.push('pause'); return ctx.succeeded(); });
    const req = await sender.sendRequest({
      destination: DST,
      details: [move(target), { ...pauseImr(), blocking: false }, { ...move(target), blocking: false }],
    });
    await flush();
    expect(order).toEqual(['move-start']);         // blocking detail holds the queue
    gate.release();
    await req.completion();
    expect(order).toEqual(['move-start', 'move-end', 'pause', 'move-start', 'move-end']);
  });

  it('cancelRequest fires the target AbortSignal and ends it CANCELED', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    let aborted = false;
    robot.onRequest('move', async (_a, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
      aborted = true;
      return ctx.aborted('OK', 'canceled by request');
    });
    const req = await sender.sendRequest({ destination: DST, details: [move(target)] });
    await flush();
    await req.cancel();
    await expect(req.completion()).rejects.toThrow(/CANCELED/);
    expect(aborted).toBe(true);
    expect(statusesFor(broker, req.requestUuid).at(-1)!.status).toBe('CANCELED');
  });

  it('does not abort an atomic detail mid-flight (C.2.3)', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    let finishedNormally = false;
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    robot.onRequest('move', async (_a, ctx) => {
      expect(ctx.signal.aborted).toBe(false);
      await held;
      finishedNormally = !ctx.signal.aborted;
      return ctx.succeeded();
    });
    const req = await sender.sendRequest({
      destination: DST, details: [{ ...move(target), atomic: true }],
    });
    await flush();
    await req.cancel();
    await flush();
    release();
    await req.completion().catch(() => undefined);
    expect(finishedNormally).toBe(true);
  });

  it('runs recoveries after an abort and still ends ABORTED (decision 8 / NP-2)', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    const ran: string[] = [];
    robot.onRequest('move', async (_a, ctx) => { ran.push('move'); return ctx.aborted('GENERAL_FAILURE', 'wheel slip'); });
    robot.onRequest('pauseImr', async (_a, ctx) => { ran.push('recovery'); return ctx.succeeded(); });
    const req = await sender.sendRequest({
      destination: DST, details: [move(target)], recoveries: [pauseImr()],
    });
    await expect(req.completion()).rejects.toThrow();
    const seq = statusesFor(broker, req.requestUuid).map((s) => s.status);
    expect(ran).toEqual(['move', 'recovery']);
    expect(seq).toContain('RECOVERY');
    expect(seq.at(-1)).toBe('ABORTED');
    expect(statusesFor(broker, req.requestUuid).at(-1)!.recoveryStatuses![0]!.status.code)
      .toBe('SUCCEEDED');
  });

  it('maps a thrown handler error to ABORTED + GENERAL_FAILURE', async () => {
    const broker = new MemoryBroker();
    const { robot, sender } = await pair(broker);
    robot.onRequest('move', async () => { throw new Error('driver crashed'); });
    const req = await sender.sendRequest({ destination: DST, details: [move(target)] });
    await expect(req.completion()).rejects.toThrow();
    const last = statusesFor(broker, req.requestUuid).at(-1)!;
    expect(last.status).toBe('ABORTED');
    expect(last.detailStatuses[0]!.status.reason).toBe('GENERAL_FAILURE');
  });

  it('refuses to replace a handler without override: true', async () => {
    const broker = new MemoryBroker();
    const { robot } = await pair(broker);
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    expect(() => robot.onRequest('move', async (_a, ctx) => ctx.succeeded())).toThrow(/override/);
    expect(() => robot.onRequest('move', async (_a, ctx) => ctx.succeeded(), { override: true }))
      .not.toThrow();
  });
});
