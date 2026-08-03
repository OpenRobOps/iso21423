# ISO 21423 NodeJS SDK — design package

Design for `@openrobops/iso21423`, a platform-agnostic TypeScript/NodeJS SDK implementing
ISO/FDIS 21423 (industrial mobile robot communications and interoperability, MQTT 3.1.1 + JSON).
It covers all protocol roles on one entity-generic core: standalone IMR, IMRFM fleet gateway
(managed-entity pattern of B.5.2.4), and observer/controller consumers.

This package mirrors the structure of the [C++ design package](../cpp_design/) and shares its
decision IDs so the two SDK designs stay comparable. Language-neutral protocol material
(interaction model, requirement traceability, state machines, conformance groups) is **not
duplicated** here — it is referenced in place under `../cpp_design/`.

## Contents

- `docs/decision_register.md` — **start here.** All architecture decisions: shared `D-xx`/`P-x`
  adoption status (including documented divergences) plus Node-specific `ND-xx`/`NP-x`.
- `docs/nodejs_api.md` — proposed TypeScript API (types, interfaces, usage sketches).
- `docs/example_imr.md`, `docs/example_imrfm.md`, `docs/example_traffic_controller.md` — role-based
  usage examples.
- `docs/testing_strategy.md` — unit / integration / e2e / interop-conformance strategy.
- `docs/deliverables.md` — sample projects and templates (`imr-simulator`, gateway template,
  observer, facility sandbox).
- `docs/oro_integration.md` — OpenRobOps bridge, packaging, publishing, and release policy.
- `diagrams/iso21423_ts_class_diagram.mmd` — high-level class diagram (Mermaid).

## Referenced shared material (in `../cpp_design/`)

- [`models/interaction_model.json`](../cpp_design/models/interaction_model.json) — machine-readable
  protocol, resources, QoS/retain, state machines.
- [`traceability/requirements_traceability.json`](../cpp_design/traceability/requirements_traceability.json)
  — requirement IDs (`REQ-*`) with clause references, used by conformance findings.
- [`docs/interaction_requirements.md`](../cpp_design/docs/interaction_requirements.md),
  [`docs/state_machines.md`](../cpp_design/docs/state_machines.md),
  [`docs/conformance_model.md`](../cpp_design/docs/conformance_model.md) — normative background.

## History

This package supersedes and absorbs the earlier prose spec
(`docs/superpowers/specs/2026-07-27-iso21423-sdk-design.md`, removed). The Plan 1 foundation
implementation plan (`docs/superpowers/plans/2026-07-27-iso21423-sdk-foundation.md`) remains valid
and now points here.
