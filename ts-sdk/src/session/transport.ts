export interface TransportMessage { topic: string; payload: Buffer; qos: 0 | 1 | 2; retain: boolean }

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

export interface MqttTransport {
  connect(opts: TransportConnectOptions): Promise<void>;
  publish(topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void>;
  subscribe(filter: string, opts: { qos: 0 | 1 | 2 }): Promise<{ granted: boolean }>;
  unsubscribe(filter: string): Promise<void>;
  onMessage(cb: (msg: TransportMessage) => void): void;
  onConnectionState(cb: (s: ConnectionState) => void): void;
  end(): Promise<void>;
}
