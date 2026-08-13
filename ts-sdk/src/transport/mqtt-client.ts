/**
 * Minimal structural contract for a consumer-supplied MQTT client.
 *
 * Deliberately narrow — it only asks for what the handoff needs (subscribe, publish,
 * an `on('message', ...)` callback). Real client implementations such as `mqtt.js`'s
 * `MqttClient` satisfy this shape without adaptation. The library only ever depends on
 * this interface, never on a concrete client or the `mqtt` package itself, so it never
 * creates, connects, or disconnects a connection.
 */
export interface MqttClientLike {
  subscribe(topic: string, callback?: (error: Error | null, granted?: unknown) => void): unknown;
  publish(
    topic: string,
    payload: string | Buffer,
    callback?: (error?: Error | null) => void,
  ): unknown;
  on(event: 'message', listener: (topic: string, payload: Buffer, packet?: unknown) => void): unknown;
}
