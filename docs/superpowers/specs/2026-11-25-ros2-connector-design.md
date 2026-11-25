# ROS 2 ↔ ISO 21423 connector — design

_Status: approved 2026-11-25._

## Intent

An open-source connector that lets **any vendor or integrator** turn a ROS 2 robot into an ISO 21423
IMR on **any** compliant broker / fleet manager. OpenRobOps (ORO) is the first target, InOrbit Space
Intelligence ("ISO robot → ISI") benefits directly, but nothing in the default behaviour may assume
ORO.

It replaces `flatland/iso-agent` — a ~350-line Node.js sidecar that reaches ROS through rosbridge
and hardcodes flatland's topics, Nav2 `NavigateToPose`, footprint, identity CCS, and ORO's
`/iso_mqtt_config` bootstrap. Flatland becomes the connector's first user and reference test.

It plays the role [ros_amr_interop](https://github.com/inorbit-ai/ros_amr_interop) plays for
VDA 5050, without inheriting its design.

## Goals

1. A ROS 2-native package (colcon, launch files, ROS parameters) — no Node, no rosbridge on the robot.
2. **A Nav2 robot connects with configuration only**: YAML for topic/action names, frames, identity,
   CCS calibration, broker. "Works in 10 minutes" for TurtleBot-class robots.
3. **Code hooks for everything else**: a vendor can replace any telemetry source or add/replace any
   request handler with a small Python class, without forking.
4. Protocol behaviour equivalent to the TypeScript SDK (`ts-sdk/`), sharing its decision register
   (`D-xx`) and corrected schema.
5. Demo-able on open robots with simulators (flatland first, then e.g. TurtleBot 4 sim).

## Non-goals (v1)

- IMRFM, observer, requester or managed-entity (`FleetGateway`) roles in the Python library — the
  connector is an IMR only.
- Maps, camera, laser, diagnostics tree: ISO 21423 has no resources for them.
- ROS 1.
- `globalPath` (NURBS) and the live `footprint` resource (half-specified in the FDIS; ORO ignores them).
- Publishing to the ROS buildfarm (see Distribution).

## Anti-goals (failure even if it "works")

- A Nav2 robot needs vendor code to connect.
- ORO-specific behaviour on by default, so the connector misbehaves on a third-party broker.
- The Python library silently diverging from the TS SDK's protocol decisions.

## Constraints

- Wire standard: ISO/FDIS 21423:2026 — MQTT 3.1.1 + JSON. Known FDIS defects and our positions:
  `docs/iso-fdis-21423-defects.md`; they apply to Python too (e.g. `cancelRequest` canonical, `cancel`
  accepted inbound; JSON Last Will `{"states":["LOST_CONNECTION"]}` on `disconnection`).
- ROS 2 **Jazzy** (Ubuntu 24.04) primary — flatland runs on it. **Humble** (22.04, Python 3.10)
  supported. Humble's Nav2 has no `opennav_docking`; handled by the dock fallback below.
- Dependencies must resolve via rosdep/apt where possible. Ubuntu 24.04 ships `python3-paho-mqtt`
  **1.6.x** and `python3-jsonschema` 4.10; the library must work with paho 1.6 and 2.x.
- Interop with ORO as it exists (`oro/website/docs/iso21423/coverage.md`): ORO sends `move`,
  `dock` (`dockActions: ["CHARGE"]`, by location), `cancelRequest`, `customCommand`; reads
  `identity`, `status` (online/offline only), `batteryStatus`, `odometry`, `localTrajectory`,
  `globalPlan`, `customData`.

## Approaches considered

**Language** (decided: Python).

| | Python (chosen) | C++ |
|---|---|---|
| ISO implementation | New ROS-free Python library, ported from the TS SDK | Implement the existing C++ design (`docs/cpp_design/`) |
| Connector | `ament_python` node on rclpy | `rclcpp` node |
| Vendor hooks | Python classes named in config | `pluginlib` plugins (compile per hook) |
| Cost | Lowest; telemetry is JSON at a few Hz, speed irrelevant | ~2–3× before first working robot; weaker schema validation |

Dropped: keeping Node.js + rosbridge (not ROS-native, two runtimes on the robot); C++ core with
Python bindings (highest cost of all).

**Integration model** (decided: B).

- A — config-only for standard robots; non-standard means forking.
- **B — config for standard (Nav2 / `sensor_msgs` / TF) parts + Python code hooks for the rest.** Chosen.
- C — adapter-first; every robot needs vendor code. Rejected: nothing works out of the box.

**Library placement** (decided: separate, ROS-free). Usable by non-ROS robots and by ORO/ISI
conformance tests; the ROS node is a thin layer on top.

## Design

### Two deliverables

| Deliverable | Where | What |
|---|---|---|
| `iso21423` Python library | `iso21423/py-sdk/` (this repo, beside `ts-sdk/`) | IMR-side ISO 21423, no ROS imports. Published to PyPI. |
| `iso21423_ros` connector | New repo `OpenRobOps/iso21423_ros` | ROS 2 `ament_python` package: node, Nav2 defaults, config, launch, Dockerfile. |

_Proposed by Claude:_ the library lives in this repo so it shares the schema, defects catalogue and
decision register with the TS SDK; the connector gets its own repo because its users, release
cadence and CI (ROS distros, simulators) differ.

### 1. Python library `iso21423` (IMR self-entity scope)

Port of the TS SDK's IMR-side surface, same semantics, Pythonic names:

- **Session** — persistent session, 60 s keep-alive, B.4 Last Will on `disconnection` (QoS 1,
  retained), stale-will cleanup on (re)connect, reconnect. Username/password and TLS.
- **Topics/resources** — `/ISO_21423/v1/<type>/<uuid>/<resource>`, Table B.1 QoS/retain, streaming
  rate gate for `odometry` (0.5–30 Hz) / `localTrajectory` (1–10 Hz), extension resources
  (`register_extension_resource`).
- **Schema validation** — the same corrected schema the TS SDK uses (`ts-sdk/src/schema/iso21423.schema.json`,
  single source; copy at build time, not a fork), egress and ingress, plus the TS SDK's ingress
  normalisation of FDIS inconsistencies.
- **Entity handle** — `register_self_entity(...)` → `publish_identity/status/battery_status/odometry/
  local_trajectory/global_plan/extension`, `unregister()` (clears retained, leaves `OFFLINE` tombstone).
- **Request serving** — `on_request(type, handler)`; executor with the C.3/C.4 state machines,
  duplicate suppression, `blocking`/`atomic`, `activeRequestsStatus`, retained-request cleanup,
  `cancelRequest`, the five C.2.2 execution policies, `sequenceId` persistence (file store).
- **Geometry** — `fit_transform` (rigid 2D least squares from ≥ 3 point pairs), apply/invert, yaw.
  Pure Python, no numpy.
- **Testing aid** — in the TS SDK an in-process broker exists; in Python, tests run against a real
  Mosquitto (CI service container) — _Claude's call:_ no in-process broker port.

**Concurrency model** — _Claude's call:_ thread-based, not asyncio. paho runs its own network
thread; each executing action detail runs in a worker thread; a handler gets `ctx` with
`ctx.cancelled` (`threading.Event`), `ctx.progress(...)`, `ctx.succeeded()`, `ctx.aborted(reason, msg)`.
Rationale: rclpy has its own executor, and blocking-style handlers that wait on ROS action futures are
the simplest thing for vendors to write.

**Conformance** — port the TS SDK's IMR-side tests as the Python suite, and add one cross-language
interop test: Python IMR ↔ TS SDK requester over Mosquitto (move, cancel, policy, reconnect).

### 2. Connector node `iso21423_ros`

One node, `iso21423_connector`, configured with a ROS parameter YAML.

```
             ROS 2 graph                       iso21423_connector                     MQTT broker
 TF map→base_link, /odom ─┐            ┌── sources ──► EntityHandle.publish_* ──►  /ISO_21423/v1/IMR/<uuid>/...
 /battery_state, /plan,  ─┼──────────► │   (default or vendor class per resource)
 /local_plan, /diagnostics┘            │
                                       └── handlers ◄── EntityHandle.on_request ◄── request/<uuid>
 Nav2 actions / topics  ◄────────────────  (default or vendor class per action type)
```

#### Configuration (shape, not final names)

```yaml
iso21423_connector:
  ros__parameters:
    entity_uuid: "7b1a9c3e-..."           # required, lowercase
    manufacturer_name: "Acme"
    identity: { model: "...", serial_number: "...", height: 0.4,
                footprint: [[0.3,0.2],[0.3,-0.2],[-0.3,-0.2],[-0.3,0.2]] }   # or footprint_from_nav2: true
    broker: { url: "mqtts://broker:8883", username: "...", password_file: "/run/secrets/iso" }
    credentials_provider: ""              # "" = static broker block; "openrobops" = ORO bootstrap (below)
    ccs:
      id: "0b1c2d3e-..."
      map_frame: map                       # CCS = map_frame transformed by:
      reference_points: []                 # ≥3 {map:[x,y], ccs:[x,y]}; empty = identity
    base_frame: base_link
    execution_policy: preempt
    sources:                               # each: default implementation + its params, or `class: pkg.mod:Cls`
      odometry: { rate_hz: 2.0, twist_topic: /odom }
      battery_status: { topic: /battery_state }
      global_plan: { topic: /plan }
      local_trajectory: { topic: /local_plan, rate_hz: 2.0 }
    handlers:                              # action type -> default or `class: pkg.mod:Cls`; omitted = not accepted
      move: { action: /navigate_to_pose }
      dock: { mode: auto }                 # opennav_docking if present, else navigate-to-dock
      undock: { mode: auto }
      pauseImr: {}
      resumeImr: {}
    extensions: {}                         # e.g. customData (below)
```

`capabilities.provides` / `accepts` are derived from the enabled sources and handlers — never
configured twice.

#### Default sources (the Nav2 profile)

| ISO resource | Default source |
|---|---|
| `odometry` | TF `map_frame`→`base_frame` sampled at `rate_hz`, converted to CCS; velocity from `/odom` twist. (Replaces flatland's `/amcl_pose`, which only updates while moving.) |
| `batteryStatus` | `sensor_msgs/BatteryState` → SoC, charging state, voltage, current, health, temperature; published on change. |
| `globalPlan` | `nav_msgs/Path` `/plan`, deduped on rounded positions, converted to CCS. _Deviation:_ ISO intends `globalPlan` as coarse stops with ETAs; we publish the path because that's what ORO renders. Downsampling is a builder detail. |
| `localTrajectory` | `nav_msgs/Path` `/local_plan`, throttled. |
| `status` | Composed (below), published on change. |

**Status composition.** Exactly one mode — `MODE_AUTO` by default, overridable by a param or a vendor
source. States contributed by:
- motion: `FORWARD`/`REVERSE` from odom twist; `IDLE` when no request is executing and no Nav2 goal is active
- localization: `LOST` when the map→base TF is missing or older than a threshold
- requests: `DOCKING` while a dock runs, `PAUSED` after `pauseImr`
- battery: `CHARGING`, `LOW_BATTERY` (threshold param)

Vendors add contributors (e.g. a stop-category from their safety PLC) via `class:` hooks. Note: the
flatland agent emitted `READY`/`NOT_READY`, which are IMRFM states, not IMR ones. The connector
does not. Mapping `/diagnostics` ERROR to a state is left to a vendor contributor; there is no
standard IMR state for it.

#### Default handlers

| Action | Default |
|---|---|
| `move` | CCS→map, `nav2_msgs/action/NavigateToPose`; `toleranceRadius` honoured by finishing early when inside the circle; feedback → `ctx.progress(distanceRemaining)` throttled. Cancel → cancel goal. |
| `dock` / `undock` | If `opennav_docking` action servers exist (Jazzy+): `DockRobot` by `dockId` when given; by pose (`dockLocation`) only when a `dock_type` param is configured (the docking server needs it); otherwise navigate to `dockLocation` (flatland behaviour). `UndockRobot` when docking servers exist, else `undock` not accepted. _Claude's call:_ ORO always docks by location, so the TurtleBot demo config sets `dock_type`. |
| `pauseImr` / `resumeImr` | Nav2 has no pause: pause cancels the active Nav2 goal and keeps the objective; resume re-sends it. Adds/removes `PAUSED`. |
| `cancelRequest` | Library-handled; surfaces as `ctx.cancelled`. |

**Requests arriving while busy** (decided by the user, option A):
- The Python library adds a true C.2.2 strategy-2 policy, `preempt`: a new request cancels the active
  one and then runs. This is the connector's default, because a nav-only robot runs one motion at a
  time and a new "Navigate to" or `dock` must replace the current one. It is configurable.
- `pauseImr` and `resumeImr` bypass admission, as `cancelRequest` already does, so they act on the
  running request. The paused `move` stays `EXECUTING`, its handler thread stays alive, and the
  pause/resume handlers share the active Nav2 goal with it through the connector's move handler.
- The library records both in the decision register as new `D-xx` entries.
- Rejected, option B: keep "parallel" and coordinate inside the connector. Every vendor hook would
  inherit hidden coordination.

**The TS SDK fix is a separate change**, outside this project. TS `policies.queueReplace()` never
cancels the active request, which deviates from strategy 2, and TS also runs pause/resume through
admission. Both get fixed in their own change. Until then the Python and TS libraries differ on
these two points, and that is documented, not silent.
- Python's `queue_replace` keeps the TS meaning (one active request plus one queued slot) so the
  presets stay comparable.
- The interop test does not depend on the fix: TS only sends the requests there.

#### Extension points (option B)

Two Python interfaces, loaded by `"package.module:ClassName"` strings in config (importlib, no pluginlib):

```python
class Source:                       # publishes one ISO resource (or contributes status states)
    def __init__(self, node, publisher, params): ...   # subscribe to whatever ROS topics you need

class Handler:                      # serves one action type
    def __init__(self, node, params): ...
    def execute(self, action, ctx): ...                # blocking; poll/wait on ctx.cancelled
```

Vendor action types (e.g. ORO's `customCommand`) are just handlers registered under a non-standard
type. Target: a vendor-specific action in < 50 lines.

#### ORO compatibility, opt-in

Shipped in the package but off by default:
- `credentials_provider: openrobops` — `POST <oro_url>/iso_mqtt_config` with an api key, retry
  until admitted (today's flatland logic).
- `customData` extension source — `std_msgs/String` `key=value` lines batched every 500 ms.
- `customCommand` handler — republishes `properties.command` on a `std_msgs/String` topic.

### 3. Flatland migration

`flatland/iso-agent/` is deleted. The `iso-agent` compose profile runs the connector image with a
`flatland.yaml` that uses identity CCS, the flatland footprint, the ORO credentials provider,
`customData` and `customCommand`. ORO docs (`website/docs/iso21423/flatland-simulator.md`) are updated.

### Distribution

v1: source build (colcon) and a Docker image `ghcr.io/openrobops/iso21423-ros:<distro>`; the
library from PyPI (`pip install iso21423`) with rosdep pip key. Buildfarm/apt release (`bloom`) is
later, once the API settles — it needs the library packaged for rosdep without pip.

### Testing

1. Library: unit + Mosquitto-backed tests ported from TS; Python↔TS interop test.
2. Connector: unit tests for mappings/status composition; `launch_testing` against the flatland image
   in CI (move, cancel, dock, pause/resume, reconnect).
3. Demo: TurtleBot sim (Jazzy) with config only — the proof of goal 2.

### Success criteria

- Flatland on ORO works with the connector, at parity with today's `iso-agent` (plus pause/resume, `LOST`).
- A TurtleBot sim connects to ORO with YAML only.
- Python and TS SDKs interoperate in CI.
- The example custom-action hook is < 50 lines.

## Left to the builder

- Exact parameter names and YAML layout; module layout of both packages.
- `globalPlan` downsampling; thresholds (TF staleness, low battery); progress throttle defaults.
- How `footprint_from_nav2` reads the costmap footprint param.
- CI matrix details (Jazzy + Humble).
- PyPI package name availability (`iso21423` vs `openrobops-iso21423`).
