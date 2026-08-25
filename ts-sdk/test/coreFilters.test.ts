import { describe, it, expect } from 'vitest';
import {
  EntityFilter, RequestFilter, RequestStatusFilter, RequestAcceptanceFilter, composeSubscription,
} from '../src/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('EntityFilter → MQTT filters (P-3 / NP-3)', () => {
  it('all() is a two-wildcard filter', () => {
    expect(EntityFilter.all().topicFiltersFor('status'))
      .toEqual(['/ISO_21423/v1/+/+/status']);
  });
  it('ofType() pins the type level', () => {
    expect(EntityFilter.ofType('IMR').topicFiltersFor('odometry'))
      .toEqual(['/ISO_21423/v1/IMR/+/odometry']);
  });
  it('entity() pins the uuid level and leaves the type wild', () => {
    expect(EntityFilter.entity(A).topicFiltersFor('status'))
      .toEqual([`/ISO_21423/v1/+/${A}/status`]);
  });
  it('anyOf() accepts uuids and filters, deduplicating', () => {
    const f = EntityFilter.anyOf([A, EntityFilter.entity(B), EntityFilter.entity(A)]);
    expect(f.topicFiltersFor('status')).toEqual([
      `/ISO_21423/v1/+/${A}/status`,
      `/ISO_21423/v1/+/${B}/status`,
    ]);
  });
  it('matches() reproduces the selector semantics locally', () => {
    expect(EntityFilter.ofType('IMR').matches({ entityType: 'IMR', entityUuid: A })).toBe(true);
    expect(EntityFilter.ofType('IMR').matches({ entityType: 'IMRFM', entityUuid: A })).toBe(false);
    expect(EntityFilter.entity(A).matches({ entityType: 'Door', entityUuid: A })).toBe(true);
  });
});

describe('request filters', () => {
  it('RequestFilter targets request topics one level below', () => {
    expect(RequestFilter.all().topicFilters()).toEqual(['/ISO_21423/v1/+/+/request/+']);
    expect(RequestFilter.toEntity(A).topicFilters()).toEqual([`/ISO_21423/v1/+/${A}/request/+`]);
  });
  it('RequestStatusFilter targets the status leaf', () => {
    expect(RequestStatusFilter.all().topicFilters()).toEqual(['/ISO_21423/v1/+/+/request/+/status']);
    expect(RequestStatusFilter.ofType('IMR').topicFilters())
      .toEqual(['/ISO_21423/v1/IMR/+/request/+/status']);
  });
  it('RequestAcceptanceFilter is a local predicate', () => {
    const req = {
      destination: B, source: A, sequenceId: 1, timestamp: '2025-04-08T12:34:56.789Z',
      details: [{ type: 'move', version: '1.0' }],
    };
    expect(RequestAcceptanceFilter.all().matches(req)).toBe(true);
    expect(RequestAcceptanceFilter.actions(['move']).matches(req)).toBe(true);
    expect(RequestAcceptanceFilter.actions(['dock']).matches(req)).toBe(false);
    expect(RequestAcceptanceFilter.fromSource(A).matches(req)).toBe(true);
    expect(RequestAcceptanceFilter.fromSource(B).matches(req)).toBe(false);
  });
});

describe('composeSubscription (D-19)', () => {
  it('unsubscribes every part once and supports await using', async () => {
    let calls = 0;
    const part = { unsubscribe: async () => { calls += 1; } };
    const sub = composeSubscription(['/a/+'], [part, part]);
    expect(sub.active).toBe(true);
    expect(sub.topicFilters).toEqual(['/a/+']);
    await sub.unsubscribe();
    await sub.unsubscribe();
    expect(calls).toBe(2);
    expect(sub.active).toBe(false);

    calls = 0;
    {
      await using scoped = composeSubscription(['/b/+'], [part]);
      expect(scoped.active).toBe(true);
    }
    expect(calls).toBe(1);
  });
});
