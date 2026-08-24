import { describe, it, expect } from 'vitest';
import { MemoryBroker } from '../src/testing/index.js';

const opts = (id: string) => ({ clientId: id, cleanSession: false, keepalive: 60 });

describe('MemoryBroker pub/sub', () => {
  it('routes by MQTT filter and preserves qos/retain metadata', async () => {
    const broker = new MemoryBroker();
    const a = broker.createTransport();
    const b = broker.createTransport();
    await a.connect(opts('a'));
    await b.connect(opts('b'));
    const seen: string[] = [];
    b.onMessage((m) => seen.push(`${m.topic}|${m.qos}|${m.retain}|${m.payload.toString()}`));
    await b.subscribe('/ISO_21423/v1/+/+/status', { qos: 1 });
    await a.publish('/ISO_21423/v1/IMR/u1/status', '{"x":1}', { qos: 1, retain: true });
    await a.publish('/ISO_21423/v1/IMR/u1/odometry', '{}', { qos: 0, retain: false }); // not matched
    expect(seen).toEqual(['/ISO_21423/v1/IMR/u1/status|1|true|{"x":1}']);
  });

  it('delivers retained messages to late subscribers', async () => {
    const broker = new MemoryBroker();
    const pub = broker.createTransport();
    await pub.connect(opts('pub'));
    await pub.publish('/ISO_21423/v1/IMR/u1/identity', '{"id":"u1"}', { qos: 1, retain: true });
    const sub = broker.createTransport();
    await sub.connect(opts('sub'));
    const seen: string[] = [];
    sub.onMessage((m) => seen.push(m.payload.toString()));
    await sub.subscribe('/ISO_21423/v1/+/+/identity', { qos: 1 });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(['{"id":"u1"}']);
  });

  it('zero-byte retained publish clears the retained message', async () => {
    const broker = new MemoryBroker();
    const t = broker.createTransport();
    await t.connect(opts('t'));
    await t.publish('/x/y', 'keep', { qos: 1, retain: true });
    await t.publish('/x/y', '', { qos: 1, retain: true });
    expect(broker.retainedOn('/x/y')).toBeUndefined();
  });
});

describe('will and connection drops', () => {
  it('fires the will (retained) on ungraceful drop, not on graceful end', async () => {
    const broker = new MemoryBroker();
    const watcher = broker.createTransport();
    await watcher.connect(opts('w'));
    const seen: string[] = [];
    watcher.onMessage((m) => seen.push(`${m.topic}:${m.payload.toString()}`));
    await watcher.subscribe('/ISO_21423/v1/IMR/u1/disconnection', { qos: 1 });

    const dying = broker.createTransport();
    await dying.connect({
      ...opts('dying'),
      will: {
        topic: '/ISO_21423/v1/IMR/u1/disconnection',
        payload: '{"states":["LOST_CONNECTION"]}',
        qos: 1, retain: true,
      },
    });
    dying.dropConnection();
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(['/ISO_21423/v1/IMR/u1/disconnection:{"states":["LOST_CONNECTION"]}']);
    expect(broker.retainedOn('/ISO_21423/v1/IMR/u1/disconnection')).toBeDefined();

    const graceful = broker.createTransport();
    await graceful.connect({ ...opts('g'), will: { topic: '/w2', payload: 'x', qos: 1, retain: true } });
    await graceful.end();
    expect(broker.retainedOn('/w2')).toBeUndefined();
  });

  it('reports reconnecting → connected around a drop', async () => {
    const broker = new MemoryBroker();
    const t = broker.createTransport();
    const states: string[] = [];
    t.onConnectionState((s) => states.push(s));
    await t.connect(opts('t'));
    t.dropConnection();
    await new Promise((r) => setImmediate(r));
    expect(states).toEqual(['connected', 'reconnecting', 'connected']);
  });
});

describe('subscription denial (ACL simulation)', () => {
  it('returns granted:false for denied filters', async () => {
    const broker = new MemoryBroker();
    broker.denySubscribe('/ISO_21423/v1/IMRFM/#');
    const t = broker.createTransport();
    await t.connect(opts('t'));
    expect((await t.subscribe('/ISO_21423/v1/IMRFM/#', { qos: 1 })).granted).toBe(false);
    expect((await t.subscribe('/ISO_21423/v1/+/+/identity', { qos: 1 })).granted).toBe(true);
  });
});

describe('reconnect and callback error handling', () => {
  it('end() after dropConnection() stays closed (no dangling reconnect)', async () => {
    const broker = new MemoryBroker();
    const t = broker.createTransport();
    const states: string[] = [];
    t.onConnectionState((s) => states.push(s));
    await t.connect(opts('t'));
    t.dropConnection();
    await t.end();
    // emitted: connected (from connect), reconnecting (from drop), then closed (from end)
    // should NOT emit a late 'connected' from the pending setImmediate
    await new Promise((r) => setImmediate(r));
    expect(states).toEqual(['connected', 'reconnecting', 'closed']);
  });

  it('throwing subscriber does not block delivery to other subscribers', async () => {
    const broker = new MemoryBroker();
    const t = broker.createTransport();
    await t.connect(opts('t'));
    const delivered: string[] = [];
    let throwCount = 0;
    t.onMessage(() => {
      throwCount++;
      if (throwCount === 1) throw new Error('first subscriber throws once');
    });
    t.onMessage((m) => {
      delivered.push(m.topic);
    });
    await t.subscribe('/x', { qos: 0 });
    await t.publish('/x', 'msg', { qos: 0, retain: false });
    // both subscribers are called; first throws once, second still receives
    await new Promise((r) => setImmediate(r));
    expect(delivered).toEqual(['/x']);
    expect(throwCount).toBe(1);
  });
});
