# Deliverables — Sample Projects and Templates

> Absorbed from the 2026-07-27 spec (§10). Shipped in the SDK monorepo under `examples/`, each
> independently runnable and copyable as a starting template (plain directories, not published
> packages). Three purposes: living documentation, e2e test actors, integration starting points.

## `examples/imr-simulator` — simulated robot (IMR role)

A standalone process simulating one IMR end-to-end:

- Publishes identity, status, battery (drains/charges), and odometry along simple kinematics in a
  configurable CCS; docks and charges at a configured station.
- Executes `move` (straight-line at `ratedSpeed`, respecting `toleranceRadius`),
  `pauseImr`/`resumeImr`, `dock`/`undock`, and `cancelRequest` (**D-02**).
- Configured via a single YAML file: UUID, footprint, speed, battery curve, initial pose.
- **Failure injection** flags for conformance testing: reject next request with a chosen reason,
  abort mid-move, freeze telemetry, drop the TCP connection (exercises the LWT), delay status
  transitions.

Used by the e2e suite as its standard robot and as the reference for implementing the IMR side on
real hardware. Built directly on `/core` (`registerSelfEntity` + `onRequest`) — with the
`EntityHandle` model there is no gateway machinery to repurpose; the core is entity-generic by
construction (**D-09**, **D-10**).

## `examples/imrfm-gateway-template` — fleet manager template (IMRFM role)

The template integrators copy to connect a fleet platform:

- Defines a small `FleetBackend` interface — `connect()`, `listRobots()`, telemetry event stream,
  `executeMove/pause/resume/dock(robotId, …)` — the single seam between the SDK and any platform.
- Ships an **in-memory mock backend** (3 scripted robots), so the template runs out of the box;
  integrators replace one file.
- Demonstrates the full gateway surface: robot registration/unregistration on backend fleet
  changes, per-action handlers delegating to the backend, dispatch callback (nearest-idle-robot as
  the example, **ND-12**), per-robot execution policies (**P-2**), CCS transform usage (backend map
  frame → facility CCS), TLS/ACL configuration, and the publish self-check (**ND-15**).

## `examples/fleet-observer` — consumer example (observer role)

A terminal dashboard built directly on `/core`: discovers all entities, renders a live table
(state, mode, battery, position, active requests), tails `disconnection` events, and offers
interactive commands to send `move`/`pauseImr`/`resumeImr`/`cancelRequest` to any entity. The
template for monitoring/orchestration integrations and a manual-testing tool against any ISO 21423
network. Uses identity-less mode (**ND-14**) by default; `--register` switches to a full entity.

## `examples/facility-sandbox` — one-command demo environment

Docker-compose tying everything together: Mosquitto (ACL-configured), three `imr-simulator`
instances, one `imrfm-gateway-template` with the mock backend, and the `fleet-observer`.
`docker compose up` yields a complete working ISO 21423 facility in under a minute — the same
environment the e2e suite runs against, so the demo and the test bed never drift apart.
