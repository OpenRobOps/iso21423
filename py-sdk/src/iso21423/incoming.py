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

import copy
import json
import threading
from contextlib import contextmanager
from typing import Protocol

from iso21423.errors import IllegalTransition
from iso21423.state_machine import DetailLifecycle, RequestLifecycle
from iso21423.timestamps import now_timestamp


class StatusSink(Protocol):
    owner_uuid: str

    def publish_status(self, req: "IncomingRequest", status: dict) -> None: ...

    def next_status_sequence_id(self) -> int: ...


def _json_copy(properties):
    """Deep, JSON-only copy of handler properties; raises (TypeError/ValueError) before any state changes."""
    if properties is None:
        return None
    if not isinstance(properties, dict):
        raise TypeError(f"properties must be a dict, got {type(properties).__name__}")
    return json.loads(json.dumps(properties, allow_nan=False))


def _seed(details: list) -> list:
    out = []
    for d in details:
        e = {"type": d["type"], "version": d["version"]}
        if d.get("blocking") is not None:
            e["blocking"] = d["blocking"]
        e["status"] = {"code": "RECEIVED"}
        out.append(e)
    return out


class IncomingRequest:
    """Server-side lifecycle for one received request; publishes a requestStatus on every change.

    A request-level transition cascades onto in-flight details that legally admit it.

    Lock order: request lock, then sink lock. The sink (server) must never call request
    mutators while holding its own lock. The request lock is reentrant, so publish_status
    may call back into this request (e.g. read `state`).

    Every mutation is atomic with its emit: if the status cannot be built, validated or published,
    the request rolls back to its last emitted state, so bad data never sticks and a later
    transition (e.g. the executor's GENERAL_FAILURE abort) can still be published."""

    def __init__(self, request: dict, request_uuid: str, sink: StatusSink):
        self.request = request
        self.request_uuid = request_uuid
        self._sink = sink
        self._lock = threading.RLock()  # serializes transition + emit
        self._lifecycle = RequestLifecycle()
        self._details = [DetailLifecycle() for _ in request["details"]]
        self._detail_statuses = _seed(request["details"])
        self._recoveries = None
        self._recovery_statuses = None

    @property
    def state(self) -> str:
        return self._lifecycle.state

    @property
    def is_terminal(self) -> bool:
        return self._lifecycle.is_terminal()

    @contextmanager
    def _atomic(self):
        with self._lock:
            saved = copy.deepcopy((self._lifecycle, self._details, self._detail_statuses,
                                   self._recoveries, self._recovery_statuses))
            try:
                yield
            except BaseException:
                (self._lifecycle, self._details, self._detail_statuses,
                 self._recoveries, self._recovery_statuses) = saved
                raise

    def publish_received(self) -> None:
        with self._lock:
            self._emit()

    def accept(self) -> None:
        self._transition_to("ACCEPTED")

    def reject(self, reason: str) -> None:
        self._transition_to("ABORTED", reason)

    def update_status(self, status: str, reason=None, message=None) -> None:
        self._transition_to(status, reason, message)

    def complete(self, status: str, reason=None, message=None) -> None:
        self._transition_to(status, reason, message)

    def update_detail_status(self, index, status, reason=None, message=None, properties=None) -> None:
        properties = _json_copy(properties)
        with self._atomic():
            lc, entry = self._at(self._details, self._detail_statuses, index, "request")
            # a cascade may already have advanced this detail: agreeing call is a no-op
            if lc.state != status:
                lc.transition(status)
            self._set_detail(entry, status, reason, message, properties)
            self._emit()

    def enter_recovery(self, recoveries: list, reason=None) -> None:
        with self._atomic():
            self._lifecycle.transition("RECOVERY")  # validate before seeding recovery state
            self._recoveries = [DetailLifecycle() for _ in recoveries]
            self._recovery_statuses = _seed(recoveries)
            self._transition_locked("RECOVERY", reason, _checked=True)

    def update_recovery_status(self, index, status, reason=None, message=None, properties=None) -> None:
        properties = _json_copy(properties)
        with self._atomic():
            lc, entry = self._at(self._recoveries, self._recovery_statuses, index, "recovery")
            # recovery lifecycles are never cascaded: first EXECUTING must step through ACCEPTED
            if status == "EXECUTING" and lc.state == "RECEIVED":
                lc.transition("ACCEPTED")
            if lc.state != status:
                lc.transition(status)
            self._set_detail(entry, status, reason, message, properties)
            self._emit()

    @staticmethod
    def _at(lifecycles, entries, index, kind):
        if lifecycles is None or not 0 <= index < len(lifecycles):
            raise IllegalTransition(f"no {kind} detail at index {index}")
        return lifecycles[index], entries[index]

    @staticmethod
    def _set_detail(entry, status, reason, message, properties) -> None:
        entry["status"] = {"code": status}
        if reason:
            entry["status"]["reason"] = reason
        if message:
            entry["status"]["message"] = message
        if properties:
            entry["properties"] = {**entry.get("properties", {}), **properties}

    def _transition_to(self, to, reason=None, message=None) -> None:
        with self._atomic():
            self._transition_locked(to, reason, message)

    def _transition_locked(self, to, reason=None, message=None, _checked=False) -> None:
        if not _checked:
            self._lifecycle.transition(to)  # raises IllegalTransition
        for lc, entry in zip(self._details, self._detail_statuses):
            if lc.is_terminal() or lc.state == to or not lc.can_transition(to):
                continue
            lc.transition(to)
            entry["status"] = {**entry["status"], "code": to}
        self._emit(reason, message)

    def _emit(self, reason=None, message=None) -> None:
        status = {
            "source": self._sink.owner_uuid,
            "destination": self.request["source"],
            "sequenceId": self._sink.next_status_sequence_id(),
            "requestSequenceId": self.request["sequenceId"],
            "timestamp": now_timestamp(),
            "status": self._lifecycle.state,
            "detailStatuses": [{**d, "status": dict(d["status"])} for d in self._detail_statuses],
        }
        if self._recovery_statuses is not None:
            status["recoveryStatuses"] = [{**d, "status": dict(d["status"])} for d in self._recovery_statuses]
        if (reason or message) and status["detailStatuses"]:
            first = status["detailStatuses"][0]["status"]
            if reason:
                first["reason"] = reason
            if message:
                first["message"] = message
        self._sink.publish_status(self, status)
