import { describe, it, expect } from 'vitest';
import { parseTopic, topicFor } from '../src/topics.js';

const ref = { entityType: 'IMRFM', entityId: '3ddd8e04-1606-4ac8-8174-8321ee094278' };

describe('topicFor', () => {
  it('builds the ISO 21423 resource topic', () => {
    expect(topicFor(ref, 'status')).toBe(
      '/ISO_21423/v1/IMRFM/3ddd8e04-1606-4ac8-8174-8321ee094278/status',
    );
  });
});

describe('parseTopic', () => {
  it('parses a well-formed resource topic', () => {
    expect(parseTopic(topicFor(ref, 'identity'))).toEqual({
      entityType: 'IMRFM',
      entityId: ref.entityId,
      resource: 'identity',
    });
  });

  it('returns null for topics outside the ISO 21423 namespace', () => {
    expect(parseTopic('ros/robot1/telemetry')).toBeNull();
  });

  it('returns null for a malformed ISO 21423 topic', () => {
    expect(parseTopic('/ISO_21423/v1/IMRFM/only-entity-id')).toBeNull();
    expect(parseTopic('/ISO_21423/v1/IMRFM/id/status/extra')).toBeNull();
  });
});
