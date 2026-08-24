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
    this.intervalMs = 1000 / maxHz;
  }

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

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}
