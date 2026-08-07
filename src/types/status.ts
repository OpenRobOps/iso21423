import type { IsoTimestamp, Uuid } from './common.js';

export const IMRFM_OPERATING_STATES = ['READY', 'NOT_READY', 'OFFLINE'] as const;

export type ImrfmOperatingState = (typeof IMRFM_OPERATING_STATES)[number];

export interface EntityStatus {
  entityId: Uuid;
  timestamp: IsoTimestamp;
  states: string[];
}
