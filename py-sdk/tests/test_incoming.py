import pytest

from iso21423.errors import IllegalTransition
from iso21423.incoming import IncomingRequest

OWNER = "91403a21-7534-4467-99a6-79c46a130fe8"
SRC = "42177726-26f7-4f5c-b735-a12a427bb96d"
REQ_2_DETAILS = {
    "source": SRC, "destination": OWNER, "sequenceId": 7, "timestamp": "2026-11-25T12:00:00.000Z",
    "details": [{"type": "move", "version": "1.0", "blocking": "STOP_CATEGORY_1"},
                {"type": "dock", "version": "1.0"}],
}


class Sink:
    owner_uuid = OWNER

    def __init__(self):
        self.seq = 0
        self.statuses = []

    def next_status_sequence_id(self):
        self.seq += 1
        return self.seq

    def publish_status(self, req, status):
        self.statuses.append(status)


@pytest.fixture
def sink():
    return Sink()


def make(sink):
    r = IncomingRequest(REQ_2_DETAILS, "r1", sink)
    r.publish_received()
    return r


def codes(s):
    return [d["status"]["code"] for d in s["detailStatuses"]]


def test_received_payload(sink):
    make(sink)
    s = sink.statuses[0]
    assert s["status"] == "RECEIVED" and s["sequenceId"] == 1
    assert s["detailStatuses"][0] == {"type": "move", "version": "1.0", "blocking": "STOP_CATEGORY_1",
                                      "status": {"code": "RECEIVED"}}
    assert "blocking" not in s["detailStatuses"][1] and "recoveryStatuses" not in s


def test_complete_cascades_details(sink):
    r = make(sink)
    r.accept(); r.update_status("EXECUTING"); r.complete("SUCCEEDED")
    last = sink.statuses[-1]
    assert last["status"] == "SUCCEEDED" and codes(last) == ["SUCCEEDED"] * 2
    assert last["source"] == OWNER and last["destination"] == SRC and last["requestSequenceId"] == 7
    assert r.is_terminal and r.state == "SUCCEEDED"


def test_reject_puts_reason_on_first_detail(sink):
    r = make(sink)
    r.reject("MALFORMED_REQUEST")
    last = sink.statuses[-1]
    assert last["status"] == "ABORTED" and codes(last) == ["ABORTED"] * 2
    assert last["detailStatuses"][0]["status"]["reason"] == "MALFORMED_REQUEST"
    assert "reason" not in last["detailStatuses"][1]["status"]


def test_message_on_first_detail(sink):
    r = make(sink)
    r.accept(); r.complete("CANCELED", reason="X", message="m")
    assert sink.statuses[-1]["detailStatuses"][0]["status"] == {"code": "CANCELED", "reason": "X", "message": "m"}


def test_illegal_complete_publishes_nothing(sink):
    r = make(sink)
    with pytest.raises(IllegalTransition):
        r.complete("SUCCEEDED")
    assert len(sink.statuses) == 1 and r.state == "RECEIVED"


def test_detail_update_after_cascade_is_noop_state_wise(sink):
    r = make(sink)
    r.accept(); r.update_status("EXECUTING")
    r.update_detail_status(0, "EXECUTING", properties={"pct": 50})
    r.update_detail_status(0, "EXECUTING", properties={"x": 1})
    d = sink.statuses[-1]["detailStatuses"][0]
    assert d["properties"] == {"pct": 50, "x": 1} and d["status"]["code"] == "EXECUTING"
    assert [s["status"] for s in sink.statuses] == ["RECEIVED", "ACCEPTED", "EXECUTING", "EXECUTING", "EXECUTING"]


def test_detail_bad_index_and_illegal(sink):
    r = make(sink)
    with pytest.raises(IllegalTransition):
        r.update_detail_status(5, "ACCEPTED")
    with pytest.raises(IllegalTransition):
        r.update_detail_status(0, "SUCCEEDED")


def test_published_snapshot_is_not_mutated_later(sink):
    r = make(sink)
    r.accept()
    assert codes(sink.statuses[0]) == ["RECEIVED"] * 2


def test_recovery_flow(sink):
    r = make(sink)
    r.accept(); r.update_status("EXECUTING")
    r.enter_recovery([{"type": "undock", "version": "1.0"}], reason="R")
    s = sink.statuses[-1]
    assert s["status"] == "RECOVERY" and s["recoveryStatuses"][0]["status"] == {"code": "RECEIVED"}
    assert s["detailStatuses"][0]["status"]["reason"] == "R"
    assert codes(s) == ["EXECUTING"] * 2  # RECOVERY has no detail-level equivalent
    r.update_recovery_status(0, "EXECUTING")
    r.update_recovery_status(0, "SUCCEEDED")
    assert sink.statuses[-1]["recoveryStatuses"][0]["status"]["code"] == "SUCCEEDED"
    r.complete("ABORTED")
    assert codes(sink.statuses[-1]) == ["ABORTED"] * 2
    with pytest.raises(IllegalTransition):
        r.update_recovery_status(3, "EXECUTING")


def test_no_recovery_index_raises(sink):
    with pytest.raises(IllegalTransition):
        make(sink).update_recovery_status(0, "EXECUTING")


def test_enter_recovery_illegal_leaves_no_recovery_state(sink):
    r = make(sink)  # RECEIVED -> RECOVERY is illegal
    with pytest.raises(IllegalTransition):
        r.enter_recovery([{"type": "undock", "version": "1.0"}])
    assert r.state == "RECEIVED" and len(sink.statuses) == 1
    assert all("recoveryStatuses" not in s for s in sink.statuses)
    r.accept()
    assert "recoveryStatuses" not in sink.statuses[-1]


def test_publish_status_may_read_request_state():
    seen = []

    class ReadingSink(Sink):
        def publish_status(self, req, status):
            seen.append(req.state)  # reentrant access must not deadlock
            super().publish_status(req, status)

    r = IncomingRequest(REQ_2_DETAILS, "r1", ReadingSink())
    r.publish_received(); r.accept()
    assert seen == ["RECEIVED", "ACCEPTED"]


def test_concurrent_progress_vs_complete_in_order():
    import threading

    class LockedSink(Sink):
        def __init__(self):
            super().__init__()
            self.lock = threading.RLock()

        def next_status_sequence_id(self):
            with self.lock:
                return super().next_status_sequence_id()

        def publish_status(self, req, status):
            with self.lock:
                super().publish_status(req, status)

    sink = LockedSink()
    r = make(sink)
    r.accept(); r.update_status("EXECUTING")

    def progress():
        for i in range(50):
            try:
                r.update_detail_status(0, "EXECUTING", properties={"i": i})
            except IllegalTransition:
                return  # complete() won the race; detail already terminal

    def finish():
        r.complete("SUCCEEDED")

    ts = [threading.Thread(target=progress), threading.Thread(target=finish)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout=5)
    assert not any(t.is_alive() for t in ts)  # no deadlock
    ids = [s["sequenceId"] for s in sink.statuses]
    assert ids == sorted(ids) and len(set(ids)) == len(ids)
    assert r.is_terminal and r.state == "SUCCEEDED"


def test_bad_properties_raise_without_changing_state(sink):
    r = make(sink)
    r.accept()
    r.update_detail_status(0, "EXECUTING")
    n = len(sink.statuses)
    for bad in ({"t": object()}, ["not", "a", "dict"]):
        with pytest.raises((TypeError, ValueError)):
            r.update_detail_status(0, "SUCCEEDED", properties=bad)
    assert len(sink.statuses) == n
    r.update_detail_status(0, "SUCCEEDED", properties={"ok": 1})
    assert codes(sink.statuses[-1])[0] == "SUCCEEDED" and sink.statuses[-1]["detailStatuses"][0]["properties"] == {"ok": 1}


def test_properties_are_copied(sink):
    r = make(sink)
    r.accept()
    props = {"nested": {"v": 1}}
    r.update_detail_status(0, "EXECUTING", properties=props)
    props["nested"]["v"] = 2
    r.complete("ABORTED")
    assert sink.statuses[-1]["detailStatuses"][0]["properties"] == {"nested": {"v": 1}}


def test_failed_emit_rolls_back_state(sink):
    r = make(sink)
    r.accept()
    publish = sink.publish_status

    def failing(req, status):
        raise RuntimeError("wire down")
    sink.publish_status = failing
    with pytest.raises(RuntimeError):
        r.update_detail_status(0, "ABORTED", reason=123)
    with pytest.raises(RuntimeError):
        r.complete("ABORTED")
    assert r.state == "ACCEPTED"
    sink.publish_status = publish
    r.complete("ABORTED", "GENERAL_FAILURE")
    assert sink.statuses[-1]["status"] == "ABORTED"
    assert sink.statuses[-1]["detailStatuses"][0]["status"] == {"code": "ABORTED", "reason": "GENERAL_FAILURE"}
