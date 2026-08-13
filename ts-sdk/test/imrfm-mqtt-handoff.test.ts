import { describe, it, expect } from 'vitest';
import { ImrfmEntity } from '../src/entities/imrfm-entity.js';
import { ImrfmMqttHandoff } from '../src/transport/imrfm-mqtt-handoff.js';
import type { MqttClientLike } from '../src/transport/mqtt-client.js';
import { topicFor } from '../src/topics.js';

const ENTITY_ID = '3ddd8e04-1606-4ac8-8174-8321ee094278';
const SOFTWARE_VERSIONS = [{ moduleName: 'core', moduleVersion: '1.0.0' }];
const REF = { entityType: 'IMRFM', entityId: ENTITY_ID };

function createEntity(): ImrfmEntity {
  return new ImrfmEntity({
    id: ENTITY_ID,
    manufacturerName: 'Acme Robotics',
    softwareVersions: SOFTWARE_VERSIONS,
  });
}

/** A minimal stub satisfying MqttClientLike, with no connect()/disconnect() at all. */
function createStubClient() {
  const messageListeners: Array<(topic: string, payload: Buffer) => void> = [];
  const client: MqttClientLike & {
    subscribeCalls: string[];
    publishCalls: Array<{ topic: string; payload: string }>;
    emitMessage(topic: string, payload: string): void;
  } = {
    subscribeCalls: [],
    publishCalls: [],
    subscribe(topic: string) {
      client.subscribeCalls.push(topic);
      return client;
    },
    publish(topic: string, payload: string | Buffer) {
      client.publishCalls.push({ topic, payload: payload.toString() });
      return client;
    },
    on(_event: 'message', listener: (topic: string, payload: Buffer) => void) {
      messageListeners.push(listener);
      return client;
    },
    emitMessage(topic: string, payload: string) {
      for (const listener of messageListeners) listener(topic, Buffer.from(payload));
    },
  };
  return client;
}

describe('ImrfmMqttHandoff construction', () => {
  it('never calls connect or disconnect on the injected client', () => {
    const client = createStubClient();
    expect('connect' in client).toBe(false);
    expect('end' in client).toBe(false);
    new ImrfmMqttHandoff(client, createEntity());
  });

  it('subscribes to the entity status topic on subscribe()', () => {
    const client = createStubClient();
    const handoff = new ImrfmMqttHandoff(client, createEntity());
    handoff.subscribe();
    expect(client.subscribeCalls).toEqual([topicFor(REF, 'status')]);
  });
});

describe('ImrfmMqttHandoff inbound routing', () => {
  it('applies a well-formed status message to the entity state', () => {
    const client = createStubClient();
    const entity = createEntity();
    new ImrfmMqttHandoff(client, entity);

    expect(entity.state).toBe('NOT_READY');
    client.emitMessage(
      topicFor(REF, 'status'),
      JSON.stringify({ entityId: ENTITY_ID, timestamp: '2025-04-08T12:34:56.789Z', states: ['READY'] }),
    );

    expect(entity.state).toBe('READY');
  });

  it('produces no state change and emits an error on an unrecognized topic', () => {
    const client = createStubClient();
    const entity = createEntity();
    const handoff = new ImrfmMqttHandoff(client, entity);

    const errors: Error[] = [];
    handoff.on('error', (err: Error) => errors.push(err));

    client.emitMessage('/ISO_21423/v1/IMRFM/some-other-id/status', JSON.stringify({ states: ['READY'] }));

    expect(entity.state).toBe('NOT_READY');
    expect(errors).toHaveLength(1);
  });

  it('produces no state change and emits an error on malformed JSON', () => {
    const client = createStubClient();
    const entity = createEntity();
    const handoff = new ImrfmMqttHandoff(client, entity);

    const errors: Error[] = [];
    handoff.on('error', (err: Error) => errors.push(err));

    client.emitMessage(topicFor(REF, 'status'), 'not json');

    expect(entity.state).toBe('NOT_READY');
    expect(errors).toHaveLength(1);
  });

  it('produces no state change and emits an error on an unknown state', () => {
    const client = createStubClient();
    const entity = createEntity();
    const handoff = new ImrfmMqttHandoff(client, entity);

    const errors: Error[] = [];
    handoff.on('error', (err: Error) => errors.push(err));

    client.emitMessage(topicFor(REF, 'status'), JSON.stringify({ states: ['BOGUS'] }));

    expect(entity.state).toBe('NOT_READY');
    expect(errors).toHaveLength(1);
  });
});

describe('ImrfmMqttHandoff outbound publishing', () => {
  it('publishes a status message to the correct topic', () => {
    const client = createStubClient();
    const entity = createEntity();
    entity.setState('READY');
    const handoff = new ImrfmMqttHandoff(client, entity);

    handoff.publishStatus('2025-04-08T12:34:56.789Z');

    expect(client.publishCalls).toHaveLength(1);
    expect(client.publishCalls[0]?.topic).toBe(topicFor(REF, 'status'));
    expect(JSON.parse(client.publishCalls[0]?.payload ?? '{}')).toEqual({
      entityId: ENTITY_ID,
      timestamp: '2025-04-08T12:34:56.789Z',
      states: ['READY'],
    });
  });

  it('publishes an identity message to the correct topic', () => {
    const client = createStubClient();
    const entity = createEntity();
    const handoff = new ImrfmMqttHandoff(client, entity);

    handoff.publishIdentity('2025-04-08T12:34:56.789Z');

    expect(client.publishCalls).toHaveLength(1);
    expect(client.publishCalls[0]?.topic).toBe(topicFor(REF, 'identity'));
  });
});
