import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSequenceStore, SequenceCounter, type SequenceStore } from '../src/index.js';

const U = '11111111-1111-4111-8111-111111111111';

describe('SequenceCounter (D-15, ND-09)', () => {
  it('is monotonic from 1 on a fresh store', async () => {
    const store = new Map<string, number>();
    const mem: SequenceStore = {
      load: async (k) => store.get(k),
      save: async (k, v) => void store.set(k, v),
    };
    const c = await SequenceCounter.open(U, mem);
    expect([await c.next(), await c.next(), await c.next()]).toEqual([1, 2, 3]);
  });

  it('never reuses ids after a restart (reservation block persisted)', async () => {
    const store = new Map<string, number>();
    const mem: SequenceStore = {
      load: async (k) => store.get(k),
      save: async (k, v) => void store.set(k, v),
    };
    const first = await SequenceCounter.open(U, mem);
    const used = [await first.next(), await first.next()];
    const second = await SequenceCounter.open(U, mem);
    const after = await second.next();
    expect(after).toBeGreaterThan(Math.max(...used));
  });

  it('falls back to an epoch-millisecond seed when the store fails (ND-09)', async () => {
    const broken: SequenceStore = {
      load: async () => { throw new Error('no fs'); },
      save: async () => { throw new Error('no fs'); },
    };
    const errors: unknown[] = [];
    const c = await SequenceCounter.open(U, broken, (e) => errors.push(e));
    const n = await c.next();
    expect(n).toBeGreaterThan(1_700_000_000_000);
    expect(errors).toHaveLength(1);
  });
});

describe('FileSequenceStore', () => {
  it('round-trips per-entity seeds through a JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iso21423-seq-'));
    const store = new FileSequenceStore(dir);
    expect(await store.load(U)).toBeUndefined();
    await store.save(U, 4242);
    expect(await store.load(U)).toBe(4242);
    const raw = JSON.parse(await readFile(join(dir, 'sequence.json'), 'utf8')) as Record<string, number>;
    expect(raw[U]).toBe(4242);
  });
});
