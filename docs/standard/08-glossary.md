# 08 — Glossary

Terms as used by ISO 21423 (informal phrasings — the standard's clause 3 has the normative definitions).

## Participants and structure

| Term | Meaning |
|---|---|
| **Entity** | Any sender or receiver of the standard's JSON messages: a robot, a fleet manager, a door... Identified by a UUID; owns a topic namespace. |
| **IMR** — industrial mobile robot | A mobile platform (with any integrated attachments) capable of navigating an industrial environment to reach locations or cover areas. Navigation may be autonomous or guided. |
| **Attachment** | Component, mechanism, or equipment integrated with a mobile platform (e.g. a lift deck, an arm, a conveyor). |
| **Fleet (IMRF)** | One or more IMRs that are collectively managed. |
| **Fleet manager (IMRFM)** | Software that monitors and directs one or more fleets: traffic management, order management, charging, parking, coordination. |
| **Managed entity** | An entity whose data is published — and whose requests may be executed — by another entity (its manager), expressed via `manages`/`managedBy` capability fields. |
| **Industrial environment** | A workplace where the public is restricted or not expected: factories, warehouses, labs, logistics sites. |
| **ERP** — enterprise resource planning | Business planning systems (inventory, orders, resources) that may participate as senders/receivers. |

## Coordinates and geometry

| Term | Meaning |
|---|---|
| **CCS** — common coordinate system | The single facility-wide (x, y, z) frame, in meters, right-hand rule, that all shared location data is expressed in. |
| **CCS origin point** | The arbitrarily chosen facility point designated (0, 0, 0). |
| **Reference point** | A surveyed point (UUID + coordinates) used by every fleet to fit the transform between its own maps and the CCS. At least three per CCS. |
| **Fiducial** | A physical marker designating a reference point; a landmark. |
| **Location point** | An entity's position in a specific CCS at a moment in time: `{ ccsId, x, y, z }`. |
| **IMR origin point** | The point within a robot designated as its local (0, 0, 0); the robot's reported position is this point's location in the CCS. |
| **IMR footprint** | 2D polygon of the robot's physical outline including payload, relative to the IMR origin point. Clockwise points; implicitly closed; can change at runtime. |
| **IMR working area** | Larger 2D polygon around the footprint: the space the robot needs to work and maneuver. |
| **Pose** | Position + orientation. |
| **Odometry** | Pose + linear velocity + angular velocity. |
| **Local trajectory** | Ordered, timestamped location points the robot will follow within sensor range — its next few seconds. |
| **Global path** | Geometric representation (NURBS curve) of the planned route beyond sensor range. |
| **Global plan** | Short list of significant future destinations with estimated arrival times — the itinerary. |
| **NURBS** — non-uniform rational basis spline | Compact mathematical encoding of smooth curves: degree + weighted control points + knot vector. |
| **Docking** | Reaching and/or connecting to another object: transfer point, charging station, another robot. |

## Communication

| Term | Meaning |
|---|---|
| **MQTT** | The publish/subscribe transport (v3.1.1, ISO/IEC 20922) all messages travel over. |
| **Topic namespace** | `/ISO_21423/v1/<entityType>/<entityUuid>/<resource>` — where an entity's data lives. |
| **Resource** | A data kind under an entity's namespace: `identity`, `status`, `odometry`, `request`, ... |
| **Retained message** | Broker-stored last value of a topic, delivered instantly to new subscribers; used for identity, status, and other "current state" resources. |
| **Streaming resource** | Telemetry published at a rate (odometry 0.5–30 Hz, local trajectory 1–10 Hz), not retained. |
| **QoS** — quality of service | MQTT delivery guarantee: 0 at-most-once (telemetry), 1 at-least-once (state), 2 exactly-once (requests). |
| **Discovery** | Subscribing to `/ISO_21423/v1/+/+/identity` to instantly receive every entity's retained identity. |
| **Persistent session** | Required MQTT session mode: subscriptions and queued QoS 1/2 messages survive brief disconnects. |
| **LWT** — last will and testament | Broker-published message on ungraceful disconnect: retained `"states": ["LOST_CONNECTION"]` on the entity's `disconnection` topic. Keep-alive is 60 s. |

## Requests

| Term | Meaning |
|---|---|
| **Request** | Envelope asking a receiver to perform an ordered list of actions; identified by `source` + `sequenceId` and by the request UUID in its topic. |
| **Request detail** | One action within a request: `type`, `version`, `blocking`, `atomic`, and type-specific `properties`. |
| **Standard actions** | `move`, `pauseImr`, `resumeImr`, `cancel`, `dock`, `undock`. Vocabularies are extensible. |
| **Blocking** (detail flag) | Executor must finish this detail before starting the next; consecutive non-blocking details may run in parallel. Default: true. |
| **Atomic** (request or detail flag) | Must run to completion; cannot be interrupted. Default: false. |
| **Recoveries** | Contingency actions executed (state `RECOVERY`) when a detail ends `CANCELED`/`ABORTED`, before the request reaches its terminal state. |
| **Request status** | Progress report published on each state change: overall state + per-detail statuses + optional reason/message. |
| **Request states** | `RECEIVED → ACCEPTED → EXECUTING → SUCCEEDED / CANCELED / ABORTED`, plus `RECOVERY`. Terminal: the last three. |
| **Reason codes** | `OK`, `GENERAL_FAILURE`, `TIMEOUT`, `VERSION_NOT_SUPPORTED`, `FORMAT_NOT_SUPPORTED`, `ACTION_NOT_IMPLEMENTED`, `REJECTED`, `MALFORMED_REQUEST`, `INVALID_IMR_STATE_FOR_ACTION`. Extensible per vendor. |
| **`activeRequestsStatus`** | Retained aggregate of all requests an entity is currently executing. |
| **Priority** | Request urgency: 0 highest, 100 default, 255 lowest. |
| **Empty destination** | A request to an IMRFM with `destination: ""` delegates robot selection to the fleet manager. |

## Operating states quick reference

**Modes (exactly one active):** `MODE_AUTO`, `MODE_SEMIAUTO`, `MODE_TELEOP`, `MODE_MANUAL`, `MODE_MAINTENANCE`.

**States (zero or more, priority-ordered):** `STOP_CATEGORY_0/1/2`, `PAUSED`, `WAIT_FOR_RESET`, `MAPPING`, `LOST`, `WAIT_FOR_ATTACHMENT`, `WAIT_FOR_EVENT`, `BLOCKED`, `ATTACHMENT_ACTIVE`, `STOPPED`, `DOCKING`, `SLOWING`, `ACCELERATING`, `LEFT_TURN`, `RIGHT_TURN`, `REVERSE`, `FORWARD`, `LINE_FOLLOWING`, `CHARGING`, `LOW_BATTERY`, `IDLE`, `PARKED`, `OFFLINE`.

**IMRFM states:** `READY`, `NOT_READY`, `OFFLINE`.

## Abbreviations

| | |
|---|---|
| CCS | common coordinate system |
| ERP | enterprise resource planning |
| IMR | industrial mobile robot |
| IMRF | industrial mobile robot fleet |
| IMRFM | industrial mobile robot fleet manager |
| JSON | JavaScript Object Notation |
| LIDAR | light detection and ranging |
| MQTT | message queuing telemetry transport |
| NURBS | non-uniform rational basis spline |
| OEM | original equipment manufacturer |
| QoS | quality of service |
| SoC | state of charge |
| UUID | universally unique identifier |
