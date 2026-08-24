import { describe, it, expect } from 'vitest';
import {
  nowTimestamp, parseTimestamp,
  KNOWN_OPERATING_STATES, REQUEST_STATES,
  move, pauseImr, cancelRequest, dock,
} from '../src/index.js';
import { ValidationError, Iso21423Error } from '../src/index.js';

describe('timestamps', () => {
  it('emits dot-decimal ISO 8601 with milliseconds', () => {
    const ts = nowTimestamp(new Date('2025-04-08T12:34:56.789Z'));
    expect(ts).toBe('2025-04-08T12:34:56.789Z');
  });
  it('parses dot-decimal timestamps', () => {
    expect(parseTimestamp('2025-04-08T12:34:56.789Z').getTime())
      .toBe(Date.UTC(2025, 3, 8, 12, 34, 56, 789));
  });
  it('parses comma-decimal timestamps (clause-table form, spec §3.1)', () => {
    expect(parseTimestamp('2024-01-11T12:58:19,050Z').getTime())
      .toBe(Date.UTC(2024, 0, 11, 12, 58, 19, 50));
  });
});

describe('constants', () => {
  it('includes the Table 5 operating states and modes', () => {
    for (const s of ['STOP_CATEGORY_0', 'LOST', 'CHARGING', 'IDLE', 'PARKED', 'MODE_AUTO', 'MODE_MAINTENANCE']) {
      expect(KNOWN_OPERATING_STATES).toContain(s);
    }
  });
  it('includes the Table C.6 request states', () => {
    expect(REQUEST_STATES).toEqual(
      ['RECEIVED', 'ACCEPTED', 'EXECUTING', 'CANCELED', 'SUCCEEDED', 'ABORTED', 'RECOVERY']);
  });
});

describe('action builders', () => {
  it('builds a move detail with defaults', () => {
    const d = move({ location: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 33, y: 3, z: 0 } });
    expect(d).toEqual({
      type: 'move',
      version: '1.0',
      format: 'ISO-21423',
      blocking: true,
      atomic: false,
      properties: { location: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 33, y: 3, z: 0 } },
    });
  });
  it('builds pauseImr with empty properties', () => {
    expect(pauseImr().type).toBe('pauseImr');
    expect(pauseImr().properties).toEqual({});
  });
  it('builds cancelRequest with requestId (Table C.4 name, not the example\'s "id")', () => {
    const d = cancelRequest({ source: '42177726-26f7-4f5c-b735-a12a427bb96d', requestId: 42 });
    expect(d.type).toBe('cancelRequest');
    expect(d.properties).toEqual({ source: '42177726-26f7-4f5c-b735-a12a427bb96d', requestId: 42 });
  });
  it('builds dock with dockActions', () => {
    const d = dock({
      dockLocation: { ccsId: '2385eed2-86ca-4dc9-8f17-dac062ce9a08', x: 1, y: 2, z: 0 },
      dockActions: ['CHARGE'],
    });
    expect(d.type).toBe('dock');
    expect((d.properties as { dockActions?: string[] }).dockActions).toEqual(['CHARGE']);
  });
});

describe('errors', () => {
  it('ValidationError extends Iso21423Error extends Error', () => {
    const e = new ValidationError('bad payload', []);
    expect(e).toBeInstanceOf(Iso21423Error);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ValidationError');
  });
});
