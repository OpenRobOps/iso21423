import { describe, it, expect, vi } from 'vitest';
import { Iso21423Session, AuthorizationDenied } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const IMR = { entityType: 'IMR', entityUuid: '91403a21-7534-4467-99a6-79c46a130fe8' };
const STATUS_TOPIC = `/ISO_21423/v1/IMR/${IMR.entityUuid}/status`;
const DISC_TOPIC = `/ISO_21423/v1/IMR/${IMR.entityUuid}/disconnection`;

const status = (states: string[]) => ({
  entityId: IMR.entityUuid, timestamp: '2025-04-08T12:34:56.789Z', states,
});

async function connect(broker: MemoryBroker) {
  return Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
}

describe('connect conformance', () => {
  it('clears a stale retained disconnection message on connect', async () => {
    const broker = new MemoryBroker();
    const t = broker.createTransport();
    await t.connect({ clientId: 'x', cleanSession: false, keepalive: 60 });
    await t.publish(DISC_TOPIC, '{"states":["LOST_CONNECTION"]}', { qos: 1, retain: true });
    await connect(broker);
    expect(broker.retainedOn(DISC_TOPIC)).toBeUndefined();
  });

  it('drops with the B.4 will: retained LOST_CONNECTION appears on ungraceful loss', async () => {
    const broker = new MemoryBroker();
    const transport = broker.createTransport();
    await Iso21423Session.connect({ transport, entity: IMR });
    transport.dropConnection();
    await new Promise((r) => setImmediate(r));
    expect(broker.retainedOn(DISC_TOPIC)?.toString()).toBe('{"states":["LOST_CONNECTION"]}');
  });
});

describe('publishResource', () => {
  it('uses Table B.1 qos/retain and validates egress', async () => {
    const broker = new MemoryBroker();
    const s = await connect(broker);
    await s.publishResource(IMR, 'status', 'entityStatus', status(['MODE_AUTO', 'IDLE']));
    const [msg] = broker.messagesOn(STATUS_TOPIC);
    expect(msg!.qos).toBe(1);
    expect(msg!.retain).toBe(true);
    await expect(s.publishResource(IMR, 'status', 'entityStatus', { states: 'bad' }))
      .rejects.toThrow(/not ISO 21423 conformant/);
  });

  it('suppresses unchanged retained publishes (on-change rule)', async () => {
    const broker = new MemoryBroker();
    const s = await connect(broker);
    await s.publishResource(IMR, 'status', 'entityStatus', status(['IDLE', 'MODE_AUTO']));
    await s.publishResource(IMR, 'status', 'entityStatus', status(['IDLE', 'MODE_AUTO']));
    await s.publishResource(IMR, 'status', 'entityStatus', status(['MODE_AUTO', 'CHARGING']));
    expect(broker.messagesOn(STATUS_TOPIC)).toHaveLength(2);
  });

  it('rejects unknown resources', async () => {
    const broker = new MemoryBroker();
    const s = await connect(broker);
    await expect(s.publishResource(IMR, 'bogus', null, {})).rejects.toThrow(/unknown resource/i);
  });

  it('rolls back retained cache on publish failure', async () => {
    const broker = new MemoryBroker();
    let statusPublishCallCount = 0;
    const failingTransport = new Proxy(broker.createTransport(), {
      get: (target, prop) => {
        if (prop === 'publish') {
          return async (topic: string, payload: string | Buffer, opts: { qos: 0 | 1 | 2; retain: boolean }) => {
            if (topic === STATUS_TOPIC) {
              statusPublishCallCount++;
              if (statusPublishCallCount === 1) {
                throw new Error('simulated publish failure');
              }
            }
            return (target as any)[prop](topic, payload, opts);
          };
        }
        return (target as any)[prop];
      },
    });
    const s = await Iso21423Session.connect({ transport: failingTransport, entity: IMR });
    const payload = status(['IDLE', 'MODE_AUTO']);
    await expect(s.publishResource(IMR, 'status', 'entityStatus', payload))
      .rejects.toThrow('simulated publish failure');
    await expect(s.publishResource(IMR, 'status', 'entityStatus', payload))
      .resolves.toBeUndefined();
    expect(statusPublishCallCount).toBe(2);
  });
});

describe('subscribeResource', () => {
  it('delivers validated messages with topic metadata', async () => {
    const broker = new MemoryBroker();
    const pub = await connect(broker);
    const sub = await connect(broker);
    const seen: Array<{ states: string[] }> = [];
    await sub.subscribeResource({}, 'status', 'entityStatus', (m) => seen.push(m as { states: string[] }));
    await pub.publishResource(IMR, 'status', 'entityStatus', status(['LOST', 'MODE_MANUAL']));
    await new Promise((r) => setImmediate(r));
    expect(seen[0]!.states).toEqual(['LOST', 'MODE_MANUAL']);
  });

  it('routes malformed third-party payloads to validation-warning, not the handler', async () => {
    const broker = new MemoryBroker();
    const sub = await connect(broker);
    const handler = vi.fn();
    const warnings: unknown[] = [];
    sub.on('validation-warning', (w) => warnings.push(w));
    await sub.subscribeResource({}, 'status', 'entityStatus', handler);
    const rogue = broker.createTransport();
    await rogue.connect({ clientId: 'rogue', cleanSession: false, keepalive: 60 });
    await rogue.publish(STATUS_TOPIC, 'not json at all', { qos: 1, retain: false });
    await rogue.publish(STATUS_TOPIC, '{"states": 42}', { qos: 1, retain: false });
    await new Promise((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(2);
  });

  it('throws AuthorizationDenied when the broker denies the filter', async () => {
    const broker = new MemoryBroker();
    broker.denySubscribe('/ISO_21423/v1/+/+/status');
    const s = await connect(broker);
    await expect(s.subscribeResource({}, 'status', 'entityStatus', () => {}))
      .rejects.toThrow(AuthorizationDenied);
  });

  it('honors per-subscription entity filters', async () => {
    const broker = new MemoryBroker();
    const pub = await connect(broker);
    const imrSub = await connect(broker);
    const imrfmSub = await connect(broker);
    const imrHandler = vi.fn();
    const imrfmHandler = vi.fn();
    await imrSub.subscribeResource({ entityType: 'IMR' }, 'status', 'entityStatus', imrHandler);
    await imrfmSub.subscribeResource({ entityType: 'IMRFM' }, 'status', 'entityStatus', imrfmHandler);
    await pub.publishResource(IMR, 'status', 'entityStatus', status(['IDLE']));
    await new Promise((r) => setImmediate(r));
    expect(imrHandler).toHaveBeenCalledOnce();
    expect(imrfmHandler).not.toHaveBeenCalled();
  });

  it('kind:null passes raw payload text to handler without parsing', async () => {
    const broker = new MemoryBroker();
    const sub = await connect(broker);
    const handler = vi.fn();
    await sub.subscribeResource({}, 'status', null, handler);
    const rogue = broker.createTransport();
    await rogue.connect({ clientId: 'rogue', cleanSession: false, keepalive: 60 });
    const jsonPayload = '{"entityId":"123","timestamp":"2025-01-01T00:00:00.000Z","states":["IDLE"]}';
    await rogue.publish(STATUS_TOPIC, jsonPayload, { qos: 1, retain: false });
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toBe(jsonPayload);
  });
});

describe('reconnect and close', () => {
  it('republishes owned retained resources after reconnect', async () => {
    const broker = new MemoryBroker();
    const transport = broker.createTransport();
    const s = await Iso21423Session.connect({ transport, entity: IMR });
    await s.publishResource(IMR, 'status', 'entityStatus', status(['IDLE', 'MODE_AUTO']));
    expect(broker.messagesOn(STATUS_TOPIC)).toHaveLength(1);
    transport.dropConnection();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(broker.messagesOn(STATUS_TOPIC)).toHaveLength(2); // republished
  });

  it('close(finalStates) publishes a final status then ends without firing the will', async () => {
    const broker = new MemoryBroker();
    const s = await connect(broker);
    await s.close(['OFFLINE', 'MODE_MAINTENANCE']);
    const msgs = broker.messagesOn(STATUS_TOPIC);
    const final = JSON.parse(msgs.at(-1)!.payload.toString()) as { states: string[] };
    expect(final.states).toEqual(['OFFLINE', 'MODE_MAINTENANCE']);
    expect(broker.retainedOn(DISC_TOPIC)).toBeUndefined(); // will did not fire
  });
});

describe('Subscription asyncDispose (D-19)', () => {
  it('Symbol.asyncDispose unsubscribes via await using-free call', async () => {
    const broker = new MemoryBroker();
    const sub = await connect(broker);
    const handler = vi.fn();
    const subscription = await sub.subscribeResource({}, 'status', 'entityStatus', handler);

    // Verify subscription is active
    const pub = await connect(broker);
    await pub.publishResource(IMR, 'status', 'entityStatus', status(['IDLE']));
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledTimes(1);

    // Dispose via Symbol.asyncDispose
    await subscription[Symbol.asyncDispose]();

    // Verify transport no longer delivers to handler
    handler.mockClear();
    await pub.publishResource(IMR, 'status', 'entityStatus', status(['CHARGING']));
    await new Promise((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
  });
});
