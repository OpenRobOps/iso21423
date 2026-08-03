# ISO 21423 Library — Design Docs Index

Entry point for the ISO 21423 library design. Start with the decision register, then the API and
diagram, then the role-based examples.

## Authoritative design

- [decision_register.md](decision_register.md) — **start here.** All architecture decisions with IDs
  (`D-xx` settled, `P-x` proposed for team discussion).
- [cpp_api.md](cpp_api.md) — proposed C++ API (types, interfaces, usage sketches).
- [../diagrams/iso21423_class_diagram.mmd](../diagrams/iso21423_class_diagram.mmd) — high-level class
  diagram (Mermaid; open with a Mermaid preview or paste into a ` ```mermaid ` block).

## Usage examples (illustrative)

- [example_imr.md](example_imr.md) — a single robot: publish resources, serve requests, act as requester.
- [example_imrfm.md](example_imrfm.md) — a fleet manager: manage multiple IMRs, publish/accept on their behalf.
- [example_traffic_controller.md](example_traffic_controller.md) — an observer/coordinator: build a world
  model from subscriptions and react.

## Background / normative context

- [interaction_requirements.md](interaction_requirements.md) — protocol, session, publication, and
  request-lifecycle requirements.
- [state_machines.md](state_machines.md) — request and request-detail state machines.
- [conformance_model.md](conformance_model.md) — conformance test categories.

## Reading order for a first review

1. `decision_register.md` — understand the settled/proposed decisions.
2. `../diagrams/iso21423_class_diagram.mmd` — see the shape of the API.
3. `cpp_api.md` — read the interfaces.
4. One example matching your role (`example_imr.md` / `example_imrfm.md` / `example_traffic_controller.md`).
5. Bring open items (`P-1`…`P-5`) to the team discussion.
