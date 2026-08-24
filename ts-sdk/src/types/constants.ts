export const ROOT_NAMESPACE = '/ISO_21423/v1';
export const PROTOCOL_VERSION = '1.0';

export const ENTITY_TYPES = ['IMR', 'IMRFM'] as const;
export type KnownEntityType = (typeof ENTITY_TYPES)[number];
export type EntityType = KnownEntityType | (string & {});

export const KNOWN_OPERATING_STATES = [
  'STOP_CATEGORY_0', 'STOP_CATEGORY_1', 'STOP_CATEGORY_2',
  'PAUSED', 'WAIT_FOR_RESET', 'MAPPING', 'LOST',
  'WAIT_FOR_ATTACHMENT', 'WAIT_FOR_EVENT', 'BLOCKED', 'ATTACHMENT_ACTIVE',
  'STOPPED', 'DOCKING', 'SLOWING', 'ACCELERATING',
  'LEFT_TURN', 'RIGHT_TURN', 'REVERSE', 'FORWARD', 'LINE_FOLLOWING',
  'CHARGING', 'LOW_BATTERY', 'IDLE', 'PARKED', 'OFFLINE',
  'READY', 'NOT_READY',
  'MODE_AUTO', 'MODE_SEMIAUTO', 'MODE_TELEOP', 'MODE_MANUAL', 'MODE_MAINTENANCE',
] as const;
export type KnownOperatingState = (typeof KNOWN_OPERATING_STATES)[number];
export type OperatingState = KnownOperatingState | (string & {});

export const OPERATING_MODES = [
  'MODE_AUTO', 'MODE_SEMIAUTO', 'MODE_TELEOP', 'MODE_MANUAL', 'MODE_MAINTENANCE',
] as const;

/** LWT state published by the broker on ungraceful disconnect (B.4). */
export const LOST_CONNECTION_STATE = 'LOST_CONNECTION';

export const REQUEST_STATES = [
  'RECEIVED', 'ACCEPTED', 'EXECUTING', 'CANCELED', 'SUCCEEDED', 'ABORTED', 'RECOVERY',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const DETAIL_STATES = [
  'RECEIVED', 'ACCEPTED', 'EXECUTING', 'CANCELED', 'SUCCEEDED', 'ABORTED',
] as const;
export type DetailState = (typeof DETAIL_STATES)[number];

export const KNOWN_REASON_CODES = [
  'OK', 'GENERAL_FAILURE', 'TIMEOUT', 'VERSION_NOT_SUPPORTED', 'FORMAT_NOT_SUPPORTED',
  'ACTION_NOT_IMPLEMENTED', 'REJECTED', 'MALFORMED_REQUEST', 'INVALID_IMR_STATE_FOR_ACTION',
] as const;
export type ReasonCode = (typeof KNOWN_REASON_CODES)[number] | (string & {});

export const BATTERY_HEALTH = [
  'UNKNOWN', 'HEALTHY', 'OVERHEAT', 'DEAD', 'OVERVOLTAGE', 'FAILURE', 'COLD',
] as const;
export type BatteryHealth = (typeof BATTERY_HEALTH)[number] | (string & {});

export const CHARGING_STATES = [
  'UNKNOWN', 'CHARGING', 'DISCHARGING', 'NOT_CHARGING', 'FULL',
] as const;
export type ChargingState = (typeof CHARGING_STATES)[number] | (string & {});

export const DOCK_ACTIONS = ['CHARGE', 'DUMP', 'FILL', 'LOAD', 'UNLOAD', 'PICK', 'DROP'] as const;
export type DockAction = (typeof DOCK_ACTIONS)[number] | (string & {});
