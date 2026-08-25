import type { IsoTimestamp, Uuid } from '../types/common.js';
import type { ConnectionState } from '../session/transport.js';
import type { OperatingState, ReasonCode, RequestState, DetailState } from '../types/constants.js';
import type { Capabilities, EntityIdentity } from '../types/identity.js';
import type { LocationPointStamped } from '../types/telemetry.js';
import type { Request, RequestDetail } from '../types/requests.js';
import { nowTimestamp } from '../types/common.js';
import type { ResourceKind } from './resources.js';
import type { ExecutionPolicy } from './policies.js';

/** nodejs_api.md calls the wire enum StatusReason; Plan 1 named it ReasonCode (decision 9). */
export type StatusReason = ReasonCode;

export type WithOptionalTimestamp<T> = Omit<T, 'timestamp'> & { timestamp?: Date | IsoTimestamp };

/** Accept Date or string at API boundaries; always emit dot-decimal ISO 8601 (ND-07). */
export function toTimestamp(t?: Date | IsoTimestamp): IsoTimestamp {
  if (typeof t === 'string') return t;
  return nowTimestamp(t ?? new Date());
}

export type { ExecutionPolicy };

/** Options for registering an entity's identity via `Iso21423Client.registerSelfEntity`/`registerManagedEntity`. */
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

/** Input to publish a new {@link EntityStatus} snapshot. */
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

/** Payload delivered to a resource observer callback: the validated/parsed message plus its origin. */
export interface ResourceEvent<T = unknown> {
  entityType: string;
  entityUuid: Uuid;
  kind: ResourceKind;
  topic: string;
  message: T;
}

/** Payload delivered to a request observer callback. */
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

/** Internal, non-fatal conditions the client surfaces via a diagnostics event rather than throwing or logging directly. */
export type DiagnosticCode =
  | 'sequence-store-unavailable' | 'legacy-cancel-normalized' | 'inbound-illegal-transition'
  | 'self-check-failed' | 'janitor-cleared' | 'duplicate-request-ignored'
  | 'dispatch-rejected' | 'will-not-armed';

export interface DiagnosticEvent { code: DiagnosticCode; detail?: unknown; at: Date }

/** Point-in-time snapshot of client connection/entity/subscription/traffic state. */
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
/** Publishes a new overall status for the whole request. */
export interface RequestStatusUpdate { status: RequestState; reason?: StatusReason; message?: string }
/** Publishes a new status for one detail by its index in the request's `details` array. */
export interface RequestDetailStatusUpdate {
  index: number;
  status: DetailState;
  reason?: StatusReason;
  message?: string;
  properties?: Record<string, unknown>;
}
/** Marks the request finished; `status` is restricted to the actual terminal states (no `RECOVERY`, which is not itself terminal). */
export interface RequestTerminalUpdate {
  status: Extract<RequestState, 'SUCCEEDED' | 'ABORTED' | 'CANCELED'>;
  reason?: StatusReason;
  message?: string;
}

/** A {@link RequestDetail} with its `properties` narrowed to the action's own payload shape `P`. */
export type TypedRequestDetail<P = Record<string, unknown>> =
  Omit<RequestDetail, 'properties'> & { properties: P };

/** Terminal outcome an {@link ActionHandler} returns (via `ctx.succeeded`/`ctx.aborted`) for one action. */
export type ActionResult =
  | { outcome: 'succeeded'; properties?: Record<string, unknown> }
  | { outcome: 'aborted'; reason: StatusReason; message?: string };

/** Handed to an {@link ActionHandler}: the executing entity, the request being served, a cancellation signal, and helpers to report progress/finish the action. */
export interface ActionContext {
  readonly entity: import('./entityHandle.js').EntityHandle;
  readonly request: Request;
  readonly signal: AbortSignal;
  /** Publishes an EXECUTING detail-status update carrying arbitrary vendor properties, without changing lifecycle state. */
  progress(properties: Record<string, unknown>): void;
  succeeded(properties?: Record<string, unknown>): ActionResult;
  aborted(reason: StatusReason, message?: string): ActionResult;
}

/** User-supplied implementation of one action type, registered via `EntityHandle.onRequest`. */
export type ActionHandler<P = Record<string, unknown>> =
  (action: TypedRequestDetail<P>, ctx: ActionContext) => Promise<ActionResult>;

export type { EntityIdentity };
