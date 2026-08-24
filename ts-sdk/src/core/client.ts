import { randomUUID } from 'node:crypto';
import type { MqttTransport, ConnectionState } from '../session/transport.js';
import { createMqttTransport } from '../session/mqttTransport.js';
import { Iso21423Session, type ValidationWarningEvent } from '../session/session.js';
import type { EntityRef } from '../topics/topics.js';
import type { Uuid } from '../types/common.js';
import type { EntityIdentity } from '../types/identity.js';
import type { Request, RequestStatus } from '../types/requests.js';
import { Iso21423Error } from '../errors.js';
import { SequenceCounter, FileSequenceStore, type SequenceStore } from './sequence.js';
import { EntityCache, type EntityCatalog, type EntityCatalogEntry } from './entityCache.js';
import { EntityHandle, type EntityContext } from './entityHandle.js';
import { EntityFilter, RequestFilter, RequestStatusFilter } from './filters.js';
import { composeSubscription, type Subscription } from './subscription.js';
import { messageKindFor, type ResourceKind } from './resources.js';
import type {
  ClientHealth, DiagnosticCode, DiagnosticEvent, EntityRegistration, ExecutionPolicy,
  ManagedEntityRegistration, RequestEvent, ResourceEvent, SecurityOptions,
} from './types.js';

export interface ClientOptions {
  transport?: MqttTransport;
  url?: string;
  security?: SecurityOptions;
  validateOutbound?: boolean;
  sourceId?: Uuid;
  sequenceStore?: SequenceStore | null;
  requestTimeoutMs?: number;
}

type ClientEvents = {
  connection: (s: ConnectionState) => void;
  'validation-warning': (w: ValidationWarningEvent) => void;
  diagnostic: (e: DiagnosticEvent) => void;
};

type CatalogListener = Parameters<EntityCatalog['on']>;

/**
 * Entry point for the ISO 21423 SDK (nodejs_api.md §6). Owns exactly one MQTT session,
 * opened lazily (decision 1) so a client can be constructed without picking an identity
 * up front — `registerSelfEntity` is what arms the B.4 Last Will.
 */
export class Iso21423Client {
  private readonly transport: MqttTransport;
  private readonly security?: SecurityOptions;
  private readonly validateOutbound?: boolean;
  private readonly sourceId?: Uuid;
  private readonly sequenceStore: SequenceStore | null;
  private readonly requestTimeoutMs: number;

  private sessionPromise?: Promise<Iso21423Session>;
  private session?: Iso21423Session;
  private cache?: EntityCache;
  private pendingCatalogListeners: CatalogListener[] = [];
  private defaultExecutionPolicy?: ExecutionPolicy;

  private readonly selfEntities = new Map<Uuid, EntityHandle>();
  private readonly managedEntities = new Map<Uuid, EntityHandle[]>();
  private readonly trackedSubs = new Set<Subscription>();

  private since?: Date;
  private lastConnectionChange?: Date;
  private subscriptionCount = 0;
  private closed = false;
  private readonly counters = { published: 0, received: 0, validationWarnings: 0, rejections: 0 };

  private readonly listeners: { [K in keyof ClientEvents]: Array<ClientEvents[K]> } = {
    connection: [], 'validation-warning': [], diagnostic: [],
  };

  private constructor(transport: MqttTransport, opts: ClientOptions) {
    this.transport = transport;
    this.security = opts.security;
    this.validateOutbound = opts.validateOutbound;
    this.sourceId = opts.sourceId;
    this.sequenceStore = opts.sequenceStore === null ? null : (opts.sequenceStore ?? new FileSequenceStore());
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
  }

  static async connect(opts: ClientOptions): Promise<Iso21423Client> {
    const hasTransport = opts.transport !== undefined;
    const hasUrl = opts.url !== undefined;
    if (hasTransport === hasUrl) {
      throw new Iso21423Error('Iso21423Client.connect requires exactly one of "transport" or "url"');
    }
    const transport = opts.transport ?? createMqttTransport(opts.url!, { ...opts.security });
    // Do not open the session here (decision 1) — the first registerSelfEntity/subscribe/discover
    // call picks the entity (or falls back to an identity-less one) and arms the will accordingly.
    return new Iso21423Client(transport, opts);
  }

  // ---- registration -------------------------------------------------------

  async registerSelfEntity(reg: EntityRegistration): Promise<EntityHandle> {
    const ref: EntityRef = { entityType: reg.entityType, entityUuid: reg.entityUuid };
    const session = await this.ensureSession(ref);
    if (session.entity.entityType !== ref.entityType || session.entity.entityUuid !== ref.entityUuid) {
      throw new Iso21423Error(
        'register the self entity before any other operation, so the B.4 Last Will can be armed ' +
        'at connect time (P-4)');
    }
    const sequence = await this.openSequence(reg.entityUuid);
    const handle = new EntityHandle(this.contextFor(ref, sequence), 'self', reg);
    await handle.publishIdentity(handle.identity());
    if (this.security?.selfCheck) await this.runSelfCheck(handle);
    this.selfEntities.set(reg.entityUuid, handle);
    return handle;
  }

  async registerManagedEntity(managerUuid: Uuid, reg: ManagedEntityRegistration): Promise<EntityHandle> {
    const manager = this.selfEntities.get(managerUuid);
    if (!manager) {
      throw new Iso21423Error(
        `registerManagedEntity: "${managerUuid}" is not a registered self entity`);
    }
    const entityType = reg.entityType ?? 'IMR';
    const ref: EntityRef = { entityType, entityUuid: reg.entityUuid };
    const sequence = await this.openSequence(reg.entityUuid);
    const handle = new EntityHandle(this.contextFor(ref, sequence), 'managed', { ...reg, entityType });
    const identity = handle.identity();
    identity.capabilities.managedBy = managerUuid;
    await handle.publishIdentity(identity);

    // B.5.2.4 link maintenance: keep the manager's retained identity in sync.
    const managerIdentity = manager.identity();
    const manages = [...(managerIdentity.capabilities.manages ?? []), reg.entityUuid];
    await manager.updateIdentity({ capabilities: { ...managerIdentity.capabilities, manages } });

    const list = this.managedEntities.get(managerUuid) ?? [];
    list.push(handle);
    this.managedEntities.set(managerUuid, list);
    return handle;
  }

  listManagedEntities(managerUuid: Uuid): EntityHandle[] {
    return [...(this.managedEntities.get(managerUuid) ?? [])];
  }

  // ---- observation --------------------------------------------------------

  /**
   * Deliberately does NOT go through `subscribeResource('identity', ...)`: the shared
   * `EntityCache` already owns the one identity-wildcard subscription (every client needs it,
   * per decision 3). A second, independent subscribeTopic() to the same filter would make the
   * fake broker (and a real one) redeliver retained identities twice over — this taps the
   * cache's own stream instead, replaying what it already knows plus every future update.
   */
  async subscribeEntities(
    filter: EntityFilter, handler: (identity: EntityIdentity) => void,
  ): Promise<Subscription> {
    await this.ensureSession();
    const cache = this.cache!;
    const matches = (e: EntityCatalogEntry) =>
      filter.matches({ entityType: e.entityType, entityUuid: e.entityUuid });

    let active = true;
    for (const entry of cache.entities()) {
      if (matches(entry)) handler(entry.identity);
    }
    cache.on('entity', (entry) => {
      if (!active || !matches(entry)) return;
      this.counters.received++;
      handler(entry.identity);
    });

    const topicFilters = Object.freeze(filter.topicFiltersFor('identity'));
    const sub: Subscription = {
      topicFilters,
      get active() { return active; },
      async unsubscribe() { active = false; }, // ponytail: EntityCache has no listener removal;
      // soft-unsubscribe (gate delivery) is enough since nothing re-subscribes on the same filter.
      async [Symbol.asyncDispose]() { active = false; },
    };
    return this.trackSubscription(sub);
  }

  async subscribeResource<T = unknown>(
    kind: ResourceKind, filter: EntityFilter, handler: (ev: ResourceEvent<T>) => void,
  ): Promise<Subscription> {
    const session = await this.ensureSession();
    const topicFilters = filter.topicFiltersFor(kind);
    const parts = await Promise.all(topicFilters.map((f) => session.subscribeTopic(
      f, messageKindFor(kind),
      (msg, meta) => {
        this.counters.received++;
        handler({
          entityType: meta.entityType, entityUuid: meta.entityUuid,
          kind, topic: meta.topic, message: msg as T,
        });
      },
    )));
    return this.trackSubscription(composeSubscription(topicFilters, parts));
  }

  async subscribeRequests(
    filter: RequestFilter, handler: (ev: RequestEvent) => void,
  ): Promise<Subscription> {
    const session = await this.ensureSession();
    const topicFilters = filter.topicFilters();
    const parts = await Promise.all(topicFilters.map((f) => session.subscribeTopic(
      f, 'request',
      (msg, meta) => {
        if (!meta.requestUuid) return;
        this.counters.received++;
        handler({
          entityType: meta.entityType, entityUuid: meta.entityUuid,
          requestUuid: meta.requestUuid, request: msg as Request, topic: meta.topic,
        });
      },
    )));
    return this.trackSubscription(composeSubscription(topicFilters, parts));
  }

  async subscribeRequestStatus(
    filter: RequestStatusFilter, handler: (ev: ResourceEvent<RequestStatus>) => void,
  ): Promise<Subscription> {
    const session = await this.ensureSession();
    const topicFilters = filter.topicFilters();
    const parts = await Promise.all(topicFilters.map((f) => session.subscribeTopic(
      f, 'requestStatus',
      (msg, meta) => {
        this.counters.received++;
        handler({
          entityType: meta.entityType, entityUuid: meta.entityUuid,
          kind: 'requestStatus', topic: meta.topic, message: msg as RequestStatus,
        });
      },
    )));
    return this.trackSubscription(composeSubscription(topicFilters, parts));
  }

  /**
   * Retained-identity-only catalog (D-18). Deliberately await-free: callers get a live handle
   * immediately, and the graph fills in as retained `identity`/`disconnection` messages arrive
   * (opening the session — identity-less if none is open yet — happens in the background).
   */
  discover(): EntityCatalog {
    // ensureSession() is idempotent — reuses the already-open session if registerSelfEntity ran
    // first, else opens an identity-less one. `this.cache` always exists once it resolves.
    void this.ensureSession().then(() => this.cache!.watchDisconnections());

    return {
      entities: () => this.cache?.entities() ?? [],
      get: (uuid: Uuid): EntityCatalogEntry | undefined => this.cache?.get(uuid),
      managedBy: (uuid: Uuid) => this.cache?.managedBy(uuid) ?? [],
      on: (event, cb) => {
        if (this.cache) {
          this.cache.on(event, cb);
        } else {
          this.pendingCatalogListeners.push([event, cb]);
        }
      },
    };
  }

  // ---- misc -----------------------------------------------------------------

  setDefaultExecutionPolicy(policy: ExecutionPolicy): void {
    this.defaultExecutionPolicy = policy;
  }

  health(): ClientHealth {
    return {
      connection: this.session?.connectionState ?? 'closed',
      since: this.since ?? new Date(0),
      lastConnectionChange: this.lastConnectionChange ?? this.since ?? new Date(0),
      entities: {
        self: [...this.selfEntities.keys()],
        managed: [...this.managedEntities.values()].flat().map((h) => h.entityUuid),
      },
      subscriptions: this.subscriptionCount,
      activeRequests: { sent: 0, serving: 0 }, // populated once Task 4 tracks in-flight requests
      counters: { ...this.counters },
    };
  }

  on<K extends keyof ClientEvents>(event: K, cb: ClientEvents[K]): void {
    this.listeners[event].push(cb);
  }

  /** Graceful shutdown: the will never fires (MemoryTransport.end() reports ungraceful:false). */
  async close(opts?: { timeout?: number }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.sessionPromise) return; // never connected: no-op
    await Promise.all([...this.trackedSubs].map((s) => s.unsubscribe().catch(() => {})));
    const session = await this.sessionPromise;
    const timeoutMs = opts?.timeout ?? 5000;
    await Promise.race([
      session.close(),
      new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs).unref?.(); }),
    ]);
  }

  // ---- internals --------------------------------------------------------

  private identitylessRef(): EntityRef {
    return { entityType: 'client', entityUuid: this.sourceId ?? randomUUID() };
  }

  private async ensureSession(self?: EntityRef): Promise<Iso21423Session> {
    if (!this.sessionPromise) this.sessionPromise = this.openSession(self);
    return this.sessionPromise;
  }

  private async openSession(self?: EntityRef): Promise<Iso21423Session> {
    const armWill = self !== undefined;
    const entity = self ?? this.identitylessRef();
    const session = await Iso21423Session.connect({
      transport: this.transport,
      entity,
      credentials: this.security && {
        username: this.security.username, password: this.security.password,
      },
      validateOutbound: this.validateOutbound,
      armWill,
    });
    if (!armWill) this.diagnostic('will-not-armed');

    this.session = session;
    this.since = new Date();
    this.lastConnectionChange = this.since;
    session.on('connection', (s) => {
      this.lastConnectionChange = new Date();
      for (const cb of this.listeners.connection) cb(s);
    });
    session.on('validation-warning', (w) => {
      this.counters.validationWarnings++;
      for (const cb of this.listeners['validation-warning']) cb(w);
    });

    this.cache = new EntityCache(session);
    await this.cache.start();
    for (const [event, cb] of this.pendingCatalogListeners) this.cache.on(event, cb);
    this.pendingCatalogListeners = [];
    return session;
  }

  private async openSequence(entityUuid: Uuid): Promise<SequenceCounter> {
    const store = this.sequenceStore === null ? undefined : this.sequenceStore;
    return SequenceCounter.open(entityUuid, store, () => this.diagnostic('sequence-store-unavailable'));
  }

  private contextFor(ref: EntityRef, sequence: SequenceCounter): EntityContext {
    return {
      session: this.session!,
      ref,
      sequence,
      catalog: this.cache!,
      diagnostic: (code, detail) => this.diagnostic(code, detail),
      countPublish: () => { this.counters.published++; },
      requestTimeoutMs: this.requestTimeoutMs,
    };
  }

  /** Minimal identity-echo publish self-check (ND-15): confirms our own retained identity round-trips. */
  private async runSelfCheck(handle: EntityHandle): Promise<void> {
    const timeoutMs = this.security?.selfCheckTimeoutMs ?? 2000;
    const topic = this.session!.topicFor(handle.ctx.ref, 'identity');
    const seen = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.session!.subscribeTopic(topic, null, () => {
        clearTimeout(timer);
        resolve(true);
      }, { qos: 1 }).then((sub) => {
        void sub.unsubscribe();
      }).catch(() => resolve(false));
    });
    if (!seen) this.diagnostic('self-check-failed');
  }

  private diagnostic(code: DiagnosticCode, detail?: unknown): void {
    const event: DiagnosticEvent = { code, detail, at: new Date() };
    for (const cb of this.listeners.diagnostic) cb(event);
  }

  private trackSubscription(sub: Subscription): Subscription {
    this.subscriptionCount += sub.topicFilters.length;
    this.trackedSubs.add(sub);
    let counted = true;
    const wrapped: Subscription = {
      topicFilters: sub.topicFilters,
      get active() { return sub.active; },
      unsubscribe: async () => {
        this.trackedSubs.delete(sub);
        await sub.unsubscribe();
        if (counted) {
          counted = false;
          this.subscriptionCount -= sub.topicFilters.length;
        }
      },
      [Symbol.asyncDispose]: async () => { await wrapped.unsubscribe(); },
    };
    return wrapped;
  }
}
