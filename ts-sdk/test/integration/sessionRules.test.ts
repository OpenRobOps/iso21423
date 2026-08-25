// test/integration/sessionRules.test.ts — ND-08 (on-change/rate-gate) and ND-10 (retained-request
// cleanup) as observable wire behavior, not internals.
import { describe, it, expect, vi } from 'vitest';
import { move } from '../../src/index.js';
import { CCS, deployment, flush, target, waitFor } from './harness.js';

const ROBOT = '91403a21-7534-4467-99a6-79c46a130fe8';
const SENDER = '42177726-26f7-4f5c-b735-a12a427bb96d';

describe('status published only on change (ND-08)', () => {
  it('three calls with two distinct payloads produce two wire messages', async () => {
    const d = deployment();
    const robotClient = await d.client();
    const robot = await robotClient.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    });
    // A fixed timestamp so the first two (otherwise identical) calls really are byte-identical
    // payloads — the on-change rule compares the exact serialized body.
    const ts = new Date().toISOString();
    await robot.publishStatus({ states: ['IDLE'], timestamp: ts });
    await robot.publishStatus({ states: ['IDLE'], timestamp: ts });
    await robot.publishStatus({ states: ['CHARGING'], timestamp: ts });
    expect(d.broker.messagesOn(`/ISO_21423/v1/IMR/${ROBOT}/status`)).toHaveLength(2);
  });
});

describe('rate-gate clamping (Table B.1, odometry maxHz=30)', () => {
  it('clamps a tight-loop burst to far fewer than 50 messages, at most one per interval', async () => {
    vi.useFakeTimers();
    try {
      const d = deployment();
      const robotClient = await d.client();
      const robot = await robotClient.registerSelfEntity({
        entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
      });
      const topic = `/ISO_21423/v1/IMR/${ROBOT}/odometry`;
      const sample = (n: number) => ({
        pose: { locationPoint: { ccsId: CCS, x: n, y: 0, z: 0 }, orientation: { yaw: 0, pitch: 0, roll: 0 } },
        velocity: { linear: 0, angular: 0 },
      });
      const intervalMs = 1000 / 30;               // Table B.1 odometry maxHz

      let n = 0;
      for (let cycle = 0; cycle < 5; cycle += 1) {
        // A tight burst within the same instant: only the first offer of the whole run emits
        // immediately, the rest of this burst coalesce into one pending (latest-wins) value.
        for (let i = 0; i < 10; i += 1) { await robot.publishOdometry(sample(n)); n += 1; }
        await vi.advanceTimersByTimeAsync(intervalMs);
      }

      const messages = d.broker.messagesOn(topic);
      expect(messages.length).toBeLessThan(50);
      // One immediate emission plus at most one flush per interval advanced.
      expect(messages.length).toBeLessThanOrEqual(6);
      expect(messages.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sender-side retained-request cleanup on terminal status (ND-10)', () => {
  it('leaves the retained request topic empty once the request settles', async () => {
    const d = deployment();
    const robotClient = await d.client();
    const robot = await robotClient.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
      capabilities: { accepts: ['move'] },
    });
    robot.onRequest('move', async (_a, ctx) => ctx.succeeded());
    const senderClient = await d.client();
    const sender = await senderClient.registerSelfEntity({
      entityUuid: SENDER, entityType: 'TrafficController', manufacturerName: 'Acme Traffic',
    });
    await flush();

    const req = await sender.sendRequest({ destination: ROBOT, details: [move(target())] });
    const topic = `/ISO_21423/v1/IMR/${ROBOT}/request/${req.requestUuid}`;
    expect(d.broker.retainedOn(topic)).toBeDefined();
    await req.completion();
    expect(d.broker.retainedOn(topic)).toBeUndefined();
  });
});

describe('gateway janitor clears a request a crashed sender left retained (ND-10)', () => {
  it('clears it after the configured grace period', async () => {
    const d = deployment();
    // harness deployment().gateway() already defaults janitor.graceMs to 10.
    const g = await d.gateway({ id: '5a35c6c1-6b60-4c2e-9f2c-4c1a7f7a9a11', manufacturerName: 'Acme Fleet', accepts: ['move'] });
    await g.registerImr({ id: ROBOT, manufacturerName: 'Acme', accepts: ['move'] });
    g.onRequest('move', async (_a, ctx) => ctx.succeeded());

    // A "crashed" sender: publishes the retained request itself and never cleans it up.
    const rogue = d.broker.createTransport();
    await rogue.connect({ clientId: 'rogue', cleanSession: false, keepalive: 60 });
    const requestUuid = 'aa53a1e1-782f-479b-88b3-fd110198be45';
    const topic = `/ISO_21423/v1/IMR/${ROBOT}/request/${requestUuid}`;
    await rogue.publish(topic, JSON.stringify({
      destination: ROBOT, source: SENDER, sequenceId: 9,
      timestamp: new Date().toISOString(), details: [move(target())],
    }), { qos: 2, retain: true });
    await flush();
    expect(d.broker.retainedOn(topic)).toBeDefined();

    await waitFor(() => d.broker.retainedOn(topic) === undefined, { label: 'janitor clears retained request' });
  });
});

describe('stale retained disconnection cleared on connect', () => {
  it('a stale LOST_CONNECTION left by a prior crash is cleared once the entity re-registers', async () => {
    const d = deployment();
    const topic = `/ISO_21423/v1/IMR/${ROBOT}/disconnection`;
    const rogue = d.broker.createTransport();
    await rogue.connect({ clientId: 'rogue', cleanSession: false, keepalive: 60 });
    await rogue.publish(topic, '{"states":["LOST_CONNECTION"]}', { qos: 1, retain: true });

    const robotClient = await d.client();
    await robotClient.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    });
    expect(d.broker.retainedOn(topic)).toBeUndefined();
  });
});

describe('reconnect republish', () => {
  it('owned retained resources appear a second time on the wire after dropConnection()', async () => {
    const d = deployment();
    const transport = d.broker.createTransport();
    const robotClient = await d.client({ transport });
    await robotClient.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    });
    const identityTopic = `/ISO_21423/v1/IMR/${ROBOT}/identity`;
    expect(d.broker.messagesOn(identityTopic)).toHaveLength(1);

    transport.dropConnection();
    await flush();

    expect(d.broker.messagesOn(identityTopic).length).toBeGreaterThanOrEqual(2);
  });
});

describe('graceful close()', () => {
  it('does not fire the will', async () => {
    const d = deployment();
    const robotClient = await d.client();
    await robotClient.registerSelfEntity({
      entityUuid: ROBOT, entityType: 'IMR', manufacturerName: 'Acme Robotics',
    });
    await robotClient.close();
    expect(d.broker.retainedOn(`/ISO_21423/v1/IMR/${ROBOT}/disconnection`)).toBeUndefined();
  });
});
