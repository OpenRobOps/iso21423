# Testing & Conformance Strategy

> Absorbed from the 2026-07-27 spec (§9), updated for the decision register. Conformance runs are
> tiered Must/Should/May with findings referencing the shared requirement IDs (**D-03**) in
> [`requirements_traceability.json`](../../cpp_design/traceability/requirements_traceability.json).

## 1. Unit

- **State machine**: table-driven, exhaustive against the Figure C.3/C.4 transition tables
  (pending **NP-2** reconciliation — the four disputed transitions are flagged in fixtures).
- **Topics**: builder/parser round-trips, wildcard filter matching.
- **Schema**: validators against every example payload in Annexes B and C (extracted as fixtures),
  plus the ND-04 lenient-ingress normalizations (`id`→`entityId`, comma timestamps,
  `cancel`→`cancelRequest`).
- **Geometry**: Annex D worked examples for the CCS transform fit.

## 2. Integration (in-memory transport)

Core + gateway wired through the `/testing` `MemoryBroker` — no broker, no network, runs on every
commit. The fake implements meaningful MQTT semantics: `+`/`#` filter matching, retained messages,
wills (fired on ungraceful drop, suppressed on graceful end), per-subscription QoS metadata,
scriptable connection drops, and ACL-style subscription denial.

Coverage targets:

- **Full request lifecycles**: multi-detail happy path; cancel mid-execution (including cancel of
  `atomic` details waiting for completion); recovery after abort/cancel, including failed recovery
  → overall `ABORTED`; blocking vs non-blocking sequencing; every automatic rejection reason
  (`ACTION_NOT_IMPLEMENTED`, `MALFORMED_REQUEST`, `VERSION_NOT_SUPPORTED`, `FORMAT_NOT_SUPPORTED`,
  `INVALID_IMR_STATE_FOR_ACTION`).
- **Execution policies** (**D-17**): the interface plus each preset (`abort-new`, `queue-replace`,
  `queue-after`, `parallel(max)`, `priority`) under interleaved requests from two senders;
  client-default vs per-handle override (**P-2**).
- **Both serving layers** (**ND-11**): per-action handlers and the `IncomingRequest` escape hatch,
  including illegal-transition rejection.
- **Managed-entity pattern**: publishing under robot namespaces, `manages`/`managedBy` link
  correctness, direct-to-robot vs via-IMRFM routing, empty-destination dispatch (no callback →
  `REJECTED`).
- **Session rules as behavior**: status published only on change; rate-gate clamping; sender-side
  retained-request cleanup on terminal status; gateway janitor clearing orphaned terminal requests;
  stale `disconnection` cleared on connect; reconnect republish.
- **Observer surface**: `EntityFilter` builders → correct wildcard subscriptions; lazy
  subscribe/unsubscribe; `discover()` catalog built purely from retained identities (**D-18**).

## 3. End-to-end / conformance (real broker)

Docker-compose with Mosquitto (second profile: EMQX), nightly and on release branches. Scenarios
are data-driven specs executed by a `ScenarioRunner`; each asserts observable **wire behavior** and
emits findings `{ severity, requirementId, detail }` (**D-03**):

1. **Discovery** — fresh client gets the full catalog from retained identities; late-joining IMR
   discovered without resubscribing (`REQ-IDENTITY-001`).
2. **Session conformance** — TCP kill ⇒ broker publishes the retained LWT (`REQ-SESSION-002`);
   graceful shutdown clears it; persistent-session delivery of QoS 1/2 while offline
   (`REQ-SESSION-001`).
3. **Retained semantics** — after terminal state a fresh subscriber to `request/<uuid>` receives
   nothing (`REQ-REQUEST-006`); `activeRequestsStatus` reflects only live requests.
4. **QoS verification** — odometry 0, status/identity 1, request/requestStatus 2, asserted from
   receiver packet metadata (`REQ-PROTO-001`, Table B.1).
5. **Telemetry rates** — odometry/localTrajectory stay within Table B.1 bounds under firehose input.
6. **Request round-trips** — move succeed / abort-with-recovery / cancel, concurrently from two
   independent clients against one gateway (`REQ-REQUEST-001…005`).
7. **Security suite** (**ND-15**) — denied subscription ⇒ `AuthorizationDenied`; missing
   managed-robot grant caught by the publish self-check; requester without `request/+` write cannot
   inject.
8. **Resilience** — broker restart mid-scenario: sessions resume, retained resources republished,
   in-flight requests fail fast with `BrokerUnavailable`.
9. **Tolerance** — unknown fields, unknown operating states, vendor action types pass through with
   `ValidationWarning`s, never crashes (**ND-05**/**ND-06**).

## 4. Interop harness

The e2e suite doubles as a conformance harness for **external** implementations: point the
`ScenarioRunner` at an existing broker and target entity UUID and it runs the observer-side
assertions (topic layout, QoS, retained behavior, schema validity, request state-machine ordering)
against any third-party IMR/IMRFM. Scenarios are tagged (`observe-only`,
`requires-request-execution`, `requires-connection-control`) so partial runs against
production-like systems are possible. Reports are tier-filterable (Must/Should/May, **D-03**).
Packaging (in-package `/conformance` vs separate tool) is **NP-4**.
