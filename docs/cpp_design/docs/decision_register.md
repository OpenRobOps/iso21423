# ISO 21423 — Architecture Decision Register

_Status legend: **[Settled]** agreed in design sessions; **[Proposed]** recommended, open for team discussion._

This register is the single source of truth for the ISO 21423 library design. It supersedes any
conflicting notes in earlier design drafts (the older "API Revision v2" ideas `query_snapshot` /
`DeploymentSnapshot` and `completion_future` are superseded by **D-18** and **D-16** respectively).

## Scope & protocol

- **D-01 [Settled]** Target standard is ISO 21423 with a **federated** interop model: no single central
  controller assumed. Architecture must allow IMRs, IMRFMs, traffic/other controllers, and factory
  devices (doors, lifts) to participate. Not all roles implemented immediately, but the design/API must
  not preclude them.
- **D-02 [Settled]** Canonical cancel action name is `cancelRequest`; internal compatibility parsing may
  accept legacy `cancel` on inbound only.
- **D-03 [Settled]** Conformance handling is balanced: normative violations = error, recommended-only =
  warning. Conformance suite supports tiered runs: Must / Should / May.
- **D-06b [Proposed]** MQTT 3.1.1 is the baseline; opportunistically use MQTT 5 features (content-type,
  payload-format-indicator, user properties) when the injected transport supports them.

## Language & runtime

- **D-04 [Settled]** C++23, using `std::expected` for error handling.
- **D-05 [Settled]** Library is ROS-agnostic and standalone; standard C++ and standard libraries only; no
  ROS dependencies.

## Architecture

- **D-06 [Settled]** Ports-and-adapters. Strongly typed domain core; transport-agnostic public facade.
- **D-07 [Settled]** Transport is **injected** via a `TransportInterface`; the library does not own or
  create the MQTT connection (mirrors vda5050_core `ProtocolAdapter` sharing a client).
- **D-08 [Settled]** No hidden threads / no internal thread pool by default. Caller-driven, pluggable into
  sync or async threading models. Inbound processing runs on the transport's callback thread or a
  caller-pumped dispatcher. Handlers must be non-blocking; internals must be thread-safe with respect to
  transport callback threads.
- **D-09 [Settled]** `EntityHandle` is the primary actor object. Requests originate only from an
  `EntityHandle` (explicit source identity). Client-level `send_request` and a separate
  `RequesterCapability` are removed.
- **D-10 [Settled]** `accept_requests` lives on `EntityHandle` for per-entity serving. The Client is
  reduced to: transport wiring, entity registration, deployment-wide observer subscriptions, and
  device/controller federation.
- **D-11 [Settled]** IMRFM modeled as one `EntityHandle` per managed IMR plus one for the IMRFM itself,
  so "who is acting" is always explicit.
- **D-20 [Settled]** Device/controller federation APIs (publish/subscribe device state; controller
  coordination) are first-class in the architecture even if implemented later.

## Request lifecycle

- **D-12 [Settled]** RECEIVED = transport-delivery confirmation. On the executor side, the library
  auto-publishes RECEIVED on schema-valid receipt, then invokes the app handler, which decides ACCEPTED
  or ABORTED (reject is always allowed).
- **D-13 [Settled]** Schema-invalid inbound requests are auto-rejected by the library (ABORTED +
  validation reason); the app handler is not invoked.
- **D-14 [Settled]** No library-invented request timeout. Absence of RECEIVED is a transport-layer
  signal, not a protocol state.
- **D-15 [Settled]** `sequenceId` is owned by `EntityHandle` (monotonic per source); apps do not manage
  it.
- **D-16 [Settled]** Request outcome model: the status **stream** is the source of truth in core. No
  completion future in core (a blocking future would deadlock a single-threaded caller-pumped app); a
  future/helper may be added later. A single stream carries request-level status with `detailStatuses`
  in the payload for optional introspection.
- **D-17 [Settled]** Default request execution is parallel-capable with a configurable runtime policy
  (serialize / buffer / preempt / priority).

## Observers & subscriptions

- **D-18 [Settled]** DeploymentSnapshot / synchronous `query_snapshot` is **removed**.
  Controllers/observers build their own world model from subscription callbacks; retained MQTT messages
  deliver last-known state on subscribe. An optional best-effort local `EntityCache` may be added later —
  never a synchronous broker query.
- **D-19 [Settled]** `Subscription` is an RAII lifetime token; destroy it or call `cancel()` to
  unsubscribe.

## Proposed (team to confirm)

- **P-1 [Proposed]** Schema distribution: embed the canonical bundle at build time (version-locked,
  single source of truth, container-friendly), with an optional runtime override path for
  testing/forward-compat. Alternative: pure runtime load from the `json_schemas` path (more flexible,
  weaker version guarantees).
- **P-2 [Proposed]** ExecutionPolicy scope: client-level default policy, overridable per `EntityHandle`
  (so an IMRFM can differ per managed IMR). Alternative: per-EntityHandle only, or client-only.
- **P-3 [Proposed]** Observer filter model: a structured filter (optional `entityType`, `entityUuid` set
  or wildcard, `resourceKind` for resource subscriptions) that maps to MQTT topic wildcard
  subscriptions, with builder helpers (e.g., `EntityFilter::all()`, `::of_type(IMR)`, `::entity(uuid)`).
- **P-4 [Proposed]** Transport lifecycle (consequence of D-07): because the library does not own the
  connection, `TransportInterface` must expose (a) Last Will registration **before** connect and (b)
  connection-state callbacks (connected/disconnected/reconnected). The library supplies the WillSpec
  (disconnection topic/payload/QoS/retain) derived from registered entities, and on reconnect
  re-publishes retained resources (identity/status). Open for team: the exact `TransportInterface`
  contract.
- **P-5 [Proposed]** Correlation: `(source, sequenceId)` is canonical; expose optional transport-level
  correlation metadata for broker/observability tooling without changing protocol semantics.
