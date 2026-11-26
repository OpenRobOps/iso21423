"""Monotonic sequenceId source per entity, persisted across restarts (ND-09)."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Protocol

log = logging.getLogger(__name__)

BLOCK = 1000


class SequenceStore(Protocol):
    def load(self, uuid: str) -> int | None: ...

    def save(self, uuid: str, value: int) -> None: ...


def default_state_dir() -> str:
    return os.environ.get("ISO21423_STATE_DIR") or os.path.join(os.path.expanduser("~"), ".iso21423")


class FileSequenceStore:
    """One JSON map per state directory, written atomically.

    ponytail: in-process lock only; use a per-file lock if multiple processes share the state dir.
    """

    def __init__(self, dir: str | None = None) -> None:
        self._dir = dir or default_state_dir()
        self._file = os.path.join(self._dir, "sequence.json")
        self._lock = threading.Lock()

    def _read(self) -> dict[str, int]:
        try:
            with open(self._file, encoding="utf8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            # ponytail: corrupt/unreadable file resets seeds; SequenceCounter.open() re-reserves
            # above ids still retained on the broker, so this is safe.
            return {}

    def load(self, uuid: str) -> int | None:
        return self._read().get(uuid)

    def save(self, uuid: str, value: int) -> None:
        with self._lock:
            data = self._read()
            data[uuid] = value
            os.makedirs(self._dir, exist_ok=True)
            tmp = f"{self._file}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf8") as fh:
                json.dump(data, fh)
            os.replace(tmp, self._file)


class SequenceCounter:
    """Hands out sequenceIds; reserves BLOCK ids per persisted write, so a crash wastes ids but never reuses them."""

    def __init__(self, uuid: str, store: SequenceStore | None, counter: int, reserved_through: float) -> None:
        self._uuid = uuid
        self._store = store
        self._counter = counter
        self._reserved_through = reserved_through
        self._lock = threading.Lock()

    @classmethod
    def open(cls, uuid: str, store: SequenceStore | None = None) -> SequenceCounter:
        if store is None:
            return cls(uuid, None, 0, float("inf"))
        try:
            seed = store.load(uuid) or 0
            store.save(uuid, seed + BLOCK)
            return cls(uuid, store, seed, seed + BLOCK)
        except Exception as err:  # persistence unavailable: fall back to epoch ms
            log.warning("sequence store unavailable, seeding from epoch ms: %s", err)
            return cls(uuid, None, int(time.time() * 1000), float("inf"))

    def next(self) -> int:
        with self._lock:
            self._counter += 1
            if self._store is not None and self._counter > self._reserved_through:
                self._reserved_through = self._counter + BLOCK
                self._store.save(self._uuid, self._reserved_through)
            return self._counter
