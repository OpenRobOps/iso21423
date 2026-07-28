# Understanding ISO 21423

**ISO 21423 — Robotics — Industrial mobile robots — Communications and interoperability**

This documentation explains what ISO 21423 does and how it works, for anyone — integrators, developers, fleet operators, or the merely curious. It is an educational companion, not a replacement for the standard itself: normative requirements always come from the official ISO text (this material is based on ISO/FDIS 21423:2026).

## The elevator pitch

Modern warehouses and factories increasingly run mobile robots **from more than one vendor** in the same space. Each vendor's robots and fleet manager speak their own proprietary protocol — so vendor A's traffic system cannot see vendor B's robots, robots queue for the same charger without knowing it, and a facility's doors and lifts have to be integrated separately for every fleet.

ISO 21423 fixes the *communication* part of that problem. It defines:

- a **shared language** (JSON messages over MQTT) that robots, fleet managers, and facility equipment use to describe themselves and their state;
- a **shared map reference** (the Common Coordinate System) so that "I am at (33.0, 3.0)" means the same thing to everyone;
- a **request protocol** for asking another participant to do something ("move here", "pause", "dock and charge") with well-defined progress reporting.

It deliberately does **not** cover safety (that's other standards — it contains no safety requirements) or navigation (how a robot plans and drives its path remains vendor magic). Think of it as the *interoperability radio channel*, not the robot's brain.

## Reading guide

| Chapter | What you'll learn |
|---|---|
| [01 — Overview](01-overview.md) | The problem, the scope, and the big picture in one diagram |
| [02 — Participants](02-participants.md) | Entities: robots (IMR), fleet managers (IMRFM), and how they relate |
| [03 — The Common Coordinate System](03-common-coordinate-system.md) | How everyone agrees on where things are |
| [04 — Communication layer](04-communication.md) | MQTT topics, discovery, QoS, sessions, and the "last will" |
| [05 — Entity data](05-entity-data.md) | Identity, capabilities, operating states, and telemetry |
| [06 — The request protocol](06-requests.md) | Asking entities to act: requests, actions, state machines |
| [07 — Extending the standard](07-extending.md) | Doors, lifts, custom actions and states; security notes |
| [08 — Glossary](08-glossary.md) | Every term and abbreviation in one place |

If you only read two chapters, read **01 — Overview** and **06 — The request protocol**: together they cover what the standard is for and its most intricate machinery.

## Fact sheet

| | |
|---|---|
| Standard | ISO 21423 (prepared by ISO/TC 299, Robotics) |
| Status of source used here | FDIS (Final Draft International Standard), 2026 |
| Transport | MQTT v3.1.1 (ISO/IEC 20922) |
| Payload format | JSON (ISO/IEC 21778), with a normative JSON Schema |
| Topic namespace | `/ISO_21423/v1/...` |
| Participants | Industrial mobile robots (IMR), fleet managers (IMRFM), extensible to other equipment |
| Explicitly out of scope | Safety, navigation, entertainment/consumer/military/medical uses, public roads |
