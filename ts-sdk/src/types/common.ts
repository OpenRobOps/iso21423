export type Uuid = string;
/** ISO 8601-1 timestamp string, dot-decimal milliseconds, UTC. */
export type IsoTimestamp = string;

export function nowTimestamp(date: Date = new Date()): IsoTimestamp {
  return date.toISOString();
}

/** Accepts both dot and comma decimal separators (spec §3.1). */
export function parseTimestamp(ts: string): Date {
  return new Date(ts.replace(',', '.'));
}
