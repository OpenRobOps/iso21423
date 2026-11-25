"""Inbound request server for one entity (ports ts-sdk core/requestServer.ts, self-entity path).

Owns the `request/+` subscription, D-12/D-13 handling, duplicate suppression, admission
(execution policies), the cancelRequest and pause/resume bypasses, and `activeRequestsStatus`.

Lock order: IncomingRequest lock, then this server's lock. `publish_status` runs under both, so
nothing here calls an IncomingRequest mutator, `executor.run` or `resolve_cancel_request` while
holding the server lock: decisions are taken under the lock and applied after releasing it."""
import json
import logging
import math
import threading
from dataclasses import dataclass
from functools import partial

from .constants import CONTROL_TYPES, DEFAULT_PRIORITY
from .errors import IllegalTransition
from .executor import resolve_cancel_request
from .incoming import IncomingRequest
from .policies import Buffer, Preempt, Reject
from .schema.validators import validate_message
from .state_machine import is_terminal_request_state
from .timestamps import now_timestamp
from .topics import RESOURCE_CONFIG, request_status_topic, request_topic, topic_for

_log = logging.getLogger(__name__)


@dataclass
class _Active:
    req: IncomingRequest
    status: dict
    # admitted = handed to the executor by a policy decision; only these form the admission view.
    # Buffered and control requests stay False but are still listed in activeRequestsStatus.
    admitted: bool = False


class RequestServer:
    def __init__(self, session, entity, executor, sequence_counter, get_policy):
        self._session = session
        self._entity = entity
        self._executor = executor
        self._seq = sequence_counter
        self._get_policy = get_policy
        self.owner_uuid = session.entity_uuid
        self._lock = threading.RLock()
        # ponytail: in-memory only; a restart re-executes requests still retained on the broker
        self._seen: set = set()
        self._active: dict[str, _Active] = {}
        self._pending: list[IncomingRequest] = []
        self._subscribed = False
        self._stopped = False

    def start(self) -> None:
        self._stopped = False
        if not self._subscribed:
            s = self._session
            s.subscribe(topic_for(s.entity_type, s.entity_uuid, "request") + "/+", self._on_message, 2)
            self._subscribed = True

    def stop(self) -> None:
        # ponytail: Session has no unsubscribe; inbound is dropped instead. Add one if stop/start churns.
        self._stopped = True

    @property
    def serving_count(self) -> int:
        with self._lock:
            return sum(1 for e in self._active.values() if e.admitted)

    # --- StatusSink ---

    def next_status_sequence_id(self) -> int:
        return self._seq.next()  # D-15: same counter as outbound requests

    def publish_status(self, req: IncomingRequest, status: dict) -> None:
        s = self._session
        cfg = RESOURCE_CONFIG["requestStatus"]
        with self._lock:
            s.publish_topic(request_status_topic(s.entity_type, s.entity_uuid, req.request_uuid),
                            "requestStatus", status, cfg.qos, cfg.retain)
            terminal = is_terminal_request_state(status["status"])
            if terminal:
                self._active.pop(req.request_uuid, None)
            elif req.request_uuid in self._active:
                self._active[req.request_uuid].status = status
            else:
                self._active[req.request_uuid] = _Active(req, status)
            s.publish_resource("activeRequestsStatus", "requestStatusArray",
                               [e.status for e in self._active.values()])
            if terminal:
                s.clear_retained(request_topic(s.entity_type, s.entity_uuid, req.request_uuid))
                if self._pending:
                    threading.Thread(target=self._drain, daemon=True).start()

    # --- inbound ---

    def _on_message(self, text: str, parsed) -> None:
        if self._stopped or text == "" or parsed.request_uuid is None:
            return
        uuid = parsed.request_uuid
        s = self._session
        topic = request_topic(s.entity_type, s.entity_uuid, uuid)
        try:
            raw = json.loads(text)
        except ValueError:
            self._reject_or_warn(topic, text, None, ["invalid JSON"], uuid)
            return
        result = validate_message("request", raw)
        if not result.ok:
            self._reject_or_warn(topic, text, result.value, result.errors, uuid)
            return
        request = result.value
        key = (request["source"], request["sequenceId"])
        with self._lock:
            duplicate = key in self._seen
            self._seen.add(key)
        if duplicate:
            _log.debug("duplicate request %s ignored", key)
            s.clear_retained(topic)  # this retained request will never terminate on its own
            return

        inc = IncomingRequest(request, uuid, self)
        inc.publish_received()  # D-12: before any admission or handler
        details = request["details"]
        if details[0]["type"] == "cancel":  # D-02 legacy name
            details[0]["type"] = "cancelRequest"
        if details[0]["type"] == "cancelRequest":
            resolve_cancel_request(inc, [self._executor])  # bypasses admission; never admitted
        elif all(d["type"] in CONTROL_TYPES for d in details):
            self._spawn(inc)  # pause/resume bypass admission; never admitted
        else:
            with self._lock:
                policy = self._get_policy()
                ops = self._decide_locked(inc, policy.admit(request, self._view()), policy)
            for op in ops:
                op()

    def _reject_or_warn(self, topic, raw, parsed, errors, uuid) -> None:
        """MALFORMED_REQUEST when (source, sequenceId) can still be read; else a validation warning."""
        obj = parsed if isinstance(parsed, dict) else {}
        source, seq = obj.get("source"), obj.get("sequenceId")
        if not isinstance(source, str) or not isinstance(seq, int) or isinstance(seq, bool):
            self._session.report_validation_warning(topic, raw, errors)
            self._session.clear_retained(topic)  # an unroutable retained request never terminates
            return
        details = obj.get("details")
        first = details[0] if isinstance(details, list) and details else None
        dtype = first["type"] if isinstance(first, dict) and isinstance(first.get("type"), str) else "unknown"
        minimal = {"destination": self.owner_uuid, "source": source, "sequenceId": seq,
                   "timestamp": now_timestamp(), "details": [{"type": dtype, "version": "1.0"}]}
        IncomingRequest(minimal, uuid, self).reject("MALFORMED_REQUEST")

    # --- admission (bookkeeping under the lock, mutators after) ---

    def _view(self) -> list:
        out = []
        for e in self._active.values():
            if e.admitted:
                p = e.req.request.get("priority")
                out.append(e.status if p is None else {**e.status, "priority": p})
        return out

    def _decide_locked(self, inc, decision, policy) -> list:
        """Record `decision` for `inc`; returns the calls to make once the lock is released."""
        if isinstance(decision, Reject):
            return [partial(inc.reject, decision.reason)]
        if isinstance(decision, Buffer):
            self._pending.append(inc)
            limit = getattr(policy, "buffer_limit", math.inf)
            displaced = []
            while len(self._pending) > limit:
                displaced.append(partial(self._pending.pop(0).reject, "REJECTED"))
            return displaced
        ops = []
        if isinstance(decision, Preempt):
            keys = {tuple(k) for k in decision.keys}
            for e in self._active.values():
                k = (e.status["destination"], e.status["requestSequenceId"])
                # executor.cancel is a leaf lock; a run it owns ends itself CANCELED
                if e.admitted and k in keys and not self._executor.cancel(k):
                    ops.append(partial(self._end_preempted, e.req))
        entry = self._active.get(inc.request_uuid)
        if entry is not None:
            entry.admitted = True
        ops.append(partial(self._spawn, inc))
        return ops

    def _drain(self) -> None:
        """Re-admit buffered requests one at a time until the policy buffers again."""
        while True:
            with self._lock:
                if not self._pending:
                    return
                policy = self._get_policy()
                i = 0
                if getattr(policy, "drain_by_priority", False):  # lowest number first, FIFO ties
                    i = min(range(len(self._pending)),
                            key=lambda j: self._pending[j].request.get("priority", DEFAULT_PRIORITY))
                inc = self._pending[i]
                decision = policy.admit(inc.request, self._view())
                if isinstance(decision, Buffer):
                    return
                del self._pending[i]
                ops = self._decide_locked(inc, decision, policy)
            for op in ops:
                op()

    @staticmethod
    def _end_preempted(inc) -> None:
        # admitted but not (yet) registered with the executor: end it here; its run thread then
        # fails its own first transition and stops
        try:
            inc.complete("CANCELED", "PREEMPTED")
        except IllegalTransition:
            pass  # already settled

    def _spawn(self, inc) -> None:
        threading.Thread(target=self._run, args=(inc,), daemon=True).start()

    def _run(self, inc) -> None:
        try:
            self._executor.run(inc, self._entity)
        except IllegalTransition as e:  # settled elsewhere first (e.g. preempted before it started)
            _log.debug("request %s: %s", inc.request_uuid, e)
        except Exception:
            _log.exception("request %s: executor failed", inc.request_uuid)
