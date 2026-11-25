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
robot.publish_odometry({"pose": {...}, "velocity": {"linear": 0.5, "angular": 0}})

# Handlers are blocking functions; the SDK runs them on worker threads and handles
# RECEIVED/ACCEPTED/EXECUTING/terminal statuses for you.
def on_move(action: dict, ctx):
    while not nav.go_to(action["properties"]["location"]):
        if ctx.cancelled.is_set():          # threading.Event, set on cancel
            return ctx.aborted("REJECTED", "cancelled")
        ctx.progress({"distanceRemaining": nav.remaining()})
    return ctx.succeeded()

robot.on_request("move", on_move)
```
