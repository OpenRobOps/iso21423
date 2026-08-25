const TIMESTAMP_KEYS = new Set(['timestamp', 'arrivalTime']);
const COMMA_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}),(\d+)(Z|[+-]\d{2}:?\d{2})$/;

/** Recursively rewrites comma-decimal timestamps (e.g. "12:00:00,500Z") to dot-decimal form, recording a warning per fix. */
function fixTimestamps(value: unknown, warnings: string[], path: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => fixTimestamps(v, warnings, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (TIMESTAMP_KEYS.has(k) && typeof v === 'string' && COMMA_TS.test(v)) {
      out[k] = v.replace(COMMA_TS, '$1.$2$3');
      warnings.push(`${path}.${k}: comma-decimal timestamp normalized to dot form`);
    } else {
      out[k] = fixTimestamps(v, warnings, `${path}.${k}`);
    }
  }
  return out;
}

/**
 * Best-effort cleanup of inbound wire payloads before schema validation: fixes comma-decimal
 * timestamps and, for `entityStatus`, renames the legacy `id` field to `entityId` (spec §3.1).
 * Never throws; returns the corrected value plus human-readable warnings for anything it touched.
 */
export function normalizeInbound(kind: string, value: unknown): { value: unknown; warnings: string[] } {
  const warnings: string[] = [];
  let v = fixTimestamps(value, warnings, kind);
  if (kind === 'entityStatus' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.entityId === undefined && typeof o.id === 'string') {
      const { id, ...rest } = o;
      v = { ...rest, entityId: id };
      warnings.push('entityStatus: legacy field "id" renamed to "entityId" (spec §3.1)');
    }
  }
  return { value: v, warnings };
}
