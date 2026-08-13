import { ImrfmEntity } from '../entities/imrfm-entity.js';
import { UnrecognizedTopicError, ValidationError } from '../errors.js';
import { IDENTITY_RESOURCE, STATUS_RESOURCE, parseTopic, topicFor } from '../topics.js';
import type { IsoTimestamp } from '../types/common.js';
import type { MqttClientLike } from './mqtt-client.js';
import { MqttHandoff } from './mqtt-handoff.js';

/**
 * Wires an {@link ImrfmEntity} to a consumer-supplied MQTT client.
 *
 * - Inbound `status` messages on this entity's topic drive {@link ImrfmEntity.setState}.
 * - {@link publishIdentity} / {@link publishStatus} serialize the entity and publish to its
 *   `identity`/`status` topics.
 * - Any message that isn't this entity's `status` topic, isn't valid JSON, or carries an
 *   unknown state emits `'error'` and leaves entity state untouched.
 */
export class ImrfmMqttHandoff extends MqttHandoff {
  private readonly entity: ImrfmEntity;

  constructor(client: MqttClientLike, entity: ImrfmEntity) {
    super(client);
    this.entity = entity;
  }

  private get ref(): { entityType: string; entityId: string } {
    return { entityType: 'IMRFM', entityId: this.entity.id };
  }

  subscribe(): void {
    this.client.subscribe(topicFor(this.ref, STATUS_RESOURCE));
  }

  /** Serialize the entity's identity and publish it to its `identity` topic. */
  publishIdentity(timestamp: IsoTimestamp): void {
    const message = this.entity.toIdentityMessage(timestamp);
    this.client.publish(topicFor(this.ref, IDENTITY_RESOURCE), JSON.stringify(message));
  }

  /** Serialize the entity's current state and publish it to its `status` topic. */
  publishStatus(timestamp: IsoTimestamp): void {
    const message = this.entity.toStatusMessage(timestamp);
    this.client.publish(topicFor(this.ref, STATUS_RESOURCE), JSON.stringify(message));
  }

  protected handleMessage(topic: string, payload: Buffer | Uint8Array | string): void {
    const parsed = parseTopic(topic);
    if (!parsed || parsed.entityId !== this.entity.id || parsed.resource !== STATUS_RESOURCE) {
      this.emit('error', new UnrecognizedTopicError(`no route for MQTT topic "${topic}"`));
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(payload.toString());
    } catch {
      this.emit('error', new ValidationError(`malformed JSON payload on topic "${topic}"`));
      return;
    }

    const state = (body as { states?: unknown[] } | null)?.states?.[0];
    if (typeof state !== 'string') {
      this.emit('error', new ValidationError(`status message on topic "${topic}" has no states`));
      return;
    }

    try {
      this.entity.setState(state);
    } catch (err) {
      this.emit('error', err);
    }
  }
}
