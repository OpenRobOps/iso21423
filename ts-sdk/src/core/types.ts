import type { IsoTimestamp, Uuid } from '../types/common.js';
import type { ConnectionState } from '../session/transport.js';
import type { OperatingState, ReasonCode, RequestState, DetailState } from '../types/constants.js';
import type { Capabilities, EntityIdentity } from '../types/identity.js';
import type { LocationPointStamped } from '../types/telemetry.js';
import type { Request, RequestDetail } from '../types/requests.js';
import { nowTimestamp } from '../types/common.js';
import type { ResourceKind } from './resources.js';

/** nodejs_api.md calls the wire enum StatusReason; Plan 1 named it ReasonCode (decision 9). */
export type StatusReason = ReasonCode;

export type WithOptionalTimestamp<T> = Omit<T, 'timestamp'> & { timestamp?: Date | IsoTimestamp };

/** Accept Date or string at API boundaries; always emit dot-decimal ISO 8601 (ND-07). */
export function toTimestamp(t?: Date | IsoTimestamp): IsoTimestamp {
  if (typeof t === 'string') return t;
  return nowTimestamp(t ?? new Date());
}

/**
 * TODO(Task 6): tighten to the real `ExecutionPolicy` from `./policies.ts` once it exists.
 * Structural placeholder only so this task stands alone.
 */
export interface ExecutionPolicy { admit: (...args: never[]) => unknown }

export interface EntityRegistration {
  entityUuid: Uuid;
  entityType: string;
  manufacturerName: string;
  iso21423Version?: string;
  details?: Record<string, unknown>;
  /** `accepts` are action type names; the SDK wraps them into `{ requests: [...] }` (schema shape). */
  capabilities?: { provides?: string[]; accepts?: string[] };
  executionPolicy?: ExecutionPolicy;
}

export type ManagedEntityRegistration = EntityRegistration;

export interface StatusUpdate {
  states: OperatingState[];
  disabledCapabilities?: Capabilities;
  timestamp?: Date | IsoTimestamp;
}

/** Wire field is `localTrajectory` (schema); the API takes `points` (example_imr.md §2). */
export interface LocalTrajectoryUpdate {
  points: LocationPointStamped[];
  timestamp?: Date | IsoTimestamp;
}

export interface ResourceEvent<T = unknown> {
  entityType: string;
  entityUuid: Uuid;
  kind: ResourceKind;
  topic: string;
  message: T;
}

export interface RequestEvent {
  entityType: string;
  entityUuid: Uuid;
  requestUuid: Uuid;
  request: Request;
  topic: string;
}

export interface SecurityOptions {
  username?: string;
  password?: string;
  /** Passed through to the transport (TLS/mTLS material) — ND-15. */
  tls?: Record<string, unknown>;
  /** Identity-echo publish self-check: default off for clients, on for FleetGateway. */
  selfCheck?: boolean;
  selfCheckTimeoutMs?: number;
}

export type DiagnosticCode =
  | 'sequence-store-unavailable' | 'legacy-cancel-normalized' | 'inbound-illegal-transition'
  | 'self-check-failed' | 'janitor-cleared' | 'duplicate-request-ignored'
  | 'dispatch-rejected' | 'will-not-armed';

export interface DiagnosticEvent { code: DiagnosticCode; detail?: unknown; at: Date }

export interface ClientHealth {
  connection: ConnectionState;
  since: Date;
  lastConnectionChange: Date;
  entities: { self: Uuid[]; managed: Uuid[] };
  subscriptions: number;
  activeRequests: { sent: number; serving: number };
  counters: { published: number; received: number; validationWarnings: number; rejections: number };
}

/** Requester-side command (Task 4). */
export interface RequestCommand {
  destination: Uuid | '';
  /** Destination namespace type; resolved from the identity catalog, else 'IMR' (decision 2). */
  destinationType?: string;
  details: RequestDetail[];
  recoveries?: RequestDetail[];
  priority?: number;
  atomic?: boolean;
  requestUuid?: Uuid;
  /** Local-only RECEIVED deadline (D-14); default from ClientOptions.requestTimeoutMs. */
  timeoutMs?: number;
  /** Set false to skip the discovered-capability check (decision 4). */
  requireCapability?: boolean;
}

/** Executor-side updates (Tasks 5–7). */
export interface RequestStatusUpdate { status: RequestState; reason?: StatusReason; message?: string }
export interface RequestDetailStatusUpdate {
  index: number;
  status: DetailState;
  reason?: StatusReason;
  message?: string;
  properties?: Record<string, unknown>;
}
export interface RequestTerminalUpdate {
  status: Extract<RequestState, 'SUCCEEDED' | 'ABORTED' | 'CANCELED'>;
  reason?: StatusReason;
  message?: string;
}

export type TypedRequestDetail<P = Record<string, unknown>> =
  Omit<RequestDetail, 'properties'> & { properties: P };

export type ActionResult =
  | { outcome: 'succeeded'; properties?: Record<string, unknown> }
  | { outcome: 'aborted'; reason: StatusReason; message?: string };

export interface ActionContext {
  readonly entity: import('./entityHandle.js').EntityHandle;
  readonly request: Request;
  readonly signal: AbortSignal;
  progress(properties: Record<string, unknown>): void;
  succeeded(properties?: Record<string, unknown>): ActionResult;
  aborted(reason: StatusReason, message?: string): ActionResult;
}

export type ActionHandler<P = Record<string, unknown>> =
  (action: TypedRequestDetail<P>, ctx: ActionContext) => Promise<ActionResult>;

export type { EntityIdentity };
