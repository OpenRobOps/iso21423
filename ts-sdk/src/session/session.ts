import type { MqttTransport, ConnectionState } from './transport.js';
import { RateGate } from './rateGate.js';
import { RESOURCE_CONFIG } from '../topics/resources.js';
import {
  topicFor, disconnectionTopic, parseTopic, topicFilterMatches, type EntityRef,
} from '../topics/topics.js';
import { ROOT_NAMESPACE, LOST_CONNECTION_STATE } from '../types/constants.js';
import { nowTimestamp } from '../types/common.js';
import { validateMessage, assertValid, type MessageKind } from '../schema/validators.js';
import { AuthorizationDenied, Iso21423Error } from '../errors.js';

/** Options for {@link Iso21423Session.connect}. */
export interface SessionOptions {
  transport: MqttTransport;
  entity: EntityRef;
  credentials?: { username?: string; password?: string };
  validateOutbound?: boolean;
  /** Arm the B.4 Last Will at connect time. Default true; false for identity-less sessions (R1). */
  armWill?: boolean;
}

/** Returned by `subscribeTopic` / `subscribeResource`: stop receiving on that filter. */
export interface SessionSubscription {
  unsubscribe(): Promise<void>;
}

/** Topic-derived metadata handed to subscription handlers alongside the parsed payload. */
export interface TopicMeta {
  topic: string;
  entityType: string;
  entityUuid: string;
  resource: string;
  requestUuid?: string;
  isRequestStatus: boolean;
}

/** Emitted on the `'validation-warning'` event when an inbound message fails schema validation or JSON parsing. */
export interface ValidationWarningEvent {
  topic: string;
  payload: string;
  errors: unknown[];
}

type SessionEvents = {
  connection: (s: ConnectionState) => void;
  'validation-warning': (w: ValidationWarningEvent) => void;
  error: (err: unknown) => void;
};

interface TopicSub {
  filter: string;
  kind: MessageKind | null;
  handler: (msg: unknown, meta: TopicMeta) => void;
}

/**
 * Owns one MQTT connection for a single entity: topic-scoped subscribe/publish, retained-resource
 * dedup and republish-on-reconnect, streaming-resource rate gating, LWT arming, and inbound schema
 * validation. This is the layer `/core` builds its request/response semantics on top of.
 */
export class Iso21423Session {
  private retainedOwned = new Map<string, { payload: string; qos: 0 | 1 | 2 }>();
  private rateGates = new Map<string, RateGate>();
  private topicSubs: TopicSub[] = [];
  private listeners: { [K in keyof SessionEvents]: Array<SessionEvents[K]> } = {
    connection: [], 'validation-warning': [], error: [],
  };
  private wasConnected = false;
  private state: ConnectionState = 'closed';

  private constructor(
    private readonly transport: MqttTransport,
    readonly entity: EntityRef,
    private readonly validateOutbound: boolean,
    private readonly armWill: boolean,
  ) {}

  /**
   * Connects the transport and, unless `armWill` is false, arms the B.4 Last Will and clears any
   * stale retained LOST_CONNECTION left over from a prior ungraceful disconnect (spec §4).
   */
  static async connect(opts: SessionOptions): Promise<Iso21423Session> {
    const armWill = opts.armWill ?? true;
    const session = new Iso21423Session(opts.transport, opts.entity, opts.validateOutbound ?? true, armWill);
    opts.transport.onMessage((m) => session.dispatch(m.topic, m.payload));
    opts.transport.onConnectionState((s) => session.handleConnectionState(s));
    await opts.transport.connect({
      clientId: `iso21423-${opts.entity.entityType}-${opts.entity.entityUuid}`,
      cleanSession: false,
      keepalive: 60,
      username: opts.credentials?.username,
      password: opts.credentials?.password,
      will: armWill ? {
        topic: disconnectionTopic(opts.entity),
        payload: JSON.stringify({ states: [LOST_CONNECTION_STATE] }),
        qos: 1,
        retain: true,
      } : undefined,
    });
    // Clear stale retained LOST_CONNECTION from a prior crash (spec §4). Skipped when no will was
    // armed: an identity-less session never owns a disconnection topic, so there is nothing stale
    // to clear (R1 — implementer's choice).
    if (armWill) await session.clearRetained(disconnectionTopic(opts.entity));
    return session;
  }

  /** Passthrough so `/core` never rebuilds topics itself (Task 3 implementer note). */
  topicFor(ref: EntityRef, resource: string): string {
    return topicFor(ref, resource);
  }

  on<K extends keyof SessionEvents>(event: K, cb: SessionEvents[K]): void {
    this.listeners[event].push(cb);
  }

  /**
   * Publishes a known resource (looked up in {@link RESOURCE_CONFIG} for its QoS/retain/rate).
   * Retained resources are deduped on-change (a re-publish with identical body is a no-op) and
   * rolled back from the dedup cache if the publish itself fails. Rate-limited (streaming)
   * resources go through a per-topic {@link RateGate} and are fire-and-forget: publish failures
   * there are reported via the `error` event, not thrown.
   */
  async publishResource(ref: EntityRef, resource: string, kind: MessageKind | null, payload: unknown): Promise<void> {
    const config = RESOURCE_CONFIG[resource];
    if (!config) throw new Iso21423Error(`unknown resource "${resource}"`);
    if (kind && this.validateOutbound) assertValid(kind, payload);
    const topic = topicFor(ref, resource);
    const body = JSON.stringify(payload);

    if (config.retain) {
      if (this.retainedOwned.get(topic)?.payload === body) return; // on-change rule
      this.retainedOwned.set(topic, { payload: body, qos: config.qos });
      try {
        await this.transport.publish(topic, body, { qos: config.qos, retain: true });
      } catch (err) {
        this.retainedOwned.delete(topic);
        throw err;
      }
      return;
    }
    if (config.maxHz !== undefined) {
      let gate = this.rateGates.get(topic);
      if (!gate) {
        gate = new RateGate(config.maxHz);
        this.rateGates.set(topic, gate);
      }
      gate.offer(body, (b) => {
        this.transport.publish(topic, b, { qos: config.qos, retain: false })
          .catch((err) => this.emitError(err));
      });
      return;
    }
    await this.transport.publish(topic, body, { qos: config.qos, retain: false });
  }

  /** Last non-wildcard resource segment → Table B.1 QoS, defaulting to QoS 1 when unknown. */
  private qosForFilter(filter: string): 0 | 1 | 2 {
    const parsed = parseTopic(filter);
    if (!parsed) return 1;
    const key = parsed.isRequestStatus ? 'requestStatus' : parsed.resource;
    return RESOURCE_CONFIG[key]?.qos ?? 1;
  }

  /**
   * Always issues a broker SUBSCRIBE (a real broker redelivers retained messages on every
   * SUBSCRIBE, so a late second handler must see the current retained value); the broker-side
   * unsubscribe still only fires once the last local listener on the filter leaves (ND-17).
   */
  async subscribeTopic(
    topicFilter: string,
    kind: MessageKind | null,
    handler: (msg: unknown, meta: TopicMeta) => void,
    opts: { qos?: 0 | 1 | 2 } = {},
  ): Promise<SessionSubscription> {
    const qos = opts.qos ?? this.qosForFilter(topicFilter);
    const { granted } = await this.transport.subscribe(topicFilter, { qos });
    if (!granted) {
      throw new AuthorizationDenied(`subscription denied by broker: ${topicFilter}`, topicFilter);
    }
    const sub: TopicSub = { filter: topicFilter, kind, handler };
    this.topicSubs.push(sub);
    return {
      unsubscribe: async () => {
        this.topicSubs = this.topicSubs.filter((s) => s !== sub);
        if (!this.topicSubs.some((s) => s.filter === topicFilter)) {
          await this.transport.unsubscribe(topicFilter);
        }
      },
    };
  }

  /** Publish to an exact topic (request / requestStatus topics are not plain resources). */
  async publishTopic(
    topic: string,
    kind: MessageKind | null,
    payload: unknown,
    opts: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<void> {
    if (kind && this.validateOutbound) assertValid(kind, payload);
    await this.transport.publish(topic, JSON.stringify(payload), opts);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /**
   * Subscribe to a resource topic with optional validation.
   * When kind is null, handler receives raw payload text without parsing or validation.
   */
  async subscribeResource(
    filter: { entityType?: string; entityUuid?: string },
    resource: string,
    kind: MessageKind | null,
    handler: (msg: unknown, meta: TopicMeta) => void,
  ): Promise<SessionSubscription & { [Symbol.asyncDispose](): Promise<void> }> {
    const config = RESOURCE_CONFIG[resource];
    if (!config) throw new Iso21423Error(`unknown resource "${resource}"`);
    const topicFilter = `${ROOT_NAMESPACE}/${filter.entityType ?? '+'}/${filter.entityUuid ?? '+'}/${resource}`;
    const sub = await this.subscribeTopic(topicFilter, kind, handler, { qos: config.qos });
    return { unsubscribe: sub.unsubscribe, [Symbol.asyncDispose]: sub.unsubscribe };
  }

  /** For subscribers that opt out of schema routing (kind: null) but still want to surface a
   *  malformed payload as the usual 'validation-warning' event (D-13's RequestServer). */
  reportValidationWarning(w: ValidationWarningEvent): void {
    this.emitWarning(w);
  }

  async publishRaw(topic: string, payload: string, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void> {
    await this.transport.publish(topic, payload, opts);
  }

  /** Clears a retained topic by publishing an empty retained payload, and drops it from the owned-retained dedup cache. */
  async clearRetained(topic: string): Promise<void> {
    this.retainedOwned.delete(topic);
    await this.transport.publish(topic, '', { qos: 1, retain: true });
  }

  /** Optionally publishes a final status, disposes all rate gates, then ends the transport. */
  async close(finalStates?: string[]): Promise<void> {
    if (finalStates) {
      await this.publishResource(this.entity, 'status', 'entityStatus', {
        entityId: this.entity.entityUuid,
        timestamp: nowTimestamp(),
        states: finalStates,
      });
    }
    for (const gate of this.rateGates.values()) gate.dispose();
    await this.transport.end();
  }

  /**
   * Routes an inbound message to every registered {@link TopicSub} whose filter matches the
   * topic. `kind: null` subscribers get the raw text with no parsing; typed subscribers get an
   * empty payload treated as a retained-clear (skipped silently) and malformed/non-conformant
   * payloads reported via `emitWarning` rather than delivered to the handler.
   */
  private dispatch(topic: string, payload: Buffer): void {
    const parsed = parseTopic(topic);
    if (!parsed) return;
    const text = payload.toString();
    const meta: TopicMeta = {
      topic,
      entityType: parsed.entityType,
      entityUuid: parsed.entityUuid,
      resource: parsed.resource,
      requestUuid: parsed.requestUuid,
      isRequestStatus: parsed.isRequestStatus,
    };
    for (const sub of this.topicSubs) {
      if (!topicFilterMatches(sub.filter, topic)) continue;
      if (!sub.kind) {
        sub.handler(text, meta);
        continue;
      }
      // An empty payload on a validated subscription is a retained-clear, not malformed input.
      if (text === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        this.emitWarning({ topic, payload: text, errors: ['invalid JSON'] });
        continue;
      }
      const result = validateMessage(sub.kind, value);
      if (!result.ok) {
        this.emitWarning({ topic, payload: text, errors: result.errors ?? [] });
        continue;
      }
      sub.handler(result.value, meta);
    }
  }

  private handleConnectionState(s: ConnectionState): void {
    this.state = s;
    for (const cb of this.listeners.connection) cb(s);
    if (s === 'connected' && this.wasConnected) {
      // Reconnect: republish owned retained resources (broker may have lost them).
      for (const [topic, { payload, qos }] of this.retainedOwned) {
        this.transport.publish(topic, payload, { qos, retain: true })
          .catch((err) => this.emitError(err));
      }
      // The LWT we armed at connect time has now fired (stale): clear it, same as the
      // stale-crash clear at initial connect (spec §4).
      if (this.armWill) {
        this.clearRetained(disconnectionTopic(this.entity)).catch((err) => this.emitError(err));
      }
    }
    if (s === 'connected') this.wasConnected = true;
  }

  private emitWarning(w: ValidationWarningEvent): void {
    for (const cb of this.listeners['validation-warning']) cb(w);
  }

  private emitError(err: unknown): void {
    const errorListeners = this.listeners.error;
    if (errorListeners.length > 0) {
      for (const cb of errorListeners) cb(err);
    } else {
      console.error('[Iso21423Session] async publish failed:', err);
    }
  }
}
