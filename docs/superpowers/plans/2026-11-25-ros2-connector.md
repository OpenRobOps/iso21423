# ROS 2 ↔ ISO 21423 connector (`iso21423_ros`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ROS 2 `ament_python` package whose node turns any Nav2 robot into an ISO 21423 IMR using configuration only, with Python hooks for everything else. Flatland's Node.js `iso-agent` is replaced by it.

**Architecture:** One node, `iso21423_connector`, built on the `iso21423` Python library (Plan 1, `py-sdk/`, PR #19).
- **Sources** publish ISO resources. Each is a default class or a vendor class named in config.
- **Handlers** serve ISO actions, also default or vendor.
- **Status composer** merges state contributions from sources and handlers.
- **Nav runner** owns the Nav2 goal handle shared by move/dock/pause/resume.
- **Threading:** the rclpy `MultiThreadedExecutor` spins on its own thread. Library worker threads run handlers, which block on Events set by action-client callbacks.

**Tech Stack:** ROS 2 Jazzy (primary) and Humble, rclpy, `nav2_msgs`, `tf2_ros`, `iso21423` (py-sdk), pytest, `launch_testing`, Docker (dev/test image and published image), Mosquitto.

**Spec:** `docs/superpowers/specs/2026-11-25-ros2-connector-design.md`, section "2. Connector node" through "Success criteria". It builds on Plan 1: `docs/superpowers/plans/2026-11-25-py-sdk.md`.

**Not in this plan:** the TurtleBot sim demo (spec Testing 3, and the success criterion "a TurtleBot sim connects with YAML only") is a follow-up once this lands. The ROS buildfarm release is also later, per the spec.

## Global Constraints

- **Location:** new local git repo `/home/herchu/inorbit/openrobops/iso21423_ros`. It holds the ROS package `iso21423_ros` at repo root (single-package repo) and Python module `iso21423_ros/`. **Creating the GitHub remote `OpenRobOps/iso21423_ros` is outward-facing: ask the user first. No task pushes.**
- **Library API (Plan 1, exact):**
  - `from iso21423 import Client, EntityHandle, ActionContext, ActionResult, policies, ResourceConfig, register_extension_resource, fit_transform, apply_transform, invert_transform, transform_yaw, RigidTransform2D, now_timestamp, Iso21423Error`
  - `Client.connect(url, username=, password=, tls=)`
  - `client.register_self_entity(entity_uuid, entity_type="IMR", manufacturer_name=, details=, provides=, accepts=, execution_policy=)`
  - `handle.on_request(type, handler)` registers only. Call `handle.start_serving()` once, after every handler is registered.
  - Handlers are `def h(action: dict, ctx) -> ActionResult`, blocking. They use `ctx.cancelled` (threading.Event), `ctx.progress(dict)`, `ctx.succeeded(props=None)` and `ctx.aborted(reason, message=None)`.
  - Publishers: `publish_status(states)`, `publish_battery_status(body)`, `publish_odometry(body)`, `publish_local_trajectory(points)`, `publish_global_plan(global_plan)`, `publish_extension(resource, payload)`, `unregister()`.
- **Dependency install:** `iso21423` is not on PyPI. The image installs it with `pip install --break-system-packages` from a build context `iso21423=../iso21423` (path `py-sdk/`), exactly as flatland's iso-agent Dockerfile does for the TS SDK. `package.xml` declares `python3-paho-mqtt` and `python3-jsonschema` as `exec_depend` (apt: noble ships paho 1.6.1 and jsonschema 4.10, both supported by py-sdk).
- **ROS:**
  - Jazzy is primary. The docking actions are `nav2_msgs/action/DockRobot` and `nav2_msgs/action/UndockRobot`. They exist on Jazzy only, so import them lazily and fall back when the import fails (Humble).
  - Navigation uses `nav2_msgs/action/NavigateToPose` (`pose` PoseStamped, `behavior_tree`; feedback `current_pose`, `distance_remaining`).
- **ROS parameters are flat:**
  - Footprint is `identity.footprint: [x1, y1, x2, y2, ...]` (flat doubles).
  - CCS reference points are `ccs.reference_points: [map_x, map_y, ccs_x, ccs_y, ...]`. Fewer than 3 points means the identity transform; a count that isn't a multiple of 4 is an error.
  - Nested maps (`sources.*`, `handlers.*`, `extensions.*`) are read via `automatically_declare_parameters_from_overrides=True`.
- **Hook interfaces (spec, exact):**
  - `Source(node, publisher, params)`. It may define `states() -> list[str]` to contribute status states.
  - `Handler(node, params)` with `execute(action, ctx) -> ActionResult`.
  - Both are loaded from `"package.module:ClassName"` via the `class` key. Default classes are referenced by the same mechanism.
- **Capabilities:** `provides` comes from the enabled sources plus `status`; `accepts` comes from the enabled handlers. Neither is configured separately.
- **Execution policy:** default `preempt`. It can be set to `abort_new | queue_after | queue_replace | parallel | priority | preempt`.
- **Preempt semantics:** the library does not wait for a preempted handler to return. A handler must cancel **only its own** Nav2 goal handle, never "the current goal".
- **ORO extras are opt-in, all off by default:** `credentials_provider: openrobops`, the `customData` extension source and the `customCommand` handler.
- **Status:**
  - Exactly one `MODE_*` comes first. Default `MODE_AUTO`, from param `mode`.
  - The connector never emits `READY`/`NOT_READY`.
  - Publish on change only. The library dedupes retained resources; the composer also skips identical lists.
- **Startup:** retry `Client.connect` and the credential fetch with a 10 s backoff until they succeed. The node must not crash when the broker is down.
- **Tests run inside the dev image:** `scripts/test.sh` builds `docker/Dockerfile` (target `dev`) and runs `colcon build` plus `colcon test` / pytest in it. The host ROS env is not used for tests.

## Review Focus

1. **Pause during a move, then resume.** The move request stays EXECUTING while paused and finishes SUCCEEDED after resume. Status shows `PAUSED` only while paused. Test: Task 5 `test_pause_resume_keeps_move_executing`.
2. **Preempt while moving.** The new move's goal is sent. The old handler cancels only its own goal handle and does not cancel the new one, even if it observes cancellation late. Test: Task 5 `test_preempted_move_does_not_cancel_successor_goal`.
3. **Nav2 action server missing or rejecting the goal.** The move ends ABORTED with a message (`GENERAL_FAILURE`), with no hang. The server wait is bounded by param `server_timeout_s` (default 5.0). Test: Task 5 `test_move_aborts_when_server_unavailable`.
4. **TF not available yet at startup.** No odometry is published and the robot reports `LOST` without crashing. Once TF arrives, odometry flows and `LOST` clears. Test: Task 4 `test_lost_until_tf_available`.
5. **Bad vendor hook path or class.** The node fails fast at startup with a clear error naming the config key. A hook that raises inside `execute` ends the request ABORTED/GENERAL_FAILURE (library guarantee). Test: Task 1 `test_load_class_errors_name_the_key`.

---

### Task 1: Repo scaffold, dev image, config model, hook loader

**Files:**
- Create in `/home/herchu/inorbit/openrobops/iso21423_ros/`:
  - `package.xml` (format 3; `exec_depend`: rclpy, tf2_ros, nav2_msgs, geometry_msgs, nav_msgs, sensor_msgs, std_msgs, python3-paho-mqtt, python3-jsonschema; `test_depend`: python3-pytest, launch_testing)
  - `setup.py`, `setup.cfg`, `resource/iso21423_ros`, `.gitignore`, `LICENSE` (copy the iso21423 repo's license file)
  - `README.md` (stub, filled in Task 8)
- Create `docker/Dockerfile`, with stages:
  - `base`: `ros:jazzy-ros-base` (ARG `ROS_DISTRO`), apt `ros-$ROS_DISTRO-nav2-msgs ros-$ROS_DISTRO-tf2-ros python3-paho-mqtt python3-jsonschema python3-pip`, then `COPY --from=iso21423 py-sdk /opt/iso21423/py-sdk` and `pip install --break-system-packages /opt/iso21423/py-sdk`
  - `dev`: base plus `python3-pytest ros-$ROS_DISTRO-launch-testing ros-$ROS_DISTRO-launch-testing-ament-cmake`
  - `runtime`: base plus `colcon build` of this package, with `ENTRYPOINT` sourcing the overlay and `CMD ["ros2","launch","iso21423_ros","connector.launch.py"]`
- Create `scripts/test.sh`: `docker build --build-context iso21423=../iso21423 --target dev -t iso21423-ros:dev -f docker/Dockerfile .`, then `docker run --rm -v $PWD:/ws/src/iso21423_ros iso21423-ros:dev bash -c "source /opt/ros/$ROS_DISTRO/setup.bash && cd /ws && colcon build && colcon test --event-handlers console_direct+ && colcon test-result --verbose"`. It accepts `ROS_DISTRO` (default jazzy) and passes extra args through as pytest args via `--pytest-args`.
- Create `iso21423_ros/__init__.py`, `iso21423_ros/config.py`, `iso21423_ros/hooks.py`.
- Test: `test/test_config.py`, `test/test_hooks.py`.

**Interfaces:**
- Produces:
  - `config.ConnectorConfig` (dataclass), with fields:
    - `entity_uuid: str` (required, lowercased, uuid-validated)
    - `manufacturer_name: str`
    - `identity: IdentityConfig(model, serial_number, height, footprint: list[tuple[float, float]], footprint_from_nav2: bool)`
    - `broker: BrokerConfig(url, username, password_file, tls: bool)`
    - `credentials_provider: str` (`""` or `"openrobops"`)
    - `oro: OroConfig(url, api_key_file)`
    - `ccs: CcsConfig(id, map_frame="map", reference_points: list[tuple[tuple, tuple]])`
    - `base_frame="base_link"`, `mode="MODE_AUTO"`, `execution_policy="preempt"`
    - `sources: dict[str, dict]`, `handlers: dict[str, dict]`, `extensions: dict[str, dict]`
  - `config.from_params(params: dict[str, object]) -> ConnectorConfig`. Its input is the flat `{"a.b.c": value}` map from `node.get_parameters_by_prefix("")`. It raises `ValueError("<key>: <reason>")` on bad input.
  - `hooks.load_class(spec: str, key: str) -> type`. It raises `ValueError(f"{key}: cannot load '{spec}': <cause>")`.
  - Default class paths used by later tasks, in `hooks.DEFAULT_SOURCES` / `hooks.DEFAULT_HANDLERS`:
    - `{"odometry": "iso21423_ros.sources.odometry:OdometrySource", "batteryStatus": "iso21423_ros.sources.battery:BatterySource", "globalPlan": "iso21423_ros.sources.paths:GlobalPlanSource", "localTrajectory": "iso21423_ros.sources.paths:LocalTrajectorySource"}`
    - `{"move": "iso21423_ros.handlers.move:MoveHandler", "dock": "iso21423_ros.handlers.dock:DockHandler", "undock": "iso21423_ros.handlers.dock:UndockHandler", "pauseImr": "iso21423_ros.handlers.pause:PauseHandler", "resumeImr": "iso21423_ros.handlers.pause:ResumeHandler"}`
  - Config keys use the ISO resource and action names (`batteryStatus`, `pauseImr`), so `provides`/`accepts` are the keys themselves.

- [ ] **Step 1: Write failing tests**

```python
def test_flat_params_build_config():
    c = from_params({"entity_uuid": "7B1A9C3E-1111-4222-8333-444455556666", "ccs.id": CCS,
                     "identity.footprint": [0.3, 0.2, 0.3, -0.2, -0.3, -0.2],
                     "ccs.reference_points": [0, 0, 1, 1, 10, 0, 11, 1, 0, 10, 1, 11],
                     "sources.odometry.rate_hz": 2.0, "handlers.move.action": "/navigate_to_pose"})
    assert c.entity_uuid == "7b1a9c3e-1111-4222-8333-444455556666"
    assert c.identity.footprint == [(0.3, 0.2), (0.3, -0.2), (-0.3, -0.2)]
    assert c.ccs.reference_points[1] == ((10, 0), (11, 1))
    assert c.sources == {"odometry": {"rate_hz": 2.0}} and c.handlers["move"]["action"] == "/navigate_to_pose"
    assert c.execution_policy == "preempt" and c.mode == "MODE_AUTO"

def test_missing_entity_uuid(): ...         # ValueError starting "entity_uuid:"
def test_odd_footprint_rejected(): ...      # "identity.footprint: ..."
def test_reference_points_not_multiple_of_4(): ...
def test_unknown_policy_rejected(): ...     # "execution_policy: ..."
def test_load_class_errors_name_the_key():
    with pytest.raises(ValueError, match=r"^handlers.move.class: cannot load 'nope:X'"):
        load_class("nope:X", "handlers.move.class")
def test_load_class_ok(): assert load_class("collections:OrderedDict", "k").__name__ == "OrderedDict"
```

- [ ] **Step 2: Run** `scripts/test.sh`. Expected: FAIL (import errors).
- [ ] **Step 3: Implement.** `password_file` and `api_key_file` are paths whose contents are read at startup (Task 7). The config only stores the path.
- [ ] **Step 4: Run** `scripts/test.sh`. Expected: PASS.
- [ ] **Step 5: Commit.** Run `git init` in the new repo first, then `git commit -m "iso21423_ros: scaffold, dev image, config model, hook loader"`.

### Task 2: CCS frame and pure ROS→ISO mappings

Ports and generalizes `flatland/iso-agent/src/mapping.js`, which is the reference for exact shapes.

**Files:** Create `iso21423_ros/ccs.py`, `iso21423_ros/mappings.py`. Test: `test/test_ccs.py`, `test/test_mappings.py`.

**Interfaces:**
- Consumes: `CcsConfig` (Task 1), and `fit_transform` / `apply_transform` / `invert_transform` / `transform_yaw` / `RigidTransform2D` from `iso21423`.
- Produces:
  - `ccs.CcsFrame(ccs_id: str, reference_points)`, with:
    - `.to_ccs(x, y) -> (x, y)`, `.yaw_to_ccs(yaw)`, `.to_map(x, y)`, `.yaw_to_map(yaw)`
    - `.location_point(x, y) -> {"ccsId", "x", "y", "z": 0}`
    - fewer than 3 points means the identity transform
  - `mappings`, all pure functions taking ROS message objects or duck-typed equivalents:
    - `yaw_from_quaternion(q) -> float`
    - `quaternion_from_yaw(yaw) -> (x, y, z, w)`
    - `odometry_body(frame: CcsFrame, x, y, yaw, linear, angular) -> dict`, shaped `{"pose": {"locationPoint", "orientation": {"yaw", "pitch": 0, "roll": 0}}, "velocity": {"linear", "angular"}}`
    - `battery_body(msg: BatteryState) -> dict`, which maps `power_supply_status` 1/2/3/4 to CHARGING/DISCHARGING/NOT_CHARGING/FULL (else UNKNOWN), and `power_supply_health` to ISO health. The health table: 1 GOOD → HEALTHY, 2 OVERHEAT → OVERHEAT, 3 DEAD → DEAD, 4 OVERVOLTAGE → OVERVOLTAGE, 5 UNSPEC_FAILURE → FAILURE, 6 COLD → COLD, else UNKNOWN. It clamps `batterySoc` to [0,1] and includes voltage, current and temperature only when finite.
    - `stamped_points(frame, path_msg) -> list[{"timestamp", "locationPoint"}]`, where every point uses the same `now_timestamp()`
    - `plan_key(path_msg) -> str`: positions rounded to 3 decimals
    - `nav_goal_pose(frame, location: dict, yaw: float|None, map_frame: str) -> PoseStamped`: converts CCS to map and sets header `frame_id = map_frame`
    - `distance(a: (x, y), b: (x, y)) -> float`

- [ ] **Step 1: Failing tests:**
  - `test_identity_frame_roundtrip`
  - `test_fitted_frame_rotates_and_translates`: reference points from a known 90° rotation plus `(5, -2)` translation; assert `to_ccs`, `to_map` and the yaw round trip.
  - `test_battery_mapping_table`: one assertion per charging state and health value, plus NaN voltage omitted.
  - `test_odometry_body_shape`: validate the result with `iso21423.schema.validate_message("odometry", {**body, "timestamp": now_timestamp()}).ok`.
  - `test_plan_key_ignores_stamps`
  - `test_nav_goal_pose_converts_ccs_to_map`
- [ ] **Step 2: Run** `scripts/test.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "iso21423_ros: CCS frame and ROS->ISO mappings"`

### Task 3: Status composer

**Files:** Create `iso21423_ros/status.py`. Test: `test/test_status.py`.

**Interfaces:**
- Produces:
  - `StatusComposer(publish: Callable[[list[str]], None], mode: str)`, with:
    - `.add_contributor(fn: Callable[[], list[str]])`
    - `.set_mode(mode)`
    - `.refresh()`: thread-safe. It computes the list and publishes only when it changed.
    - `.states() -> list[str]`: the last published list
  - Ordering:
    - The mode comes first.
    - Then states in the priority order `STOP_CATEGORY_0, STOP_CATEGORY_1, STOP_CATEGORY_2, LOST, BLOCKED, PAUSED, WAIT_FOR_RESET, DOCKING, CHARGING, LOW_BATTERY, FORWARD, REVERSE, STOPPED, IDLE`.
    - Unknown vendor states come after, in contributor order.
    - Duplicates are removed.
  - Mode validation: a `mode` not in `OPERATING_MODES` raises `ValueError`. Any `MODE_*` a contributor returns is dropped and logged once, because mode belongs to the composer.

- [ ] **Step 1: Failing tests:**
  - `test_mode_first_and_priority_order`: contributors return `["IDLE"]`, `["CHARGING", "LOW_BATTERY"]` and `["LOST"]`; expect `["MODE_AUTO", "LOST", "CHARGING", "LOW_BATTERY", "IDLE"]`.
  - `test_publishes_only_on_change`
  - `test_vendor_state_after_known`
  - `test_contributor_mode_ignored`
  - `test_never_emits_ready`: a contributor returning `READY` is still published, because it is vendor-defined, but the default contributors in later tasks never return it. Here, only assert that `READY` is not added by the composer itself.
  - `test_contributor_exception_skipped_and_logged`: one failing contributor doesn't block the others.
- [ ] **Step 2: Run** `scripts/test.sh`. Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `scripts/test.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "iso21423_ros: status composer"`

### Task 4: Default telemetry sources

**Files:** Create `iso21423_ros/sources/__init__.py`, `sources/odometry.py`, `sources/battery.py`, `sources/paths.py`. Test: `test/test_sources.py`, a `launch_testing`-free test that uses `rclpy` in-process with a fake publisher.

**Interfaces:**
- Consumes:
  - `mappings`, `CcsFrame` (Task 2)
  - the `node` attributes `node.ccs: CcsFrame`, `node.map_frame`, `node.base_frame`, `node.tf_buffer` and `node.status: StatusComposer`, which Task 8 provides. Tests build a minimal rclpy `Node` subclass with these attributes.
  - `publisher`: an `EntityHandle`, or in tests any object with the `publish_*` methods
- Produces:
  - **`OdometrySource(node, publisher, params)`.** Params: `rate_hz` (default 2.0), `twist_topic` (`/odom`) and `lost_after_s` (2.0).
    - A timer looks up TF `map_frame → base_frame`. If the lookup works, it publishes `odometry_body`, using the twist from the latest `nav_msgs/Odometry`.
    - `states()` returns `["LOST"]` when the lookup fails or the transform is older than `lost_after_s`. It returns `["FORWARD"]` / `["REVERSE"]` when `|linear| > 0.01`.
  - **`BatterySource`.** Params: `topic` (`/battery_state`) and `low_threshold` (0.2).
    - Publishes `battery_body` on each message. The library dedupes.
    - `states()` returns `CHARGING` when charging and `LOW_BATTERY` when the SoC is below the threshold.
  - **`GlobalPlanSource`.** Param: `topic` (`/plan`). Publishes `{"globalPlan": stamped_points}`, deduped by `plan_key`.
  - **`LocalTrajectorySource`.** Params: `topic` (`/local_plan`) and `rate_hz` (2.0). Publishes `stamped_points`, throttled.
  - Every source calls `node.status.refresh()` after updating anything that `states()` depends on.

- [ ] **Step 1: Failing tests**, using a real `rclpy` node with a `tf2_ros.Buffer` and a `StaticTransformBroadcaster` or a direct `buffer.set_transform`:
  - `test_lost_until_tf_available`: no TF gives `states() == ["LOST"]` and no odometry published. After a transform is set, odometry is published with CCS coordinates and `LOST` clears.
  - `test_odometry_uses_ccs_frame`: a non-identity frame transforms the pose.
  - `test_battery_states_and_body`
  - `test_global_plan_deduped`: the same positions with different stamps publish once.
  - `test_local_trajectory_throttled`
- [ ] **Step 2: Run** `scripts/test.sh`. Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `scripts/test.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "iso21423_ros: default telemetry sources"`

### Task 5: Nav runner, move handler, pause/resume

The core of Review Focus 1–3.

**Files:** Create `iso21423_ros/nav.py`, `iso21423_ros/handlers/__init__.py`, `handlers/move.py`, `handlers/pause.py`. Test: `test/test_nav.py`, which uses an in-process fake `NavigateToPose` action server built with `rclpy.action.ActionServer` on a test node.

**Interfaces:**
- Consumes: `nav_goal_pose`, `distance` (Task 2), `StatusComposer` (Task 3), and the library's `ActionContext`/`ActionResult`.
- Produces:
  - **`nav.NavRunner(node, action_name="/navigate_to_pose", server_timeout_s=5.0, progress_min_interval_s=2.0)`**
    - `.navigate(pose: PoseStamped, ctx, tolerance_radius: float|None=None, target_xy=None) -> ActionResult`: blocking. It runs on the library worker thread.
    - `.pause()`, `.resume()`, `.paused -> bool`, `.busy -> bool` (an objective is held)
    - `.states() -> list[str]`: `["PAUSED"]` while paused, `["IDLE"]` when not busy, and nothing otherwise
  - **`navigate` behaviour**, one objective per call. It keeps its OWN goal handle in a local variable.
    1. If `paused`, it waits (no goal sent) until resumed or `ctx.cancelled`.
    2. It sends the goal. If the server isn't available within `server_timeout_s`, it returns `aborted("GENERAL_FAILURE", "navigate_to_pose server unavailable")`. A rejected goal returns `aborted("GENERAL_FAILURE", "goal rejected")`.
    3. While the goal is active, it watches for three events:
       - `ctx.cancelled` → cancel this handle and return `aborted("REJECTED", "canceled")`. The executor maps that to CANCELED.
       - pause → cancel this handle, wait for resume, go to step 2.
       - feedback → throttled `ctx.progress({"distanceRemaining": fb.distance_remaining})`. With a `tolerance_radius` and `distance(current, target) <= tolerance_radius`, it cancels this handle and returns `succeeded()`.
    4. On result: SUCCEEDED → `succeeded()`. CANCELED that was not caused by this call (another client canceled it) → `aborted("GENERAL_FAILURE", "goal canceled externally")`. ABORTED → `aborted("GENERAL_FAILURE", f"nav2 error {error_code}: {error_msg}")`.
    5. It never cancels any goal handle other than its own.
    - `pause()` and `resume()` only flip state and wake waiters. Each `navigate` call reacts for its own handle.
    - Contributes `states()` to the status composer and calls `node.status.refresh()` on changes.
  - **`handlers.move.MoveHandler(node, params)`.** Params: `action` (`/navigate_to_pose`), `server_timeout_s`, `progress_min_interval_s`.
    - It uses the shared `node.nav: NavRunner`, which Task 8 creates. The `action` param is passed when the node creates the runner; the handler only reads it for validation.
    - `execute(action, ctx)` converts `properties.location` plus optional `orientation.yaw` via `nav_goal_pose`, and passes `toleranceRadius`.
  - **`handlers.pause.PauseHandler` / `ResumeHandler`.** `execute` calls `node.nav.pause()` / `resume()` and returns `succeeded()`.

- [ ] **Step 1: Failing tests** with the fake action server. Its goals take a configurable time, publish feedback, and the server can be told to abort or reject.
  - `test_move_succeeds_and_reports_progress`
  - `test_cancel_cancels_own_goal_and_aborts_rejected`
  - `test_pause_resume_keeps_move_executing`: while paused, the server sees the goal canceled and no new goal. After resume, a new goal arrives and the call returns succeeded. `states()` is `["PAUSED"]` only in between.
  - `test_preempted_move_does_not_cancel_successor_goal`: call A starts. Call B starts while A's ctx is cancelled late, so A sees `cancelled` after B's goal was accepted. Assert the server never received a cancel for B's goal id.
  - `test_move_aborts_when_server_unavailable`: no server, `server_timeout_s=0.5`, returns aborted within 2 s.
  - `test_goal_rejected_aborts`
  - `test_tolerance_radius_finishes_early`
  - `test_external_cancel_aborts_general_failure`
  - `test_idle_state_when_no_objective`
- [ ] **Step 2: Run** `scripts/test.sh`. Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `scripts/test.sh` three times. Expected: PASS every time.
- [ ] **Step 5: Commit** `git commit -m "iso21423_ros: nav runner, move and pause/resume handlers"`

### Task 6: Dock and undock handlers

**Files:** Create `iso21423_ros/handlers/dock.py`. Test: `test/test_dock.py`, with fake `DockRobot`/`UndockRobot` servers. On distros without them, those tests skip.

**Interfaces:**
- Consumes: `NavRunner` (Task 5) for the fallback, and `nav_goal_pose`.
- Produces:
  - **`DockHandler(node, params)`.** Params: `mode` (`auto|docking_server|navigate`, default `auto`), `action` (`/dock_robot`), `dock_type` (`""`) and `server_timeout_s` (2.0).
    - Uses `DockRobot` when:
      - `mode` is `docking_server`, or `mode` is `auto` with the `nav2_msgs.action.DockRobot` import available and the server answering within `server_timeout_s`; and
      - `properties.dockId` is set (`use_dock_id=True`), or a `dock_type` param is configured (`use_dock_id=False`, `dock_pose` from `dockLocation`, `dock_type`).
    - Otherwise it calls `node.nav.navigate(nav_goal_pose(dockLocation))`, the flatland behaviour.
    - Contributes `DOCKING` while executing.
    - Results: `success=False` → `aborted("GENERAL_FAILURE", f"dock error {error_code}: {error_msg}")`. Cancel → cancel its own goal and return `aborted("REJECTED", "canceled")`.
  - **`UndockHandler(node, params)`.** Params: `action` (`/undock_robot`), `dock_type`, `server_timeout_s`.
    - Only enabled (accepted) when the `UndockRobot` import works.
    - `execute` sends `UndockRobot`. If the server is unavailable, it returns `aborted("GENERAL_FAILURE", ...)`.
  - A class-level helper `UndockHandler.available() -> bool`. Task 8 uses it to drop `undock` from `accepts` on Humble or when import fails.

- [ ] **Step 1: Failing tests:**
  - `test_dock_by_id_uses_docking_server`
  - `test_dock_by_pose_needs_dock_type`: no `dock_type` falls back to navigate; with `dock_type` it uses DockRobot by pose.
  - `test_auto_falls_back_when_no_server`
  - `test_docking_state_while_executing`
  - `test_dock_failure_maps_error`
  - `test_undock`
  - `test_undock_unavailable_when_import_fails`: monkeypatch the import.
- [ ] **Step 2: Run** `scripts/test.sh`. Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `scripts/test.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "iso21423_ros: dock and undock handlers"`

### Task 7: Credentials and the opt-in ORO extras

Ports the logic of `flatland/iso-agent/src/main.js` (`fetchBrokerConfig`, customData batching, customCommand) and `mapping.js` (`parseKeyValue`).

**Files:** Create `iso21423_ros/credentials.py`, `iso21423_ros/oro.py`. Test: `test/test_credentials.py`, `test/test_oro.py`.

**Interfaces:**
- Produces:
  - **`credentials.resolve(cfg: ConnectorConfig, sleep=time.sleep, log=...) -> BrokerCredentials(url, username, password, tls: bool)`**
    - With provider `""`: read `password_file` if set and return the static broker block.
    - With provider `"openrobops"`: `POST {oro.url}/iso_mqtt_config` with JSON `{"apiKey": <api_key_file contents stripped>, "entityUuid": uuid}`, using `urllib.request` (stdlib).
      - Retries every 10 s until HTTP 200. A 403 logs a "robot not admitted" hint.
      - Builds `url = f"{protocol}{hostname}:{port}"`, because ORO's `protocol` already contains `://`.
  - **`oro.CustomDataSource(node, publisher, params)`.** Params: `topic` (`/inorbit/custom_data`) and `batch_ms` (500).
    - Registers extension resource `customData` with `ResourceConfig(qos=1, retain=False)`.
    - Parses `key=value` lines and batches them per window. Publishes `{"timestamp": now_timestamp(), "values": {...}}`.
    - It is configured under `extensions.customData`, and `provides` includes `customData`.
  - **`oro.CustomCommandHandler(node, params)`.** Param: `topic` (`/inorbit/custom_command`).
    - A non-string `properties.command` returns `aborted("MALFORMED_REQUEST", "properties.command must be a string")`.
    - Otherwise it publishes `std_msgs/String` and returns `succeeded()`.
    - It is configured under `handlers.customCommand.class: iso21423_ros.oro:CustomCommandHandler`. `customCommand` is not in `DEFAULT_HANDLERS`, so it is opt-in by naming the class.

- [ ] **Step 1: Failing tests:**
  - `test_static_credentials_read_password_file`
  - `test_oro_provider_retries_until_200`: a local `http.server` returns 403, then 200. Use an injected `sleep` that records calls. Assert the URL composition and the request body.
  - `test_parse_key_value`
  - `test_custom_data_batched`
  - `test_custom_command_publishes_and_validates`
- [ ] **Step 2: Run** `scripts/test.sh`. Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `scripts/test.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "iso21423_ros: credentials providers and opt-in OpenRobOps extras"`

### Task 8: Connector node, launch, default config, README

**Files:**
- Create: `iso21423_ros/node.py` (entry point `iso21423_connector` in `setup.py`), `launch/connector.launch.py` (arg `params_file`, default `config/nav2_default.yaml`), `config/nav2_default.yaml`, `config/example_vendor_hook.py` (the < 50-line custom-action example from the spec), `README.md`
- Test: `test/test_node.py`, using `launch_testing` or an in-process rclpy node with the library `Client` pointed at a Docker Mosquitto from the dev container. Start `mosquitto` inside the dev image by adding `mosquitto` to the `dev` stage apt list.

**Interfaces:**
- Consumes: everything from Tasks 1–7, plus the library.
- Produces `ConnectorNode(rclpy.node.Node)` with `automatically_declare_parameters_from_overrides=True`. Its public attributes are what hooks see: `.config`, `.ccs`, `.map_frame`, `.base_frame`, `.tf_buffer`, `.status`, `.nav`, `.entity`.
- Startup order:
  1. parse config
  2. load every hook class; fail fast on error
  3. resolve credentials
  4. `Client.connect` with the 10 s retry loop
  5. `register_self_entity`, with `provides = ["status"] + sources + extensions` and `accepts = enabled handlers` (minus `undock` when unavailable), the policy from config, and `details` from identity: `imrModel`, `imrSerialNumber`, `imrFootprint`, `imrWorkingArea` = the footprint, `imrHeight`, `softwareVersions = [{"moduleName": "iso21423_ros", "moduleVersion": <package version>}]`
  6. build sources, handlers and the status composer (contributors: every source/handler with `states()`, plus `nav.states`)
  7. `on_request` for each handler
  8. `start_serving()`
  9. initial `status.refresh()`
- Shutdown (SIGINT/SIGTERM or node destroy): `entity.unregister()`, then `client.close()`.
- `main()` runs the node in a `MultiThreadedExecutor` with a `ReentrantCallbackGroup` for action clients and subscriptions.
- `footprint_from_nav2: true`: read the param `footprint` of `/global_costmap/global_costmap` via the `rcl_interfaces/GetParameters` service with a 5 s timeout. Nav2 stores it as a string `"[[x,y],...]"`, so parse it with `ast.literal_eval`. On failure, log and fall back to `identity.footprint`.

- [ ] **Step 1: Failing tests:**
  - `test_capabilities_derived_from_config`: the identity on the broker has `provides`/`accepts` matching the enabled sources and handlers, and `undock` is absent when unavailable.
  - `test_bad_hook_fails_fast`
  - `test_vendor_custom_action_example`: load `config/example_vendor_hook.py` as a handler for type `beep`. Send a request with raw paho and expect SUCCEEDED. Assert the example file is under 50 lines.
  - `test_starts_when_broker_comes_up_later`: start the node, start mosquitto 3 s later, expect the identity to appear.
  - `test_unregister_on_shutdown`
- [ ] **Step 2: Run** `scripts/test.sh`. Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Write `README.md`:**
  - what it is
  - quick start for a Nav2 robot (YAML only)
  - the full parameter reference: every key from Task 1 with its default
  - the hook interfaces with the example
  - the ORO opt-in section
  - the Docker image
  - Humble notes (no docking)
  - the behaviour notes: preempt doesn't wait for the old handler; the connector never emits READY/NOT_READY
- [ ] **Step 6: Commit** `git commit -m "iso21423_ros: connector node, launch, default config, README"`

### Task 9: Simulation integration test and CI

**Files:**
- Create `test/sim/docker-compose.yml`, with three services:
  - `sim`: `ghcr.io/openrobops/flatland-nav2:latest`, headless (`--no-rviz`)
  - `broker`: `eclipse-mosquitto:2` with an anonymous config
  - `connector`: this repo's `runtime` image with `test/sim/flatland_test.yaml`
  - all with `network_mode: host`, matching flatland's compose
- Create `test/sim/test_sim.py`. It is a pytest file run on the host (not colcon) with `paho-mqtt` in a venv, acting as the fleet manager with raw MQTT and JSON, like py-sdk's `tests/integration/test_live.py`.
- Create `scripts/sim_test.sh` (compose up, pytest, compose down; always tears down) and `.github/workflows/ci.yml`. The workflow has three jobs:
  - `unit` matrix: `ROS_DISTRO` jazzy and humble, running `scripts/test.sh`
  - `sim` on jazzy, running `scripts/sim_test.sh`
  - both check out `OpenRobOps/iso21423` beside the repo for the build context

**Interfaces:** Consumes the runtime image and the node (Task 8).

- [ ] **Step 1: Write the sim tests**, each waiting on statuses with a 60 s timeout:
  - `test_identity_and_telemetry`: the identity is retained, odometry arrives, and the battery is published.
  - `test_move_round_trip`: a move to a free cell in the sample map ends SUCCEEDED, and odometry ends near the target (within 0.5 m).
  - `test_cancel_move`
  - `test_pause_resume_move`
  - `test_dock_falls_back_to_navigate`: flatland runs no docking server.
  - `test_preempt_new_move`: the second move succeeds and the first ends CANCELED.
- [ ] **Step 2: Run** `scripts/sim_test.sh`. Expected: PASS. Fix connector bugs it reveals, with unit tests where possible.
- [ ] **Step 3: Run** `ROS_DISTRO=humble scripts/test.sh`. Expected: PASS, with dock tests skipped.
- [ ] **Step 4: Validate the workflow YAML parses.** Don't push.
- [ ] **Step 5: Commit** `git commit -m "iso21423_ros: simulation integration tests and CI"`

### Task 10: Flatland migration and OpenRobOps docs

Work on a new branch `iso21423-ros-connector` in `/home/herchu/inorbit/openrobops/flatland` and in `/home/herchu/inorbit/openrobops/oro`. No pushes.

**Files:**
- **flatland:**
  - Delete `iso-agent/`.
  - Create `config/iso21423_connector.yaml`. It covers:
    - entity uuid and CCS id from env via launch substitution, or a generated file; see Step 3
    - the identity: the flatland footprint `0.60 × 0.38 m` rounded rectangle (port `roundedRectPolygon` from `iso-agent/src/mapping.js` into the flat footprint list, keeping the 20-point output), height 0.4, model `flatland-nav2`
    - `credentials_provider: openrobops`
    - `extensions.customData` and `handlers.customCommand`
    - `handlers.dock.mode: navigate`
  - Modify `docker-compose.yml`: profile `iso-agent` now runs the service `iso-connector`. It uses image `ghcr.io/openrobops/iso21423-ros:jazzy`, the build context from the `../iso21423_ros` and `../iso21423` siblings, mounts `config/iso21423_connector.yaml`, and `env_file: local/iso-agent.env.sh`. Keep the profile name so users' commands don't change.
  - Modify `local/iso-agent.env.sh.example`: `ORO_API_KEY` is written to a file, or the launch reads env. Pick one in Step 3 and document it.
  - Modify `README.md`: the "ISO 21423 Agent" section, the repo tree and the Development section.
  - Modify `.github/workflows/publish.yml`: drop the iso-agent image step.
  - Modify `launch/flatland_nav2.launch.py`: the rosbridge comment no longer names iso-agent. Keep rosbridge.
- **oro:**
  - Modify `website/docs/iso21423/flatland-simulator.md`: the agent is now the `iso21423_ros` connector.
  - Modify `website/docs/iso21423/coverage.md` if it references the Node agent.

**Interfaces:** Consumes the connector image and config (Task 8). It must reach parity with the old agent:
- status, odometry, battery, `customData`, `globalPlan`, `localTrajectory`
- `move`, `dock`, `cancelRequest`, `customCommand`

It adds `pauseImr`/`resumeImr` and `LOST`.

- [ ] **Step 1: Write a parity checklist** in the flatland README's Development section, mapping each old agent feature to its connector config line.
- [ ] **Step 2: Implement the flatland changes.**
- [ ] **Step 3: Resolve secret passing.** The connector reads `ORO_API_KEY` from env when `oro.api_key_file` is empty. This is a small addition to Task 7's `resolve`, with a unit test in `iso21423_ros`. Commit that in the connector repo first: `git commit -m "iso21423_ros: ORO api key from env"`.
- [ ] **Step 4: Verify end-to-end against a local ORO**, if one runs at `ORO_URL`. Otherwise run the Task 9 sim stack with the flatland config against Mosquitto and `credentials_provider: ""`. Record which one was run.
- [ ] **Step 5: Implement the ORO doc changes.**
- [ ] **Step 6: Commit** in flatland: `git commit -m "Replace Node.js iso-agent with the iso21423_ros connector"`. Commit in oro: `git commit -m "docs: flatland ISO mode uses the iso21423_ros connector"`.
