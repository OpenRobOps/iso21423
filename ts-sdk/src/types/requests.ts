import type { Uuid, IsoTimestamp } from './common.js';
import type { RequestState, DetailState, ReasonCode } from './constants.js';

export interface RequestDetail {
  type: string;
  version: string;
  format?: string;                     // default "ISO-21423"
  blocking?: boolean;                  // default true
  atomic?: boolean;                    // default false
  properties?: Record<string, unknown>;
}

export interface Request {
  destination: Uuid | '';              // "" → IMRFM picks the robot (spec §3.1)
  source: Uuid;
  sequenceId: number;
  timestamp: IsoTimestamp;
  priority?: number;                   // 0 high … 255 low, default 100
  atomic?: boolean;
  details: RequestDetail[];
  recoveries?: RequestDetail[];
}

export interface DetailStatusBody {
  code: DetailState;
  reason?: ReasonCode;
  message?: string;
  [vendor: string]: unknown;
}

export interface RequestDetailStatus {
  type: string;
  version: string;
  blocking?: boolean;
  status: DetailStatusBody;
  properties?: Record<string, unknown>;
}

export interface RequestStatus {
  source: Uuid;
  destination: Uuid;
  sequenceId: number;
  requestSequenceId: number;
  timestamp: IsoTimestamp;
  status: RequestState;
  detailStatuses: RequestDetailStatus[];
  recoveryStatuses?: RequestDetailStatus[];
}
