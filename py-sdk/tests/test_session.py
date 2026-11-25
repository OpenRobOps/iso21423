import time

import pytest

from iso21423.errors import AuthorizationDenied, ValidationError
from iso21423.session import Session
from iso21423.testing import FakeTransport
from iso21423.topics import topic_filter_matches
from iso21423.transport import Will

U = "123e4567-e89b-42d3-a456-426614174000"
TS = "2025-04-08T12:34:56.789Z"
B = {"timestamp": TS, "batterySoc": 0.8}
ST = {"entityId": U, "timestamp": TS, "states": ["MODE_AUTO"]}
ODOM = {
    "timestamp": TS,
    "pose": {"locationPoint": {"ccsId": U, "x": 1.0, "y": 2.0, "z": 0.0},
             "orientation": {"yaw": 0.1, "pitch": 0.0, "roll": 0.0}},
    "velocity": {"linear": 0.5, "angular": 0.0},
}


def count(t, resource):
    return sum(1 for p in t.published if p[0].endswith("/" + resource))


@pytest.fixture
def ts():
    t = FakeTransport()
    return t, Session.connect(t, "IMR", U)


def test_connect_arms_will_and_clears_stale_will():
    t = FakeTransport(); Session.connect(t, "IMR", U)
    assert t.connect_args.will == Will(f"/ISO_21423/v1/IMR/{U}/disconnection", '{"states":["LOST_CONNECTION"]}', 1, True)
    assert t.connect_args.client_id == f"iso21423-IMR-{U}" and t.connect_args.keepalive == 60
    assert not t.connect_args.clean_session
    assert t.published[0] == (f"/ISO_21423/v1/IMR/{U}/disconnection", "", 1, True)


def test_retained_on_change_only(ts):
    t, s = ts
    s.publish_resource("batteryStatus", "batteryStatus", B)
    s.publish_resource("batteryStatus", "batteryStatus", B)
    assert count(t, "batteryStatus") == 1
    s.publish_resource("batteryStatus", "batteryStatus", {**B, "batterySoc": 0.7})
    assert count(t, "batteryStatus") == 2


def test_streaming_rate_limited(ts):
    t, s = ts
    for _ in range(100):  # 100 offers well inside 0.1 s
        s.publish_resource("odometry", "odometry", ODOM)
    assert 1 <= count(t, "odometry") <= 4


def test_outbound_validation_raises(ts):
    _, s = ts
    with pytest.raises(ValidationError):
        s.publish_resource("odometry", "odometry", {})


def test_reconnect_republishes_owned_retained(ts):
    t, s = ts
    s.publish_resource("status", "entityStatus", ST)
    t.set_state("reconnecting"); t.set_state("connected")
    assert count(t, "status") == 2
    assert t.published[-1] == (f"/ISO_21423/v1/IMR/{U}/disconnection", "", 1, True)


def test_close_publishes_final_states(ts):
    t, s = ts
    s.close(["OFFLINE"])
    assert '"states":["OFFLINE"]' in t.retained[f"/ISO_21423/v1/IMR/{U}/status"]
    assert t.closed


def test_subscribe_dispatch_and_handler_errors(ts):
    t, s = ts
    got, errs = [], []
    s.on("error", errs.append)
    s.subscribe(f"/ISO_21423/v1/+/+/identity", lambda text, p: got.append((text, p.entity_uuid)), 1)
    s.subscribe(f"/ISO_21423/v1/IMR/{U}/#", lambda text, p: 1 / 0, 1)
    t.inject(f"/ISO_21423/v1/IMR/{U}/identity", "{}")
    t.inject("/other/topic", "x")
    assert got == [("{}", U)] and len(errs) == 1


def test_subscribe_denied(ts):
    t, s = ts
    t.grant = False
    with pytest.raises(AuthorizationDenied):
        s.subscribe("/ISO_21423/v1/+/+/status", lambda *_: None, 1)


def test_validation_warning_event(ts):
    _, s = ts
    w = []
    s.on("validation_warning", lambda *a: w.append(a))
    s.report_validation_warning("t", "p", ["e"])
    assert w == [("t", "p", ["e"])]


def test_topic_filter_matches():
    assert topic_filter_matches("a/+/c", "a/b/c") and topic_filter_matches("a/#", "a/b/c")
    assert not topic_filter_matches("a/+", "a/b/c") and not topic_filter_matches("a/b/c/d", "a/b/c")


def test_concurrent_retained_publishes_keep_broker_and_cache_consistent():
    import threading

    class Slow(FakeTransport):
        slow = False

        def publish(self, *a):
            if self.slow and '"batterySoc":0.1' in a[1]:
                self.slow = False
                time.sleep(0.1)  # first publisher stalls after setting the cache
            super().publish(*a)
    t = Slow(); s = Session.connect(t, "IMR", U)
    t.slow = True
    topic = f"/ISO_21423/v1/IMR/{U}/batteryStatus"
    a = threading.Thread(target=s.publish_resource, args=("batteryStatus", "batteryStatus", {**B, "batterySoc": 0.1}))
    a.start(); time.sleep(0.03)
    s.publish_resource("batteryStatus", "batteryStatus", {**B, "batterySoc": 0.2})
    a.join()
    assert t.retained[topic] == s._retained[topic][0]


def test_close_closes_transport_even_if_final_publish_fails(ts):
    t, s = ts
    t.publish = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        s.close(["OFFLINE"])
    assert t.closed
