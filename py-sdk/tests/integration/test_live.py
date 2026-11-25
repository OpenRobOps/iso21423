"""Live-broker tests: the SDK against a real Mosquitto, observed by a raw paho client (the fleet manager)."""
import json
import socket
import threading
import time
import uuid
from urllib.parse import urlparse

import paho.mqtt.client as mqtt
import pytest

from iso21423 import ActionResult, Client

pytestmark = pytest.mark.integration

ROOT = "/ISO_21423/v1/IMR"
WAIT = 15.0


class Fleet:
    """Raw paho subscriber; (re)subscribes on every connect so it survives a broker restart."""

    def __init__(self, url, filters=()):
        u = urlparse(url)
        kw = {"client_id": f"fleet-{uuid.uuid4().hex[:8]}"}
        self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, **kw) if hasattr(mqtt, "CallbackAPIVersion") \
            else mqtt.Client(**kw)
        self.msgs: list[tuple[str, str]] = []
        self.cond = threading.Condition()
        self.filters = list(filters)
        self.subscribed = threading.Event()
        self._pending: set[int] = set()
        self.c.on_connect = self._on_connect
        self.c.on_subscribe = self._on_subscribe
        self.c.on_message = self._on_message
        self.c.reconnect_delay_set(1, 2)
        self.c.connect(u.hostname, u.port or 1883)
        self.c.loop_start()
        assert self.subscribed.wait(WAIT), "fleet subscribe timed out"

    def _on_connect(self, c, ud, flags, rc):
        self.subscribed.clear()
        self._pending = {c.subscribe(f, 2)[1] for f in self.filters}
        if not self._pending:
            self.subscribed.set()

    def _on_subscribe(self, c, ud, mid, granted):
        self._pending.discard(mid)
        if not self._pending:
            self.subscribed.set()

    def _on_message(self, c, ud, m):
        with self.cond:
            self.msgs.append((m.topic, m.payload.decode()))
            self.cond.notify_all()

    def wait(self, pred, what="condition"):
        with self.cond:
            if not self.cond.wait_for(lambda: pred(list(self.msgs)), WAIT):
                raise AssertionError(f"timed out waiting for {what}; got {self.msgs[-10:]}")

    def on(self, suffix):
        return [json.loads(p) if p else None for t, p in self.msgs if t.endswith(suffix)]

    def statuses(self):
        out = [s["status"] for s in self.on("/status") if s]
        return [s for i, s in enumerate(out) if i == 0 or s != out[i - 1]]

    def stop(self):
        self.c.disconnect()
        self.c.loop_stop()


def retained(url, filter, settle=1.0):
    """What a fresh subscriber is handed on subscribing: retained messages arrive right after the SUBACK."""
    f = Fleet(url, [filter])
    time.sleep(settle)  # absence can only be observed by waiting
    f.stop()
    return f.msgs


@pytest.fixture
def fleet_of(broker_url):
    made = []

    def make(*filters):
        f = Fleet(broker_url, filters)
        made.append(f)
        return f
    yield make
    for f in made:
        f.stop()


@pytest.fixture
def robot(broker_url):
    ids = {"uuid": str(uuid.uuid4())}
    c = Client.connect(broker_url, sequence_store=None)
    h = c.register_self_entity(ids["uuid"], "IMR", "Acme", provides=["odometry"], accepts=["move"])
    h.publish_status(["IDLE"])
    yield c, h, ids["uuid"]
    c.close()


def request(robot_uuid, seq=1, fleet_uuid="11111111-1111-4111-8111-111111111111"):
    return {"destination": robot_uuid, "source": fleet_uuid, "sequenceId": seq,
            "timestamp": "2026-11-25T12:00:00.000Z", "details": [{"type": "move", "version": "1.0"}]}


def send(fleet, robot_uuid, req=None):
    ruuid = str(uuid.uuid4())
    fleet.c.publish(f"{ROOT}/{robot_uuid}/request/{ruuid}", json.dumps(req or request(robot_uuid)), 2, True)
    return ruuid


def test_will_published_on_ungraceful_disconnect(broker_url, robot, fleet_of):
    c, h, uid = robot
    fleet = fleet_of(f"{ROOT}/{uid}/disconnection")
    paho_client = c._session._t._client
    paho_client.reconnect_delay_set(30, 30)  # keep the retained will observable, don't clear it by reconnecting
    paho_client.socket().shutdown(socket.SHUT_RDWR)  # drop the TCP connection without DISCONNECT
    fleet.wait(lambda m: any(p for _, p in m), "will")
    assert fleet.on("/disconnection")[-1] == {"states": ["LOST_CONNECTION"]}
    assert json.loads(retained(broker_url, f"{ROOT}/{uid}/disconnection")[0][1]) == {"states": ["LOST_CONNECTION"]}


def test_move_request_round_trip(robot, fleet_of):
    c, h, uid = robot
    h.on_request("move", lambda a, ctx: ctx.succeeded())
    fleet = fleet_of(f"{ROOT}/{uid}/request/+/status", f"{ROOT}/{uid}/activeRequestsStatus")
    send(fleet, uid)
    fleet.wait(lambda m: "SUCCEEDED" in fleet.statuses(), "SUCCEEDED")
    assert fleet.statuses() == ["RECEIVED", "ACCEPTED", "EXECUTING", "SUCCEEDED"]
    fleet.wait(lambda m: fleet.on("/activeRequestsStatus")[-1] == [], "activeRequestsStatus []")


def test_terminal_request_retained_topic_cleared(broker_url, robot, fleet_of):
    c, h, uid = robot
    h.on_request("move", lambda a, ctx: ctx.succeeded())
    fleet = fleet_of(f"{ROOT}/{uid}/request/+")
    ruuid = send(fleet, uid)
    # the fleet sees the SDK's clearing (empty retained) after its own request
    fleet.wait(lambda m: [p for t, p in m if t.endswith(ruuid)][-1:] == [""], "request topic cleared")
    assert retained(broker_url, f"{ROOT}/{uid}/request/+") == []


def test_reconnect_republishes_and_finishes_request(broker, broker_url, robot, fleet_of):
    if not broker.container:
        pytest.skip("cannot restart an external broker")
    c, h, uid = robot
    running = threading.Event()

    def handler(a, ctx):
        running.set()
        time.sleep(2)
        return ctx.succeeded()
    h.on_request("move", handler)
    fleet = fleet_of(f"{ROOT}/{uid}/request/+/status")
    send(fleet, uid)
    assert running.wait(WAIT)
    broker.restart()
    fleet.subscribed.wait(WAIT)
    fleet.wait(lambda m: "SUCCEEDED" in fleet.statuses(), "SUCCEEDED after restart")
    assert json.loads(retained(broker_url, f"{ROOT}/{uid}/identity")[0][1])["id"] == uid
    assert json.loads(retained(broker_url, f"{ROOT}/{uid}/status")[0][1])["states"] == ["IDLE"]
    assert retained(broker_url, f"{ROOT}/{uid}/disconnection") == []


def test_odometry_rate_capped_at_30hz(robot, fleet_of):
    c, h, uid = robot
    fleet = fleet_of(f"{ROOT}/{uid}/odometry")
    pt = {"ccsId": "22222222-2222-4222-8222-222222222222", "x": 0, "y": 0, "z": 0}
    start, i = time.monotonic(), 0
    while time.monotonic() - start < 1.0:  # ~200 offers/s, wall-clock bounded
        i += 1
        pt = {**pt, "x": i}
        h.publish_odometry({"pose": {"locationPoint": pt, "orientation": {"yaw": 0, "pitch": 0, "roll": 0}},
                            "velocity": {"linear": 0, "angular": 0}})
        time.sleep(0.004)
    assert i >= 100
    time.sleep(0.5)  # trailing sample, then silence
    n = len(fleet.on("/odometry"))
    assert 20 <= n <= 31, n
