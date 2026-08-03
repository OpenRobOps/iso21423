# ISO 21423 NodeJS SDK — Architecture Decision Register

_Status legend: **[Settled]** agreed in design sessions; **[Proposed]** recommended, open for team
discussion. For decisions shared with the C++ register: **[Adopted]** taken as-is;
**[Adopted ±]** taken with a documented Node-specific divergence; **[N/A]** language-specific to C++._

This register is the single source of truth for the NodeJS SDK design. It supersedes the earlier
prose spec (`docs/superpowers/specs/2026-07-27-iso21423-sdk-design.md`, now absorbed here and into
[`nodejs_api.md`](nodejs_api.md)).

**Relationship to the C++ design:** decisions `D-xx` / `P-x` are defined in the
[C++ decision register](../../cpp_design/docs/decision_register.md) and keep their IDs here so the two
SDK designs stay comparable. Node-specific decisions are `ND-xx` (settled) and `NP-x` (proposed).
Where this SDK deliberately diverges from a shared decision, the divergence is stated inline — never
silent.

## Shared decisions — scope & protocol

- **D-01 [Adopted]** Federated interop model: no central controller assumed; IMRs, IMRFMs,
  traffic/other controllers, and factory devices must all be expressible. Consequence for Node: a
  single entity-generic core (`EntityHandle`, see D-09/D-10) with role facades on top — the earlier
  hard split into a `FleetGateway` package and a consumer `Iso21423Client` package is replaced by
  facades over one core.
- **D-02 [Adopted]** Canonical cancel action name is **`cancelRequest`**; legacy `cancel` accepted on
  inbound only (warn + normalize). _Supersedes the earlier Node draft, which used `cancel`
  throughout._ Note the Annex A bundle schema itself defines the properties under
  `$defs/cancelRequest` and enumerates **both** `"cancel"` and `"cancelRequest"` as action types — so
  by ND-04's "schema wins" rule this is also the schema-conformant choice. Egress emits
  `cancelRequest`.
- **D-03 [Adopted]** Balanced conformance: normative violations are errors, recommended-only issues
  are warnings; conformance runs are tiered Must / Should / May. Node realization: the interop
  `ScenarioRunner` (see [testing_strategy.md](testing_strategy.md)) emits structured findings
  `{ severity, requirementId, detail }` where `requirementId` references the shared requirement list
  in [`requirements_traceability.json`](../../cpp_design/traceability/requirements_traceability.json)
  (`REQ-*`).
- **D-06b [Adopted]** MQTT 3.1.1 is the protocol baseline. The `mqtt@^5` client library is used, but
  MQTT 5 features (content-type, user properties) are opportunistic and confined behind the
  transport interface — no API change needed to adopt them later.

## Shared decisions — language & runtime

- **D-04 [N/A]** (C++23 / `std::expected`.) Node equivalent: **ND-01**.
- **D-05 [N/A]** (ROS-agnostic standalone C++.) Node equivalent: **ND-02**.

## Shared decisions — architecture

- **D-06 [Adopted]** Ports-and-adapters: strongly typed domain core; transport-agnostic public
  surface; strictly downward dependencies (`core`/`gateway` → `session` → `topics`/`schema`/`types`;
  `geometry` → `types`).
- **D-07 [Adopted ±]** Transport is injected via the `MqttTransport` interface; the `mqtt` package is
  confined to one adapter module, and a caller-constructed mqtt client is accepted. _Divergence:_ the
  Node session layer drives `connect()` on the injected transport (it owns session orchestration —
  stale-will cleanup, reconnect republish), whereas the C++ library never initiates the connection.
  The contract requirements of **P-4** (Last Will registration at connect time, connection-state
  callbacks) are part of `MqttTransport`.
- **D-08 [Adopted — moot in JS]** No hidden threads. The JS event loop makes this structural: the SDK
  spawns no workers, all callbacks fire on the event loop, handlers are `async` and must not block
  it. Internals need no locking; ordering guarantees come from the single-threaded dispatch.
- **D-09 [Adopted ±]** **`EntityHandle` is the primary actor.** Every entity — self or managed —
  is an `EntityHandle` that publishes resources, sends requests (`sendRequest`), and serves requests
  (`acceptRequests`). Requests carry an explicit `source` because they originate from a handle.
  _Divergence (**ND-14**):_ an identity-less "observer plus requests" mode with a bare `sourceId` is
  kept for lightweight tooling; publishing an identity is the recommended, conformance-friendly mode.
- **D-10 [Adopted]** `acceptRequests` lives on `EntityHandle`. `Iso21423Client` (the core root
  object) is reduced to: transport/session wiring, entity registration, deployment-wide observer
  subscriptions, and (later) device/controller federation.
- **D-11 [Adopted]** An IMRFM is modeled as one self `EntityHandle` plus one `EntityHandle` per
  managed IMR, so "who is acting" is always explicit. `FleetGateway.registerImr()` returns exactly
  such a managed handle.
- **D-20 [Adopted]** Device/controller federation is first-class in the architecture even though v1
  ships no dedicated device API: the open `entityType` string, generic
  `subscribeResource`/`acceptRequests`, and `sendRequest` already cover B.7 devices (doors, lifts).
  Dedicated ergonomics may be added later without breaking changes.

## Shared decisions — request lifecycle

- **D-12 [Adopted]** RECEIVED is transport-delivery confirmation: the SDK auto-publishes
  `RECEIVED` on schema-valid receipt **before** invoking any app handler; the handler then decides
  accept vs reject.
- **D-13 [Adopted]** Schema-invalid inbound requests are auto-rejected (`ABORTED` +
  `MALFORMED_REQUEST`); app handlers never see them.
- **D-14 [Adopted ±]** No library-invented protocol timeout. _Node refinement:_ the request sender
  raises a **local** `RequestTimeout` error if no `RECEIVED` arrives within a configurable window —
  this is surfaced to the caller only and is never published as a protocol state change.
- **D-15 [Adopted]** `sequenceId` is owned by the `EntityHandle` (monotonic per source); apps never
  manage it. Node adds durability (**ND-09**) so restarts cannot collide with still-retained
  requests.
- **D-16 [Adopted ±]** The requestStatus **stream is the source of truth** for a request's outcome;
  `RequestHandle.latestStatus()` exposes the last cached snapshot. _Divergence:_
  `RequestHandle.completion()` (a Promise resolving on `SUCCEEDED`, rejecting with `RequestFailed`
  on `ABORTED`/`CANCELED`) is kept — the C++ rationale for banning a future (deadlock in a
  single-threaded caller-pumped app) does not apply to the JS event loop. `completion()` is
  documented as sugar over the stream.
- **D-17 [Adopted]** Default request execution is **parallel-capable** with a pluggable runtime
  policy. The policy abstraction is an interface —
  `admit(pending, active) → AdmissionDecision` — and the named strategies of C.2.2 (`abort-new`,
  `queue-replace`, `queue-after`, `parallel(max)`, `priority`) ship as presets built on it.
  _Supersedes the earlier Node draft default of `abort-new`; aligned with the C++ register for
  cross-SDK consistency._

## Shared decisions — observers & subscriptions

- **D-18 [Adopted]** No synchronous deployment snapshot / broker query. Observers build their own
  world model from filtered subscriptions; retained messages replay last-known state on subscribe.
  `Iso21423Client.discover()` / `.entities()` is the optional **best-effort local `EntityCache`**
  explicitly allowed by D-18 — built purely from retained `identity` messages, never a broker query.
- **D-19 [Adopted]** `Subscription` is a lifetime token: `unsubscribe()` plus
  `Symbol.asyncDispose`, so `await using sub = …` unsubscribes on scope exit (the JS analog of RAII).

## Shared proposed items — Node positions

- **P-1** Schema distribution → **settled for Node as ND-03** (bundle in the npm package, runtime
  override for testing).
- **P-2 [Adopted]** ExecutionPolicy scope: client-level default, overridable per `EntityHandle`
  (an IMRFM can differ per managed IMR).
- **P-3 [Adopted]** Observer filter model: structured `EntityFilter` with builder helpers
  (`EntityFilter.all()`, `.ofType('IMR')`, `.entity(uuid)`, `.anyOf([...])`) compiling to MQTT
  wildcard subscriptions. Exact builder surface: **NP-3**.
- **P-4** Transport lifecycle contract → **settled for Node**: `MqttTransport` already carries
  Last-Will options at `connect()` and connection-state callbacks; the session republishes retained
  resources on reconnect (ND-08).
- **P-5** Transport-level correlation metadata → mirrored as **NP-1**, open.

## Node-specific decisions

- **ND-01 [Settled]** TypeScript 5, Node ≥ 22, ES2022 output. Errors are typed exception classes
  (thrown / promise rejections), not result objects — idiomatic JS, unlike C++'s `std::expected`.
- **ND-02 [Settled]** Platform-agnostic, no native modules. Runtime deps only `ajv` (+`ajv-formats`)
  and `uuid`; `mqtt@^5` is a peer dependency. License Apache-2.0. Package `@openrobops/iso21423`.
- **ND-03 [Settled]** Annex A schemas are bundled in the package (version-locked, with the documented
  ND-04 patches), with a runtime override path for testing/forward-compat. Settles P-1 for Node.
- **ND-04 [Settled]** Wire-format resolution rules for FDIS self-contradictions: **the Annex A
  schema and Annex B topic details win over clause tables and prose**, except where the schema
  forecloses a feature the tables describe. Ingress is lenient (warn + normalize unambiguous legacy
  forms); egress always emits the conformant form. The full table lives in
  [`nodejs_api.md` §3](nodejs_api.md); the clause-level defect catalogue is
  [`docs/iso-fdis-21423-defects.md`](../../iso-fdis-21423-defects.md). Includes D-02's
  `cancelRequest` row.
- **ND-05 [Settled]** Open enums: known values as const arrays with `| string` union types
  (operating states, action types, entity types). Validators warn — never reject — on unknown values.
- **ND-06 [Settled]** Validation at the boundary, not in the types: ajv validators run on ingress
  always; on egress by default outside production. Outbound validation failures throw synchronously
  at the publish call site; inbound malformed third-party messages become `validation-warning`
  events and never crash user code.
- **ND-07 [Settled]** Timestamps: emit dot-decimal millisecond ISO 8601 (`…ss.fffZ`); parse both dot
  and comma; accept `Date` at API boundaries.
- **ND-08 [Settled]** All Annex B session rules are encoded in `Iso21423Session` and not expressible
  incorrectly through the public API: persistent session (`cleanSession: false`), keep-alive 60 s,
  the B.4 Last Will, stale retained `disconnection` cleared on connect, graceful close suppresses
  the will, per-resource QoS/retain from the Table B.1 registry (callers never pass QoS), on-change
  deep-equality guard for retained resources, token-bucket rate gate for streaming resources
  (odometry 0.5–30 Hz, localTrajectory 1–10 Hz), and reconnect republish of owned retained
  resources.
- **ND-09 [Settled]** `sequenceId` durability: counter derived from a persisted seed (pluggable
  store, default file); epoch-milliseconds fallback when persistence is unavailable.
- **ND-10 [Settled]** Retained-request cleanup (B.5.3 zero-byte publish on terminal state) is the
  **sender's** duty and the request sender performs it. The gateway additionally runs an optional
  janitor (on by default) that clears requests in its own namespaces still retained a grace period
  after terminal state — protection against crashed senders.
- **ND-11 [Settled]** Two request-serving layers, both on the D-12/D-13 substrate:
  1. **High-level per-action executor** (default): `onRequest(type, handler)` with
     `ActionHandler(detail, ctx)` (`ctx`: `AbortSignal`, `progress()`, `succeeded()`, `aborted()`),
     SDK-owned detail sequencing (`blocking` serial / consecutive non-blocking concurrent), `atomic`
     protection, recovery execution, and automatic rejection reason codes
     (`ACTION_NOT_IMPLEMENTED`, `MALFORMED_REQUEST`, `VERSION_NOT_SUPPORTED`,
     `FORMAT_NOT_SUPPORTED`, `INVALID_IMR_STATE_FOR_ACTION`). `cancelRequest` actions are resolved
     by the executor itself (fires the target's `AbortSignal`).
  2. **Low-level escape hatch**: `EntityHandle.acceptRequests(filter, handler)` hands the app an
     `IncomingRequest` (`accept()` / `reject(reason)` / `updateStatus()` / `updateDetailStatus()` /
     `complete()`) so a fleet scheduler can admit and drive **whole requests** with custom
     sequencing.
- **ND-12 [Settled]** Empty-destination requests (`destination: ""` to an IMRFM) delegate robot
  selection to an app callback (`onDispatch(request, imrs) → Uuid | null`); with no callback (or
  `null`) they are rejected with reason `REJECTED`.
- **ND-13 [Settled]** Status reason codes follow the **full wire enum** (`OK`, `GENERAL_FAILURE`,
  `TIMEOUT`, `VERSION_NOT_SUPPORTED`, `FORMAT_NOT_SUPPORTED`, `ACTION_NOT_IMPLEMENTED`, `REJECTED`,
  `MALFORMED_REQUEST`, `INVALID_IMR_STATE_FOR_ACTION`) as listed in the shared
  [`interaction_model.json`](../../cpp_design/models/interaction_model.json). (Noted upstream: the
  C++ `cpp_api.md` `StatusReason` sketch is narrower than its own model; cpp_design is intentionally
  left unmodified for now.)
- **ND-14 [Settled]** Identity-less requester mode — a deliberate, documented divergence from
  strict D-09: a client may send requests with a bare `sourceId` without publishing an entity
  identity (useful for dashboards/CLIs). Recommended mode remains registering an entity (any
  `entityType`), which enables the full session behavior including the Last Will.
- **ND-15 [Settled]** Security model per spec: authentication is connection-time (TLS + broker
  credentials or mTLS), authorization is broker-side topic ACLs. SDK responsibilities: full
  credential/TLS pass-through, `AuthorizationDenied` on SUBACK denial, optional startup publish
  self-check via identity echo (default **on** for gateways, opt-in for clients), and a documented
  recommended ACL matrix per role. Broker provisioning is out of scope.
- **ND-16 [Settled]** Error taxonomy: `Iso21423Error` base → `ValidationError`, `RequestFailed`,
  `RequestTimeout`, `BrokerUnavailable`, `AuthorizationDenied`, `NotCapableError`,
  `IllegalTransition`.
- **ND-17 [Settled]** Subscriptions are lazy: MQTT subscribe on first listener, unsubscribe on last —
  a consumer doesn't flood itself with 30 Hz odometry it isn't reading.
- **ND-18 [Settled]** Observability is first-class for long-lived processes: `client.health()`
  snapshot plus structured diagnostic/metric events (the Node realization of the C++
  `ObservabilitySink`).
- **ND-19 [Settled]** Packaging & distribution: dual CJS + ESM build with bundled `.d.ts` (plain-JS
  CommonJS consumers fully supported, no top-level await in CJS); repo `openrobops/iso21423`;
  publish to GitHub Packages first, public npmjs at API stability (target 1.0 when the standard
  leaves FDIS); semver `0.x` meanwhile; the `/v1` topic namespace version is independent of the
  package version. The OpenRobOps bridge lives inside `oro/ingest` (see
  [oro_integration.md](oro_integration.md)).

## Proposed (team to confirm)

- **NP-1 [Proposed]** (mirrors P-5) Optional transport-level correlation metadata alongside the
  canonical `(source, sequenceId)`, for broker/observability tooling, without changing protocol
  semantics.
- **NP-2 [Proposed]** **Request state-machine table reconciliation.** The Node transition table and
  the C++ [`interaction_model.json`](../../cpp_design/models/interaction_model.json) disagree on
  four transitions, all conservative readings of prose pending the final Figure C.3 artwork:
  | Transition | Node table | C++ model |
  |---|---|---|
  | `RECEIVED → CANCELED` | allowed | absent |
  | `ACCEPTED → ABORTED` | allowed | absent |
  | `ACCEPTED → RECOVERY` | allowed | absent |
  | `RECOVERY → SUCCEEDED` | absent | allowed |
  Proposal: resolve once against the published Figures C.3/C.4, record the result in the shared
  interaction model, and have both SDKs consume the same table. Until resolved, the Node SDK
  implements its current table with these four transitions flagged in code comments.
- **NP-3 [Proposed]** (mirrors P-3) Exact `EntityFilter` builder surface and its mapping to MQTT
  wildcard filters (`all()`, `ofType()`, `entity()`, `anyOf()`; interaction with per-entity typed
  subscription accessors).
- **NP-4 [Proposed]** Conformance runner packaging: ship the interop `ScenarioRunner` inside
  `@openrobops/iso21423` (e.g. `/conformance` subpath) vs. as a separate tool package.
