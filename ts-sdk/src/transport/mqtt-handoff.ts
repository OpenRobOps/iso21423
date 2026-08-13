import { EventEmitter } from 'node:events';
import type { MqttClientLike } from './mqtt-client.js';

/**
 * Public MQTT handoff contract.
 *
 * A consumer (e.g. ORO) constructs a subclass by injecting its own, already-connected
 * MQTT client. This library never calls `connect()`, `end()`, or `disconnect()` on that
 * client and never owns its lifecycle — it only subscribes, publishes, and listens for
 * `'message'` events on the topics the domain model cares about.
 *
 * Emits `'error'` (with an `Error`) whenever an inbound message can't be routed to the
 * domain model — an unrecognized topic, a malformed payload, or an invalid state
 * transition. Routing never throws back into the caller; failures always surface here.
 */
export abstract class MqttHandoff extends EventEmitter {
  protected readonly client: MqttClientLike;

  constructor(client: MqttClientLike) {
    super();
    this.client = client;
    this.client.on('message', (topic, payload) => this.handleMessage(topic, payload));
  }

  /** Subscribe to the topic(s) this handoff routes. Call once, after construction. */
  abstract subscribe(): void;

  /** Route one inbound MQTT message to the domain model, or emit 'error' if it can't be routed. */
  protected abstract handleMessage(topic: string, payload: Buffer | Uint8Array | string): void;
}
