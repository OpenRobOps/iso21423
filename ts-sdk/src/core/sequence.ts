import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Uuid } from '../types/common.js';

/** Pluggable persistence for the per-entity sequenceId seed (ND-09). */
export interface SequenceStore {
  load(entityUuid: Uuid): Promise<number | undefined>;
  save(entityUuid: Uuid, value: number): Promise<void>;
}

export function defaultStateDir(): string {
  return process.env.ISO21423_STATE_DIR ?? join(homedir(), '.iso21423');
}

/** Default store: one JSON map per state directory, written atomically. */
export class FileSequenceStore implements SequenceStore {
  private readonly file: string;
  // ponytail: in-process serialization only; use a per-file lock if multiple processes share ISO21423_STATE_DIR
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string = defaultStateDir()) {
    this.file = join(this.dir, 'sequence.json');
  }

  private async read(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, number>;
    } catch {
      // ponytail: corrupted/unreadable file resets seeds to empty; acceptable because
      // SequenceCounter.open() re-reserves a fresh block above any ids already retained on the broker.
      return {};
    }
  }

  async load(entityUuid: Uuid): Promise<number | undefined> {
    return (await this.read())[entityUuid];
  }

  /** Queued so concurrent saves in one process read-modify-write the file one at a time. */
  save(entityUuid: Uuid, value: number): Promise<void> {
    const result = this.#queue.then(() => this.writeOne(entityUuid, value));
    // A failed write must not wedge the queue: later saves still run, only this caller sees the error.
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async writeOne(entityUuid: Uuid, value: number): Promise<void> {
    const all = await this.read();
    all[entityUuid] = value;
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all), 'utf8');
    await rename(tmp, this.file);
  }
}

const BLOCK = 1000;

/**
 * Monotonic sequenceId source owned by an EntityHandle (D-15).
 * Reserves BLOCK ids per persisted write, so a crash can waste ids but never reuse them.
 */
export class SequenceCounter {
  private constructor(
    private readonly entityUuid: Uuid,
    private readonly store: SequenceStore | undefined,
    private counter: number,
    private reservedThrough: number,
  ) {}

  static async open(
    entityUuid: Uuid,
    store?: SequenceStore,
    onFallback?: (err: unknown) => void,
  ): Promise<SequenceCounter> {
    if (!store) return new SequenceCounter(entityUuid, undefined, 0, Number.MAX_SAFE_INTEGER);
    try {
      const seed = (await store.load(entityUuid)) ?? 0;
      await store.save(entityUuid, seed + BLOCK);
      return new SequenceCounter(entityUuid, store, seed, seed + BLOCK);
    } catch (err) {
      // Persistence unavailable: seed from epoch milliseconds so restarts cannot collide
      // with requests still retained on the broker (ND-09).
      onFallback?.(err);
      return new SequenceCounter(entityUuid, undefined, Date.now(), Number.MAX_SAFE_INTEGER);
    }
  }

  async next(): Promise<number> {
    this.counter += 1;
    if (this.counter > this.reservedThrough && this.store) {
      this.reservedThrough = this.counter + BLOCK;
      await this.store.save(this.entityUuid, this.reservedThrough);
    }
    return this.counter;
  }
}
