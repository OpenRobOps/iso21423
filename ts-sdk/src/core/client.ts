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
import { RequestHandle } from './requestHandle.js';
import { EntityFilter, RequestFilter, RequestStatusFilter } from './filters.js';
import { composeSubscription, type Subscription } from './subscription.js';
import { messageKindFor, type ResourceKind } from './resources.js';
import { cancelRequest } from '../types/actions.js';
import type {
  ClientHealth, DiagnosticCode, DiagnosticEvent, EntityRegistration, ExecutionPolicy,
  ManagedEntityRegistration, RequestEvent, ResourceEvent, SecurityOptions,
} from './types.js';
import { DEFAULT_EXECUTION_POLICY } from './policies.js';
import { publishSelfCheck } from './selfCheck.js';

// Lazy module-level singleton (brief: "a shared FileSequenceStore()") — two clients in one
// process share the same write queue instead of racing separate ones against the same file.
let sharedSequenceStore: FileSequenceStore | undefined;
function defaultSequenceStore(): FileSequenceStore {
  return sharedSequenceStore ??= new FileSequenceStore();
}

/** Options for {@link Iso21423Client.connect}. */
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
  private readonly inFlightRequests = new Set<RequestHandle>();

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
    this.sequenceStore = opts.sequenceStore === null ? null : (opts.sequenceStore ?? defaultSequenceStore());
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

  /**
   * Registers this process's own entity: opens the session (arming the B.4 Last Will) if it
   * isn't open yet, and publishes the resulting identity. Must be the first operation on the
   * client (P-4) — if a session is already open under a different entity, throws rather than
   * silently registering under the wrong identity/will.
   */
  async registerSelfEntity(reg: EntityRegistration): Promise<EntityHandle> {
    const ref: EntityRef = { entityType: reg.entityType, entityUuid: reg.entityUuid };
    const session = await this.ensureSession(ref);
    if (session.entity.entityType !== ref.entityType || session.entity.entityUuid !== ref.entityUuid) {
      throw new Iso21423Error(
        'register the self entity before any other operation, so the B.4 Last Will can be armed ' +
        'at connect time (P-4)');
    }
    const sequence = await this.openSequence(reg.entityUuid);
    const { ctx, bindSelf } = this.contextFor(ref, sequence);
    const handle = new EntityHandle(ctx, 'self', reg);
    bindSelf(handle);
    await handle.publishIdentity(handle.identity());
    if (this.security?.selfCheck) await this.runSelfCheck(handle);
    this.selfEntities.set(reg.entityUuid, handle);
    return handle;
  }

  /**
   * Registers an entity managed on behalf of `managerUuid` (an already-registered self entity,
   * per B.5.2.4): publishes the managed entity's identity with `managedBy` set, and updates the
   * manager's own retained identity to include it in `manages`.
   */
  async registerManagedEntity(managerUuid: Uuid, reg: ManagedEntityRegistration): Promise<EntityHandle> {
    const manager = this.selfEntities.get(managerUuid);
    if (!manager) {
      throw new Iso21423Error(
        `registerManagedEntity: "${managerUuid}" is not a registered self entity`);
    }
    const entityType = reg.entityType ?? 'IMR';
    const ref: EntityRef = { entityType, entityUuid: reg.entityUuid };
    const sequence = await this.openSequence(reg.entityUuid);
    const { ctx, bindSelf } = this.contextFor(ref, sequence);
    const handle = new EntityHandle(ctx, 'managed', { ...reg, entityType });
    bindSelf(handle);
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

  /** @internal — FleetGateway.registerImr rollback (ND-15 self-check failure): drops a managed
   *  entity's handle so listManagedEntities()/health() stop reporting it. */
  removeManagedEntity(managerUuid: Uuid, entityUuid: Uuid): void {
    const list = this.managedEntities.get(managerUuid);
    if (!list) return;
    this.managedEntities.set(managerUuid, list.filter((h) => h.entityUuid !== entityUuid));
  }

  /** Set the client-wide default execution policy (P-2), overridable per entity handle. */
  setDefaultExecutionPolicy(policy: ExecutionPolicy): void {
    this.defaultExecutionPolicy = policy;
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
    const listener = (entry: EntityCatalogEntry): void => {
      if (!active || !matches(entry)) return;
      this.counters.received++;
      handler(entry.identity);
    };
    cache.on('entity', listener);

    const topicFilters = Object.freeze(filter.topicFiltersFor('identity'));
    const sub: Subscription = {
      topicFilters,
      get active() { return active; },
      async unsubscribe() {
        active = false;
        cache.off('entity', listener);
      },
      async [Symbol.asyncDispose]() { await sub.unsubscribe(); },
    };
    return this.trackSubscription(sub);
  }

  /** Subscribes to a raw resource (not identity — see {@link subscribeEntities}) across every entity `filter` selects. */
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

  /** Observes inbound requests matching `filter`, without participating in serving them (no admission/status effects). */
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

  /** Observes request status updates matching `filter`, e.g. for a fleet-wide activity dashboard. */
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
    void this.ensureSession().then(() => this.cache!.watchDisconnections())
      // No fitting DiagnosticCode for "the session itself never opened" — console.error, same
      // fallback convention as Iso21423Session.emitError with no error listeners.
      .catch((err) => console.error('[Iso21423Client] discover(): failed to open session', err));

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

  /** Point-in-time snapshot of connection state, registered entities, subscription/traffic counters — see {@link ClientHealth}. */
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
      activeRequests: { sent: this.inFlightRequests.size, serving: this.servingCount() },
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
    this.failAllInFlight();
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
      // nodejs_api.md §12: an offline broker fails every in-flight request instead of hanging.
      if (s === 'offline') this.failAllInFlight();
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

  /**
   * `bindSelf` must be called with the `EntityHandle` built from the returned `ctx`, right after
   * construction — `sendCancel` re-enters `EntityHandle.sendRequest` (cancel = a new request,
   * D-02) and `contextFor` necessarily runs before that `EntityHandle` exists.
   */
  private contextFor(
    ref: EntityRef, sequence: SequenceCounter,
  ): { ctx: EntityContext; bindSelf: (handle: EntityHandle) => void } {
    const box: { handle?: EntityHandle } = {};
    const ctx: EntityContext = {
      session: this.session!,
      ref,
      sequence,
      catalog: this.cache!,
      diagnostic: (code, detail) => this.diagnostic(code, detail),
      countPublish: () => { this.counters.published++; },
      requestTimeoutMs: this.requestTimeoutMs,
      sendCancel: async (handle, actionId) => {
        const destRef = handle.internalDestRef();
        await box.handle!.sendRequest({
          destination: destRef.entityUuid,
          destinationType: destRef.entityType,
          details: [cancelRequest({
            source: handle.sourceUuid, requestId: handle.sequenceId,
            ...(actionId !== undefined ? { actionId } : {}),
          })],
          requireCapability: false,
        });
      },
      trackInFlight: (handle) => {
        this.inFlightRequests.add(handle);
        const drop = () => { this.inFlightRequests.delete(handle); };
        handle.completion().then(drop, drop);
      },
      getDefaultExecutionPolicy: () => {
        return this.defaultExecutionPolicy ?? DEFAULT_EXECUTION_POLICY;
      },
      getExecutionPolicy: () => {
        // Resolution order: per-handle override > registration seed > client default > DEFAULT_EXECUTION_POLICY
        return box.handle!.getExecutionPolicy();
      },
    };
    return { ctx, bindSelf: (handle) => { box.handle = handle; } };
  }

  private failAllInFlight(): void {
    for (const handle of [...this.inFlightRequests]) handle.failFast();
  }

  /** Identity-echo publish self-check (ND-15): confirms our own retained identity round-trips.
   *  Shares its implementation with FleetGateway's self-check (default ON there, OFF here). */
  private async runSelfCheck(handle: EntityHandle): Promise<void> {
    await publishSelfCheck(this.session!, handle.ctx.ref, this.security?.selfCheckTimeoutMs);
  }

  private diagnostic(code: DiagnosticCode, detail?: unknown): void {
    if (code === 'dispatch-rejected') this.counters.rejections++;
    const event: DiagnosticEvent = { code, detail, at: new Date() };
    for (const cb of this.listeners.diagnostic) cb(event);
  }

  /** ND-18: sum of servingCount() across every self and managed handle. */
  private servingCount(): number {
    let n = 0;
    for (const handle of this.selfEntities.values()) n += handle.servingCount();
    for (const list of this.managedEntities.values()) for (const handle of list) n += handle.servingCount();
    return n;
  }

  /** Wraps a raw {@link Subscription} to maintain `subscriptionCount` and the tracked-subs set that `close()` drains. */
  private trackSubscription(sub: Subscription): Subscription {
    this.subscriptionCount += sub.topicFilters.length;
    let counted = true;
    const wrapped: Subscription = {
      topicFilters: sub.topicFilters,
      get active() { return sub.active; },
      unsubscribe: async () => {
        this.trackedSubs.delete(wrapped);
        await sub.unsubscribe();
        if (counted) {
          counted = false;
          this.subscriptionCount -= sub.topicFilters.length;
        }
      },
      [Symbol.asyncDispose]: async () => { await wrapped.unsubscribe(); },
    };
    // Track the wrapped subscription (not the raw one) — close() calls unsubscribe() on every
    // tracked entry, and only the wrapper's unsubscribe() does the counter/set bookkeeping.
    this.trackedSubs.add(wrapped);
    return wrapped;
  }
}
