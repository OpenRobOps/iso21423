/** An inbound message as delivered by the transport. */
export interface TransportMessage { topic: string; payload: Buffer; qos: 0 | 1 | 2; retain: boolean }

/** MQTT Last Will and Testament to arm at connect time (see B.4). */
export interface WillOptions { topic: string; payload: string; qos: 0 | 1 | 2; retain: boolean }

export interface TransportConnectOptions {
  clientId: string;
  cleanSession: boolean;
  keepalive: number;
  will?: WillOptions;
  username?: string;
  password?: string;
}

export type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'closed';

/**
 * Broker-agnostic MQTT transport contract the SDK is built against. `session/mqttTransport.ts`
 * implements it over the `mqtt` npm package; `testing/memoryTransport.ts` implements it in-memory
 * for tests. Handlers registered via `onMessage`/`onConnectionState` are additive, not replacing.
 */
export interface MqttTransport {
  connect(opts: TransportConnectOptions): Promise<void>;
  publish(topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void>;
  subscribe(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<{ granted: boolean }>;
  unsubscribe(filter: string): Promise<void>;
  onMessage(cb: (msg: TransportMessage) => void): void;
  onConnectionState(cb: (s: ConnectionState) => void): void;
  end(): Promise<void>;
}
