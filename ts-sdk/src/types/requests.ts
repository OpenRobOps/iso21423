import type { Uuid, IsoTimestamp } from './common.js';
import type { RequestState, DetailState, ReasonCode } from './constants.js';

/** One action within a {@link Request}'s `details` array. */
export interface RequestDetail {
  type: string;
  version: string;
  format?: string;                     // default "ISO-21423"
  blocking?: boolean;                  // default true
  atomic?: boolean;                    // default false
  properties?: Record<string, unknown>;
}

/** Wire shape of an ISO 21423 request message, one or more {@link RequestDetail} actions bundled together. */
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

/** Status of a single detail/action. Allows arbitrary vendor extension keys alongside the standard fields. */
export interface DetailStatusBody {
  code: DetailState;
  reason?: ReasonCode;
  message?: string;
  [vendor: string]: unknown;
}

/** Status of one {@link RequestDetail}, mirroring its `type`/`version`/`blocking`. */
export interface RequestDetailStatus {
  type: string;
  version: string;
  blocking?: boolean;
  status: DetailStatusBody;
  properties?: Record<string, unknown>;
}

/** Wire shape of a status message replying to a {@link Request}. */
export interface RequestStatus {
  source: Uuid;
  destination: Uuid;
  sequenceId: number;
  requestSequenceId: number;                  // echoes the originating Request.sequenceId
  timestamp: IsoTimestamp;
  status: RequestState;
  detailStatuses: RequestDetailStatus[];
  recoveryStatuses?: RequestDetailStatus[];
}
