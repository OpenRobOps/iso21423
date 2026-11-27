/**
 * Copyright 2026 InOrbit, Inc.
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

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

/** Looks up a resource's schema message kind; unknown resources are treated as "no schema" rather than throwing. */
export function messageKindFor(resource: string): MessageKind | null {
  return RESOURCE_MESSAGE_KIND[resource] ?? null;
}
