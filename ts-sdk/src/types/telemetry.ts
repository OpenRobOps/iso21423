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
