import type {
  MqttTransport, TransportConnectOptions, TransportMessage, ConnectionState,
} from '../session/transport.js';
import { topicFilterMatches } from '../topics/topics.js';

interface Sub { filter: string; qos: 0 | 1 | 2 }

/**
 * In-process stand-in for an MQTT broker: routes published messages to matching subscribers,
 * stores retained messages, and can simulate a denied subscription or a dropped connection.
 * Pairs with {@link MemoryTransport} to test the SDK without a real broker.
 */
export class MemoryBroker {
  private clients = new Set<MemoryTransport>();
  private retained = new Map<string, TransportMessage>();
  private deniedFilters: string[] = [];
  private log: TransportMessage[] = [];

  createTransport(): MemoryTransport {
    const t = new MemoryTransport(this);
    this.clients.add(t);
    return t;
  }

  /** Makes future `subscribe()` calls for exactly this filter string report `granted: false`, for testing subscription-denied paths. */
  denySubscribe(filterPattern: string): void {
    this.deniedFilters.push(filterPattern);
  }

  isDenied(filter: string): boolean {
    // ponytail: exact-filter match only; make wildcard-aware if a test ever needs prefix denial
    return this.deniedFilters.includes(filter);
  }

  /** Current retained payload for `topic`, if any — mirrors what a newly-subscribing client would receive. */
  retainedOn(topic: string): Buffer | undefined {
    return this.retained.get(topic)?.payload;
  }

  /** All messages ever routed to exactly `topic`, in publish order (test assertion helper). */
  messagesOn(topic: string): TransportMessage[] {
    return this.log.filter((m) => m.topic === topic);
  }

  /** Every logged message whose topic starts with `prefix` (test convenience). */
  messagesUnder(prefix: string): TransportMessage[] {
    return this.log.filter((m) => m.topic.startsWith(prefix));
  }

  /** Logs `msg`, updates the retained-message store (empty payload clears it), and delivers it to every connected client. */
  route(msg: TransportMessage): void {
    this.log.push(msg);
    if (msg.retain) {
      if (msg.payload.length === 0) this.retained.delete(msg.topic);
      else this.retained.set(msg.topic, msg);
    }
    for (const c of this.clients) {
      c.deliver(msg); // deliver() isolates callback exceptions internally, never throws
    }
  }

  /** Asynchronously (next tick) delivers every retained message matching `filter` to `to`, mimicking a real broker's SUBSCRIBE-time redelivery. */
  deliverRetained(to: MemoryTransport, filter: string): void {
    for (const msg of this.retained.values()) {
      if (topicFilterMatches(filter, msg.topic)) {
        setImmediate(() => to.deliver(msg, filter));
      }
    }
  }

  /** Routes a client's LWT if the disconnect was ungraceful and a will was armed; a graceful `end()` never fires the will. */
  disconnected(t: MemoryTransport, ungraceful: boolean): void {
    if (ungraceful && t.will) {
      this.route({
        topic: t.will.topic,
        payload: Buffer.from(t.will.payload),
        qos: t.will.qos,
        retain: t.will.retain,
      });
    }
  }

  /** Every live subscription across all clients — for lazy-subscribe and QoS assertions. */
  subscriptions(): Array<{ clientId: string; filter: string; qos: 0 | 1 | 2 }> {
    return [...this.clients].flatMap((c) =>
      c.subscriptions().map((s) => ({ clientId: c.clientId, ...s })));
  }
}

/** {@link MqttTransport} implementation backed by a {@link MemoryBroker}, for broker-free tests. */
export class MemoryTransport implements MqttTransport {
  will: TransportConnectOptions['will'];
  clientId = '';
  private subs: Sub[] = [];
  private messageCbs: Array<(m: TransportMessage) => void> = [];
  private stateCbs: Array<(s: ConnectionState) => void> = [];
  private connected = false;
  private reconnectTimer: NodeJS.Immediate | null = null;

  constructor(private readonly broker: MemoryBroker) {}

  async connect(opts: TransportConnectOptions): Promise<void> {
    this.will = opts.will;
    this.clientId = opts.clientId;
    this.connected = true;
    this.emitState('connected');
  }

  async publish(topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void> {
    this.broker.route({
      topic,
      payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
      qos: opts.qos,
      retain: opts.retain,
    });
  }

  /** Subscribes (unless the broker has denied this filter) and triggers retained-message redelivery for it. */
  async subscribe(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<{ granted: boolean }> {
    if (this.broker.isDenied(filter)) return { granted: false };
    // Re-subscribing the same (filter, qos) pair replaces the entry, as on a real broker.
    if (!this.subs.some((s) => s.filter === filter && s.qos === opts.qos)) {
      this.subs.push({ filter, qos: opts.qos });
    }
    this.broker.deliverRetained(this, filter);
    return { granted: true };
  }

  async unsubscribe(filter: string): Promise<void> {
    this.subs = this.subs.filter((s) => s.filter !== filter);
  }

  subscriptions(): ReadonlyArray<{ filter: string; qos: 0 | 1 | 2 }> {
    return [...this.subs];
  }

  onMessage(cb: (m: TransportMessage) => void): void {
    this.messageCbs.push(cb);
  }

  onConnectionState(cb: (s: ConnectionState) => void): void {
    this.stateCbs.push(cb);
  }

  /**
   * Delivers `msg` to this client's message callbacks if it's currently connected and either
   * `viaFilter` is given (a targeted retained redelivery, always delivered) or the topic matches
   * one of this client's live subscriptions. Isolates each callback's exceptions so one bad
   * handler can't break delivery to the others.
   */
  deliver(msg: TransportMessage, viaFilter?: string): void {
    if (!this.connected) return;
    const matched = viaFilter !== undefined
      || this.subs.some((s) => topicFilterMatches(s.filter, msg.topic));
    if (matched) {
      for (const cb of this.messageCbs) {
        try {
          cb(msg);
        } catch (err) {
          console.error('[MemoryTransport] subscriber callback threw:', err);
        }
      }
    }
  }

  /** Simulate ungraceful TCP loss: will fires, then auto-reconnect. */
  dropConnection(): void {
    this.connected = false;
    if (this.reconnectTimer) clearImmediate(this.reconnectTimer);
    this.emitState('reconnecting');
    this.broker.disconnected(this, true);
    this.reconnectTimer = setImmediate(() => {
      this.reconnectTimer = null;
      this.connected = true;
      this.emitState('connected');
    });
  }

  async end(): Promise<void> {
    if (this.reconnectTimer) clearImmediate(this.reconnectTimer);
    this.connected = false;
    this.broker.disconnected(this, false);
    this.emitState('closed');
  }

  private emitState(s: ConnectionState): void {
    for (const cb of this.stateCbs) {
      try {
        cb(s);
      } catch (err) {
        console.error('[MemoryTransport] subscriber callback threw:', err);
      }
    }
  }
}
