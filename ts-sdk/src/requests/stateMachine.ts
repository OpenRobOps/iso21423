import type { RequestState, DetailState } from '../types/constants.js';
import { IllegalTransition } from '../errors.js';

/** Figure C.3 — request message state transitions. */
export const REQUEST_TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  RECEIVED: [
    'ACCEPTED',
    'CANCELED', // NP-2: RECEIVED→CANCELED disputed vs shared interaction model (Figure C.3 final artwork may differ)
    'ABORTED',
  ],
  ACCEPTED: [
    'EXECUTING',
    'CANCELED',
    'ABORTED', // NP-2: ACCEPTED→ABORTED disputed vs shared interaction model (Figure C.3 final artwork may differ)
    'RECOVERY', // NP-2: ACCEPTED→RECOVERY disputed vs shared interaction model (Figure C.3 final artwork may differ)
  ],
  EXECUTING: ['SUCCEEDED', 'CANCELED', 'ABORTED', 'RECOVERY'],
  RECOVERY: ['CANCELED', 'ABORTED'], // NP-2: no RECOVERY→SUCCEEDED (disputed vs shared interaction model, Figure C.3 final artwork may differ)
  CANCELED: [],
  SUCCEEDED: [],
  ABORTED: [],
};

/** Figure C.4 — requestDetail state transitions (no RECOVERY at detail level). */
export const DETAIL_TRANSITIONS: Record<DetailState, readonly DetailState[]> = {
  RECEIVED: ['ACCEPTED', 'CANCELED', 'ABORTED'],
  ACCEPTED: ['EXECUTING', 'CANCELED', 'ABORTED'],
  EXECUTING: ['SUCCEEDED', 'CANCELED', 'ABORTED'],
  CANCELED: [],
  SUCCEEDED: [],
  ABORTED: [],
};

export function isTerminalRequestState(s: RequestState): boolean {
  return REQUEST_TRANSITIONS[s].length === 0;
}

class Lifecycle<S extends string> {
  #state: S;
  constructor(private readonly table: Record<S, readonly S[]>, initial: S) {
    this.#state = initial;
  }
  get state(): S {
    return this.#state;
  }
  canTransition(to: S): boolean {
    return this.table[this.#state].includes(to);
  }
  transition(to: S): void {
    if (!this.canTransition(to)) {
      throw new IllegalTransition(`illegal transition ${this.#state} → ${to}`);
    }
    this.#state = to;
  }
  isTerminal(): boolean {
    return this.table[this.#state].length === 0;
  }
}

export class RequestLifecycle extends Lifecycle<RequestState> {
  constructor() { super(REQUEST_TRANSITIONS, 'RECEIVED'); }
}

export class DetailLifecycle extends Lifecycle<DetailState> {
  constructor() { super(DETAIL_TRANSITIONS, 'RECEIVED'); }
}
