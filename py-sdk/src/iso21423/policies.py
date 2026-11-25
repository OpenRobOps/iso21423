"""Admission policies (ports ts-sdk core/policies.ts, D-17), plus the py-only preempt()."""
import math
from dataclasses import dataclass, field
from typing import Callable, List, Protocol, Union

from .constants import DEFAULT_PRIORITY
from .executor import RequestKey


@dataclass(frozen=True)
class Accept:
    pass


@dataclass(frozen=True)
class Reject:
    reason: str


@dataclass(frozen=True)
class Buffer:
    pass


@dataclass(frozen=True)
class Preempt:
    keys: List[RequestKey]


Decision = Union[Accept, Reject, Buffer, Preempt]


class ExecutionPolicy(Protocol):
    """`active` is the admission view: admitted, non-terminal requestStatus dicts, each with the
    request's `priority` added when it had one. `buffer_limit` / `drain_by_priority` are optional
    (the server defaults them to inf / False)."""
    buffer_limit: float
    drain_by_priority: bool

    def admit(self, pending: dict, active: list) -> Decision: ...


@dataclass(frozen=True)
class _Preset:
    _admit: Callable[[dict, list], Decision] = field(repr=False)
    buffer_limit: float = math.inf
    drain_by_priority: bool = False

    def admit(self, pending: dict, active: list) -> Decision:
        return self._admit(pending, active)


def _priority(r: dict) -> int:
    return r.get("priority", DEFAULT_PRIORITY)


def _key(s: dict) -> RequestKey:
    # a status's `destination` is the original sender; `source` is this serving entity
    return (s["destination"], s["requestSequenceId"])


def _accept_or(other: Decision):
    return lambda pending, active: Accept() if not active else other


def _priority_admit(pending, active):
    if not active:
        return Accept()
    if all(_priority(pending) < _priority(s) for s in active):
        return Preempt([_key(s) for s in active])
    return Buffer()


class policies:
    """Named C.2.2 execution policy presets."""

    @staticmethod
    def abort_new() -> ExecutionPolicy:
        """One active request; anything new while busy is rejected (no buffering)."""
        return _Preset(_accept_or(Reject("REJECTED")))

    @staticmethod
    def queue_replace() -> ExecutionPolicy:
        """One active plus one queued slot; a newer arrival displaces the queued one (REJECTED)."""
        return _Preset(_accept_or(Buffer()), buffer_limit=1)

    @staticmethod
    def queue_after() -> ExecutionPolicy:
        """One active request; unlimited FIFO queue behind it."""
        return _Preset(_accept_or(Buffer()))

    @staticmethod
    def parallel(max: float = math.inf) -> ExecutionPolicy:
        """Up to `max` concurrent requests; beyond that, buffer FIFO."""
        return _Preset(lambda pending, active: Accept() if len(active) < max else Buffer())

    @staticmethod
    def priority() -> ExecutionPolicy:
        """Strictly higher priority (lower number) than every active request preempts them all;
        otherwise buffer, draining by priority."""
        return _Preset(_priority_admit, drain_by_priority=True)

    @staticmethod
    def preempt() -> ExecutionPolicy:
        """A new request cancels every admitted request, then runs (C.2.2 strategy 2)."""
        return _Preset(lambda pending, active: Preempt([_key(s) for s in active]) if active else Accept(),
                       buffer_limit=0)


DEFAULT_EXECUTION_POLICY: ExecutionPolicy = policies.parallel()
