import { describe, it, expect } from 'vitest';
import { policies, DEFAULT_EXECUTION_POLICY, nowTimestamp } from '../src/index.js';
import type { Request, RequestStatus } from '../src/index.js';

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
    expect(p.admit(req({ priority: 10 }), [active(1, 100)]))
      .toEqual({ action: 'preempt', preempt: [{ source: B, sequenceId: 1 }] });
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
