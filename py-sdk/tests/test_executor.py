# Copyright 2026 InOrbit, Inc.
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#    Unless required by applicable law or agreed to in writing, software
#    distributed under the License is distributed on an "AS IS" BASIS,
#    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#    See the License for the specific language governing permissions and
#    limitations under the License.

import threading
import time

import pytest

from iso21423.errors import Iso21423Error
from iso21423.executor import ActionExecutor, resolve_cancel_request
from iso21423.incoming import IncomingRequest

OWNER = "91403a21-7534-4467-99a6-79c46a130fe8"
SRC = "42177726-26f7-4f5c-b735-a12a427bb96d"
CCS = "2385eed2-86ca-4dc9-8f17-dac062ce9a08"
TARGET = {"location": {"ccsId": CCS, "x": 1, "y": 2, "z": 0}}


def move(**kw):
    return {"type": "move", "version": "1.0", "properties": TARGET, **kw}


def pause(**kw):
    return {"type": "pauseImr", "version": "1.0", "properties": {}, **kw}


def req(details, recoveries=None, seq=7):
    r = {"source": SRC, "destination": OWNER, "sequenceId": seq,
         "timestamp": "2026-11-25T12:00:00.000Z", "details": details}
    if recoveries:
        r["recoveries"] = recoveries
    return r


class Sink:
    owner_uuid = OWNER

    def __init__(self):
        self.seq = 0
        self.statuses = []

    def next_status_sequence_id(self):
        self.seq += 1
        return self.seq

    def publish_status(self, r, status):
        self.statuses.append(status)


class Entity:
    def __init__(self, states=()):
        self.states = list(states)

    def last_states(self):
        return self.states


@pytest.fixture
def sink():
    return Sink()


@pytest.fixture
def ex():
    return ActionExecutor()


def incoming(sink, request):
    i = IncomingRequest(request, "r1", sink)
    i.publish_received()
    return i


def run(ex, sink, request, entity=None):
    i = incoming(sink, request)
    ex.run(i, entity or Entity())
    return i


def start_run(ex, sink, request, entity=None):
    i = incoming(sink, request)
    th = threading.Thread(target=ex.run, args=(i, entity or Entity()))
    th.start()
    return i, th


def wait_for(cond, t=2):
    end = time.time() + t
    while not cond():
        assert time.time() < end, "timeout"
        time.sleep(0.005)


def test_drives_received_accepted_executing_succeeded_around_handler(sink, ex):
    seen = {}

    def h(action, ctx):
        seen["props"] = action["properties"]
        seen["request"] = ctx.request
        ctx.progress({"distanceRemaining": 3})
        return ctx.succeeded({"arrived": True})

    ex.register("move", h)
    run(ex, sink, req([move()]))
    assert seen["props"] == TARGET
    assert [s["status"] for s in sink.statuses] == [
        "RECEIVED", "ACCEPTED", "EXECUTING", "EXECUTING", "EXECUTING", "SUCCEEDED"]


def test_rejects_unknown_actions_with_action_not_implemented_before_accepted(sink, ex):
    ex.register("move", lambda a, c: c.succeeded())
    run(ex, sink, req([{"type": "teleport", "version": "1.0", "properties": {}}]))
    assert [s["status"] for s in sink.statuses] == ["RECEIVED", "ABORTED"]
    assert sink.statuses[-1]["detailStatuses"][0]["status"]["reason"] == "ACTION_NOT_IMPLEMENTED"


def test_rejects_unsupported_versions_and_formats(sink, ex):
    ex.register("move", lambda a, c: c.succeeded())
    run(ex, sink, req([move(version="2.0")]))
    assert sink.statuses[-1]["detailStatuses"][0]["status"]["reason"] == "VERSION_NOT_SUPPORTED"
    run(ex, sink, req([move(format="VENDOR-X")]))
    assert sink.statuses[-1]["detailStatuses"][0]["status"]["reason"] == "FORMAT_NOT_SUPPORTED"


def test_rejects_invalid_imr_state_for_action_while_stopped(sink, ex):
    ex.register("move", lambda a, c: c.succeeded())
    run(ex, sink, req([move()]), Entity(["MODE_AUTO", "STOP_CATEGORY_0"]))
    assert sink.statuses[-1]["detailStatuses"][0]["status"]["reason"] == "INVALID_IMR_STATE_FOR_ACTION"


def test_exempt_types_run_while_stopped(sink, ex):
    ex.register("pauseImr", lambda a, c: c.succeeded())
    run(ex, sink, req([pause()]), Entity(["STOP_CATEGORY_0"]))
    assert sink.statuses[-1]["status"] == "SUCCEEDED"


def test_runs_blocking_serially_and_consecutive_non_blocking_concurrently(sink, ex):
    order, gate = [], threading.Event()
    lock = threading.Lock()

    def add(x):
        with lock:
            order.append(x)

    def mv(a, c):
        add("move-start"); gate.wait(5); add("move-end")
        return c.succeeded()

    def ps(a, c):
        add("pause")
        return c.succeeded()

    ex.register("move", mv)
    ex.register("pauseImr", ps)
    i, th = start_run(ex, sink, req([move(), pause(blocking=False), move(blocking=False)]))
    wait_for(lambda: order == ["move-start"])
    time.sleep(0.05)
    assert order == ["move-start"]  # blocking detail holds the queue
    gate.set()
    th.join(5)
    assert order[:2] == ["move-start", "move-end"]
    assert sorted(order[2:]) == ["move-end", "move-start", "pause"]
    assert i.state == "SUCCEEDED"


def test_cancel_request_fires_target_event_and_ends_canceled(sink, ex):
    ex.register("move", lambda a, c: (c.cancelled.wait(5), c.aborted("REJECTED", "canceled"))[1])
    i, th = start_run(ex, sink, req([move()]))
    wait_for(lambda: len(sink.statuses) >= 4)
    assert ex.cancel((SRC, 7))
    th.join(2)
    assert sink.statuses[-1]["status"] == "CANCELED"
    assert not ex.cancel((SRC, 7))  # run deregistered


def test_does_not_abort_atomic_detail_mid_flight(sink, ex):
    started, release, seen = threading.Event(), threading.Event(), {}

    def h(a, c):
        started.set()
        release.wait(5)
        seen["set"] = c.cancelled.is_set()
        return c.succeeded()

    ex.register("move", h)
    i, th = start_run(ex, sink, req([move(atomic=True)]))
    started.wait(2)
    assert ex.cancel((SRC, 7))
    release.set()
    th.join(2)
    assert seen["set"] is False


def test_runs_recoveries_after_abort_and_still_ends_aborted(sink, ex):
    ran = []
    ex.register("move", lambda a, c: (ran.append("move"), c.aborted("GENERAL_FAILURE", "wheel slip"))[1])
    ex.register("pauseImr", lambda a, c: (ran.append("recovery"), c.succeeded())[1])
    run(ex, sink, req([move()], [pause()]))
    seq = [s["status"] for s in sink.statuses]
    assert ran == ["move", "recovery"] and "RECOVERY" in seq and seq[-1] == "ABORTED"
    assert sink.statuses[-1]["recoveryStatuses"][0]["status"]["code"] == "SUCCEEDED"


def test_resolves_cancel_request_during_recovery_and_ends_original_canceled(sink, ex):
    held, entered = threading.Event(), threading.Event()
    ex.register("move", lambda a, c: c.aborted("GENERAL_FAILURE", "wheel slip"))
    ex.register("pauseImr", lambda a, c: (entered.set(), held.wait(5), c.succeeded())[2])
    i, th = start_run(ex, sink, req([move()], [pause()]))
    assert entered.wait(2)
    csink = Sink()
    cancel = IncomingRequest(
        req([{"type": "cancelRequest", "version": "1.0",
              "properties": {"source": SRC, "requestId": 7}}], seq=8), "c1", csink)
    cancel.publish_received()
    resolve_cancel_request(cancel, [ex])
    assert cancel.state == "SUCCEEDED"
    held.set()
    th.join(2)
    assert sink.statuses[-1]["status"] == "CANCELED"


def test_cancel_request_unknown_is_rejected(sink, ex):
    cancel = IncomingRequest(
        req([{"type": "cancelRequest", "version": "1.0",
              "properties": {"source": SRC, "requestId": 99}}]), "c1", sink)
    cancel.publish_received()
    resolve_cancel_request(cancel, [ex])
    assert sink.statuses[-1]["detailStatuses"][0]["status"]["reason"] == "REJECTED"


def test_runs_every_recovery_detail_after_mid_request_cancel(sink, ex):
    ran = []
    ex.register("move", lambda a, c: (c.cancelled.wait(5), c.aborted("OK", "canceled by request"))[1])
    ex.register("pauseImr", lambda a, c: (ran.append("pause"), c.succeeded())[1])
    ex.register("resumeImr", lambda a, c: (ran.append("resume"), c.succeeded())[1])
    i, th = start_run(ex, sink, req([move()], [pause(), {"type": "resumeImr", "version": "1.0"}]))
    wait_for(lambda: len(sink.statuses) >= 4)
    ex.cancel((SRC, 7))
    th.join(3)
    last = sink.statuses[-1]
    assert ran == ["pause", "resume"] and last["status"] == "CANCELED"
    assert [r["status"]["code"] for r in last["recoveryStatuses"]] == ["SUCCEEDED", "SUCCEEDED"]


def test_handler_exception_aborts_general_failure(sink, ex):
    ex.register("move", lambda a, c: 1 / 0)
    run(ex, sink, req([move()]))
    last = sink.statuses[-1]
    assert last["status"] == "ABORTED" and last["detailStatuses"][0]["status"]["reason"] == "GENERAL_FAILURE"


def test_refuses_to_replace_handler_without_override(ex):
    ex.register("move", lambda a, c: c.succeeded())
    with pytest.raises(Iso21423Error, match="override"):
        ex.register("move", lambda a, c: c.succeeded())
    ex.register("move", lambda a, c: c.succeeded(), override=True)
    assert ex.has_handlers()


def test_cancel_just_after_main_abort_before_recovery_ends_canceled(sink, ex):
    ex.register("move", lambda a, c: c.aborted("GENERAL_FAILURE", "x"))
    ex.register("pauseImr", lambda a, c: c.succeeded())
    fired = []
    orig = sink.publish_status

    def hook(r, status):
        orig(r, status)
        if not fired and status["detailStatuses"][0]["status"]["code"] == "ABORTED":
            fired.append(ex.cancel((SRC, 7)))  # inside the window: after the cancelled check, before recovery

    sink.publish_status = hook
    run(ex, sink, req([move()], [pause()]))
    assert fired == [True]
    last = sink.statuses[-1]
    assert last["status"] == "CANCELED"
    assert last["recoveryStatuses"][0]["status"]["code"] == "SUCCEEDED"


def test_exception_in_concurrent_step_worker_propagates(sink, ex):
    ex.register("move", lambda a, c: c.succeeded())
    i = incoming(sink, req([move(blocking=False), move(blocking=False)]))
    boom = RuntimeError("publish failed")

    def bad(*a, **k):
        raise boom

    i.update_detail_status = bad
    i.accept(); i.update_status("EXECUTING")
    i.reject = i.accept = i.update_status = lambda *a, **k: None
    with pytest.raises(RuntimeError, match="publish failed"):
        ex.run(i, Entity())
