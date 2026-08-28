# @openrobops/iso21423 — TypeScript SDK for ISO 21423

A TypeScript/Node.js implementation of **ISO 21423** — *Robotics — Industrial mobile robots —
Communications and interoperability* — the open standard for how autonomous mobile robots (IMRs),
fleet managers (IMRFMs) and facility equipment talk to each other over **MQTT 3.1.1 + JSON**.

The SDK was developed as part of **[OpenRobOps](https://github.com/OpenRobOps)**, the open-source
robot operations platform, which uses it to run as an ISO 21423 fleet manager (see
[ISO 21423 in OpenRobOps](https://openrobops.org/docs/iso21423/overview)). It is independent of
OpenRobOps, though: anyone building an ISO 21423 robot, fleet manager, observer or facility
controller in Node.js can use it.

> **Status:** v0.1 — tracks **ISO/FDIS 21423:2026** (Final Draft). The API may still move before
> 1.0; the wire format follows the FDIS, with the deviations listed under
> [Spec deviations](#spec-deviations). Known defects in the draft are catalogued in
> [`docs/iso-fdis-21423-defects.md`](../docs/iso-fdis-21423-defects.md).

## What it gives you

- **Topics and resources** — the `/ISO_21423/v1/<entityType>/<uuid>/<resource>` namespace, Table B.1
  QoS/retain/rate per resource, identity discovery wildcard, topic parsing, and deployment-defined
  extension resources.
- **Session rules you cannot get wrong** — persistent session, 60 s keep-alive, the B.4 Last Will on
  `disconnection` (QoS 1, retained), stale-will cleanup on (re)connect, streaming rate limits for
  `odometry` / `localTrajectory`.
- **Typed messages + JSON Schema validation** — every Annex A object typed, validated on egress and
  ingress (Ajv), with tolerant normalisation of known FDIS inconsistencies.
- **The request protocol** — `request` / `requestStatus` topics, the Figure C.3/C.4 state machines,
  `activeRequestsStatus`, retained-request cleanup on terminal states, and all five C.2.2
  concurrency strategies as ready-made execution policies.
- **Roles** — one `EntityHandle` abstraction that publishes, sends requests, and serves them, for
  your own entity or for entities you manage on their behalf (B.5.2.4); a `FleetGateway` facade for
  the IMRFM role; observer subscriptions with structured filters.
- **Geometry** — least-squares rigid 2D transform fitting between a local map and the facility
  Common Coordinate System (Clause 4, Annex D).
- **Testing** — an in-process MQTT broker so you can test robots and fleet managers without
  Mosquitto.

## Install

Requires Node.js ≥ 22. The package is published to GitHub Packages under `@openrobops`
(public npmjs publication follows API stability):

```ini
# .npmrc
@openrobops:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs `read:packages`, even for public packages. Then:

```sh
npm install @openrobops/iso21423 mqtt
```

`mqtt@^5` is a peer dependency: install it, or inject your own `MqttTransport` (see
[Transports](#transports)). ESM and CJS builds with type declarations are included.

## Quick start

### A robot (IMR)

```ts
import { Iso21423Client, createMqttTransport } from '@openrobops/iso21423';
import type { MoveProps } from '@openrobops/iso21423';

const client = await Iso21423Client.connect({
  transport: createMqttTransport('mqtt://broker.local:1883', { username: 'amr07', password: '…' }),
});

// Registering the self entity publishes the retained identity and arms the Last Will.
const robot = await client.registerSelfEntity({
  entityUuid: '5f8c1e2a-6b3d-4a9f-8e11-2c7d9a4b1f00',
  entityType: 'IMR',
  manufacturerName: 'Acme Robotics',
  details: {
    imrModel: 'AMR-7', imrSerialNumber: 'A7-0042', imrHeight: 1.2,
    imrFootprint: [{ x: 0.4, y: 0.3 }, { x: 0.4, y: -0.3 }, { x: -0.4, y: -0.3 }, { x: -0.4, y: 0.3 }],
    imrWorkingArea: [], softwareVersions: [{ moduleName: 'nav', moduleVersion: '3.1.0' }],
  },
  capabilities: { provides: ['odometry', 'batteryStatus'], accepts: ['move', 'pauseImr', 'resumeImr', 'cancelRequest'] },
});

await robot.publishStatus({ states: ['MODE_AUTO', 'IDLE'] });
await robot.publishBatteryStatus({ batterySoc: 0.82, batteryChargingState: 'DISCHARGING' });
await robot.publishOdometry({
  pose: { locationPoint: { ccsId: CCS_ID, x: 12.4, y: 8.1, z: 0 }, orientation: { yaw: 1.57, pitch: 0, roll: 0 } },
  velocity: { linear: 0.5, angular: 0 },
});

// Serve requests. The SDK handles RECEIVED/ACCEPTED/EXECUTING/terminal statuses, activeRequestsStatus,
// retained-request cleanup and concurrency; you implement the action.
robot.onRequest<MoveProps>('move', async (action, ctx) => {
  await nav.goTo(action.properties.location, ctx.signal);   // ctx.signal aborts on cancel
  ctx.progress({ distanceRemaining: 0 });
  return ctx.succeeded();
});
robot.onRequest('pauseImr', async (_a, ctx) => { nav.pause(); return ctx.succeeded(); });
```

### A fleet manager (IMRFM) commanding robots

```ts
import { Iso21423Client, EntityFilter, move, RequestFailed } from '@openrobops/iso21423';

const client = await Iso21423Client.connect({ url: 'mqtt://broker.local:1883', security: { username, password } });
const fm = await client.registerSelfEntity({
  entityUuid: IMRFM_ID, entityType: 'IMRFM', manufacturerName: 'Acme Fleet',
  details: { softwareVersions: [{ moduleName: 'fleet', moduleVersion: '1.0.0' }] },
});

// Discover robots as their retained identities arrive (current ones are replayed synchronously).
await client.subscribeEntities(EntityFilter.ofType('IMR'), (identity) => console.log('IMR', identity.id));
await client.subscribeResource('odometry', EntityFilter.ofType('IMR'), (ev) => track(ev.entityUuid, ev.message));

// Send a request. The SDK refuses to send an action the robot does not advertise in `accepts`.
const handle = await fm.sendRequest({
  destination: ROBOT_ID,
  details: [move({ location: { ccsId: CCS_ID, x: 20, y: 5, z: 0 } })],
});
handle.onStatus((s) => console.log(s.status));
try {
  await handle.completion();                 // resolves on SUCCEEDED
} catch (e) {
  if (e instanceof RequestFailed) console.log('ended', e.finalStatus);
}
// …or cancel it: sends a `cancelRequest` for this request.
await handle.cancel();
```

### A fleet manager publishing on behalf of robots

For robots that do not speak ISO 21423 themselves (B.5.2.4 "managed entities"), `FleetGateway`
owns the IMRFM identity, every managed robot's identity (with `manages` / `managedBy` links kept
consistent), and replays fleet-wide handlers onto each robot:

```ts
import { FleetGateway } from '@openrobops/iso21423';

const fleet = await FleetGateway.connect({
  url: 'mqtt://broker.local:1883',
  imrfm: { id: IMRFM_ID, manufacturerName: 'Acme Fleet', accepts: ['move'] },
});
const r1 = await fleet.registerImr({ id: ROBOT_1, manufacturerName: 'Legacy Co', accepts: ['move'] });
await r1.publishOdometry(sampleFromLegacyApi());

fleet.onRequest('move', async (action, ctx) => {
  await legacy.goTo(ctx.entity.entityUuid, action.properties);
  return ctx.succeeded();
});
// Requests with an empty `destination` ("IMRFM picks the robot") land here:
fleet.onDispatch((request, imrs) => imrs.find(isIdle)?.entityUuid ?? null);
```

The gateway also turns on two robustness features by default: a **retained-request janitor** that
clears retained requests left behind by crashed senders after a grace period, and a **publish
self-check** that verifies the session can actually publish under its own identity (catches
broker ACL misconfiguration early).

### An observer

```ts
const client = await Iso21423Client.connect({ url });          // no identity → no Last Will
await client.subscribeRequestStatus(RequestStatusFilter.all(), (ev) => dashboard.update(ev));
const catalog = client.discover();                             // every entity seen so far
catalog.on('lost', (e) => alert(`${e.entityUuid} lost connection`));
```

## Concepts

### Entities and `EntityHandle`

Everything on the ISO network is an *entity* with a type (`IMR`, `IMRFM`, or a deployment-defined
type such as `DOOR`) and a UUID. `Iso21423Client` owns one MQTT session and hands out
`EntityHandle`s:

- `registerSelfEntity(reg)` — the entity *this process is*. The first call arms the B.4 Last Will
  for it. Publishes the retained identity.
- `registerManagedEntity(managerUuid, reg)` — an entity this process publishes *for*, under the
  entity's own topic tree, linked to its manager via `manages`/`managedBy`.

A handle publishes (`publishIdentity`, `updateIdentity`, `publishStatus`, `publishBatteryStatus`,
`publishOdometry`, `publishLocalTrajectory`, `publishGlobalPath`, `publishGlobalPlan`,
`publishExtension`), sends requests (`sendRequest`), and serves them (`onRequest`, or the low-level
`acceptRequests`). `unregister()` clears every retained topic except a final `OFFLINE` status
tombstone.

### Requests

`sendRequest` publishes a retained `request/<uuid>` (QoS 2), subscribes to its status *before*
publishing so no update is missed, and returns a `RequestHandle`:

| | |
|---|---|
| `onStatus(cb)` | every `requestStatus` for this request |
| `completion()` | resolves with the final status on `SUCCEEDED`, rejects with `RequestFailed` on `ABORTED`/`CANCELED`, `RequestTimeout` if no terminal status arrives in `timeoutMs`, `BrokerUnavailable` if the connection drops |
| `cancel()` | sends a `cancelRequest` naming this request |

Action builders in `@openrobops/iso21423` produce correctly-shaped `RequestDetail`s: `move`,
`dock`, `undock`, `pauseImr`, `resumeImr`, `cancelRequest`. Vendor actions are plain
`{ type, version, properties }` objects; a robot opts in by listing the type in
`capabilities.accepts`. Pass `requireCapability: false` to send to an entity whose capabilities are
unknown or that does not advertise the action.

On the serving side, `onRequest(type, handler)` registers an `ActionHandler` per action type. The
executor handles the whole lifecycle — `RECEIVED` before any handler runs, duplicate suppression,
admission by execution policy, `ACCEPTED`/`EXECUTING`, `blocking`/`atomic` semantics across a
multi-detail request, `recoveries`, terminal status, `activeRequestsStatus`, and clearing the
retained request with a zero-byte payload. The handler gets an `ActionContext` with the request,
an `AbortSignal` that fires on cancel, `progress()`, `succeeded()` and `aborted(reason)`.

**Execution policies** (`policies.*`, Clause C.2.2) decide what happens when a request arrives
while others are active: `abortNew()`, `queueReplace()`, `queueAfter()`, `parallel(max?)`
(default) and `priority()`. Set per entity (`executionPolicy` at registration,
`setExecutionPolicy`) or per client (`setDefaultExecutionPolicy`), or supply your own
`ExecutionPolicy`.

`sequenceId`s are monotonic per entity and survive restarts through a `SequenceStore` — by default
a JSON file under `$ISO21423_STATE_DIR` or `~/.iso21423`. Pass `sequenceStore: null` for
in-memory only (tests).

### Filters

Observer APIs take structured filters that compile to MQTT wildcards: `EntityFilter.all() /
ofType(t) / entity(uuid) / anyOf([...])`, `RequestFilter.all() / toEntity(uuid) / ofType(t)`,
`RequestStatusFilter.all() / ofEntity(uuid) / ofType(t)`, and `RequestAcceptanceFilter.all() /
actions([...]) / fromSource(uuid)` for `acceptRequests`.

### Extension resources

The standard leaves the resource catalogue open. Register a deployment-defined resource once on
each side and publish/subscribe it like any other:

```ts
import { registerExtensionResource } from '@openrobops/iso21423';
registerExtensionResource('customData', { qos: 1, retain: false });
await robot.publishExtension('customData', { timestamp: new Date().toISOString(), values: { echo: 'hi' } });
await client.subscribeResource('customData', EntityFilter.ofType('IMR'), (ev) => …);
```

Standard names cannot be redefined; identical re-registration is a no-op. Extension payloads are
not schema-validated.

### Geometry

`fitTransform(from, to)` fits a rigid 2D transform (rotation + translation, least squares) from
≥ 3 point pairs — e.g. reference points measured both in a robot's map frame and in the facility
CCS; `applyTransform`, `invertTransform` and `transformYaw` apply it. The standard defines the CCS
but no way to distribute it, so calibration data is deployment configuration.

### Transports

`createMqttTransport(url, { username, password, tls, reconnectPeriod })` builds a transport on
`mqtt@5`. `wrapMqttClient(client)` adopts a client you constructed — it is rejected if its `will`
does not match what the standard requires. Implement the small `MqttTransport` interface to use
any other client. `Iso21423Client.connect({ url, security })` is shorthand for the first form.

### Diagnostics and health

- `client.on('connection', s)` — `connected | reconnecting | offline | closed`.
- `client.on('validation-warning', w)` — inbound messages that were normalised or carry unknown
  operating states.
- `client.on('diagnostic', e)` — non-fatal conditions: `duplicate-request-ignored`,
  `legacy-cancel-normalized`, `inbound-illegal-transition`, `dispatch-rejected`, `janitor-cleared`,
  `self-check-failed`, `sequence-store-unavailable`, `will-not-armed`.
- `client.health()` — connection state, entities, subscriptions, in-flight/serving counts and
  publish/receive/warning/rejection counters.

Errors are subclasses of `Iso21423Error`: `ValidationError`, `RequestFailed`, `RequestTimeout`,
`BrokerUnavailable`, `AuthorizationDenied`, `NotCapableError`, `IllegalTransition`.

## Testing your integration

`@openrobops/iso21423/testing` ships `MemoryBroker`, an in-process broker with retained messages,
Last Will and subscription-denial simulation:

```ts
import { MemoryBroker } from '@openrobops/iso21423/testing';

const broker = new MemoryBroker();
const robotClient = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
const fmClient = await Iso21423Client.connect({ transport: broker.createTransport(), sequenceStore: null });
// … register entities, send a request …
broker.retainedOn(`/ISO_21423/v1/IMR/${ROBOT}/identity`);   // inspect the wire
broker.messagesUnder(`/ISO_21423/v1/IMR/${ROBOT}/request`);
```

## Module map

| Entry point | Contents |
|---|---|
| `@openrobops/iso21423` | everything below, re-exported |
| `…/types` | TypeScript types for every Annex A object, vocabularies (`KNOWN_OPERATING_STATES`, `REQUEST_STATES`, `DOCK_ACTIONS`, …), action builders |
| `…/schema` | `validateMessage`, `assertValid`, `normalizeInbound`, the bundled JSON Schema |
| `…/topics` | `topicFor`, `requestTopic`, `parseTopic`, `identityWildcard`, `RESOURCE_CONFIG`, `registerExtensionResource` |
| `…/geometry` | `fitTransform`, `applyTransform`, `invertTransform`, `transformYaw` |
| `…/session` | `Iso21423Session`, `MqttTransport`, `createMqttTransport`, `wrapMqttClient`, `RateGate` |
| `…/core` | `Iso21423Client`, `EntityHandle`, `RequestHandle`, `IncomingRequest`, filters, `policies`, `SequenceStore` |
| `…/gateway` | `FleetGateway`, `RetainedRequestJanitor`, `publishSelfCheck` |
| `…/testing` | `MemoryBroker`, `MemoryTransport` |

## Coverage

| ISO 21423 area | Status |
|---|---|
| Clause 4 CCS — types, Annex D transform fit | ✅ (no CCS transport: none is defined by the standard) |
| Clause 5/7 identity and capabilities (Tables 4, 7, A.3) | ✅ |
| Clause 6/8 status, all Table 5 / Table 9 states, battery, odometry, trajectories, NURBS global path | ✅ |
| Clause 9 / Annex C requests — envelope, details, status, state machines, all C.2.2 policies, recoveries, empty destination | ✅ |
| Clause 10 / Annex B — topics, QoS/retain, persistent session, Last Will, keep-alive, streaming rate bounds | ✅ |
| B.5.2.4 managed entities | ✅ (`FleetGateway`) |
| Annex A JSON Schema | 🌗 all objects except `ccs`, `referencePoint`, `entityFootprintHeight` |
| `footprint` resource | 🌗 QoS/retain entry only; no schema or typed publisher (the FDIS leaves it half specified) |
| Table 5 conditional rules (exactly one `MODE_*`, stop categories in manual modes) | ❌ unknown states only warn |
| Minimum publish frequency (6.3, Clause 8) | ❌ only the Table B.1 maxima are enforced |
| Broker provisioning, ACLs, credential issuance | out of scope — see how OpenRobOps does it |

## Spec deviations

Deliberate, documented positions on FDIS defects (details and rationale in
[`docs/iso-fdis-21423-defects.md`](../docs/iso-fdis-21423-defects.md) and the
[decision register](../docs/nodejs_design/docs/decision_register.md)):

- The cancel action is emitted as **`cancelRequest`**; the FDIS name `cancel` is accepted on
  ingress and normalised (diagnostic `legacy-cancel-normalized`).
- Resource name **`activeRequestsStatus`** (Table B.1) over B.2.2's `activeRequestStatus`.
- Status messages use **`entityId` / `states`**; inbound `id` is renamed with a warning.
- The Last Will payload is valid JSON, **`{"states":["LOST_CONNECTION"]}`**, and `disconnection`
  is treated as a first-class resource.
- Request/status topics always include the `<entityType>` segment.
- Comma decimal separators in timestamps are normalised to dots on ingress.
- `move.orientation`, odometry `orientation`, `imrName` and `disabledCapabilities` — present in the
  FDIS schema/examples but not its tables — are supported.

## Development

```sh
nvm use          # Node 22, see .nvmrc
npm install
npm run build    # tsup → dist/ (ESM + CJS + .d.ts)
npm test         # unit + integration (in-process broker)
npm run test:live   # against a real broker: ISO21423_BROKER_URL=mqtt://localhost:1883
npm run typecheck
npm run lint
```

Layout: `src/` (see module map), `test/` (Vitest: unit suites, `integration/` scenarios on
`MemoryBroker`, `live/` round-trip against a real broker). Releases are published to GitHub
Packages by CI on `v*` tags.

### Code style

Every non-trivial exported class, interface, function and method carries a TSDoc comment stating
what the signature alone can't — units, ordering, throw conditions, side effects. Trivial members
stay bare. Spec references (ISO clause numbers, `ND-xx`, `D-xx` decision ids) are kept verbatim
wherever they appear.

## Further reading

- [Understanding ISO 21423](../docs/standard/README.md) — plain-language companion to the standard
- [NodeJS SDK design](../docs/nodejs_design/README.md) — decision register, API rationale, role examples
- [FDIS defects catalogue](../docs/iso-fdis-21423-defects.md)
- [ISO 21423 in OpenRobOps](https://openrobops.org/docs/iso21423/overview) — a production fleet manager built on this SDK, and its [coverage page](https://openrobops.org/docs/iso21423/coverage)
- [sim-flatland](https://github.com/OpenRobOps/sim-flatland) — a simulated robot with an ISO 21423 agent built on this SDK

## License

Apache-2.0.
