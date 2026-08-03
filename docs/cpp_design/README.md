# ISO 21423 implementation design seed

This package extracts design-relevant information from the ISO/FDIS 21423 draft into files intended to seed implementation design for a library and API layer.

## Contents

- `models/interaction_model.json` - machine-readable protocol, resources, interactions, and state machines.
- `traceability/requirements_traceability.json` - concise requirement list with source clause references.
- `docs/interaction_requirements.md` - narrative explanation of normative interactions.
- `docs/state_machines.md` - request and requestDetail state-machine notes.
- `docs/conformance_model.md` - suggested conformance groups and checks.
- `api/api_surface_seed.md` - non-normative library/API design seed.
- `diagrams/*.mmd` - Mermaid diagrams for request lifecycle, request detail lifecycle, and managed-entity publishing.
- `agent_prompts/design_agent_prompt.md` - prompt for another person/agent to continue design work.

## Important scope note

The JSON Schema validates payload structure only. This package adds the interactions, state management, topic/resource model, session requirements, and conformance checks that a library/API design also needs.
