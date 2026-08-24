import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateGate } from '../src/index.js';

describe('RateGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits the first value immediately', () => {
    const gate = new RateGate(10); // 10 Hz → 100 ms
    const out: number[] = [];
    gate.offer(1, (v) => out.push(v));
    expect(out).toEqual([1]);
  });

  it('coalesces bursts to latest-wins at the rate bound', () => {
    const gate = new RateGate(10);
    const out: number[] = [];
    gate.offer(1, (v) => out.push(v));
    gate.offer(2, (v) => out.push(v));   // within 100 ms — deferred
    gate.offer(3, (v) => out.push(v));   // replaces 2
    expect(out).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(out).toEqual([1, 3]);         // only the latest flushed
  });

  it('emits immediately again after the interval has passed idle', () => {
    const gate = new RateGate(10);
    const out: number[] = [];
    gate.offer(1, (v) => out.push(v));
    vi.advanceTimersByTime(150);
    gate.offer(2, (v) => out.push(v));
    expect(out).toEqual([1, 2]);
  });

  it('dispose cancels any pending flush', () => {
    const gate = new RateGate(10);
    const out: number[] = [];
    gate.offer(1, (v) => out.push(v));
    gate.offer(2, (v) => out.push(v));
    gate.dispose();
    vi.advanceTimersByTime(500);
    expect(out).toEqual([1]);
  });
});
