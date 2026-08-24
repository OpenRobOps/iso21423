import { randomUUID } from 'node:crypto';
import type { Iso21423Session } from '../session/session.js';
import type { EntityRef } from '../topics/topics.js';
import { requestStatusTopic, requestTopic } from '../topics/topics.js';
import type { Uuid } from '../types/common.js';
import type { OperatingState } from '../types/constants.js';
import type { BatteryStatus, GlobalPath, GlobalPlan, Odometry } from '../types/telemetry.js';
import type { EntityIdentity } from '../types/identity.js';
import type { Request, RequestStatus } from '../types/requests.js';
import { PROTOCOL_VERSION } from '../types/constants.js';
import { Iso21423Error, NotCapableError } from '../errors.js';
import { messageKindFor } from './resources.js';
import {
  toTimestamp, type EntityRegistration, type LocalTrajectoryUpdate, type RequestCommand,
  type StatusUpdate, type WithOptionalTimestamp, type ExecutionPolicy,
  type ActionHandler,
} from './types.js';
import type { SequenceCounter } from './sequence.js';
import type { EntityCache } from './entityCache.js';
import type { DiagnosticCode } from './types.js';
import { RequestHandle } from './requestHandle.js';
import { RequestServer } from './requestServer.js';
import type { IncomingRequest } from './incomingRequest.js';
import type { RequestAcceptanceFilter } from './filters.js';
import { composeSubscription, type Subscription } from './subscription.js';
import { ActionExecutor } from './executor.js';

/** Internal seam shared by the publication, requester and executor mixins (Tasks 4–7). */
export interface EntityContext {
  session: Iso21423Session;
  ref: EntityRef;
  sequence: SequenceCounter;
  catalog: EntityCache;
  diagnostic(code: DiagnosticCode, detail?: unknown): void;
  countPublish(): void;
  requestTimeoutMs: number;
  /** Cancel = a new request naming (source, requestId) — D-02, Table C.4. */
  sendCancel(handle: RequestHandle, actionId?: number): Promise<void>;
  /** Registers a sent request so close()/an offline connection can failFast() it and
   *  health().activeRequests.sent stays accurate; the client drops it once it settles. */
  trackInFlight(handle: RequestHandle): void;
  /** Get the client's default execution policy. */
  getDefaultExecutionPolicy(): ExecutionPolicy;
  /** Get the resolved execution policy for this entity (per-handle > registration > client default > DEFAULT_EXECUTION_POLICY). */
  getExecutionPolicy(): ExecutionPolicy;
}

const RETAINED_RESOURCES = [
  'identity', 'batteryStatus', 'globalPath', 'globalPlan', 'activeRequestsStatus', 'disconnection',
] as const;

export class EntityHandle {
  #identity: EntityIdentity;
  #states: OperatingState[] = [];
  #requestServer?: RequestServer;
  #executor?: ActionExecutor;
  #executionPolicy?: ExecutionPolicy;
  #registrationPolicy?: ExecutionPolicy;

  /** @internal — constructed by Iso21423Client.registerSelfEntity/registerManagedEntity. */
  constructor(
    readonly ctx: EntityContext,
    readonly ownershipMode: 'self' | 'managed',
    registration: EntityRegistration,
  ) {
    this.#identity = {
      id: registration.entityUuid,
      timestamp: toTimestamp(),
      entityType: registration.entityType,
      manufacturerName: registration.manufacturerName,
      iso21423Version: registration.iso21423Version ?? PROTOCOL_VERSION,
      capabilities: {
        provides: registration.capabilities?.provides ?? [],
        accepts: { requests: registration.capabilities?.accepts ?? [] },
      },
      details: registration.details ?? {},
    };
    this.#registrationPolicy = registration.executionPolicy;
  }

  get entityUuid(): Uuid { return this.ctx.ref.entityUuid; }
  get entityType(): string { return this.ctx.ref.entityType; }
  /** Last states this handle published — feeds the automatic INVALID_IMR_STATE_FOR_ACTION rule. */
  lastStates(): readonly OperatingState[] { return this.#states; }
  identity(): EntityIdentity { return this.#identity; }

  async publishIdentity(identity: EntityIdentity): Promise<void> {
    this.#identity = { ...identity, timestamp: toTimestamp(identity.timestamp) };
    await this.publish('identity', this.#identity);
  }

  async updateIdentity(partial: Partial<EntityIdentity>): Promise<void> {
    await this.publishIdentity({ ...this.#identity, ...partial, timestamp: toTimestamp() });
  }

  /** Set a per-handle execution policy override (P-2). */
  setExecutionPolicy(policy: ExecutionPolicy): void {
    this.#executionPolicy = policy;
  }

  /** Get the resolved execution policy (per-handle > registration > client default > DEFAULT_EXECUTION_POLICY). */
  getExecutionPolicy(): ExecutionPolicy {
    return this.#executionPolicy ?? this.#registrationPolicy ?? this.ctx.getDefaultExecutionPolicy();
  }

  async publishStatus(update: StatusUpdate): Promise<void> {
    this.#states = [...update.states];
    await this.publish('status', {
      entityId: this.entityUuid,
      timestamp: toTimestamp(update.timestamp),
      states: update.states,
      ...(update.disabledCapabilities ? { disabledCapabilities: update.disabledCapabilities } : {}),
    });
  }

  async publishBatteryStatus(update: WithOptionalTimestamp<BatteryStatus>): Promise<void> {
    await this.publish('batteryStatus', { ...update, timestamp: toTimestamp(update.timestamp) });
  }

  async publishOdometry(sample: WithOptionalTimestamp<Odometry>): Promise<void> {
    await this.publish('odometry', { ...sample, timestamp: toTimestamp(sample.timestamp) });
  }

  async publishLocalTrajectory(sample: LocalTrajectoryUpdate): Promise<void> {
    await this.publish('localTrajectory', {
      timestamp: toTimestamp(sample.timestamp),
      localTrajectory: sample.points,
    });
  }

  async publishGlobalPath(snapshot: WithOptionalTimestamp<GlobalPath>): Promise<void> {
    await this.publish('globalPath', { ...snapshot, timestamp: toTimestamp(snapshot.timestamp) });
  }

  async publishGlobalPlan(snapshot: WithOptionalTimestamp<GlobalPlan>): Promise<void> {
    await this.publish('globalPlan', { ...snapshot, timestamp: toTimestamp(snapshot.timestamp) });
  }

  async sendRequest(cmd: RequestCommand): Promise<RequestHandle> {
    const destRef = this.resolveDestRef(cmd);

    if (cmd.requireCapability !== false && cmd.destination) {
      const accepts = this.ctx.catalog.acceptsOf(cmd.destination);   // undefined = unknown
      const missing = accepts && cmd.details
        .map((d) => d.type)
        .filter((t) => !accepts.includes(t));
      if (missing && missing.length > 0) {
        throw new NotCapableError(
          `entity ${cmd.destination} does not accept: ${missing.join(', ')} ` +
          `(pass requireCapability: false to send anyway)`);
      }
    }

    const sequenceId = await this.ctx.sequence.next();
    const requestUuid = cmd.requestUuid ?? randomUUID();
    const request: Request = {
      destination: cmd.destination,
      source: this.entityUuid,
      sequenceId,
      timestamp: toTimestamp(),
      ...(cmd.priority !== undefined ? { priority: cmd.priority } : {}),
      ...(cmd.atomic !== undefined ? { atomic: cmd.atomic } : {}),
      details: cmd.details,
      ...(cmd.recoveries ? { recoveries: cmd.recoveries } : {}),
    };

    const handle = new RequestHandle(
      this.ctx, destRef, requestUuid, this.entityUuid, sequenceId, cmd.destination,
      cmd.timeoutMs ?? this.ctx.requestTimeoutMs);

    // Subscribe to the status stream BEFORE publishing, so no status can be missed.
    const sub = await this.ctx.session.subscribeTopic(
      requestStatusTopic(destRef, requestUuid), 'requestStatus',
      (msg) => handle.ingest(msg as RequestStatus), { qos: 2 });
    this.ctx.trackInFlight(handle);
    handle.armTimeout(sub);

    await this.ctx.session.publishTopic(
      requestTopic(destRef, requestUuid), 'request', request, { qos: 2, retain: true });
    this.ctx.countPublish();
    return handle;
  }

  /** Registers a low-level request handler (Task 5); Tasks 6/7 add admission and the executor
   *  hand-off on top of the same `RequestServer`. */
  async acceptRequests(
    filter: RequestAcceptanceFilter, handler: (req: IncomingRequest) => void,
  ): Promise<Subscription> {
    if (!this.#requestServer) this.#requestServer = new RequestServer(this.ctx);
    const server = this.#requestServer;
    await server.ensureStarted();
    const deregister = server.register(filter, handler);
    const requestFilterTopic = `${this.ctx.session.topicFor(this.ctx.ref, 'request')}/+`;
    return composeSubscription([requestFilterTopic], [{
      unsubscribe: async () => {
        deregister();
        if (server.handlerCount === 0) {
          await server.teardown();
          // Drop the instance too (not just its subscription): a later acceptRequests() then
          // builds a fresh RequestServer, so its `seen`/activeStatuses maps start empty instead
          // of carrying stale state from this handle's previous run.
          if (this.#requestServer === server) this.#requestServer = undefined;
        }
      },
    }]);
  }

  /**
   * Registers a per-action handler (Task 7, ND-11.1): the `ActionExecutor` becomes the fallback
   * consumer on this handle's `RequestServer` — low-level `acceptRequests` filters still win when
   * they match, otherwise any request whose details this executor recognizes is driven through
   * the executor's sequencing/atomic/recovery/cancelRequest logic. Registering a second handler
   * for the same `type` without `override: true` throws.
   */
  onRequest<P = Record<string, unknown>>(
    type: string, handler: ActionHandler<P>, opts?: { override?: true },
  ): void {
    if (!this.#executor) {
      this.#executor = new ActionExecutor();
      if (!this.#requestServer) this.#requestServer = new RequestServer(this.ctx);
      this.#requestServer.setExecutor(this.#executor, this);
      void this.#requestServer.ensureStarted().catch(() => {});
    }
    this.#executor.register(type, handler as ActionHandler, opts);
  }

  /**
   * Controller ruling R3: an empty `destination` (spec §3.1 "IMRFM picks the robot") is not a
   * literal topic segment — resolve the actual target from the identity catalog by
   * `destinationType` (default `'IMRFM'`). Exactly one match is required; the wire `Request`
   * still carries `destination: ''` (only the topic ref is resolved).
   */
  private resolveDestRef(cmd: RequestCommand): EntityRef {
    if (cmd.destination !== '') {
      const destinationType = cmd.destinationType
        ?? this.ctx.catalog.entityTypeOf(cmd.destination)
        ?? 'IMR';                                            // decision 2
      return { entityType: destinationType, entityUuid: cmd.destination };
    }
    const entityType = cmd.destinationType ?? 'IMRFM';
    const candidates = this.ctx.catalog.entities().filter((e) => e.entityType === entityType);
    if (candidates.length !== 1) {
      throw new Iso21423Error(
        `sendRequest: cannot resolve an empty destination to exactly one "${entityType}" ` +
        `entity (found ${candidates.length}) — pass destinationType and ensure exactly one ` +
        `such entity is discoverable`);
    }
    return { entityType, entityUuid: candidates[0]!.entityUuid };
  }

  /** Final OFFLINE status stays as the tombstone; every other retained topic is cleared. */
  async unregister(): Promise<void> {
    await this.publishStatus({ states: ['OFFLINE'] });
    for (const resource of RETAINED_RESOURCES) {
      await this.ctx.session.clearRetained(
        this.ctx.session.topicFor(this.ctx.ref, resource));
    }
  }

  private async publish(resource: string, payload: unknown): Promise<void> {
    await this.ctx.session.publishResource(
      this.ctx.ref, resource, messageKindFor(resource), payload);
    this.ctx.countPublish();
  }
}
