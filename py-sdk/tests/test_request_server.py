"""Ports ts-sdk/test/corePolicies.test.ts (server wiring) and
ts-sdk/test/integration/executionPolicies.test.ts onto FakeTransport, plus py-only cases."""
import json
import threading
import time

import pytest

from iso21423.executor import ActionExecutor
from iso21423.policies import DEFAULT_EXECUTION_POLICY, policies
from iso21423.request_server import RequestServer
from iso21423.sequence import SequenceCounter
from iso21423.session import Session
from iso21423.testing import FakeTransport
from iso21423.topics import request_status_topic, request_topic, topic_for

ROBOT = "91403a21-7534-4467-99a6-79c46a130fe8"
SA = "42177726-26f7-4f5c-b735-a12a427bb96d"
SB = "11111111-1111-4111-8111-111111111111"
CCS = "2385eed2-86ca-4dc9-8f17-dac062ce9a08"
TERMINAL = ("SUCCEEDED", "CANCELED", "ABORTED")


def MOVE(x=1):
    return {"type": "move", "version": "1.0", "properties": {"location": {"ccsId": CCS, "x": x, "y": 0, "z": 0}}}


PAUSE = {"type": "pauseImr", "version": "1.0", "properties": {}}


def CANCEL(seq, src=SA, type="cancelRequest"):
    return {"type": type, "version": "1.0", "properties": {"source": src, "requestId": seq}}


def ruuid(seq):
    return f"00000000-0000-4000-8000-{seq:012d}"


def wait_for(pred, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return
        time.sleep(0.005)
    raise AssertionError("condition not met in time")


class Entity:
    def last_states(self):
        return []


class Robot:
    def __init__(self, policy=DEFAULT_EXECUTION_POLICY, entity=None):
        self.t = FakeTransport()
        self.session = Session.connect(self.t, "IMR", ROBOT)
        self.ex = ActionExecutor()
        self.warnings = []
        self.session.on("validation_warning", lambda *a: self.warnings.append(a))
        self.server = RequestServer(self.session, entity or Entity(), self.ex, SequenceCounter.open(ROBOT, None),
                                    lambda: policy)
        self.server.start()

    def send(self, details, seq, src=SA, priority=None, uuid=None):
        r = {"destination": ROBOT, "source": src, "sequenceId": seq,
             "timestamp": "2026-11-25T12:00:00.000Z", "details": details}
        if priority is not None:
            r["priority"] = priority
        self.inject(r, uuid or ruuid(seq))
        return uuid or ruuid(seq)

    def inject(self, payload, uuid):
        raw = payload if isinstance(payload, str) else json.dumps(payload)
        self.t.inject(request_topic("IMR", ROBOT, uuid), raw)

    def statuses(self, seq, uuid=None):
        topic = request_status_topic("IMR", ROBOT, uuid or ruuid(seq))
        return [json.loads(p) for (t, p, _, _) in list(self.t.published) if t == topic]

    def sequence(self, seq):
        return [s["status"] for s in self.statuses(seq)]

    def status_of(self, seq):
        s = self.statuses(seq)
        return s[-1]["status"] if s else None

    def reason_of(self, seq):
        return self.statuses(seq)[-1]["detailStatuses"][0]["status"].get("reason")

    def wait_status(self, seq, status):
        wait_for(lambda: status in self.sequence(seq))

    def last_active(self):
        topic = topic_for("IMR", ROBOT, "activeRequestsStatus")
        return [json.loads(p) for (t, p, _, _) in list(self.t.published) if t == topic][-1]

    def gated(self, type="move"):
        """Handler that blocks per invocation until its gate is set; records start/end by source."""
        order, gates = [], []

        def handler(action, ctx):
            gate = threading.Event()
            order.append(f"start:{ctx.request['source']}")
            gates.append(gate)
            gate.wait(5)
            order.append(f"end:{ctx.request['source']}")
            return ctx.succeeded()
        self.ex.register(type, handler)
        return order, gates


def test_start_subscribes_request_wildcard_at_qos2():
    r = Robot()
    assert (topic_for("IMR", ROBOT, "request") + "/+", 2) in r.t.subscriptions


# --- executionPolicies.test.ts ---

def test_abort_new_rejects_a_concurrent_second_request():
    r = Robot(policies.abort_new())
    order, gates = r.gated()
    r.send([MOVE()], 1, SA)
    r.wait_status(1, "EXECUTING")
    r.send([MOVE()], 2, SB)
    r.wait_status(2, "ABORTED")
    assert r.reason_of(2) == "REJECTED"
    wait_for(lambda: len(gates) == 1)
    gates[0].set()
    r.wait_status(1, "SUCCEEDED")
    assert order == [f"start:{SA}", f"end:{SA}"]


def test_queue_after_buffers_second_until_first_succeeds():
    r = Robot(policies.queue_after())
    order, gates = r.gated()
    r.send([MOVE()], 1, SA)
    wait_for(lambda: len(gates) == 1)
    r.send([MOVE()], 2, SB)
    time.sleep(0.05)
    assert r.sequence(2) == ["RECEIVED"]  # buffered: RECEIVED on the wire, no ACCEPTED yet
    assert order == [f"start:{SA}"]
    gates[0].set()
    wait_for(lambda: len(gates) == 2)
    assert order == [f"start:{SA}", f"end:{SA}", f"start:{SB}"]
    gates[1].set()
    r.wait_status(2, "SUCCEEDED")
    assert r.status_of(1) == "SUCCEEDED"


def test_queue_replace_displaces_the_queued_request():
    r = Robot(policies.queue_replace())
    order, gates = r.gated()
    r.send([MOVE(1)], 1, SA)
    wait_for(lambda: len(gates) == 1)
    r.send([MOVE(2)], 2, SB)  # takes the buffer slot
    r.send([MOVE(3)], 3, SA)  # displaces seq 2
    r.wait_status(2, "ABORTED")
    assert r.reason_of(2) == "REJECTED"
    gates[0].set()
    r.wait_status(1, "SUCCEEDED")
    wait_for(lambda: len(gates) == 2)
    gates[1].set()
    r.wait_status(3, "SUCCEEDED")
    assert order == [f"start:{SA}", f"end:{SA}", f"start:{SA}", f"end:{SA}"]


def test_parallel_2_runs_two_and_buffers_the_third():
    r = Robot(policies.parallel(2))
    order, gates = r.gated()
    r.send([MOVE(1)], 1, SA)
    r.send([MOVE(2)], 2, SB)
    wait_for(lambda: len(gates) == 2)
    r.send([MOVE(3)], 3, SA)
    time.sleep(0.05)
    assert "EXECUTING" in r.sequence(1) and "EXECUTING" in r.sequence(2)
    assert r.sequence(3) == ["RECEIVED"]
    assert r.server.serving_count == 2
    gates[0].set()
    gates[1].set()
    r.wait_status(1, "SUCCEEDED")
    r.wait_status(2, "SUCCEEDED")
    wait_for(lambda: len(gates) == 3)
    gates[2].set()
    r.wait_status(3, "SUCCEEDED")
    wait_for(lambda: r.server.serving_count == 0)


def test_priority_preempts_an_executing_lower_priority_request():
    r = Robot(policies.priority())
    saw_abort = threading.Event()

    def handler(action, ctx):
        if ctx.request.get("priority") == 100:
            ctx.cancelled.wait(5)
            saw_abort.set()
            return ctx.aborted("OK", "preempted")
        return ctx.succeeded()
    r.ex.register("move", handler)
    r.send([MOVE(1)], 1, SA, priority=100)
    r.wait_status(1, "EXECUTING")
    r.send([MOVE(2)], 2, SB, priority=10)
    r.wait_status(1, "CANCELED")
    assert saw_abort.is_set()
    r.wait_status(2, "SUCCEEDED")


def test_priority_drains_buffered_requests_by_priority():
    r = Robot(policies.priority())
    order = []
    gates = []

    def handler(action, ctx):
        gate = threading.Event()
        order.append(f"start-{ctx.request.get('priority', 100)}")
        gates.append(gate)
        gate.wait(5)
        order.append(f"end-{ctx.request.get('priority', 100)}")
        return ctx.succeeded()
    r.ex.register("move", handler)
    r.send([MOVE(1)], 1, SA, priority=5)
    wait_for(lambda: len(gates) == 1)
    r.send([MOVE(2)], 2, SA, priority=50)
    r.send([MOVE(3)], 3, SA, priority=10)  # arrives later, must drain first
    time.sleep(0.05)
    assert order == ["start-5"]  # both buffered, nothing preempted
    gates[0].set()
    wait_for(lambda: len(gates) == 2)
    gates[1].set()
    wait_for(lambda: len(gates) == 3)
    gates[2].set()
    for seq in (1, 2, 3):
        r.wait_status(seq, "SUCCEEDED")
    assert order == ["start-5", "end-5", "start-10", "end-10", "start-50", "end-50"]


# --- cancel bypass (corePolicies.test.ts server wiring) ---

@pytest.mark.parametrize("cancel_type", ["cancelRequest", "cancel"])  # legacy `cancel` normalized (D-02)
def test_cancel_request_bypasses_abort_new(cancel_type):
    r = Robot(policies.abort_new())

    def handler(action, ctx):
        ctx.cancelled.wait(5)
        return ctx.succeeded()
    r.ex.register("move", handler)
    r.send([MOVE()], 1)
    r.wait_status(1, "EXECUTING")
    r.send([CANCEL(1, type=cancel_type)], 2)
    r.wait_status(2, "SUCCEEDED")
    r.wait_status(1, "CANCELED")
    wait_for(lambda: r.server.serving_count == 0)


def test_cancel_of_unknown_request_is_rejected():
    r = Robot()
    r.send([CANCEL(42)], 2)
    r.wait_status(2, "ABORTED")
    assert r.reason_of(2) == "REJECTED"


# --- py-only: preempt() and the control bypass ---

def cooperative(r, type="move"):
    def handler(action, ctx):
        ctx.cancelled.wait(5)
        return ctx.succeeded()
    r.ex.register(type, handler)


def test_preempt_cancels_active_then_runs_new():
    r = Robot(policies.preempt())
    cooperative(r)
    r.send([MOVE(1)], 1)
    r.wait_status(1, "EXECUTING")
    r.send([MOVE(2)], 2)
    r.wait_status(1, "CANCELED")
    r.wait_status(2, "EXECUTING")
    assert r.status_of(2) == "EXECUTING"


def test_preempt_back_to_back_before_first_run_registers(caplog):
    r = Robot(policies.preempt())
    cooperative(r)
    r.send([MOVE(1)], 1)  # no wait: may be preempted before the executor registers its run
    r.send([MOVE(2)], 2)
    r.wait_status(1, "CANCELED")
    r.wait_status(2, "EXECUTING")
    assert r.server.serving_count == 1
    assert not [rec for rec in caplog.records if rec.levelname == "ERROR"]


def test_preempt_of_run_not_yet_registered_ends_it_directly(caplog):
    gate, calls = threading.Event(), []

    class SlowPreflight:
        def last_states(self):  # first run stalls in executor preflight, before it registers
            calls.append(1)
            if len(calls) == 1:
                gate.wait(5)
            return []
    r = Robot(policies.preempt(), entity=SlowPreflight())
    ran = []
    r.ex.register("move", lambda a, ctx: (ran.append(ctx.request["sequenceId"]), ctx.succeeded())[1])
    r.send([MOVE(1)], 1)
    wait_for(lambda: len(calls) == 1)
    r.send([MOVE(2)], 2)
    r.wait_status(1, "CANCELED")
    assert r.reason_of(1) == "PREEMPTED"
    gate.set()
    r.wait_status(2, "SUCCEEDED")
    time.sleep(0.05)
    assert ran == [2]  # the preempted request's handler never runs
    assert not [rec for rec in caplog.records if rec.levelname == "ERROR"]


def test_preempted_run_registering_after_admission_is_signalled():
    gate, calls = threading.Event(), []

    class SlowPreflight:
        def last_states(self):  # first run stalls before registering, so the preempt cancel misses it
            calls.append(1)
            if len(calls) == 1:
                gate.wait(5)
            return []
    r = Robot(policies.preempt(), entity=SlowPreflight())
    started, saw_cancel = threading.Event(), []

    def handler(action, ctx):
        if ctx.request["sequenceId"] == 1:
            started.set()
            saw_cancel.append(ctx.cancelled.wait(5))
        return ctx.succeeded()
    r.ex.register("move", handler)
    end_preempted = r.server._end_preempted

    def late_end(inc, key):  # the run registers and enters its handler before the direct end
        gate.set()
        assert started.wait(5)
        end_preempted(inc, key)
    r.server._end_preempted = late_end
    r.send([MOVE(1)], 1)
    wait_for(lambda: len(calls) == 1)
    r.send([MOVE(2)], 2)
    wait_for(lambda: saw_cancel == [True])
    r.wait_status(1, "CANCELED")
    r.wait_status(2, "SUCCEEDED")


def test_pause_bypasses_admission_under_abort_new():
    r = Robot(policies.abort_new())
    cooperative(r)
    r.ex.register("pauseImr", lambda a, ctx: ctx.succeeded())
    r.send([MOVE()], 1)
    r.wait_status(1, "EXECUTING")
    r.send([PAUSE], 2)
    r.wait_status(2, "SUCCEEDED")
    assert r.status_of(1) == "EXECUTING"
    assert r.server.serving_count == 1


def test_pause_not_visible_to_admission():
    r = Robot(policies.preempt())
    cooperative(r)
    pause_gate = threading.Event()
    r.ex.register("pauseImr", lambda a, ctx: (pause_gate.wait(5), ctx.succeeded())[1])
    r.send([PAUSE], 1)
    r.wait_status(1, "EXECUTING")
    assert r.server.serving_count == 0  # a control request is never admitted
    r.send([MOVE()], 2)  # nothing admitted: accepted, does not preempt the pause
    r.wait_status(2, "EXECUTING")
    r.send([PAUSE], 3)  # a second pause does not preempt the move
    r.wait_status(3, "EXECUTING")
    pause_gate.set()
    r.wait_status(1, "SUCCEEDED")
    r.wait_status(3, "SUCCEEDED")
    assert r.status_of(2) == "EXECUTING"


def test_mixed_pause_and_move_goes_through_admission():
    r = Robot(policies.abort_new())
    cooperative(r)
    r.ex.register("pauseImr", lambda a, ctx: ctx.succeeded())
    r.send([MOVE()], 1)
    r.wait_status(1, "EXECUTING")
    r.send([PAUSE, MOVE()], 2)
    r.wait_status(2, "ABORTED")
    assert r.reason_of(2) == "REJECTED"


def test_cancel_of_uncooperative_handler_still_succeeds_cancel():
    r = Robot()
    done = threading.Event()

    def stubborn(action, ctx):
        time.sleep(1)  # ignores ctx.cancelled
        done.set()
        return ctx.succeeded()
    r.ex.register("move", stubborn)
    r.send([MOVE()], 1)
    r.wait_status(1, "EXECUTING")
    t0 = time.monotonic()
    r.send([CANCEL(1)], 2)
    r.wait_status(2, "SUCCEEDED")
    assert time.monotonic() - t0 < 0.5 and not done.is_set()
    r.wait_status(1, "CANCELED")


# --- inbound handling ---

def test_malformed_request_rejected_or_warned():
    r = Robot()
    bad = ruuid(500)
    r.inject("{not json", bad)
    assert r.warnings and r.warnings[0][0] == request_topic("IMR", ROBOT, bad)
    assert (request_topic("IMR", ROBOT, bad), "", 1, True) in r.t.published
    r.inject({"source": SA, "sequenceId": 9, "details": "x"}, ruuid(9))
    assert r.status_of(9) == "ABORTED" and r.reason_of(9) == "MALFORMED_REQUEST"


def test_empty_payload_ignored():
    r = Robot()
    before = len(r.t.published)
    r.inject("", ruuid(1))
    assert len(r.t.published) == before and not r.warnings


def test_duplicate_request_ignored_and_cleared():
    r = Robot()
    cooperative(r)
    r.send([MOVE()], 1)
    r.wait_status(1, "EXECUTING")
    dup = ruuid(77)
    r.send([MOVE()], 1, uuid=dup)  # same (source, sequenceId), different request uuid
    assert r.statuses(1, uuid=dup) == []
    assert (request_topic("IMR", ROBOT, dup), "", 1, True) in r.t.published


def test_active_requests_status_lists_non_terminal_only():
    r = Robot(policies.queue_after())
    order, gates = r.gated()
    r.send([MOVE()], 1)
    wait_for(lambda: len(gates) == 1)
    r.send([MOVE()], 2)  # buffered: still listed
    wait_for(lambda: sorted(s["requestSequenceId"] for s in r.last_active()) == [1, 2])
    gates[0].set()
    r.wait_status(1, "SUCCEEDED")
    wait_for(lambda: len(gates) == 2)
    wait_for(lambda: [s["requestSequenceId"] for s in r.last_active()] == [2])
    gates[1].set()
    r.wait_status(2, "SUCCEEDED")
    wait_for(lambda: r.last_active() == [])


def test_terminal_clears_retained_request_topic():
    r = Robot()
    r.ex.register("move", lambda a, ctx: ctx.succeeded())
    uuid = r.send([MOVE()], 1)
    r.wait_status(1, "SUCCEEDED")
    topic = request_topic("IMR", ROBOT, uuid)
    wait_for(lambda: (topic, "", 1, True) in r.t.published)
    status_topic = request_status_topic("IMR", ROBOT, uuid)
    assert r.t.retained[status_topic]  # the requestStatus itself stays retained
    assert all(q == 2 and ret for (t, _, q, ret) in r.t.published if t == status_topic)


def test_stop_ignores_further_requests():
    r = Robot()
    r.server.stop()
    r.send([MOVE()], 1)
    assert r.statuses(1) == []
