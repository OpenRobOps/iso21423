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
  private readonly messageCbs: Array<(m: TransportMessage) => void> = [];
  private readonly stateCbs: Array<(s: ConnectionState) => void> = [];

  constructor(
    private readonly acquire: (opts: TransportConnectOptions) => Promise<MqttClientLike>,
    private readonly checkWill: boolean,
  ) {}

  async connect(opts: TransportConnectOptions): Promise<void> {
    const client = await this.acquire(opts);
    if (this.checkWill && opts.will && client.options?.will?.topic !== opts.will.topic) {
      throw new Iso21423Error(
        `caller-constructed mqtt client must be created with will { topic: "${opts.will.topic}", ` +
        `payload: '${opts.will.payload}', qos: ${opts.will.qos}, retain: ${opts.will.retain} } (P-4)`,
      );
    }
    this.client = client;
    client.on('message', ((topic: string, payload: Buffer, packet: { qos?: 0 | 1 | 2; retain?: boolean }) => {
      const msg: TransportMessage = {
        topic, payload, qos: packet?.qos ?? 0, retain: packet?.retain ?? false,
      };
      for (const cb of this.messageCbs) cb(msg);
    }) as never);
    client.on('reconnect', (() => this.emitState('reconnecting')) as never);
    client.on('offline', (() => this.emitState('offline')) as never);
    client.on('close', (() => this.emitState('closed')) as never);

    if (client.connected) {
      this.emitState('connected');
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => { this.emitState('connected'); resolve(); };
      const onError = (err: Error) => reject(new BrokerUnavailable(`mqtt connect failed: ${err.message}`));
      client.on('connect', onConnect as never);
      client.on('error', onError as never);
    });
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
  return new MqttAdapter(async () => client, true);
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
  }, false);
}
