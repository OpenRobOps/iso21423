import { describe, it, expect } from 'vitest';
import { validateMessage, normalizeInbound, assertValid, ValidationError } from '../src/index.js';

const IDENTITY = {          // B.5.2.1 (trimmed but structurally complete)
  timestamp: '2025-04-08T12:34:56.789Z',
  id: '91403a21-7534-4467-99a6-79c46a130fe8',
  entityType: 'IMR',
  manufacturerName: 'acme',
  iso21423Version: '1.0',
  capabilities: {
    provides: ['identity', 'status', 'odometry', 'activeRequestsStatus'],
    accepts: { requests: ['pauseImr', 'resumeImr', 'move'] },
  },
  details: {
    imrModel: 'm1', imrSerialNumber: 's1',
    imrFootprint: [{ x: -2, y: -2 }, { x: -2, y: 2 }, { x: 2, y: 2 }, { x: 2, y: -2 }],
    imrWorkingArea: [{ x: -3, y: -3 }, { x: -3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: -3 }],
    imrHeight: 1.5,
    softwareVersions: [{ moduleName: 'nav', moduleVersion: '2.1' }],
  },
};

const STATUS = {            // B.5.5.1
  entityId: 'd41e4efe-65e5-4070-8c0d-578c07f05ab4',
  timestamp: '2025-04-08T12:34:56.789Z',
  states: ['DOCKING', 'LOW_BATTERY', 'MODE_AUTO'],
  disabledCapabilities: { provides: [], accepts: { requests: ['move'] } },
};

const ODOMETRY = {          // B.5.7
  timestamp: '2025-04-08T12:34:56.789Z',
  pose: {
    locationPoint: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 0, y: 0, z: 0 },
    orientation: { yaw: 0, pitch: 0, roll: 0 },
  },
  velocity: { linear: 0, angular: 0 },
};

const REQUEST = {           // C.2.4.2.1 (first detail)
  source: '5f4d2824-d279-4fdf-9050-62e0cef72f25',
  destination: '42177726-26f7-4f5c-b735-a12a427bb96d',
  sequenceId: 42,
  timestamp: '2025-04-08T12:34:56.789Z',
  details: [{
    type: 'move', version: '0.1', format: 'ISO-21423', blocking: true, atomic: false,
    properties: {
      location: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 33, y: 3, z: 0 },
      orientation: { yaw: 1, pitch: 0, roll: 0 },
    },
  }],
};

describe('validateMessage', () => {
  it('accepts the standard example payloads', () => {
    expect(validateMessage('entityIdentity', IDENTITY).ok).toBe(true);
    expect(validateMessage('entityStatus', STATUS).ok).toBe(true);
    expect(validateMessage('odometry', ODOMETRY).ok).toBe(true);
    expect(validateMessage('request', REQUEST).ok).toBe(true);
  });
  it('accepts empty destination (defect A1 patch)', () => {
    expect(validateMessage('request', { ...REQUEST, destination: '' }).ok).toBe(true);
  });
  it('rejects a request missing required fields', () => {
    const r = validateMessage('request', { source: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errors!.length).toBeGreaterThan(0);
  });
  it('warns (not rejects) on unknown operating states', () => {
    const r = validateMessage('entityStatus', { ...STATUS, states: ['MODE_AUTO', 'VENDOR_SPECIAL'] });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('VENDOR_SPECIAL'))).toBe(true);
  });
});

describe('normalizeInbound (§3.1 leniency)', () => {
  it('renames id → entityId on status messages with a warning', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _drop, ...rest } = { ...STATUS } as Record<string, unknown> & { id?: string };
    const legacy = { ...rest, id: STATUS.entityId } as Record<string, unknown>;
    delete legacy.entityId;
    const { value, warnings } = normalizeInbound('entityStatus', legacy);
    expect((value as { entityId: string }).entityId).toBe(STATUS.entityId);
    expect(warnings.length).toBe(1);
  });
  it('converts comma-decimal timestamps to dot form', () => {
    const { value } = normalizeInbound('odometry', { ...ODOMETRY, timestamp: '2025-04-08T12:34:56,789Z' });
    expect((value as { timestamp: string }).timestamp).toBe('2025-04-08T12:34:56.789Z');
  });
});

describe('assertValid (egress)', () => {
  it('throws ValidationError with ajv details on invalid payload', () => {
    expect(() => assertValid('entityStatus', { states: 'nope' })).toThrow(ValidationError);
  });
});
