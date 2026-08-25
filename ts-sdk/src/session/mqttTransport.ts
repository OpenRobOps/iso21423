import type {
  ConnectionState, MqttTransport, TransportConnectOptions, TransportMessage,
} from './transport.js';
import { BrokerUnavailable, Iso21423Error } from '../errors.js';

/** The minimal mqtt@5 surface the adapter uses — keeps `mqtt` out of the public types. */
export interface MqttClientLike {
  options?: { will?: { topic?: string }; clean?: boolean };
  connected: boolean;
  on(event: string, cb: (...args: never[]) => void): void;
  publishAsync(
    topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<unknown>;
  subscribeAsync(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<Array<{ topic: string; qos: number }>>;
  unsubscribeAsync(filter: string): Promise<unknown>;
  endAsync(force?: boolean): Promise<void>;
}

export interface MqttTransportOptions {
  username?: string;
  password?: string;
  /** TLS / socket options passed straight through to mqtt.connect (ND-15). */
  tls?: Record<string, unknown>;
  reconnectPeriod?: number;
}

class MqttAdapter implements MqttTransport {
  private client?: MqttClientLike;
  private ended = false;
  private wired = false;
  private readonly messageCbs: Array<(m: TransportMessage) => void> = [];
  private readonly stateCbs: Array<(s: ConnectionState) => void> = [];

  constructor(
    private readonly acquire: (opts: TransportConnectOptions) => Promise<MqttClientLike>,
    private readonly checkWill: boolean,
    private readonly ownsClient: boolean,
  ) {}

  async connect(opts: TransportConnectOptions): Promise<void> {
    const client = await this.acquire(opts);
    if (this.checkWill && opts.will && client.options?.will?.topic !== opts.will.topic) {
      throw new Iso21423Error(
        `caller-constructed mqtt client must be created with will { topic: "${opts.will.topic}", ` +
        `payload: '${opts.will.payload}', qos: ${opts.will.qos}, retain: ${opts.will.retain} } (P-4)`,
      );
    }

    // Wire message/state listeners only once per adapter
    if (!this.wired) {
      this.wired = true;
      client.on('message', ((topic: string, payload: Buffer, packet: { qos?: 0 | 1 | 2; retain?: boolean }) => {
        const msg: TransportMessage = {
          topic, payload, qos: packet?.qos ?? 0, retain: packet?.retain ?? false,
        };
        for (const cb of this.messageCbs) cb(msg);
      }) as never);
      client.on('reconnect', (() => this.emitState('reconnecting')) as never);
      client.on('offline', (() => this.emitState('offline')) as never);
      client.on('close', (() => this.emitState('closed')) as never);
      // Persistent 'connect' listener: mqtt.js re-emits 'connect' after every auto-reconnect, not
      // just the initial handshake. This is the ONLY place that emits 'connected' — the initial
      // connect's own onConnect (below) fires after this one (registered later, same event) and
      // only settles the promise/records `this.client`, so each 'connect' event still produces
      // exactly one 'connected' state, initial or reconnect alike.
      client.on('connect', (() => this.emitState('connected')) as never);
    }

    if (client.connected) {
      // Already connected (e.g. a caller-constructed client via wrapMqttClient): no 'connect'
      // event will fire for this state, so emit it directly — the persistent listener above only
      // covers events, not the already-there case.
      this.client = client;
      this.emitState('connected');
      return;
    }

    // Local settled flag ensures onConnect/onError fires at most once per promise
    let settled = false;
    const resolveReject = { resolve: null as unknown as (v: void) => void, reject: null as unknown as (r: unknown) => void };

    const onConnect = (() => {
      if (settled) return;
      settled = true;
      // 'connected' itself is emitted by the persistent listener registered above (same event) —
      // this only needs to record the live client and settle the connect() promise.
      this.client = client;
      resolveReject.resolve();
    }) as (...args: never[]) => void;

    const onError = ((err: Error) => {
      if (settled) return;
      settled = true;
      // Clean up owned clients (createMqttTransport path)
      if (this.ownsClient) {
        client.endAsync(true).catch(() => {}); // fire-and-forget
      }
      resolveReject.reject(new BrokerUnavailable(`mqtt connect failed: ${err.message}`));
    }) as (...args: never[]) => void;

    try {
      await new Promise<void>((resolve, reject) => {
        resolveReject.resolve = resolve;
        resolveReject.reject = reject;
        client.on('connect', onConnect);
        client.on('error', onError);
      });
    } finally {
      // Clean up settled listeners to prevent accumulation on retry
      try {
        const clientWithRemoval = client as { off?: (ev: string, cb: unknown) => void; removeListener?: (ev: string, cb: unknown) => void };
        (clientWithRemoval.off ?? clientWithRemoval.removeListener)?.('connect', onConnect);
        (clientWithRemoval.off ?? clientWithRemoval.removeListener)?.('error', onError);
      } catch {
        // Ignore cleanup errors (client might be disconnected/destroyed)
      }
    }
  }

  async publish(
    topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<void> {
    await this.live().publishAsync(topic, payload, opts);
  }

  async subscribe(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<{ granted: boolean }> {
    const grants = await this.live().subscribeAsync(filter, opts);
    // MQTT 3.1.1 SUBACK: return code >= 0x80 means the broker refused the filter (ND-15).
    const granted = grants.length > 0 && grants.every((g) => g.qos < 128);
    return { granted };
  }

  async unsubscribe(filter: string): Promise<void> {
    await this.live().unsubscribeAsync(filter);
  }

  onMessage(cb: (m: TransportMessage) => void): void {
    this.messageCbs.push(cb);
  }

  onConnectionState(cb: (s: ConnectionState) => void): void {
    this.stateCbs.push(cb);
  }

  async end(): Promise<void> {
    this.ended = true;
    if (this.client) await this.client.endAsync();
    this.emitState('closed');
  }

  private live(): MqttClientLike {
    if (this.ended || !this.client) throw new BrokerUnavailable('mqtt transport is not connected');
    return this.client;
  }

  private emitState(s: ConnectionState): void {
    for (const cb of this.stateCbs) cb(s);
  }
}

/** Adapt a caller-constructed mqtt client (D-07). Its will must match the SDK's (P-4). */
export function wrapMqttClient(client: MqttClientLike): MqttTransport {
  return new MqttAdapter(async () => client, true, false);
}

/**
 * Default adapter. `mqtt` is a peer dependency and is imported lazily inside connect(),
 * so importing this module never pulls mqtt into the graph (no top-level await, ND-19).
 */
export function createMqttTransport(url: string, opts: MqttTransportOptions = {}): MqttTransport {
  return new MqttAdapter(async (connectOpts) => {
    let mod: { connect: (url: string, o: Record<string, unknown>) => MqttClientLike };
    try {
      mod = (await import('mqtt')) as never;
    } catch (err) {
      throw new BrokerUnavailable(
        `the "mqtt" peer dependency is not installed: ${(err as Error).message}`,
      );
    }
    return mod.connect(url, {
      ...opts.tls,
      clientId: connectOpts.clientId,
      clean: connectOpts.cleanSession,
      keepalive: connectOpts.keepalive,
      username: connectOpts.username ?? opts.username,
      password: connectOpts.password ?? opts.password,
      reconnectPeriod: opts.reconnectPeriod,
      will: connectOpts.will,
    });
  }, false, true);
}
