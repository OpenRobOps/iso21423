import type { MessageKind } from '../schema/validators.js';

export type ResourceKind =
  | 'identity' | 'status' | 'batteryStatus' | 'odometry' | 'localTrajectory'
  | 'globalPath' | 'globalPlan' | 'activeRequestsStatus' | 'disconnection'
  | (string & {});

/** Resource name → schema message kind; `null` means "no schema, raw text" (ND-04). */
export const RESOURCE_MESSAGE_KIND: Record<string, MessageKind | null> = {
  identity: 'entityIdentity',
  status: 'entityStatus',
  batteryStatus: 'batteryStatus',
  odometry: 'odometry',
  localTrajectory: 'localTrajectory',
  globalPath: 'globalPath',
  globalPlan: 'globalPlan',
  request: 'request',
  requestStatus: 'requestStatus',
  activeRequestsStatus: 'requestStatusArray',
  disconnection: null,
  footprint: null,
};

export function messageKindFor(resource: string): MessageKind | null {
  return RESOURCE_MESSAGE_KIND[resource] ?? null;
}
