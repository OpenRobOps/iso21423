import type { Uuid } from './common.js';

export interface Point { x: number; y: number }

export interface Ccs { id: Uuid; name: string; referencePointIds: Uuid[] }

export interface ReferencePoint { id: Uuid; name: string; x: number; y: number }

export interface LocationPoint { ccsId: Uuid; x: number; y: number; z: number }

export interface Orientation { yaw: number; pitch: number; roll: number }
