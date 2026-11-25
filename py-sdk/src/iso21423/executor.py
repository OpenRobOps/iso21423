"""Per-action executor: runs registered handlers against admitted requests (ports ts-sdk core/executor.ts)."""
import threading
from dataclasses import dataclass
from typing import Any, Callable, Literal, Optional, Tuple

from .constants import BLOCKING_STATES, PROTOCOL_VERSION
from .errors import Iso21423Error
from .incoming import IncomingRequest

STATE_EXEMPT_TYPES = ("cancelRequest", "pauseImr", "resumeImr")

RequestKey = Tuple[str, int]  # (original sender uuid, sender's sequenceId)


@dataclass
class ActionResult:
    outcome: Literal["succeeded", "aborted"]
    reason: Optional[str] = None
    message: Optional[str] = None
    properties: Optional[dict] = None


class ActionContext:
    def __init__(self, action, request, entity, cancelled, update):
        self.action = action
        self.request = request
        self.entity = entity
        self.cancelled = cancelled
        self._update = update

    def progress(self, properties: dict) -> None:
        self._update("EXECUTING", properties=properties)

    def succeeded(self, properties=None) -> ActionResult:
        return ActionResult("succeeded", properties=properties)

    def aborted(self, reason: str, message=None) -> ActionResult:
        return ActionResult("aborted", reason=reason, message=message)


ActionHandler = Callable[[dict, ActionContext], ActionResult]


class _Run:
    def __init__(self):
        self.cancelled = threading.Event()
        self.cancel_requested = False


def _major(v: str) -> str:
    return v.split(".")[0]


def _group_steps(details) -> list:
    """Consecutive `blocking: false` details form one concurrent step; others are one step each."""
    steps, i = [], 0
    while i < len(details):
        if details[i].get("blocking") is False:
            group = []
            while i < len(details) and details[i].get("blocking") is False:
                group.append(i)
                i += 1
            steps.append(group)
        else:
            steps.append([i])
            i += 1
    return steps


class ActionExecutor:
    def __init__(self):
        self._handlers: dict = {}
        self._runs: dict = {}
        self._runs_lock = threading.Lock()  # guards only runs get/set/delete

    def register(self, type: str, handler: ActionHandler, override: bool = False) -> None:
        if type in self._handlers and not override:
            raise Iso21423Error(
                f'on_request: a handler for "{type}" is already registered - pass override=True to replace it')
        self._handlers[type] = handler

    def has_handlers(self) -> bool:
        return bool(self._handlers)

    def cancel(self, key: RequestKey) -> bool:
        with self._runs_lock:
            run = self._runs.get(tuple(key))
            if run is None:
                return False
            run.cancel_requested = True
            run.cancelled.set()
        return True

    def run(self, incoming: IncomingRequest, entity) -> None:
        try:
            self._run(incoming, entity)
        except BaseException:
            # whatever failed, the request must not stay non-terminal: it would wedge admission
            if not incoming.is_terminal:
                try:
                    incoming.complete("ABORTED", "GENERAL_FAILURE")
                except Exception:
                    pass  # best effort; the original error is what the caller reports
            raise

    def _run(self, incoming: IncomingRequest, entity) -> None:
        request = incoming.request
        reason = self._preflight(request, entity)
        if reason:
            incoming.reject(reason)
            return
        incoming.accept()
        incoming.update_status("EXECUTING")

        key = (request["source"], request["sequenceId"])
        run = _Run()
        with self._runs_lock:
            self._runs[key] = run
        try:
            outcome = self._sequence(request["details"], request, entity, run, True, False,
                                     incoming.update_detail_status)
            if outcome[0] == "success":
                incoming.complete("SUCCEEDED")
                return
            trigger, reason, message = outcome
            recoveries = request.get("recoveries")
            if recoveries:
                # recoveries are cleanup FOR the trigger: fresh cancel tracking, so only a new cancel stops them.
                # A cancel that landed after the main sequence's check still reclassifies the outcome.
                with self._runs_lock:
                    late = run.cancel_requested
                    run.cancelled = threading.Event()
                    run.cancel_requested = False
                if late:
                    trigger = "cancel"
                incoming.enter_recovery(recoveries, reason)
                rec = self._sequence(recoveries, request, entity, run, False, True,
                                     incoming.update_recovery_status)
                if rec[0] != "success":
                    if rec[0] == "cancel":
                        trigger = "cancel"
                    reason = rec[1] or reason
                    message = rec[2] or message
            incoming.complete("CANCELED" if trigger == "cancel" else "ABORTED", reason, message)
        finally:
            with self._runs_lock:
                self._runs.pop(key, None)

    def _sequence(self, items, request, entity, run, allow_skip_last, mark_remaining_canceled, update):
        steps = _group_steps(items)
        for s, group in enumerate(steps):
            results = [None] * len(group)
            errors = []

            def work(k, index):
                try:
                    results[k] = self._one(index, items[index], request, entity, run, update)
                except BaseException as e:  # re-raised on the run thread after join
                    errors.append(e)

            if len(group) == 1:
                work(0, group[0])
            else:
                threads = [threading.Thread(target=work, args=(k, idx)) for k, idx in enumerate(group)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()
            if errors:
                raise errors[0]
            batch_abort = any(r.outcome == "aborted" for r in results)
            cancelled_now = run.cancelled.is_set() or run.cancel_requested
            for index, r in zip(group, results):
                if r.outcome == "succeeded":
                    if not (allow_skip_last and index == len(items) - 1 and not batch_abort and not cancelled_now):
                        update(index, "SUCCEEDED", properties=r.properties)
                else:
                    update(index, "ABORTED", reason=r.reason, message=r.message)
            if batch_abort or cancelled_now:
                if mark_remaining_canceled:
                    for g in steps[s + 1:]:
                        for index in g:
                            update(index, "CANCELED")
                first = next((r for r in results if r.outcome == "aborted"), None)
                return ("cancel" if cancelled_now else "abort",
                        first and first.reason, first and first.message)
        return ("success",)

    def _one(self, index, detail, request, entity, run, update) -> ActionResult:
        atomic = detail.get("atomic", False) or request.get("atomic", False)
        cancelled = threading.Event() if atomic else run.cancelled  # private, never set
        update(index, "EXECUTING")
        action = {**detail, "properties": detail.get("properties") or {}}
        ctx = ActionContext(action, request, entity, cancelled,
                            lambda status, properties=None: update(index, status, properties=properties))
        handler = self._handlers.get(detail["type"])
        try:
            if handler is None:
                return ActionResult("aborted", reason="ACTION_NOT_IMPLEMENTED")
            result = handler(action, ctx)
            if not isinstance(result, ActionResult):
                return ActionResult("aborted", reason="GENERAL_FAILURE",
                                    message=f"handler returned {type(result).__name__}, not ActionResult")
            return result
        except Exception as e:  # handler errors map to GENERAL_FAILURE
            return ActionResult("aborted", reason="GENERAL_FAILURE", message=str(e))

    def _preflight(self, request, entity) -> Optional[str]:
        details = request["details"]
        if any(d.get("format") not in (None, "ISO-21423") for d in details):
            return "FORMAT_NOT_SUPPORTED"
        if any(_major(d["version"]) != _major(PROTOCOL_VERSION) for d in details):
            return "VERSION_NOT_SUPPORTED"
        if any(d["type"] != "cancelRequest" and d["type"] not in self._handlers for d in details):
            return "ACTION_NOT_IMPLEMENTED"
        states = entity.last_states()
        if any(s in states for s in BLOCKING_STATES) and \
                any(d["type"] not in STATE_EXEMPT_TYPES for d in details):
            return "INVALID_IMR_STATE_FOR_ACTION"
        return None


def resolve_cancel_request(cancel_req: IncomingRequest, executors) -> None:
    """cancelRequest is resolved by the executors' run maps, never dispatched to a handler."""
    details = cancel_req.request["details"]
    props = (details[0].get("properties") if details else None) or {}
    src, rid = props.get("source"), props.get("requestId")
    found = src is not None and rid is not None and any(ex.cancel((src, rid)) for ex in executors)
    if found:
        # SUCCEEDED is only reachable from EXECUTING
        cancel_req.accept()
        cancel_req.update_status("EXECUTING")
        cancel_req.complete("SUCCEEDED")
    else:
        cancel_req.reject("REJECTED")
