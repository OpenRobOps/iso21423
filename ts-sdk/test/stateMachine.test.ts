/**
 * Copyright 2026 InOrbit, Inc.
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

import { describe, it, expect } from 'vitest';
import {
  RequestLifecycle, DetailLifecycle, isTerminalRequestState,
  REQUEST_TRANSITIONS, IllegalTransition,
} from '../src/index.js';

describe('request lifecycle (Figure C.3)', () => {
  it('walks the happy path RECEIVED → ACCEPTED → EXECUTING → SUCCEEDED', () => {
    const lc = new RequestLifecycle();
    expect(lc.state).toBe('RECEIVED');
    lc.transition('ACCEPTED');
    lc.transition('EXECUTING');
    lc.transition('SUCCEEDED');
    expect(lc.isTerminal()).toBe(true);
  });
  it('allows EXECUTING → RECOVERY → ABORTED and RECOVERY → CANCELED', () => {
    const a = new RequestLifecycle();
    a.transition('ACCEPTED'); a.transition('EXECUTING'); a.transition('RECOVERY'); a.transition('ABORTED');
    expect(a.isTerminal()).toBe(true);
    const b = new RequestLifecycle();
    b.transition('ACCEPTED'); b.transition('EXECUTING'); b.transition('RECOVERY'); b.transition('CANCELED');
    expect(b.isTerminal()).toBe(true);
  });
  it('allows early rejection: RECEIVED → ABORTED', () => {
    const lc = new RequestLifecycle();
    lc.transition('ABORTED');
    expect(lc.isTerminal()).toBe(true);
  });
  it('rejects illegal transitions', () => {
    const lc = new RequestLifecycle();
    expect(() => lc.transition('SUCCEEDED')).toThrow(IllegalTransition);       // skip states
    lc.transition('ACCEPTED'); lc.transition('EXECUTING'); lc.transition('SUCCEEDED');
    expect(() => lc.transition('EXECUTING')).toThrow(IllegalTransition);       // out of terminal
    expect(() => new RequestLifecycle().transition('RECOVERY')).toThrow(IllegalTransition); // RECOVERY before ACCEPTED
  });
  it('every state in the transition table only names known states', () => {
    for (const [from, tos] of Object.entries(REQUEST_TRANSITIONS)) {
      for (const to of tos) expect(REQUEST_TRANSITIONS).toHaveProperty(to);
      expect(REQUEST_TRANSITIONS).toHaveProperty(from);
    }
  });
});

describe('detail lifecycle (Figure C.4)', () => {
  it('has no RECOVERY state and terminal SUCCEEDED/CANCELED/ABORTED', () => {
    const lc = new DetailLifecycle();
    lc.transition('ACCEPTED'); lc.transition('EXECUTING'); lc.transition('CANCELED');
    expect(lc.isTerminal()).toBe(true);
    expect(() => (lc as unknown as RequestLifecycle).transition('RECOVERY' as never)).toThrow();
  });
});

describe('isTerminalRequestState', () => {
  it('is true exactly for CANCELED, SUCCEEDED, ABORTED', () => {
    expect(isTerminalRequestState('CANCELED')).toBe(true);
    expect(isTerminalRequestState('SUCCEEDED')).toBe(true);
    expect(isTerminalRequestState('ABORTED')).toBe(true);
    expect(isTerminalRequestState('EXECUTING')).toBe(false);
    expect(isTerminalRequestState('RECOVERY')).toBe(false);
  });
});
