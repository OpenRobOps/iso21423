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

import { Iso21423Error } from '../errors.js';

/**
 * Latest-wins rate limiter for streaming telemetry (Table B.1 bounds).
 * Emits immediately when the minimum interval has elapsed; otherwise keeps
 * only the newest value and flushes it when the interval expires.
 */
export class RateGate {
  private readonly intervalMs: number;
  private lastEmit = -Infinity;
  private pending?: { value: unknown; emit: (v: never) => void };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(maxHz: number) {
    if (!(maxHz > 0) || !Number.isFinite(maxHz)) {
      throw new Iso21423Error(`RateGate requires a finite maxHz > 0, got ${maxHz}`);
    }
    this.intervalMs = 1000 / maxHz;
  }

  /** Offers a value for emission; emits now if the interval has elapsed, else schedules a trailing emit and discards any previously-pending value. */
  offer<T>(value: T, emit: (v: T) => void): void {
    const now = Date.now();
    if (now - this.lastEmit >= this.intervalMs) {
      this.lastEmit = now;
      emit(value);
      return;
    }
    this.pending = { value, emit: emit as (v: never) => void };
    if (this.timer === undefined) {
      const wait = this.intervalMs - (now - this.lastEmit);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const p = this.pending;
        this.pending = undefined;
        if (p) {
          this.lastEmit = Date.now();
          (p.emit as (v: unknown) => void)(p.value);
        }
      }, wait);
    }
  }

  /** Cancels any pending trailing emit. The pending value is dropped, not flushed. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}
