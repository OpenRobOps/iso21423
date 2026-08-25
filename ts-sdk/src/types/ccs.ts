import type { Uuid } from './common.js';

export interface Point { x: number; y: number }

/** A named coordinate system, defined by the reference points it's anchored to. */
export interface Ccs { id: Uuid; name: string; referencePointIds: Uuid[] }

export interface ReferencePoint { id: Uuid; name: string; x: number; y: number }

/** A point expressed relative to a specific {@link Ccs} rather than global coordinates. */
export interface LocationPoint { ccsId: Uuid; x: number; y: number; z: number }

/** Euler angles in radians. */
export interface Orientation { yaw: number; pitch: number; roll: number }
