import type { IsoTimestamp } from './common.js';
import type { BatteryHealth, ChargingState } from './constants.js';
import type { LocationPoint, Orientation } from './ccs.js';

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

export interface LocalTrajectory { timestamp: IsoTimestamp; localTrajectory: LocationPointStamped[] }

export interface NurbsControlPoint { locationPoint: LocationPoint; weight?: number }

export interface NurbsCurve { degree: number; controlPoints: NurbsControlPoint[]; knots: number[] }

export interface GlobalPath { timestamp: IsoTimestamp; globalPath: NurbsCurve }

export interface GlobalPlan { timestamp: IsoTimestamp; globalPlan: LocationPointStamped[] }
