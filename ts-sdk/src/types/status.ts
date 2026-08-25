import type { Uuid, IsoTimestamp } from './common.js';
import type { OperatingState } from './constants.js';
import type { Capabilities } from './identity.js';

export interface EntityStatus {
  entityId: Uuid;                      // schema name; clause tables say "id" (spec §3.1)
  timestamp: IsoTimestamp;
  states: OperatingState[];            // mode first, then states by priority
  disabledCapabilities?: Capabilities;
}
