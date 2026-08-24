import type { Iso21423Session } from '../session/session.js';
import type { EntityRef } from '../topics/topics.js';
import type { Uuid } from '../types/common.js';
import type { OperatingState } from '../types/constants.js';
import type { BatteryStatus, GlobalPath, GlobalPlan, Odometry } from '../types/telemetry.js';
import type { EntityIdentity } from '../types/identity.js';
import { PROTOCOL_VERSION } from '../types/constants.js';
import { messageKindFor } from './resources.js';
import {
  toTimestamp, type EntityRegistration, type LocalTrajectoryUpdate, type StatusUpdate,
  type WithOptionalTimestamp,
} from './types.js';
import type { SequenceCounter } from './sequence.js';
import type { EntityCache } from './entityCache.js';
import type { DiagnosticCode } from './types.js';

/** Internal seam shared by the publication, requester and executor mixins (Tasks 4–7). */
export interface EntityContext {
  session: Iso21423Session;
  ref: EntityRef;
  sequence: SequenceCounter;
  catalog: EntityCache;
  diagnostic(code: DiagnosticCode, detail?: unknown): void;
  countPublish(): void;
  requestTimeoutMs: number;
}

const RETAINED_RESOURCES = [
  'identity', 'batteryStatus', 'globalPath', 'globalPlan', 'activeRequestsStatus', 'disconnection',
] as const;

export class EntityHandle {
  #identity: EntityIdentity;
  #states: OperatingState[] = [];

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
