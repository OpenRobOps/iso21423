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

export interface SessionOptions {
  transport: MqttTransport;
  entity: EntityRef;
  credentials?: { username?: string; password?: string };
  validateOutbound?: boolean;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

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

interface ResourceSub {
  filter: string;
  resource: string;
  kind: MessageKind | null;
  handler: (msg: unknown, meta: { topic: string; entityType: string; entityUuid: string }) => void;
}

export class Iso21423Session {
  private retainedOwned = new Map<string, { payload: string; qos: 0 | 1 | 2 }>();
  private rateGates = new Map<string, RateGate>();
  private resourceSubs: ResourceSub[] = [];
  private listeners: { [K in keyof SessionEvents]: Array<SessionEvents[K]> } = {
    connection: [], 'validation-warning': [], error: [],
  };
  private wasConnected = false;

  private constructor(
    private readonly transport: MqttTransport,
    readonly entity: EntityRef,
    private readonly validateOutbound: boolean,
  ) {}

  static async connect(opts: SessionOptions): Promise<Iso21423Session> {
    const session = new Iso21423Session(opts.transport, opts.entity, opts.validateOutbound ?? true);
    opts.transport.onMessage((m) => session.dispatch(m.topic, m.payload));
    opts.transport.onConnectionState((s) => session.handleConnectionState(s));
    await opts.transport.connect({
      clientId: `iso21423-${opts.entity.entityType}-${opts.entity.entityUuid}`,
      cleanSession: false,
      keepalive: 60,
      username: opts.credentials?.username,
      password: opts.credentials?.password,
      will: {
        topic: disconnectionTopic(opts.entity),
        payload: JSON.stringify({ states: [LOST_CONNECTION_STATE] }),
        qos: 1,
        retain: true,
      },
    });
    // Clear stale retained LOST_CONNECTION from a prior crash (spec §4).
    await session.clearRetained(disconnectionTopic(opts.entity));
    return session;
  }

  on<K extends keyof SessionEvents>(event: K, cb: SessionEvents[K]): void {
    this.listeners[event].push(cb);
  }

  async publishResource(ref: EntityRef, resource: string, kind: MessageKind | null, payload: unknown): Promise<void> {
    const config = RESOURCE_CONFIG[resource];
    if (!config) throw new Iso21423Error(`unknown resource "${resource}"`);
    if (kind && this.validateOutbound) assertValid(kind, payload);
    const topic = topicFor(ref, resource);
    const body = JSON.stringify(payload);

    if (config.retain) {
      if (this.retainedOwned.get(topic)?.payload === body) return; // on-change rule
      this.retainedOwned.set(topic, { payload: body, qos: config.qos });
      await this.transport.publish(topic, body, { qos: config.qos, retain: true });
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

  /**
   * Subscribe to a resource topic with optional validation.
   * When kind is null, handler receives raw payload text without parsing or validation.
   */
  async subscribeResource(
    filter: { entityType?: string; entityUuid?: string },
    resource: string,
    kind: MessageKind | null,
    handler: ResourceSub['handler'],
  ): Promise<Subscription> {
    const config = RESOURCE_CONFIG[resource];
    if (!config) throw new Iso21423Error(`unknown resource "${resource}"`);
    const topicFilter = `${ROOT_NAMESPACE}/${filter.entityType ?? '+'}/${filter.entityUuid ?? '+'}/${resource}`;
    const { granted } = await this.transport.subscribe(topicFilter, { qos: config.qos });
    if (!granted) {
      throw new AuthorizationDenied(`subscription denied by broker: ${topicFilter}`, topicFilter);
    }
    const sub: ResourceSub = { filter: topicFilter, resource, kind, handler };
    this.resourceSubs.push(sub);
    const cleanup = async () => {
      this.resourceSubs = this.resourceSubs.filter((s) => s !== sub);
      if (!this.resourceSubs.some((s) => s.filter === topicFilter)) {
        await this.transport.unsubscribe(topicFilter);
      }
    };
    return {
      unsubscribe: cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }

  async publishRaw(topic: string, payload: string, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void> {
    await this.transport.publish(topic, payload, opts);
  }

  async clearRetained(topic: string): Promise<void> {
    this.retainedOwned.delete(topic);
    await this.transport.publish(topic, '', { qos: 1, retain: true });
  }

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

  private dispatch(topic: string, payload: Buffer): void {
    const parsed = parseTopic(topic);
    if (!parsed) return;
    for (const sub of this.resourceSubs) {
      if (parsed.resource !== sub.resource) continue;
      if (!topicFilterMatches(sub.filter, topic)) continue;
      const meta = { topic, entityType: parsed.entityType, entityUuid: parsed.entityUuid };
      const text = payload.toString();
      if (!sub.kind) {
        sub.handler(text, meta);
        continue;
      }
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
    for (const cb of this.listeners.connection) cb(s);
    if (s === 'connected' && this.wasConnected) {
      // Reconnect: republish owned retained resources (broker may have lost them).
      for (const [topic, { payload, qos }] of this.retainedOwned) {
        this.transport.publish(topic, payload, { qos, retain: true })
          .catch((err) => this.emitError(err));
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
