# ISO 21423 — Proposed NodeJS/TypeScript API

> Status: design proposal for team review. Aligns with the
> [NodeJS Decision Register](decision_register.md); shared decision IDs (**D-xx**, **P-x**) refer to
> the [C++ register](../../cpp_design/docs/decision_register.md), Node-specific IDs (**ND-xx**,
> **NP-x**) to the Node register. The companion visual is
> [`diagrams/iso21423_ts_class_diagram.mmd`](../diagrams/iso21423_ts_class_diagram.mmd).

## 1. Conventions

- **Language**: TypeScript 5, Node ≥ 22, ES2022 (**ND-01**). Async methods return Promises; errors
  are typed classes (**ND-16**) thrown or rejected — no result objects.
- **Platform-agnostic** (**ND-02**): runtime deps `ajv`, `uuid`; `mqtt@^5` peered behind the
  injected transport.
- **Transport injected** (**D-07**): the SDK talks to an `MqttTransport` interface; the `mqtt`
  package never leaks into the public surface.
- **Event-loop native** (**D-08**): no worker threads; handlers are `async` and must not block the
  loop.
- **`EntityHandle` is the primary actor** (**D-09**, **D-10**): resources are published and requests
  are sent/served through an `EntityHandle`.
- **Status stream is the source of truth** (**D-16**): `completion()` is sugar over it.
- **`Subscription` is a disposable token** (**D-19**): `unsubscribe()` or `await using`.
- Every behavioral "shall" (QoS per topic, retain flags, LWT, on-change publishing,
  retained-request cleanup) is enforced by the SDK and not expressible incorrectly through the
  public API (**ND-08**). Domain semantics (what a `move` does) belong to the caller.

## 2. Package layout

One npm package, `@openrobops/iso21423`, with subpath exports (**ND-02**, **ND-19**):

```
@openrobops/iso21423
├── /types      Generated + hand-refined TS types, enums, constants
├── /schema     Annex A JSON Schema (bundled, ND-03) + runtime validators (ajv)
├── /topics     Topic builder/parser, per-resource QoS/retain registry (Table B.1) + registerExtensionResource()
├── /geometry   CCS transforms (Annex D least-squares fit), point/pose utilities
├── /session    Conformant MQTT session (LWT, persistent, keep-alive, publish rules)
├── /core       Iso21423Client, EntityHandle, RequestHandle, IncomingRequest,
│               Subscription, EntityFilter, ExecutionPolicy, RequestExecutor
├── /gateway    FleetGateway facade (IMRFM ergonomics over /core)
└── /testing    MemoryBroker/MemoryTransport fakes for broker-free tests
```

Dependency rules are strictly downward: `gateway` → `core` → `session` → `topics`/`schema`/`types`;
`geometry` → `types`. There is no separate `/client` package: the consumer role is served directly
by `/core` (**D-01**, **D-10**) — this replaces the earlier gateway/client split.

## 3. Core data types (`/types`)

Types mirror Annex A schema names 1:1 so the standard remains the documentation.

```typescript
// Identity & capability (Tables 4, 7, A.1–A.4, A.12)
interface EntityIdentity {
  id: Uuid; timestamp: IsoTimestamp;
  entityType: 'IMR' | 'IMRFM' | string;      // open for B.7 extension entities (ND-05)
  manufacturerName: string;
  iso21423Version?: string;                  // "1.0"
  capabilities: Capabilities;
  details: ImrDetails | ImrfmDetails;
}
interface Capabilities {
  provides: ResourceName[];
  accepts: { requests: string[] };           // action type names, vendor-extensible
  manages?: Uuid[]; managedBy?: Uuid;
}

// Status & telemetry (Tables 5, 6, 8, 9, A.5–A.11)
interface EntityStatus {
  entityId: Uuid; timestamp: IsoTimestamp;
  states: OperatingState[];                  // mode first, then states by priority
  disabledCapabilities?: Capabilities;
}
type OperatingState = KnownOperatingState | string;   // open enum (ND-05)
interface Odometry {
  timestamp: IsoTimestamp;
  pose: { locationPoint: LocationPoint; orientation: Orientation };
  velocity: { linear: number; angular: number };
}
interface LocationPoint { ccsId: Uuid; x: number; y: number; z: number }
interface BatteryStatus {
  timestamp: IsoTimestamp; batterySoc: number;        // 0..1
  batteryChargingState?: ChargingState; batteryHealth?: BatteryHealth;
  batteryTemperature?: number; batteryVoltage?: number; batteryCurrent?: number;
}
// LocalTrajectory, GlobalPath (NurbsCurve), GlobalPlan per Tables A.6–A.11

// Requests (Annex C, Tables C.1–C.7)
interface Request {
  destination: Uuid | '';                    // '' → IMRFM picks the robot (ND-12)
  source: Uuid; sequenceId: number; timestamp: IsoTimestamp;
  priority?: number;                         // 0 high … 255 low, default 100
  atomic?: boolean;
  details: RequestDetail[]; recoveries?: RequestDetail[];
}
interface RequestDetail {
  type: string; version: string; format?: string;     // default "ISO-21423"
  blocking?: boolean;                        // default true
  atomic?: boolean;                          // default false
  properties?: Record<string, unknown>;
}
interface RequestStatus {
  source: Uuid; destination: Uuid; sequenceId: number;
  requestSequenceId: number; timestamp: IsoTimestamp;
  status: RequestState;  // RECEIVED|ACCEPTED|EXECUTING|CANCELED|SUCCEEDED|ABORTED|RECOVERY
  detailStatuses: RequestDetailStatus[]; recoveryStatuses?: RequestDetailStatus[];
}
type StatusReason =                          // full wire enum (ND-13)
  | 'OK' | 'GENERAL_FAILURE' | 'TIMEOUT' | 'VERSION_NOT_SUPPORTED' | 'FORMAT_NOT_SUPPORTED'
  | 'ACTION_NOT_IMPLEMENTED' | 'REJECTED' | 'MALFORMED_REQUEST' | 'INVALID_IMR_STATE_FOR_ACTION';

// Typed action builders for the standard actions (D-02: cancelRequest, not cancel):
//   move({location, orientation?, toleranceRadius?, orientationTolerance?, arrivalTime?})
//   pauseImr(), resumeImr(), cancelRequest({source, requestId, actionId?})
//   dock({dockLocation, dockId?, dockActions?, ...}), undock()

// CCS (Clause 4) + geometry helpers (Annex D)
interface Ccs { id: Uuid; name: string; referencePointIds: Uuid[] }
interface ReferencePoint { id: Uuid; name: string; x: number; y: number }
// geometry: fitTransform(localPts, ccsPts): RigidTransform2D, applyTransform, invertTransform
```

Deliberate choices: open enums (**ND-05**), validation at the boundary not in the types (**ND-06**),
ISO 8601 dot-decimal timestamps with `Date` accepted at API boundaries (**ND-07**).

### 3.1 Known FDIS inconsistencies and resolution policy (ND-04)

**Resolution rule: the Annex A JSON schema and Annex B topic details win over clause tables and
prose** — except where the schema forecloses a feature the tables describe. Ingress is lenient
(warn + normalize); egress always emits the conformant form. Clause-level citations live in
[`docs/iso-fdis-21423-defects.md`](../../iso-fdis-21423-defects.md).

| Where | Conflict | SDK follows |
|---|---|---|
| Status message | Tables 6/8 say `id`/`operatingStates`; schema and B.5.5 examples say `entityId`/`states` | `entityId` / `states` (schema) |
| Active requests topic | B.2.2 says `activeRequestStatus`; Table B.1 and examples say `activeRequestsStatus` | `activeRequestsStatus` |
| Cancel action name (**D-02**) | Clause 9 / C.2.4 use `cancel`; the schema's `$defs` name is `cancelRequest` and its action enum lists **both** | Emit `cancelRequest`; accept `cancel` inbound (warn + normalize) |
| Cancel properties | Table C.4 defines `requestId`; the C.1.1.2.6.4 example uses `"id"` | `requestId` (table; example is malformed) |
| Move properties | C.1.1.2.5 example includes target `orientation` that Table C.3 never defines | Accept and emit optional `orientation` — tolerance without a target is meaningless |
| Timestamp decimals | Clause tables write `ss,fffZ`; schema examples use `ss.fffZ` | Dot; parser accepts both |
| Empty destination | Table C.1 describes empty-`destination` dispatch; the schema's UUID pattern rejects `""` | Support `""`; patch bundled schema with `anyOf: [uuid, const ""]` (table wins — schema forecloses a described feature) |
| NURBS knots | Table A.9 says int32 array; schema says `number` items | `number[]` (real-valued knot vectors are standard NURBS) |

## 4. Transport port (`/session`)

The injected transport must support Last-Will registration at connect and connection-state
callbacks (**P-4**, settled for Node).

```typescript
type Qos = 0 | 1 | 2;
type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'closed';

interface WillOptions { topic: string; payload: string; qos: Qos; retain: boolean }
interface TransportConnectOptions {
  clientId: string; cleanSession: boolean; keepalive: number;
  will?: WillOptions; username?: string; password?: string;   // + TLS options pass-through (ND-15)
}
interface TransportMessage { topic: string; payload: Buffer; qos: Qos; retain: boolean }

interface MqttTransport {
  connect(opts: TransportConnectOptions): Promise<void>;
  publish(topic: string, payload: string | Buffer, opts: { qos: Qos; retain: boolean }): Promise<void>;
  subscribe(filter: string, opts: { qos: Qos }): Promise<{ granted: boolean }>;
  unsubscribe(filter: string): Promise<void>;
  onMessage(cb: (msg: TransportMessage) => void): void;
  onConnectionState(cb: (s: ConnectionState) => void): void;
  end(): Promise<void>;                       // graceful: suppresses the will
}
```

`Iso21423Session` (internal substrate for `/core`) encodes every Annex B session rule — persistent
session, keep-alive 60 s, the B.4 will, stale-`disconnection` cleanup on connect, Table B.1
QoS/retain lookup, on-change guard for retained resources, streaming rate gate, reconnect republish
(**ND-08**). `MemoryBroker`/`MemoryTransport` in `/testing` implement enough MQTT semantics
(wildcard matching, retained messages, wills, scriptable drops, ACL denial) for broker-free tests.

## 5. `Subscription` (`/core`)

```typescript
interface Subscription extends AsyncDisposable {
  unsubscribe(): Promise<void>;               // idempotent
  readonly active: boolean;
  readonly topicFilters: readonly string[];
  // [Symbol.asyncDispose]() === unsubscribe()  →  `await using sub = …` (D-19)
}
```

Subscriptions are lazy underneath (**ND-17**): the MQTT subscribe happens on first listener per
filter, unsubscribe on last.

## 6. `Iso21423Client` (`/core`)

The root object: session wiring, entity registration, deployment-wide observation, diagnostics
(**D-10**, **D-18**).

```typescript
class Iso21423Client {
  static connect(opts: {
    transport: MqttTransport;                 // or broker URL + options → default mqtt adapter
    security?: SecurityOptions;               // TLS/credentials pass-through, selfCheck (ND-15)
    validateOutbound?: boolean;               // default: on outside production (ND-06)
    sourceId?: Uuid;                          // identity-less requester mode (ND-14)
  }): Promise<Iso21423Client>;

  // Entity registration (D-09, D-11)
  registerSelfEntity(reg: EntityRegistration): Promise<EntityHandle>;
  registerManagedEntity(managerUuid: Uuid, reg: ManagedEntityRegistration): Promise<EntityHandle>;
  listManagedEntities(managerUuid: Uuid): EntityHandle[];

  // Deployment-wide observation (D-18): build your own world model from these.
  subscribeEntities(filter: EntityFilter, handler: (id: EntityIdentity) => void): Promise<Subscription>;
  subscribeResource(kind: ResourceKind, filter: EntityFilter,
                    handler: (ev: ResourceEvent) => void): Promise<Subscription>;
  subscribeRequests(filter: RequestFilter, handler: (ev: RequestEvent) => void): Promise<Subscription>;
  subscribeRequestStatus(filter: RequestStatusFilter,
                         handler: (s: RequestStatus) => void): Promise<Subscription>;

  // Optional local EntityCache sanctioned by D-18 — retained identities only, never a broker query.
  discover(): EntityCatalog;                  // emits 'entity' events; entities() snapshot incl.
                                              // manages/managedBy graph and disconnection state

  // Policy & diagnostics
  setDefaultExecutionPolicy(policy: ExecutionPolicy): void;      // P-2
  health(): ClientHealth;                                        // ND-18
  on(event: 'connection' | 'validation-warning' | 'diagnostic', cb: (...args) => void): void;

  close(opts?: { timeout?: number }): Promise<void>;
}
```

`EntityFilter` builders (**P-3**/**NP-3**): `EntityFilter.all()`, `.ofType('IMR')`,
`.entity(uuid)`, `.anyOf([a, b])` — each compiles to an MQTT wildcard subscription.

## 7. `EntityHandle` (`/core`)

Primary actor (**D-09**). Owns its monotonic, persisted `sequenceId` (**D-15**, **ND-09**).

```typescript
class EntityHandle {
  readonly entityUuid: Uuid;
  readonly entityType: string;
  readonly ownershipMode: 'self' | 'managed';

  // Resource publication — QoS/retain/rate/on-change enforced by the session (ND-08)
  publishIdentity(identity: EntityIdentity): Promise<void>;
  updateIdentity(partial: Partial<EntityIdentity>): Promise<void>;   // republishes (retained)
  publishStatus(update: StatusUpdate): Promise<void>;
  publishBatteryStatus(update: BatteryStatus): Promise<void>;
  publishOdometry(sample: Odometry): Promise<void>;
  publishLocalTrajectory(sample: LocalTrajectory): Promise<void>;
  publishGlobalPath(snapshot: GlobalPath): Promise<void>;
  publishGlobalPlan(snapshot: GlobalPlan): Promise<void>;
  /** Deployment-defined resource declared via registerExtensionResource(); no schema, raw JSON. */
  publishExtension(resource: string, payload: unknown): Promise<void>;

  // Requester side (D-09): sequenceId assigned internally (D-15)
  sendRequest(cmd: RequestCommand): Promise<RequestHandle>;

  // Executor side — low-level escape hatch (ND-11.2). The SDK auto-publishes RECEIVED and
  // auto-rejects schema-invalid requests before the handler runs (D-12, D-13).
  acceptRequests(filter: RequestAcceptanceFilter,
                 handler: (req: IncomingRequest) => void): Promise<Subscription>;

  // Executor side — high-level per-action layer (ND-11.1), same substrate
  onRequest(type: string, handler: ActionHandler): void;
  onRequest(type: string, handler: ActionHandler, opts: { override: true }): void;

  setExecutionPolicy(policy: ExecutionPolicy): void;   // P-2 per-handle override
  unregister(): Promise<void>;   // final OFFLINE status, zero-byte-clears retained topics
}

type ActionHandler = (action: TypedRequestDetail, ctx: ActionContext) => Promise<ActionResult>;
// ctx: { entity: EntityHandle, request: Request, signal: AbortSignal, progress(props): void,
//        succeeded(props?): ActionResult, aborted(reason: StatusReason, msg?): ActionResult }
```

The per-action layer (**ND-11.1**) owns detail sequencing (`blocking` serial, consecutive
non-blocking concurrent), `atomic` protection, recovery execution, `activeRequestsStatus`
aggregation, `cancelRequest` resolution, and automatic rejection reason codes. Sending `move` to an
entity whose discovered capabilities don't accept it throws `NotCapableError` client-side
(overridable).

## 8. `RequestHandle` (`/core`)

Outcome is a status **stream** (**D-16**); `completion()` is sugar over it.

```typescript
class RequestHandle {
  readonly requestUuid: Uuid;
  readonly sourceUuid: Uuid;
  readonly sequenceId: number;
  readonly destination: Uuid | '';
  readonly createdAt: Date;

  latestStatus(): RequestStatus | undefined;              // last cached status
  onStatus(handler: (s: RequestStatus) => void): Subscription;  // live updates (source of truth)
  completion(): Promise<RequestStatus>;   // resolves SUCCEEDED; rejects RequestFailed(ABORTED|CANCELED)
  cancel(opts?: { actionId?: string }): Promise<void>;    // sends cancelRequest targeting this request
}
```

Sender-side duties handled automatically (**ND-10**, **D-14**): publish QoS 2 retained to the
destination's `request/<uuid>` topic, subscribe to `…/status`, track the state machine, raise a
local-only `RequestTimeout` if no `RECEIVED` arrives in the configured window, and zero-byte-clear
the retained request on any terminal status (B.5.3).

## 9. `IncomingRequest` (`/core`)

Handed to `acceptRequests` handlers. `RECEIVED` is already published (**D-12**); schema-invalid
requests never reach here (**D-13**).

```typescript
class IncomingRequest {
  readonly request: Request;
  readonly source: Uuid;
  readonly sequenceId: number;

  accept(): Promise<void>;                                        // → ACCEPTED
  reject(reason: StatusReason): Promise<void>;                    // → ABORTED
  updateStatus(update: RequestStatusUpdate): Promise<void>;       // e.g. → EXECUTING
  updateDetailStatus(update: RequestDetailStatusUpdate): Promise<void>;
  complete(terminal: RequestTerminalUpdate): Promise<void>;       // → terminal state
}
```

All transitions are validated against the Figure C.3/C.4 state machines (`IllegalTransition` on
violation; table pending **NP-2** reconciliation); `requestStatus` publishes on change only.

## 10. `ExecutionPolicy` (`/core`)

Interface first, presets on top (**D-17**, **P-2**):

```typescript
interface ExecutionPolicy {
  admit(pending: Request, active: readonly RequestStatus[]): AdmissionDecision;
  // AdmissionDecision: { action: 'accept' | 'reject' | 'buffer' | 'preempt', ... }
}
// Presets mirroring C.2.2: policies.abortNew(), policies.queueReplace(), policies.queueAfter(),
//                          policies.parallel(max?), policies.priority()
// Default: parallel-capable (D-17). Client-level default, per-handle override (P-2).
```

## 11. `FleetGateway` (`/gateway`) — IMRFM facade

A thin ergonomic layer over `/core` for the fleet-manager role — everything it does is expressible
with `Iso21423Client` + `EntityHandle` directly.

```typescript
const gateway = await FleetGateway.connect({
  transport, security,
  imrfm: { id, manufacturerName, details, accepts: [...] },
});
const robot: EntityHandle = gateway.registerImr({ id, identity: {...}, accepts: [...] });
// = client.registerManagedEntity(imrfmUuid, …) + manages/managedBy bookkeeping (D-11)

gateway.onRequest('move', handler);                      // fleet-wide per-action handler
gateway.onRequest('move', handler, { imr: imrUuid });    // per-robot override
gateway.onDispatch((request, imrs) => Uuid | null);      // empty-destination dispatch (ND-12)
gateway.unregisterImr(id);   // final OFFLINE, clears retained topics, updates manages links
```

Gateway extras: automatic `manages`/`managedBy` links on the IMRFM identity, the retained-request
janitor (**ND-10**), and the publish self-check on startup (**ND-15**, default on).

## 12. Errors (`/types`) — ND-16

`Iso21423Error` base → `ValidationError`, `RequestFailed`, `RequestTimeout`, `BrokerUnavailable`,
`AuthorizationDenied`, `NotCapableError`, `IllegalTransition`.

Rules: inbound malformed third-party messages never throw into user code
(`validation-warning` events); outbound validation failures throw at the call site; handler
exceptions in the executor map to `ABORTED` + `GENERAL_FAILURE` (then recoveries run); in-flight
request operations during a disconnect fail fast with `BrokerUnavailable`; publishers buffer
nothing except retained resources, which republish on reconnect.

## 13. Security — ND-15

Authentication: connection-time TLS (+ credentials or mTLS), passed through to the transport.
Authorization: broker-side topic ACLs keyed on the UUID-bearing topic layout. The SDK surfaces
SUBACK denials as `AuthorizationDenied`, offers the identity-echo publish self-check (silent ACL
drops are otherwise undetectable in MQTT 3.1.1), and ships a documented per-role ACL matrix.
Broker provisioning, credential rotation, and identity lifecycle are deployment concerns
(IEC 62443).

## 14. Usage sketches

See the role examples for full walkthroughs:
[IMR](example_imr.md) · [IMRFM](example_imrfm.md) ·
[Traffic controller](example_traffic_controller.md).

```typescript
// Standalone IMR — publish, serve, request (all three on one EntityHandle)
const client = await Iso21423Client.connect({ transport });
const imr = await client.registerSelfEntity(imrRegistration);
await imr.publishStatus({ states: ['MODE_AUTO', 'IDLE'] });
imr.onRequest('move', async (move, ctx) => { /* drive robot */ return ctx.succeeded(); });
const door = await imr.sendRequest({ destination: doorUuid, details: [openDoor({ doorId: 'D7' })] });
await door.completion();
```

## 15. Open items affecting this API

- **NP-2** — state-machine transition table reconciliation (blocks freezing `IllegalTransition`
  conformance tests).
- **NP-3** — exact `EntityFilter` builder surface.
- **NP-1** — optional transport-level correlation metadata.
- **NP-4** — conformance runner packaging (`/conformance` subpath vs separate tool).
