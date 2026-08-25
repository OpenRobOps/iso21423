import { ROOT_NAMESPACE } from '../types/constants.js';

/** Identifies an entity for topic-building purposes: its ISO type ("IMR"/"IMRFM") and its uuid. */
export interface EntityRef { entityType: string; entityUuid: string }

/** Decomposed form of an ISO 21423 topic string, as produced by {@link parseTopic}. */
export interface ParsedTopic {
  entityType: string;
  entityUuid: string;
  resource: string;
  requestUuid?: string;
  isRequestStatus: boolean;
}

export function topicFor(ref: EntityRef, resource: string): string {
  return `${ROOT_NAMESPACE}/${ref.entityType}/${ref.entityUuid}/${resource}`;
}

export function requestTopic(ref: EntityRef, requestUuid: string): string {
  return `${topicFor(ref, 'request')}/${requestUuid}`;
}

export function requestStatusTopic(ref: EntityRef, requestUuid: string): string {
  return `${requestTopic(ref, requestUuid)}/status`;
}

export function disconnectionTopic(ref: EntityRef): string {
  return topicFor(ref, 'disconnection');
}

/** MQTT wildcard subscription matching every entity's identity topic, used to build the fleet-wide entity cache. */
export function identityWildcard(): string {
  return `${ROOT_NAMESPACE}/+/+/identity`;
}

/**
 * Splits a concrete topic string into its parts, or returns `null` if it doesn't
 * live under {@link ROOT_NAMESPACE} or has an unrecognized shape (e.g. extra path segments).
 */
export function parseTopic(topic: string): ParsedTopic | null {
  if (!topic.startsWith(`${ROOT_NAMESPACE}/`)) return null;
  const rest = topic.slice(ROOT_NAMESPACE.length + 1).split('/');
  const [entityType, entityUuid, resource, ...tail] = rest;
  if (!entityType || !entityUuid || !resource) return null;
  if (resource === 'request' && tail.length >= 1) {
    const [requestUuid, maybeStatus] = tail;
    if (!requestUuid || (maybeStatus !== undefined && maybeStatus !== 'status') || tail.length > 2) return null;
    return { entityType, entityUuid, resource, requestUuid, isRequestStatus: maybeStatus === 'status' };
  }
  if (tail.length > 0) return null;
  return { entityType, entityUuid, resource, isRequestStatus: false };
}

/** MQTT 3.1.1 topic filter matching (+ single level, # multi level). */
export function topicFilterMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    const seg = f[i];
    if (seg === '#') return true;
    if (i >= t.length) return false;
    if (seg !== '+' && seg !== t[i]) return false;
  }
  return f.length === t.length;
}
