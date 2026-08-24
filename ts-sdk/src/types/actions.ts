import { PROTOCOL_VERSION, type DockAction } from './constants.js';
import type { Uuid } from './common.js';
import type { LocationPoint, Orientation } from './ccs.js';
import type { RequestDetail } from './requests.js';

export interface OrientationTolerance { yaw: number; pitch: number; roll: number }

export interface MoveProps {
  location: LocationPoint;
  orientation?: Orientation;           // in examples but not Table C.3 (spec §3.1)
  toleranceRadius?: number;
  orientationTolerance?: OrientationTolerance;
  arrivalTime?: string;
}

export interface CancelProps { source: Uuid; requestId: number; actionId?: number }

export interface DockProps {
  dockLocation: LocationPoint;
  dockId?: Uuid;
  dockActions?: DockAction[];
  toleranceRadius?: number;
  orientationTolerance?: OrientationTolerance;
}

interface BuilderOpts { blocking?: boolean; atomic?: boolean; version?: string }

function detail(type: string, properties: Record<string, unknown>, opts: BuilderOpts = {}): RequestDetail {
  return {
    type,
    version: opts.version ?? PROTOCOL_VERSION,
    format: 'ISO-21423',
    blocking: opts.blocking ?? true,
    atomic: opts.atomic ?? false,
    properties,
  };
}

export const move = (props: MoveProps, opts?: BuilderOpts): RequestDetail =>
  detail('move', { ...props }, opts);
export const pauseImr = (opts?: BuilderOpts): RequestDetail => detail('pauseImr', {}, opts);
export const resumeImr = (opts?: BuilderOpts): RequestDetail => detail('resumeImr', {}, opts);
export const cancelRequest = (props: CancelProps, opts?: BuilderOpts): RequestDetail =>
  detail('cancelRequest', { ...props }, opts);
export const dock = (props: DockProps, opts?: BuilderOpts): RequestDetail =>
  detail('dock', { ...props }, opts);
export const undock = (opts?: BuilderOpts): RequestDetail => detail('undock', {}, opts);
