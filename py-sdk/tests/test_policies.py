"""Ports ts-sdk/test/corePolicies.test.ts 'C.2.2 presets (D-17)' plus the py-only preempt()."""
import math

from iso21423.policies import (DEFAULT_EXECUTION_POLICY, Accept, Buffer, Preempt, Reject, policies)

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"


def req(**over):
    return {"destination": B, "source": A, "sequenceId": 1, "timestamp": "2026-11-25T12:00:00.000Z",
            "details": [{"type": "move", "version": "1.0", "properties": {}}], **over}


def active(seq, priority=None):
    s = {"source": B, "destination": A, "sequenceId": seq, "requestSequenceId": seq,
         "timestamp": "2026-11-25T12:00:00.000Z", "status": "EXECUTING", "detailStatuses": []}
    if priority is not None:
        s["priority"] = priority
    return s


def test_abort_new_rejects_while_anything_is_active():
    p = policies.abort_new()
    assert p.admit(req(), []) == Accept()
    assert p.admit(req(), [active(1)]) == Reject("REJECTED")
    assert p.buffer_limit == math.inf and p.drain_by_priority is False


def test_queue_after_buffers_behind_any_active_request():
    p = policies.queue_after()
    assert p.admit(req(), []) == Accept()
    assert p.admit(req(), [active(1)]) == Buffer()
    assert p.buffer_limit == math.inf


def test_queue_replace_buffers_with_a_single_slot():
    p = policies.queue_replace()
    assert p.admit(req(), []) == Accept()
    assert p.admit(req(), [active(1)]) == Buffer()
    assert p.buffer_limit == 1


def test_parallel_max_accepts_up_to_max():
    p = policies.parallel(2)
    assert p.admit(req(), [active(1)]) == Accept()
    assert p.admit(req(), [active(1), active(2)]) == Buffer()
    assert policies.parallel().admit(req(), [active(1), active(2), active(3)]) == Accept()


def test_priority_preempts_strictly_lower_priority_work_and_buffers_otherwise():
    p = policies.priority()
    # the key names the ORIGINAL sender (A), not the serving robot (B)
    assert p.admit(req(priority=10), [active(1, 100)]) == Preempt([(A, 1)])
    assert p.admit(req(priority=100), [active(1, 10)]) == Buffer()
    assert p.admit(req(), []) == Accept()
    assert p.admit(req(), [active(1)]) == Buffer()  # omitted priority is mid-scale on both sides
    assert p.drain_by_priority is True


def test_preempt_preempts_every_admitted_request():
    p = policies.preempt()
    assert p.admit(req(), []) == Accept()
    assert p.admit(req(priority=255), [active(1, 0), active(2)]) == Preempt([(A, 1), (A, 2)])
    assert p.buffer_limit == 0


def test_default_policy_is_parallel_capable():
    assert DEFAULT_EXECUTION_POLICY.admit(req(), [active(1), active(2)]) == Accept()


def test_custom_policy_implementing_the_interface():
    class Custom:
        buffer_limit = math.inf
        drain_by_priority = False

        def admit(self, pending, active):
            if any(d["type"] == "move" for d in pending["details"]):
                return Accept()
            return Reject("ACTION_NOT_IMPLEMENTED")

    assert Custom().admit(req(), []) == Accept()
