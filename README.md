# ISO 21423 — SDK design workspace

Working repository for understanding **ISO 21423** (*Robotics — Industrial mobile robots —
Communications and interoperability*, MQTT 3.1.1 + JSON) and for designing open-source SDK
implementations of it under [OpenRobOps](https://github.com/openrobops).

ISO 21423 lets mobile robots, fleet managers, and facility equipment from different vendors share
one interoperability channel: a common topic/message model for identity, status, and telemetry, a
Common Coordinate System, and a request protocol with a defined state machine. New here? Start
with the [plain-language explainer](docs/standard/README.md).

> **Status:** all material is based on **ISO/FDIS 21423:2026** (Final Draft). Details may still
> change in the published International Standard; known defects in the draft are catalogued in
> [docs/iso-fdis-21423-defects.md](docs/iso-fdis-21423-defects.md).

## Repository map

| Path | What it is |
|---|---|
| [`docs/standard/`](docs/standard/README.md) | **Understanding ISO 21423** — an 8-chapter educational companion to the standard (overview, participants, CCS, communication, entity data, requests, extensions, glossary) |
| [`docs/json_schemas/`](docs/json_schemas/README.md) | Annex A JSON Schemas, normalized and corrected for implementation, with example payloads and a Python validator |
| [`docs/iso-fdis-21423-defects.md`](docs/iso-fdis-21423-defects.md) | Clause-level catalogue of FDIS self-contradictions and gaps, with the SDKs' resolution positions; doubles as ISO/TC 299 comment material |
| [`docs/cpp_design/`](docs/cpp_design/README.md) | **C++ SDK design** — decision register (`D-xx`/`P-x`), proposed C++23 API, role examples — plus the shared language-neutral protocol extraction (machine-readable interaction model, requirement traceability, state machines, conformance groups) |
| [`docs/nodejs_design/`](docs/nodejs_design/README.md) | **NodeJS SDK design** for `@openrobops/iso21423` — decision register (`ND-xx`/`NP-x`, cross-referencing the shared `D-xx` decisions), proposed TypeScript API, role examples, testing/conformance strategy, OpenRobOps integration |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Implementation plans (Plan 1: NodeJS SDK foundation layers) |
| `ISO_FDIS_21423_(E).docx` | The FDIS source document this work is based on |

## The two SDK designs

Both designs share one architecture, tracked through **decision registers** so choices stay
comparable across languages:

- Shared decisions (`D-01`…`D-20`, `P-1`…`P-5`) live in the
  [C++ decision register](docs/cpp_design/docs/decision_register.md).
- The [NodeJS decision register](docs/nodejs_design/docs/decision_register.md) records each shared
  decision's adoption status — including deliberate, documented divergences — plus Node-specific
  decisions.

Cornerstones common to both: a federated interop model with no assumed central controller; an
entity-generic core where `EntityHandle` is the primary actor (publisher, requester, and request
executor — self or managed); an injected MQTT transport; SDK-enforced session and lifecycle rules
(every behavioral "shall" is not expressible incorrectly through the public API); and tiered
Must/Should/May conformance checking traceable to requirement IDs.

## Suggested reading order

1. [docs/standard/01-overview.md](docs/standard/01-overview.md) — what the standard is for.
2. [docs/standard/06-requests.md](docs/standard/06-requests.md) — its most intricate machinery.
3. The decision register for your language
   ([C++](docs/cpp_design/docs/decision_register.md) /
   [NodeJS](docs/nodejs_design/docs/decision_register.md)).
4. The corresponding API proposal
   ([C++](docs/cpp_design/docs/cpp_api.md) / [NodeJS](docs/nodejs_design/docs/nodejs_api.md)) and
   the usage example matching your role (IMR, IMRFM, or observer/controller).
