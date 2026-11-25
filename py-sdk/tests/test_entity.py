import json
import threading
import time

import pytest

from iso21423 import Client, Iso21423Error, policies
from iso21423.testing import FakeTransport
from iso21423.topics import request_status_topic, request_topic, topic_for

U = "91403a21-7534-4467-99a6-79c46a130fe8"
SA = "42177726-26f7-4f5c-b735-a12a427bb96d"
SB = "11111111-1111-4111-8111-111111111111"
CCS = "2385eed2-86ca-4dc9-8f17-dac062ce9a08"
DETAILS = {}


def MOVE(x=1):
    return {"type": "move", "version": "1.0", "properties": {"location": {"ccsId": CCS, "x": x, "y": 0, "z": 0}}}


def ruuid(seq):
    return f"00000000-0000-4000-8000-{seq:012d}"


def wait_for(pred, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return
        time.sleep(0.005)
    raise AssertionError("condition not met in time")


def published(t, resource):
    topic = topic_for("IMR", U, resource)
    return [(p, q, r) for (tp, p, q, r) in t.published if tp == topic]


def last(t, resource):
    return published(t, resource)[-1][0]


def setup(**kw):
    t = FakeTransport()
    c = Client.connect(transport=t, sequence_store=None)
    return t, c, c.register_self_entity(U, manufacturer_name="Acme", **kw)


def send(t, seq, src=SA, details=None):
    r = {"destination": U, "source": src, "sequenceId": seq,
         "timestamp": "2026-11-25T12:00:00.000Z", "details": details or [MOVE()]}
    t.inject(request_topic("IMR", U, ruuid(seq)), json.dumps(r))


def statuses(t, seq):
    topic = request_status_topic("IMR", U, ruuid(seq))
    return [json.loads(p) for (tp, p, _, _) in list(t.published) if tp == topic]


def wait_status(t, seq, status):
    wait_for(lambda: any(s["status"] == status for s in statuses(t, seq)))


def test_session_opens_lazily():
    t = FakeTransport()
    c = Client.connect(transport=t, sequence_store=None)
    assert t.connect_args is None
    c.register_self_entity(U)
    assert t.connect_args.client_id == f"iso21423-IMR-{U}"


def test_connect_needs_exactly_one_of_url_transport():
    with pytest.raises(Iso21423Error):
        Client.connect()
    with pytest.raises(Iso21423Error):
        Client.connect("mqtt://x", transport=FakeTransport())


def test_register_publishes_identity():
    t, c, h = setup(details=DETAILS, provides=["odometry"], accepts=["move"])
    ident = json.loads(last(t, "identity"))
    assert ident["id"] == U and ident["capabilities"] == {"provides": ["odometry"], "accepts": {"requests": ["move"]}}
    assert ident["iso21423Version"] == "1.0" and ident["manufacturerName"] == "Acme"


def test_register_twice_raises():
    t, c, h = setup()
    with pytest.raises(Iso21423Error):
        c.register_self_entity(U)


def test_update_identity_merges_and_republishes():
    t, c, h = setup()
    h.update_identity(manufacturerName="Other")
    assert json.loads(last(t, "identity"))["manufacturerName"] == "Other"


def test_publishers_add_timestamp_and_kinds():
    t, c, h = setup()
    h.publish_status(["MODE_AUTO"])
    s = json.loads(last(t, "status"))
    assert s["entityId"] == U and s["states"] == ["MODE_AUTO"] and s["timestamp"].endswith("Z")
    pt = {"ccsId": CCS, "x": 1, "y": 2, "z": 0}
    h.publish_battery_status({"batterySoc": 0.5})
    h.publish_odometry({"pose": {"locationPoint": pt, "orientation": {"yaw": 0, "pitch": 0, "roll": 0}},
                        "velocity": {"linear": 0, "angular": 0}})
    stamped = {"timestamp": "2026-11-25T12:00:00.000Z", "locationPoint": pt}
    h.publish_local_trajectory([stamped])
    h.publish_global_plan([stamped])
    for res in ("batteryStatus", "odometry", "localTrajectory", "globalPlan"):
        assert "timestamp" in json.loads(last(t, res)), res
    assert json.loads(last(t, "localTrajectory"))["localTrajectory"][0]["locationPoint"]["x"] == 1
    assert len(json.loads(last(t, "globalPlan"))["globalPlan"]) == 1


def test_publish_extension_has_no_kind():
    from iso21423 import ResourceConfig, register_extension_resource
    register_extension_resource("vendorX", ResourceConfig(0, False))
    t, c, h = setup()
    h.publish_extension("vendorX", {"anything": 1})
    assert json.loads(last(t, "vendorX")) == {"anything": 1}


def test_status_tracks_last_states_and_blocks_actions():
    t, c, h = setup(accepts=["move"])
    h.publish_status(["MODE_AUTO", "STOP_CATEGORY_2"])
    assert h.last_states() == ["MODE_AUTO", "STOP_CATEGORY_2"]
    h.on_request("move", lambda a, ctx: ctx.succeeded())
    h.start_serving()
    send(t, 1)
    wait_status(t, 1, "ABORTED")
    assert statuses(t, 1)[-1]["detailStatuses"][0]["status"]["reason"] == "INVALID_IMR_STATE_FOR_ACTION"


def test_on_request_runs_handler():
    t, c, h = setup(accepts=["move"])
    h.on_request("move", lambda a, ctx: ctx.succeeded())
    h.start_serving()
    send(t, 1)
    wait_status(t, 1, "SUCCEEDED")


def test_unregister_leaves_offline_tombstone():
    t, c, h = setup()
    h.unregister()
    assert json.loads(t.retained[topic_for("IMR", U, "status")])["states"] == ["OFFLINE"]
    for res in ("identity", "batteryStatus", "globalPath", "globalPlan", "activeRequestsStatus", "disconnection"):
        assert topic_for("IMR", U, res) not in t.retained, res
        assert published(t, res)[-1] == ("", 1, True)


def test_close_closes_transport_once():
    t, c, h = setup()
    c.close()
    c.close()
    assert t.closed


def test_events_forwarded():
    t = FakeTransport()
    c = Client.connect(transport=t, sequence_store=None)
    seen = []
    c.on("connection", seen.append)
    c.register_self_entity(U)
    assert "connected" in seen


def test_per_handle_override_wins_over_registration_policy():
    # py has no client-wide default setter; registration policy stands in for it (P-2)
    t, c, h = setup(accepts=["move"], execution_policy=policies.abort_new())
    h.set_execution_policy(policies.parallel())
    gates = []

    def handler(action, ctx):
        g = threading.Event()
        gates.append(g)
        g.wait(5)
        return ctx.succeeded()
    h.on_request("move", handler)
    h.start_serving()
    send(t, 1, SA)
    send(t, 2, SB)
    wait_for(lambda: len(gates) == 2)
    for g in gates:
        g.set()
    wait_status(t, 1, "SUCCEEDED")
    wait_status(t, 2, "SUCCEEDED")


def test_registration_policy_applies_without_override():
    t, c, h = setup(accepts=["move"], execution_policy=policies.abort_new())
    gates = []

    def handler(action, ctx):
        g = threading.Event()
        gates.append(g)
        g.wait(5)
        return ctx.succeeded()
    h.on_request("move", handler)
    h.start_serving()
    send(t, 1, SA)
    wait_status(t, 1, "EXECUTING")
    send(t, 2, SB)
    wait_status(t, 2, "ABORTED")
    gates[0].set()
    wait_status(t, 1, "SUCCEEDED")


def test_on_request_only_registers_until_start_serving():
    t, c, h = setup(accepts=["move", "dock"])
    req_filter = (topic_for("IMR", U, "request") + "/+", 2)
    h.on_request("move", lambda a, ctx: ctx.succeeded())
    assert req_filter not in t.subscriptions
    h.start_serving()
    h.start_serving()  # idempotent
    assert t.subscriptions.count(req_filter) == 1
    h.on_request("dock", lambda a, ctx: ctx.succeeded())  # live registration still works
    send(t, 1, details=[{"type": "dock", "version": "1.0"}])
    wait_status(t, 1, "SUCCEEDED")


class RetainedTransport(FakeTransport):
    """Replays retained requests on subscribe, like a broker does right after the SUBACK."""

    def subscribe(self, filter, qos):
        ok = super().subscribe(filter, qos)
        for topic, payload in list(self.retained.items()):
            if "/request/" in topic and not topic.endswith("/status"):
                self.inject(topic, payload)
        return ok


def test_retained_request_replayed_to_handlers_registered_before_start():
    t = RetainedTransport()
    c = Client.connect(transport=t, sequence_store=None)
    h = c.register_self_entity(U, accepts=["move", "dock"])
    r = {"destination": U, "source": SA, "sequenceId": 1, "timestamp": "2026-11-25T12:00:00.000Z",
         "details": [{"type": "dock", "version": "1.0"}]}
    t.retained[request_topic("IMR", U, ruuid(1))] = json.dumps(r)
    h.on_request("move", lambda a, ctx: ctx.succeeded())
    h.on_request("dock", lambda a, ctx: ctx.succeeded())
    h.start_serving()
    wait_status(t, 1, "SUCCEEDED")
