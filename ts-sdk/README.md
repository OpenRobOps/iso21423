# @openrobops/iso21423 — TypeScript SDK

TypeScript SDK implementing **ISO 21423** (Industrial mobile robots: communications and
interoperability, MQTT + JSON). See the [repository root README](../README.md) for the standard
overview and design docs.

## Requirements

- Node.js >= 22 (see `.nvmrc`)

## Setup

```sh
nvm use
npm install
```

## Common tasks

| Task | Command |
|---|---|
| Build (dual ESM + CJS + `.d.ts`) | `npm run build` |
| Run tests | `npm test` |
| Run tests in watch mode | `npm run test:watch` |
| Type-check without emitting | `npm run typecheck` |
| Lint | `npm run lint` |

Build output goes to `dist/`.

## Layout

- `src/` — SDK source
- `test/` — Vitest test suites
- `dist/` — build output (generated, gitignored)

## MQTT handoff

The SDK never creates, connects, or disconnects an MQTT client — the consumer (e.g. ORO)
owns the connection and hands off an already-connected client instance. This keeps the
library transport-agnostic and independent of any one consumer.

```ts
import mqtt from 'mqtt';
import { ImrfmEntity, ImrfmMqttHandoff } from '@openrobops/iso21423';

const client = mqtt.connect('mqtt://broker.example.com'); // consumer owns this connection
const entity = new ImrfmEntity({ id, manufacturerName, softwareVersions });

const handoff = new ImrfmMqttHandoff(client, entity);
handoff.subscribe(); // subscribes to this entity's status topic

// inbound: a status message on the entity's topic updates entity.state
handoff.on('error', (err) => console.error('unroutable ISO 21423 message', err));

// outbound: publish the entity's current identity/status
handoff.publishIdentity(new Date().toISOString());
handoff.publishStatus(new Date().toISOString());
```

- `MqttHandoff` — abstract base defining the handoff contract: constructed with a
  consumer-supplied `MqttClientLike` (`subscribe`/`publish`/`on('message', ...)`); never
  calls `connect()`/`end()` on it. Emits `'error'` for any inbound message it can't route.
- `ImrfmMqttHandoff` — wires an `ImrfmEntity` to the injected client following the
  `/ISO_21423/v1/<entityType>/<entityUuid>/<resourceName>` topic layout
  ([standard, Ch. 04](../docs/standard/04-communication.md)): inbound `status` messages
  update `entity.state`; `publishIdentity`/`publishStatus` publish the entity's
  serialized `identity`/`status` messages.
- `MqttClientLike` — the minimal structural contract a consumer's client must satisfy.
  A real `mqtt.js` client conforms to it as-is.
