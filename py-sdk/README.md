# iso21423 (Python)

ROS-free Python SDK for ISO 21423 (IMR / IMRFM) over MQTT. Python >= 3.10.

```sh
pip install -e '.[test]'   # from this directory
```

## Quick start: a robot (IMR)

```python
from iso21423 import Client

client = Client.connect("mqtt://broker.local:1883", username="amr07", password="...")

# Registering the self entity publishes the retained identity and arms the Last Will.
robot = client.register_self_entity(
    "5f8c1e2a-6b3d-4a9f-8e11-2c7d9a4b1f00",
    entity_type="IMR",
    manufacturer_name="Acme Robotics",
    details={"imrModel": "AMR-7", "imrSerialNumber": "A7-0042", "imrHeight": 1.2,
             "imrFootprint": [{"x": 0.4, "y": 0.3}, {"x": 0.4, "y": -0.3},
                              {"x": -0.4, "y": -0.3}, {"x": -0.4, "y": 0.3}],
             "imrWorkingArea": [],
             "softwareVersions": [{"moduleName": "nav", "moduleVersion": "3.1.0"}]},
    provides=["odometry", "batteryStatus"],
    accepts=["move", "pauseImr", "resumeImr", "cancelRequest"],
)

robot.publish_status(["MODE_AUTO", "IDLE"])
robot.publish_battery_status({"batterySoc": 0.82, "batteryChargingState": "DISCHARGING"})
CCS_ID = "9c0f6a52-3e1b-4d6a-9a77-0b5c2d8e4f11"  # the facility coordinate system
robot.publish_odometry({
    "pose": {"locationPoint": {"ccsId": CCS_ID, "x": 12.4, "y": 8.1, "z": 0},
             "orientation": {"yaw": 1.57, "pitch": 0, "roll": 0}},
    "velocity": {"linear": 0.5, "angular": 0},
})

# Handlers are blocking functions; the SDK runs them on worker threads and handles
# RECEIVED/ACCEPTED/EXECUTING/terminal statuses for you.
def on_move(action: dict, ctx):
    # `nav` stands for your own navigation stack
    while not nav.go_to(action["properties"]["location"]):
        if ctx.cancelled.is_set():          # threading.Event, set on cancel
            return ctx.aborted("REJECTED", "cancelled")
        ctx.progress({"distanceRemaining": nav.remaining()})
    return ctx.succeeded()

robot.on_request("move", on_move)
# Register every handler first: start_serving() subscribes to requests, and the broker replays
# retained (still pending) requests right away. on_request() after this still works.
robot.start_serving()
```

## Behaviour notes

- `preempt()` and `priority()` start the new request as soon as the old one is *signalled*; they do
  not wait for the old handler to return (TS parity). Handlers must therefore honour `ctx.cancelled`
  promptly, or the old and new handlers briefly run side by side.
- A `cancelRequest` that arrives before its target run is registered is **rejected**, not queued (TS parity).
- `robot.wait_idle(timeout)` blocks until no request is non-terminal and no handler run is alive (True when idle, False on timeout); call it on shutdown before `unregister()` / `client.close()` so terminal statuses get published.

## Differences from the TS SDK

The library default policy is still `parallel()` (D-17). Two deliberate divergences, recorded in the
[C++/shared decision register](../docs/cpp_design/docs/decision_register.md); the TS SDK adopts both in a
separate change (marked `[Pending]` in the [Node register](../docs/nodejs_design/docs/decision_register.md)):

1. **`policies.preempt()`** (C.2.2 strategy 2, **D-21**): a new request cancels every admitted request,
   then runs. New here; `queue_replace()` keeps the TS meaning (one active plus one queued slot).
2. **pause/resume bypass admission** (**D-22**): a request made only of `pauseImr` / `resumeImr` details
   is executed but never admitted, exactly like `cancelRequest`, so the policy can neither refuse nor preempt it.
