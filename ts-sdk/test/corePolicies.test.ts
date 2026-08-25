import { describe, it, expect } from 'vitest';
import {
  policies, DEFAULT_EXECUTION_POLICY, nowTimestamp, Iso21423Client, RequestAcceptanceFilter, move,
  cancelRequest,
} from '../src/index.js';
import type { Request, RequestStatus } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const req = (over: Partial<Request> = {}): Request => ({
  destination: B, source: A, sequenceId: 1, timestamp: nowTimestamp(),
  details: [{ type: 'move', version: '1.0', properties: {} }], ...over,
});

const active = (sequenceId: number, priority?: number): RequestStatus & { priority?: number } => ({
  source: B, destination: A, sequenceId, requestSequenceId: sequenceId,
  timestamp: nowTimestamp(), status: 'EXECUTING', detailStatuses: [],
  ...(priority !== undefined ? { priority } : {}),
});

describe('C.2.2 presets (D-17)', () => {
  it('abortNew rejects while anything is active', () => {
    const p = policies.abortNew();
    expect(p.admit(req(), [])).toEqual({ action: 'accept' });
    expect(p.admit(req(), [active(1)])).toEqual({ action: 'reject', reason: 'REJECTED' });
  });

  it('queueAfter buffers behind any active request', () => {
    const p = policies.queueAfter();
    expect(p.admit(req(), [])).toEqual({ action: 'accept' });
    expect(p.admit(req(), [active(1)])).toEqual({ action: 'buffer' });
  });

  it('queueReplace buffers and signals replacement of the queued slot', () => {
    const p = policies.queueReplace();
    expect(p.admit(req(), [])).toEqual({ action: 'accept' });
    expect(p.admit(req(), [active(1)])).toEqual({ action: 'buffer' });
  });

  it('parallel(max) accepts up to max concurrent requests', () => {
    const p = policies.parallel(2);
    expect(p.admit(req(), [active(1)])).toEqual({ action: 'accept' });
    expect(p.admit(req(), [active(1), active(2)])).toEqual({ action: 'buffer' });
    expect(policies.parallel().admit(req(), [active(1), active(2), active(3)]))
      .toEqual({ action: 'accept' });
  });

  it('priority preempts strictly lower-priority work and buffers otherwise', () => {
    const p = policies.priority();
    // The preempt key names the ORIGINAL sender (A), not the serving robot (B) — see keyOf
    // (policies.ts): a preempt/cancel key must disambiguate by sender, since two different
    // senders could otherwise share a sequenceId.
    expect(p.admit(req({ priority: 10 }), [active(1, 100)]))
      .toEqual({ action: 'preempt', preempt: [{ source: A, sequenceId: 1 }] });
    expect(p.admit(req({ priority: 100 }), [active(1, 10)])).toEqual({ action: 'buffer' });
    expect(p.admit(req(), [])).toEqual({ action: 'accept' });
  });

  it('the default policy is parallel-capable (D-17)', () => {
    expect(DEFAULT_EXECUTION_POLICY.admit(req(), [active(1), active(2)]))
      .toEqual({ action: 'accept' });
  });

  it('accepts a custom policy implementing the interface', () => {
    const custom = {
      admit: (pending: Request) =>
        pending.details.some((d) => d.type === 'move')
          ? ({ action: 'accept' } as const)
          : ({ action: 'reject', reason: 'ACTION_NOT_IMPLEMENTED' } as const),
    };
    expect(custom.admit(req())).toEqual({ action: 'accept' });
  });
});

// Server-level integration tests
const SRC = '11111111-1111-4111-8111-111111111111';
const DST = '22222222-2222-4222-8222-222222222222';
const CCS = '33333333-3333-4333-8333-333333333333';

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

async function setup(broker: MemoryBroker, policy = DEFAULT_EXECUTION_POLICY) {
  const robotClient = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null,
  });
  const robotHandle = await robotClient.registerSelfEntity({
    entityUuid: DST, entityType: 'IMR', manufacturerName: 'Test',
    capabilities: { accepts: ['move', 'cancelRequest'] }, executionPolicy: policy,
  });

  const requesterClient = await Iso21423Client.connect({
    transport: broker.createTransport(), sequenceStore: null,
  });
  const requesterHandle = await requesterClient.registerSelfEntity({
    entityUuid: SRC, entityType: 'APP', manufacturerName: 'Test',
  });

  return { robotClient, robotHandle, requesterClient, requesterHandle };
}

describe('Server admission wiring (Task 6 integration)', () => {
  it('abortNew: first request accepted, second concurrent rejected', async () => {
    const broker = new MemoryBroker();
    const { robotHandle, requesterHandle } = await setup(broker, policies.abortNew());

    await robotHandle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      // Keep the first request busy so the second sees it as active
      await req.accept();
      await new Promise((r) => setTimeout(r, 100));
      await req.updateStatus({ status: 'EXECUTING' });
      await req.complete({ status: 'SUCCEEDED' });
    });

    const h1 = await requesterHandle.sendRequest({
      destination: DST,
      details: [move({ location: { ccsId: CCS, x: 1, y: 2, z: 0 } })],
    });
    await flush();
    const h2 = await requesterHandle.sendRequest({
      destination: DST,
      details: [move({ location: { ccsId: CCS, x: 1, y: 2, z: 0 } })],
    });
    await flush();

    // Wait for first to complete
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    const s1 = await h1.completion();
    let s2Error: string | null = null;
    try {
      await h2.completion();
    } catch (e) {
      // ABORTED status is treated as failure by RequestHandle
      s2Error = String(e);
    }

    expect(s1.status).toBe('SUCCEEDED');
    expect(s2Error).toContain('ABORTED');
  });

  it('queueAfter: second request buffers and runs after first completes', async () => {
    const broker = new MemoryBroker();
    const { robotHandle, requesterHandle } = await setup(broker, policies.queueAfter());
    const runOrder: string[] = [];

    await robotHandle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      try {
        runOrder.push(`start-${req.sequenceId}`);
        await req.accept();
        await req.updateStatus({ status: 'EXECUTING' });
        await new Promise((r) => setTimeout(r, 50));
        await req.complete({ status: 'SUCCEEDED' });
        runOrder.push(`end-${req.sequenceId}`);
      } catch (e) {
        runOrder.push(`error-${req.sequenceId}-${String(e)}`);
      }
    });

    const h1 = await requesterHandle.sendRequest({
      destination: DST,
      details: [move({ location: { ccsId: CCS, x: 1, y: 2, z: 0 } })],
    });
    await flush();
    const h2 = await requesterHandle.sendRequest({
      destination: DST,
      details: [move({ location: { ccsId: CCS, x: 2, y: 3, z: 0 } })],
    });
    await flush();

    // Buffering is an admission decision, not a protocol stall: RECEIVED is published immediately
    // (D-12), and ACCEPTED only arrives once the first request reaches a terminal state.
    expect(h2.latestStatus()?.status).toBe('RECEIVED');
    expect(runOrder).toEqual(['start-1']);

    const s1 = await h1.completion();
    const s2 = await h2.completion();
    await flush();                       // the handler resumes one microtask after completion()

    expect(runOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(s1.status).toBe('SUCCEEDED');
    expect(s2.status).toBe('SUCCEEDED');
  });

  it('queueReplace: a third request displaces the queued one with ABORTED/REJECTED', async () => {
    const broker = new MemoryBroker();
    const { robotHandle, requesterHandle } = await setup(broker, policies.queueReplace());
    const runOrder: string[] = [];

    await robotHandle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      runOrder.push(`start-${req.sequenceId}`);
      await req.accept();
      await req.updateStatus({ status: 'EXECUTING' });
      await new Promise((r) => setTimeout(r, 30));
      await req.complete({ status: 'SUCCEEDED' });
      runOrder.push(`end-${req.sequenceId}`);
    });

    const send = async (x: number) => requesterHandle.sendRequest({
      destination: DST,
      details: [move({ location: { ccsId: CCS, x, y: 0, z: 0 } })],
    });
    const h1 = await send(1);
    await flush();
    const h2 = await send(2);                              // takes the single buffer slot
    await flush();
    const h3 = await send(3);                              // displaces h2
    await flush();

    await expect(h2.completion()).rejects.toThrow(/ABORTED/);
    expect(h2.latestStatus()?.detailStatuses[0]?.status.reason).toBe('REJECTED');
    expect((await h1.completion()).status).toBe('SUCCEEDED');
    expect((await h3.completion()).status).toBe('SUCCEEDED');
    await flush();
    expect(runOrder).toEqual(['start-1', 'end-1', 'start-3', 'end-3']);
  });

  it('priority preempt: high-priority request cancels executing low-priority request', async () => {
    const broker = new MemoryBroker();
    const { robotHandle, requesterHandle } = await setup(broker, policies.priority());

    await robotHandle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      await req.accept();
      await req.updateStatus({ status: 'EXECUTING' });
      await new Promise((r) => setTimeout(r, 200)); // Simulate work
      if (!req.isTerminal) {
        await req.complete({ status: 'SUCCEEDED' });
      }
    });

    // First: low priority request
    const h1 = await requesterHandle.sendRequest({
      destination: DST,
      priority: 100,
      details: [move({ location: { ccsId: CCS, x: 1, y: 2, z: 0 } })],
    });
    await flush();

    // Wait for it to be executing
    await new Promise((r) => setTimeout(r, 50));

    // Second: high priority request (lower number = higher priority)
    const h2 = await requesterHandle.sendRequest({
      destination: DST,
      priority: 10,
      details: [move({ location: { ccsId: CCS, x: 2, y: 3, z: 0 } })],
    });
    await flush();

    let s1Error: string | null = null;
    try {
      await h1.completion();
    } catch (e) {
      // CANCELED status is treated as failure by RequestHandle
      s1Error = String(e);
    }
    const s2 = await h2.completion();

    expect(s1Error).toContain('CANCELED');
    expect(s2.status).toBe('SUCCEEDED');
  });

  it('cancelRequest bypasses abortNew', async () => {
    const broker = new MemoryBroker();
    const { robotHandle, requesterHandle } = await setup(broker, policies.abortNew());
    const handled: string[] = [];

    await robotHandle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      handled.push(req.request.details[0]!.type);
      if (req.request.details[0]!.type !== 'cancelRequest') {
        await req.accept();
        await req.updateStatus({ status: 'EXECUTING' });
        await new Promise((r) => setTimeout(r, 100));
        await req.complete({ status: 'SUCCEEDED' });
      }
    });

    const h1 = await requesterHandle.sendRequest({
      destination: DST,
      details: [move({ location: { ccsId: CCS, x: 1, y: 2, z: 0 } })],
    });
    await flush();
    await new Promise((r) => setTimeout(r, 20)); // Let first start executing

    // Send cancelRequest while first is still active — should bypass abortNew
    await requesterHandle.sendRequest({
      destination: DST,
      details: [cancelRequest({ source: SRC, requestId: h1.sequenceId })],
    });
    await flush();

    expect(handled).toContain('move');
    expect(handled).toContain('cancelRequest');
  });

  it('priority() drains buffered requests in priority order: 10 before 50', async () => {
    const broker = new MemoryBroker();
    const { robotHandle, requesterHandle } = await setup(broker, policies.priority());
    const runOrder: string[] = [];

    await robotHandle.acceptRequests(RequestAcceptanceFilter.all(), async (req) => {
      runOrder.push(`start-${req.request.priority ?? 100}`);
      await req.accept();
      await req.updateStatus({ status: 'EXECUTING' });
      await new Promise((r) => setTimeout(r, 50));
      await req.complete({ status: 'SUCCEEDED' });
      runOrder.push(`end-${req.request.priority ?? 100}`);
    });

    // Executing request is priority 5 — better than both newcomers, so neither preempts it.
    const h1 = await requesterHandle.sendRequest({
      destination: DST,
      priority: 5,
      details: [move({ location: { ccsId: CCS, x: 1, y: 2, z: 0 } })],
    });
    await flush();

    // Buffer priority 50
    const h2 = await requesterHandle.sendRequest({
      destination: DST,
      priority: 50,
      details: [move({ location: { ccsId: CCS, x: 2, y: 3, z: 0 } })],
    });
    await flush();

    // Buffer priority 10 (arrives second, must drain first)
    const h3 = await requesterHandle.sendRequest({
      destination: DST,
      priority: 10,
      details: [move({ location: { ccsId: CCS, x: 3, y: 4, z: 0 } })],
    });
    await flush();

    expect(runOrder).toEqual(['start-5']);          // both newcomers buffered, nothing preempted

    const s1 = await h1.completion();
    const s3 = await h3.completion();
    const s2 = await h2.completion();
    await flush();

    // Drain is by priority, not arrival: 10 before 50.
    expect(runOrder).toEqual(['start-5', 'end-5', 'start-10', 'end-10', 'start-50', 'end-50']);
    expect(s1.status).toBe('SUCCEEDED');
    expect(s2.status).toBe('SUCCEEDED');
    expect(s3.status).toBe('SUCCEEDED');
  });
});
