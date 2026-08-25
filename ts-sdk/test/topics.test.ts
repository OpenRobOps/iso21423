import { describe, it, expect } from 'vitest';
import {
  topicFor, requestTopic, requestStatusTopic, disconnectionTopic,
  parseTopic, identityWildcard, topicFilterMatches, RESOURCE_CONFIG,
} from '../src/index.js';

const ref = { entityType: 'IMR', entityUuid: '91403a21-7534-4467-99a6-79c46a130fe8' };
const REQ = 'aa53a1e1-782f-479b-88b3-fd110198be45';

describe('topic builder', () => {
  it('builds resource topics under the B.2.1 layout', () => {
    expect(topicFor(ref, 'odometry'))
      .toBe('/ISO_21423/v1/IMR/91403a21-7534-4467-99a6-79c46a130fe8/odometry');
  });
  it('builds request and request-status topics (with entityType — defect A6 fix)', () => {
    expect(requestTopic(ref, REQ))
      .toBe(`/ISO_21423/v1/IMR/${ref.entityUuid}/request/${REQ}`);
    expect(requestStatusTopic(ref, REQ))
      .toBe(`/ISO_21423/v1/IMR/${ref.entityUuid}/request/${REQ}/status`);
  });
  it('builds the disconnection (LWT) topic', () => {
    expect(disconnectionTopic(ref))
      .toBe(`/ISO_21423/v1/IMR/${ref.entityUuid}/disconnection`);
  });
  it('exposes the discovery wildcard', () => {
    expect(identityWildcard()).toBe('/ISO_21423/v1/+/+/identity');
  });
});

describe('topic parser', () => {
  it('parses a simple resource topic', () => {
    expect(parseTopic(`/ISO_21423/v1/IMRFM/${REQ}/status`))
      .toEqual({ entityType: 'IMRFM', entityUuid: REQ, resource: 'status', isRequestStatus: false });
  });
  it('parses request and request-status topics', () => {
    expect(parseTopic(`/ISO_21423/v1/IMR/${ref.entityUuid}/request/${REQ}`))
      .toEqual({ entityType: 'IMR', entityUuid: ref.entityUuid, resource: 'request', requestUuid: REQ, isRequestStatus: false });
    expect(parseTopic(`/ISO_21423/v1/IMR/${ref.entityUuid}/request/${REQ}/status`))
      .toEqual({ entityType: 'IMR', entityUuid: ref.entityUuid, resource: 'request', requestUuid: REQ, isRequestStatus: true });
  });
  it('returns null for foreign topics', () => {
    expect(parseTopic('ros/rosbag/upload')).toBeNull();
    expect(parseTopic('/ISO_21423/v2/IMR/x/status')).toBeNull();
  });
});

describe('topicFilterMatches', () => {
  it('matches + and # wildcards with leading-slash topics', () => {
    expect(topicFilterMatches('/ISO_21423/v1/+/+/identity', `/ISO_21423/v1/IMR/${REQ}/identity`)).toBe(true);
    expect(topicFilterMatches(`/ISO_21423/v1/IMR/${REQ}/#`, `/ISO_21423/v1/IMR/${REQ}/request/x/status`)).toBe(true);
    expect(topicFilterMatches('/ISO_21423/v1/+/+/identity', `/ISO_21423/v1/IMR/${REQ}/odometry`)).toBe(false);
  });
});

describe('RESOURCE_CONFIG (Table B.1)', () => {
  it('assigns normative QoS and retain per resource', () => {
    expect(RESOURCE_CONFIG.identity).toEqual({ qos: 1, retain: true });
    expect(RESOURCE_CONFIG.status).toEqual({ qos: 1, retain: true });
    expect(RESOURCE_CONFIG.batteryStatus).toEqual({ qos: 0, retain: true });
    expect(RESOURCE_CONFIG.odometry).toEqual({ qos: 0, retain: false, minHz: 0.5, maxHz: 30 });
    expect(RESOURCE_CONFIG.localTrajectory).toEqual({ qos: 0, retain: false, minHz: 1, maxHz: 10 });
    expect(RESOURCE_CONFIG.request).toEqual({ qos: 2, retain: true });
    expect(RESOURCE_CONFIG.requestStatus).toEqual({ qos: 2, retain: true });
    expect(RESOURCE_CONFIG.activeRequestsStatus).toEqual({ qos: 1, retain: true });
    expect(RESOURCE_CONFIG.disconnection).toEqual({ qos: 1, retain: true });
  });
});
