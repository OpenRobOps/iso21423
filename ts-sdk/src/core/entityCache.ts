import type { Uuid } from '../types/common.js';
import type { EntityIdentity } from '../types/identity.js';
import type { Iso21423Session, TopicMeta } from '../session/session.js';
import { validateMessage } from '../schema/validators.js';
import { ROOT_NAMESPACE, LOST_CONNECTION_STATE } from '../types/constants.js';

/** One entity's known-state snapshot in the {@link EntityCache}. */
export interface EntityCatalogEntry {
  entityUuid: Uuid;
  entityType: string;
  identity: EntityIdentity;
  manages: readonly Uuid[];
  managedBy?: Uuid;
  lost: boolean;
  firstSeen: Date;
  lastSeen: Date;
}

/** Public read/observe surface over the discovered-entity catalog. */
export interface EntityCatalog {
  entities(): EntityCatalogEntry[];
  get(uuid: Uuid): EntityCatalogEntry | undefined;
  managedBy(uuid: Uuid): EntityCatalogEntry[];
  on(event: 'entity' | 'lost' | 'gone', cb: (e: EntityCatalogEntry) => void): void;
}

/**
 * Best-effort local catalog built purely from retained `identity` messages (D-18) —
 * never a broker query. Also backs destination-type resolution and capability checks.
 */
export class EntityCache implements EntityCatalog {
  private readonly byUuid = new Map<Uuid, EntityCatalogEntry>();
  private readonly listeners: Record<'entity' | 'lost' | 'gone', Array<(e: EntityCatalogEntry) => void>> =
    { entity: [], lost: [], gone: [] };
  private disconnectionSubscribed = false;

  constructor(private readonly session: Iso21423Session) {}

  /** Subscribed once per client session (decision 3): identities are cheap and always needed. */
  async start(): Promise<void> {
    // kind: null — a zero-byte retained clear must be seen as a removal, not a warning.
    await this.session.subscribeTopic(
      `${ROOT_NAMESPACE}/+/+/identity`, null, (raw, meta) => this.onIdentity(raw, meta),
      { qos: 1 });
  }

  /** Disconnection tracking is only wired when someone actually calls discover(). */
  async watchDisconnections(): Promise<void> {
    if (this.disconnectionSubscribed) return;
    this.disconnectionSubscribed = true;
    await this.session.subscribeTopic(
      `${ROOT_NAMESPACE}/+/+/disconnection`, null, (raw, meta) => this.onDisconnection(raw, meta),
      { qos: 1 });
  }

  entities(): EntityCatalogEntry[] { return [...this.byUuid.values()]; }
  get(uuid: Uuid): EntityCatalogEntry | undefined { return this.byUuid.get(uuid); }
  managedBy(uuid: Uuid): EntityCatalogEntry[] {
    return this.entities().filter((e) => e.managedBy === uuid);
  }

  on(event: 'entity' | 'lost' | 'gone', cb: (e: EntityCatalogEntry) => void): void {
    this.listeners[event].push(cb);
  }

  /** Removal path for `on()` — not part of the public `EntityCatalog` interface (D-18 consumers
   *  never unsubscribe from discovery), but used internally so per-call listeners don't leak. */
  off(event: 'entity' | 'lost' | 'gone', cb: (e: EntityCatalogEntry) => void): void {
    const arr = this.listeners[event];
    const i = arr.indexOf(cb);
    if (i !== -1) arr.splice(i, 1);
  }

  /** Destination entityType resolution for request topics (decision 2). */
  entityTypeOf(uuid: Uuid): string | undefined { return this.byUuid.get(uuid)?.entityType; }

  /** Known-accepts lookup for NotCapableError (decision 4); undefined = unknown entity. */
  acceptsOf(uuid: Uuid): string[] | undefined {
    const entry = this.byUuid.get(uuid);
    if (!entry) return undefined;
    return entry.identity.capabilities?.accepts?.requests;
  }

  private onIdentity(raw: unknown, meta: TopicMeta): void {
    const text = typeof raw === 'string' ? raw : '';
    if (text.length === 0) {
      const gone = this.byUuid.get(meta.entityUuid);
      if (gone) {
        this.byUuid.delete(meta.entityUuid);
        this.emit('gone', gone);
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;                                   // third-party noise never breaks the catalog
    }
    const result = validateMessage('entityIdentity', parsed);
    if (!result.ok) return;
    const identity = result.value as EntityIdentity;
    const now = new Date();
    const prev = this.byUuid.get(meta.entityUuid);
    const entry: EntityCatalogEntry = {
      entityUuid: meta.entityUuid,
      entityType: identity.entityType ?? meta.entityType,
      identity,
      manages: identity.capabilities?.manages ?? [],
      managedBy: identity.capabilities?.managedBy,
      // Preserve connectivity status across an identity re-publish (e.g. an owned-retained
      // resend after the transport reconnects, session.ts's handleConnectionState): only a
      // disconnection message (onDisconnection) or a real reconnect-clear should change this.
      lost: prev?.lost ?? false,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
    };
    this.byUuid.set(entry.entityUuid, entry);
    this.emit('entity', entry);
  }

  private onDisconnection(raw: unknown, meta: TopicMeta): void {
    const entry = this.byUuid.get(meta.entityUuid);
    if (!entry) return;
    const text = typeof raw === 'string' ? raw : '';
    const lost = text.length > 0 && text.includes(LOST_CONNECTION_STATE);
    if (lost === entry.lost) return;
    const updated = { ...entry, lost, lastSeen: new Date() };
    this.byUuid.set(entry.entityUuid, updated);
    if (lost) this.emit('lost', updated);
  }

  private emit(event: 'entity' | 'lost' | 'gone', e: EntityCatalogEntry): void {
    for (const cb of this.listeners[event]) cb(e);
  }
}
