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

import type { IsoTimestamp } from './common.js';
import type { BatteryHealth, ChargingState } from './constants.js';
import type { LocationPoint, Orientation } from './ccs.js';

/** Pose + velocity telemetry sample. */
export interface Odometry {
  timestamp: IsoTimestamp;
  pose: { locationPoint: LocationPoint; orientation: Orientation };
  velocity: { linear: number; angular: number };
}

export interface BatteryStatus {
  timestamp: IsoTimestamp;
  batterySoc: number;                  // 0..1
  batteryHealth?: BatteryHealth;
  batteryTemperature?: number;
  batteryVoltage?: number;
  batteryCurrent?: number;
  batteryChargingState?: ChargingState;
}

export interface LocationPointStamped { timestamp: IsoTimestamp; locationPoint: LocationPoint }

/** Recent path already traveled, as a time-ordered sequence of points. */
export interface LocalTrajectory { timestamp: IsoTimestamp; localTrajectory: LocationPointStamped[] }

export interface NurbsControlPoint { locationPoint: LocationPoint; weight?: number }

/** NURBS curve definition for a planned path. */
export interface NurbsCurve { degree: number; controlPoints: NurbsControlPoint[]; knots: number[] }

/** Global path as a single NURBS curve (contrast with {@link GlobalPlan}'s discrete waypoints). */
export interface GlobalPath { timestamp: IsoTimestamp; globalPath: NurbsCurve }

/** Global plan as a time-ordered sequence of waypoints (contrast with {@link GlobalPath}'s curve). */
export interface GlobalPlan { timestamp: IsoTimestamp; globalPlan: LocationPointStamped[] }
