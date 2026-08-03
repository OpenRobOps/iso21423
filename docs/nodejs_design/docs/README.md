# ISO 21423 NodeJS SDK — Design Docs Index

Entry point for the NodeJS SDK design. Start with the decision register, then the API and diagram,
then the role-based examples.

## Authoritative design

- [decision_register.md](decision_register.md) — **start here.** All architecture decisions:
  shared `D-xx`/`P-x` (from the [C++ register](../../cpp_design/docs/decision_register.md)) with
  their Node adoption status and documented divergences, plus Node-specific `ND-xx` settled and
  `NP-x` proposed decisions.
- [nodejs_api.md](nodejs_api.md) — proposed TypeScript API (types, interfaces, usage sketches).
- [../diagrams/iso21423_ts_class_diagram.mmd](../diagrams/iso21423_ts_class_diagram.mmd) —
  high-level class diagram (Mermaid; open with a Mermaid preview or paste into a ` ```mermaid `
  block).

## Usage examples (illustrative)

- [example_imr.md](example_imr.md) — a single robot: publish resources, serve requests, act as
  requester.
- [example_imrfm.md](example_imrfm.md) — a fleet manager: manage multiple IMRs, publish/accept on
  their behalf, dispatch.
- [example_traffic_controller.md](example_traffic_controller.md) — an observer/coordinator: build a
  world model from subscriptions and react.

## Delivery

- [testing_strategy.md](testing_strategy.md) — unit / integration / e2e / interop conformance.
- [deliverables.md](deliverables.md) — sample projects and templates.
- [oro_integration.md](oro_integration.md) — OpenRobOps bridge, packaging, publishing.

## Background / normative context (shared, in cpp_design)

- [interaction_requirements.md](../../cpp_design/docs/interaction_requirements.md) — protocol,
  session, publication, and request-lifecycle requirements.
- [state_machines.md](../../cpp_design/docs/state_machines.md) — request and request-detail state
  machines.
- [conformance_model.md](../../cpp_design/docs/conformance_model.md) — conformance test categories.
- [interaction_model.json](../../cpp_design/models/interaction_model.json) /
  [requirements_traceability.json](../../cpp_design/traceability/requirements_traceability.json) —
  machine-readable protocol model and requirement IDs.

## Reading order for a first review

1. `decision_register.md` — the settled/adopted/proposed decisions and divergences.
2. `../diagrams/iso21423_ts_class_diagram.mmd` — the shape of the API.
3. `nodejs_api.md` — the interfaces.
4. One example matching your role.
5. Bring open items (`NP-1`…`NP-4`) to the team discussion.
