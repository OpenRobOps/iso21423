import type { Uuid } from '../types/common.js';
import type { Request, RequestStatus } from '../types/requests.js';
import type { StatusReason } from './types.js';

export interface RequestKey { source: Uuid; sequenceId: number }

export type AdmissionDecision =
  | { action: 'accept' }
  | { action: 'reject'; reason: StatusReason }
  | { action: 'buffer' }
  | { action: 'preempt'; preempt: readonly RequestKey[] };

/** Runtime admission strategy (D-17). Named C.2.2 strategies ship as presets below. */
export interface ExecutionPolicy {
  admit(pending: Request, active: readonly RequestStatus[]): AdmissionDecision;
  /** Optional hint: how many buffered requests to hold before displacing the oldest. */
  readonly bufferLimit?: number;
}

const DEFAULT_PRIORITY = 100;                       // 0 high … 255 low (Table C.1)
const priorityOf = (r: { priority?: number }): number => r.priority ?? DEFAULT_PRIORITY;
const keyOf = (s: RequestStatus): RequestKey => ({ source: s.source, sequenceId: s.requestSequenceId });

export const policies = {
  abortNew(): ExecutionPolicy {
    return {
      admit: (_pending, active) =>
        active.length === 0 ? { action: 'accept' } : { action: 'reject', reason: 'REJECTED' },
    };
  },

  /** One active + one queued slot; the server aborts the displaced queue entry with REJECTED. */
  queueReplace(): ExecutionPolicy {
    const policy: ExecutionPolicy = {
      admit: (_pending, active) => (active.length === 0 ? { action: 'accept' } : { action: 'buffer' }),
    };
    Object.assign(policy, { bufferLimit: 1 });
    return policy;
  },

  queueAfter(): ExecutionPolicy {
    const policy: ExecutionPolicy = {
      admit: (_pending, active) => (active.length === 0 ? { action: 'accept' } : { action: 'buffer' }),
    };
    Object.assign(policy, { bufferLimit: Number.POSITIVE_INFINITY });
    return policy;
  },

  parallel(max = Number.POSITIVE_INFINITY): ExecutionPolicy {
    const policy: ExecutionPolicy = {
      admit: (_pending, active) => (active.length < max ? { action: 'accept' } : { action: 'buffer' }),
    };
    Object.assign(policy, { bufferLimit: Number.POSITIVE_INFINITY });
    return policy;
  },

  priority(): ExecutionPolicy {
    const policy: ExecutionPolicy = {
      admit: (pending, active) => {
        if (active.length === 0) return { action: 'accept' };
        const mine = priorityOf(pending);
        const beatsAll = active.every(
          (s) => mine < priorityOf(s as RequestStatus & { priority?: number }));
        return beatsAll
          ? { action: 'preempt', preempt: active.map(keyOf) }
          : { action: 'buffer' };
      },
    };
    Object.assign(policy, { bufferLimit: Number.POSITIVE_INFINITY });
    return policy;
  },
};

/** Parallel-capable default (D-17); overridable per client (P-2) and per handle. */
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = policies.parallel();
