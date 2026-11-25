import math
import threading
import time
from typing import Callable

from .errors import Iso21423Error


class RateGate:
    """Latest-wins limiter: emit now if the interval elapsed, else keep only the newest value
    and emit it when the interval expires."""

    def __init__(self, max_hz: float):
        if not (max_hz > 0) or not math.isfinite(max_hz):
            raise Iso21423Error(f"RateGate requires a finite max_hz > 0, got {max_hz}")
        self._interval = 1.0 / max_hz
        self._last = -math.inf
        self._pending: tuple | None = None
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    def offer(self, value, emit: Callable) -> None:
        with self._lock:
            now = time.monotonic()
            if now - self._last >= self._interval:
                self._last = now
                self._pending = None  # superseded; a still-armed timer must not emit it right behind this value
            else:
                self._pending = (value, emit)
                if self._timer is None:
                    self._timer = threading.Timer(self._interval - (now - self._last), self._flush)
                    self._timer.daemon = True
                    self._timer.start()
                return
        emit(value)

    def _flush(self) -> None:
        with self._lock:
            self._timer = None
            p = self._pending
            if p is None:
                return
            now = time.monotonic()
            wait = self._interval - (now - self._last)
            if wait > 0:  # an immediate emit moved the window since this timer was armed
                self._timer = threading.Timer(wait, self._flush)
                self._timer.daemon = True
                self._timer.start()
                return
            self._pending, self._last = None, now
        if p:
            p[1](p[0])

    def dispose(self) -> None:
        """Cancel any pending trailing emit; the pending value is dropped."""
        with self._lock:
            if self._timer:
                self._timer.cancel()
            self._timer, self._pending = None, None
