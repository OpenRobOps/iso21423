# Prompt to seed another person or design agent

You are designing an implementation of ISO 21423 for industrial mobile robot interoperability. Use the files in this package as source material.

Primary inputs:

- `models/interaction_model.json`
- `traceability/requirements_traceability.json`
- `docs/interaction_requirements.md`
- `docs/state_machines.md`
- `docs/conformance_model.md`
- `api/api_surface_seed.md`

Design goals:

1. Define the core library architecture for ISO 21423 payload validation, topic routing, resource publication, request handling, request state machines, and managed entity bridging.
2. Define a public API that supports both low-level protocol use and higher-level robotics/fleet integration.
3. Define validation/conformance test categories.
4. Explicitly identify draft ambiguities and propose configurable compatibility modes.

Constraints:

- Treat JSON Schema as necessary but insufficient. Include interactions, session behavior, retained topic behavior, request lifecycle behavior, and state-machine validation.
- Keep normative requirements separate from implementation recommendations.
- Do not silently resolve known draft inconsistencies; document them and propose policy choices.
