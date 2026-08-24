import { describe, it, expect } from 'vitest';
import {
  wrapMqttClient, createMqttTransport, BrokerUnavailable, Iso21423Error,
  type MqttClientLike,
} from '../src/index.js';

function fakeClient(will?: { topic: string }): MqttClientLike & {
  emit: (ev: string, ...args: unknown[]) => void;
  published: Array<{ topic: string; payload: string; qos: number; retain: boolean }>;
  subscribed: Array<{ filter: string; qos: number }>;
  unsubscribed: string[];
  ended: boolean;
  grant: number;
} {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const obj = {
    options: { will, clean: false },
    connected: false,
    grant: 1,
    published: [] as Array<{ topic: string; payload: string; qos: number; retain: boolean }>,
    subscribed: [] as Array<{ filter: string; qos: number }>,
    unsubscribed: [] as string[],
    ended: false,
    on(ev: string, cb: (...a: unknown[]) => void) {
      const list = handlers.get(ev) ?? [];
      list.push(cb);
      handlers.set(ev, list);
    },
    emit(ev: string, ...args: unknown[]) {
      for (const cb of handlers.get(ev) ?? []) cb(...args);
    },
    async publishAsync(topic: string, payload: string | Buffer, opts: { qos: number; retain: boolean }) {
      obj.published.push({ topic, payload: payload.toString(), qos: opts.qos, retain: opts.retain });
      return undefined;
    },
    async subscribeAsync(filter: string, opts: { qos: number }) {
      obj.subscribed.push({ filter, qos: opts.qos });
      return [{ topic: filter, qos: obj.grant }];
    },
    async unsubscribeAsync(filter: string) {
      obj.unsubscribed.push(filter);
      return undefined;
    },
    async endAsync() {
      obj.ended = true;
    },
  };
  return obj as never;
}

const CONNECT = {
  clientId: 'iso21423-IMR-u1',
  cleanSession: false,
  keepalive: 60,
  will: { topic: '/ISO_21423/v1/IMR/u1/disconnection', payload: '{}', qos: 1 as const, retain: true },
};

describe('wrapMqttClient', () => {
  it('resolves connect() when the client reports connect', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const states: string[] = [];
    t.onConnectionState((s) => states.push(s));
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;
    expect(states).toEqual(['connected']);
  });

  it('rejects when the caller-constructed client has no matching will (P-4)', async () => {
    const t = wrapMqttClient(fakeClient());
    await expect(t.connect(CONNECT)).rejects.toThrow(Iso21423Error);
    await expect(t.connect(CONNECT)).rejects.toThrow(/will/i);
  });

  it('maps publish/subscribe/unsubscribe and reports SUBACK denial', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;

    await t.publish('/a/b', '{"x":1}', { qos: 2, retain: true });
    expect(c.published).toEqual([{ topic: '/a/b', payload: '{"x":1}', qos: 2, retain: true }]);

    expect(await t.subscribe('/a/+', { qos: 1 })).toEqual({ granted: true });
    c.grant = 128; // MQTT failure code
    expect(await t.subscribe('/denied/#', { qos: 1 })).toEqual({ granted: false });

    await t.unsubscribe('/a/+');
    expect(c.unsubscribed).toEqual(['/a/+']);
  });

  it('relays messages and connection-state transitions', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const seen: string[] = [];
    const states: string[] = [];
    t.onMessage((m) => seen.push(`${m.topic}|${m.qos}|${m.retain}|${m.payload.toString()}`));
    t.onConnectionState((s) => states.push(s));
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;
    c.emit('message', '/a/b', Buffer.from('hi'), { qos: 1, retain: true });
    c.emit('reconnect');
    c.emit('offline');
    c.emit('close');
    expect(seen).toEqual(['/a/b|1|true|hi']);
    expect(states).toEqual(['connected', 'reconnecting', 'offline', 'closed']);
  });

  it('rejects publish after end() with BrokerUnavailable', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;
    await t.end();
    expect(c.ended).toBe(true);
    await expect(t.publish('/a/b', 'x', { qos: 1, retain: false })).rejects.toThrow(BrokerUnavailable);
  });

  it('resolves connect() asynchronously via event (not fast path)', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const states: string[] = [];
    t.onConnectionState((s) => states.push(s));
    const p = t.connect(CONNECT);
    // Keep connected=false; only emit 'connect' after yielding to event loop
    await Promise.resolve();
    c.connected = true;
    c.emit('connect');
    await p;
    expect(states).toEqual(['connected']);
  });

  it('handles error after successful connect without state corruption', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const states: string[] = [];
    t.onConnectionState((s) => states.push(s));
    const p = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p;
    expect(states).toEqual(['connected']);
    // Emit error after successful connect — should not corrupt state
    c.emit('error', new Error('broker error'));
    expect(states).toEqual(['connected']); // no extra state
    // Transport should still be usable
    await t.publish('/a/b', '{}', { qos: 1, retain: false });
    expect(c.published.length).toBe(1);
  });

  it('deduplicates listeners on repeated connect()', async () => {
    const c = fakeClient({ topic: CONNECT.will.topic });
    const t = wrapMqttClient(c);
    const seen: string[] = [];
    t.onMessage((m) => seen.push(m.topic));

    // First connect
    const p1 = t.connect(CONNECT);
    c.connected = true;
    c.emit('connect');
    await p1;

    // Reset connected, emit another message from first connect
    c.connected = false;
    c.emit('message', '/x', Buffer.from('x'), { qos: 0, retain: false });
    expect(seen).toEqual(['/x']);

    // Second connect on same adapter (asynchronous path)
    seen.length = 0;
    const p2 = t.connect(CONNECT);
    await Promise.resolve();
    c.connected = true;
    c.emit('connect');
    await p2;

    // Emit message after second connect — should arrive exactly once despite listener duplication bug fix
    c.emit('message', '/y', Buffer.from('y'), { qos: 0, retain: false });
    expect(seen).toEqual(['/y']);
  });
});

describe('createMqttTransport', () => {
  it('does not touch the network until connect()', () => {
    expect(() => createMqttTransport('mqtt://127.0.0.1:1')).not.toThrow();
  });

  it('surfaces a refused connection as BrokerUnavailable', async () => {
    const t = createMqttTransport('mqtt://127.0.0.1:1', { reconnectPeriod: 0 });
    await expect(t.connect({ ...CONNECT })).rejects.toThrow(BrokerUnavailable);
  }, 10_000);
});
