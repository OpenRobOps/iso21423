import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from './iso21423.schema.json' with { type: 'json' };
import { KNOWN_OPERATING_STATES } from '../types/constants.js';
import { ValidationError } from '../errors.js';
import { normalizeInbound } from './normalize.js';

export type MessageKind =
  | 'entityIdentity' | 'entityStatus' | 'batteryStatus' | 'odometry'
  | 'localTrajectory' | 'globalPath' | 'globalPlan'
  | 'request' | 'requestStatus' | 'requestStatusArray';

export interface ValidationResult {
  ok: boolean;
  value?: unknown;
  warnings: string[];
  errors?: unknown[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (ajv: Ajv2020) => void)(ajv);
ajv.addSchema(schema);

const KNOWN_STATES = new Set<string>(KNOWN_OPERATING_STATES);

function collectWarnings(kind: MessageKind, value: unknown, warnings: string[]): void {
  if (kind !== 'entityStatus') return;
  const states = (value as { states?: unknown })?.states;
  if (!Array.isArray(states)) return;
  for (const s of states) {
    if (typeof s === 'string' && !KNOWN_STATES.has(s)) {
      warnings.push(`entityStatus: unknown operating state "${s}" (deployment extension?)`);
    }
  }
}

export function validateMessage(kind: MessageKind, raw: unknown): ValidationResult {
  const { value, warnings } = normalizeInbound(kind, raw);
  const validate = ajv.getSchema(`https://openrobops.org/schemas/iso21423/v1.json#/$defs/${kind}`);
  if (!validate) throw new Error(`No schema for message kind: ${kind}`);
  const ok = validate(value) as boolean;
  collectWarnings(kind, value, warnings);
  return ok
    ? { ok: true, value, warnings }
    : { ok: false, value, warnings, errors: validate.errors ?? [] };
}

/** Egress guard: throws on non-conformant outbound payloads. */
export function assertValid(kind: MessageKind, value: unknown): void {
  const r = validateMessage(kind, value);
  if (!r.ok) {
    throw new ValidationError(`outbound ${kind} message is not ISO 21423 conformant`, r.errors ?? []);
  }
}
