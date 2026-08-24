import { describe, it, expect } from 'vitest';
import { Iso21423Session, AuthorizationDenied } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';

const IMR = { entityType: 'IMR', entityUuid: '91403a21-7534-4467-99a6-79c46a130fe8' };
const REQ = 'aa53a1e1-782f-479b-88b3-fd110198be45';
const REQ_TOPIC = `/ISO_21423/v1/IMR/${IMR.entityUuid}/request/${REQ}`;
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

const request = {
  destination: IMR.entityUuid, source: '42177726-26f7-4f5c-b735-a12a427bb96d',
  sequenceId: 7, timestamp: '2025-04-08T12:34:56.789Z',
  details: [{ type: 'move', version: '1.0', properties: {} }],
};

describe('session.publishTopic / subscribeTopic', () => {
  it('publishes validated payloads to an arbitrary topic with explicit qos/retain', async () => {
    const broker = new MemoryBroker();
    const s = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    await s.publishTopic(REQ_TOPIC, 'request', request, { qos: 2, retain: true });
    const [msg] = broker.messagesOn(REQ_TOPIC);
    expect(msg!.qos).toBe(2);
    expect(msg!.retain).toBe(true);
    await expect(s.publishTopic(REQ_TOPIC, 'request', { destination: 5 }, { qos: 2, retain: true }))
      .rejects.toThrow(/not ISO 21423 conformant/);
  });

  it('delivers to wildcard topic subscriptions with parsed meta', async () => {
    const broker = new MemoryBroker();
    const pub = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    const sub = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    const seen: Array<{ requestUuid?: string; resource: string; entityUuid: string }> = [];
    await sub.subscribeTopic('/ISO_21423/v1/+/+/request/+', 'request', (_m, meta) => seen.push(meta));
    await pub.publishTopic(REQ_TOPIC, 'request', request, { qos: 2, retain: true });
    await flush();
    expect(seen).toEqual([
      { topic: REQ_TOPIC, entityType: 'IMR', entityUuid: IMR.entityUuid, resource: 'request',
        requestUuid: REQ, isRequestStatus: false },
    ]);
  });

  it('passes raw text through when kind is null (zero-byte clears included)', async () => {
    const broker = new MemoryBroker();
    const s = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    const seen: unknown[] = [];
    await s.subscribeTopic('/ISO_21423/v1/+/+/identity', null, (m) => seen.push(m));
    await s.publishRaw(`/ISO_21423/v1/IMR/${IMR.entityUuid}/identity`, '', { qos: 1, retain: true });
    await flush();
    expect(seen).toEqual(['']);
  });

  it('throws AuthorizationDenied on SUBACK denial', async () => {
    const broker = new MemoryBroker();
    broker.denySubscribe('/ISO_21423/v1/+/+/request/+');
    const s = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    await expect(s.subscribeTopic('/ISO_21423/v1/+/+/request/+', 'request', () => {}))
      .rejects.toThrow(AuthorizationDenied);
  });

  it('unsubscribes from the broker only when the last listener on a filter goes away (ND-17)', async () => {
    const broker = new MemoryBroker();
    const s = await Iso21423Session.connect({ transport: broker.createTransport(), entity: IMR });
    const a = await s.subscribeTopic('/ISO_21423/v1/+/+/status', 'entityStatus', () => {});
    const b = await s.subscribeTopic('/ISO_21423/v1/+/+/status', 'entityStatus', () => {});
    expect(broker.subscriptions().filter((x) => x.filter.endsWith('/status'))).toHaveLength(1);
    await a.unsubscribe();
    expect(broker.subscriptions().filter((x) => x.filter.endsWith('/status'))).toHaveLength(1);
    await b.unsubscribe();
    expect(broker.subscriptions().filter((x) => x.filter.endsWith('/status'))).toHaveLength(0);
  });
});
