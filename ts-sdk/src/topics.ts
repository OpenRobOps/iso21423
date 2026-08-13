import type { Uuid } from './types/common.js';

/**
 * ISO 21423 topics follow `/ISO_21423/v1/<entityType>/<entityUuid>/<resourceName>`
 * (see `docs/standard/04-communication.md`). Only the resources the current domain
 * model understands — `identity` and `status` — are covered here; other resources
 * (odometry, requests, etc.) are out of scope until the domain model supports them.
 */
export const ROOT_NAMESPACE = '/ISO_21423/v1';

export const IDENTITY_RESOURCE = 'identity';
export const STATUS_RESOURCE = 'status';

export interface EntityRef {
  entityType: string;
  entityId: Uuid;
}

export interface ParsedTopic {
  entityType: string;
  entityId: Uuid;
  resource: string;
}

export function topicFor(ref: EntityRef, resource: string): string {
  return `${ROOT_NAMESPACE}/${ref.entityType}/${ref.entityId}/${resource}`;
}

export function parseTopic(topic: string): ParsedTopic | null {
  if (!topic.startsWith(`${ROOT_NAMESPACE}/`)) return null;
  const segments = topic.slice(ROOT_NAMESPACE.length + 1).split('/');
  const [entityType, entityId, resource, ...rest] = segments;
  if (!entityType || !entityId || !resource || rest.length > 0) return null;
  return { entityType, entityId, resource };
}
