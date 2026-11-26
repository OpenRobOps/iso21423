import time

import pytest

from iso21423.errors import Iso21423Error
from iso21423.rate_gate import RateGate


def test_rate_gate_latest_wins():
    out = []
    g = RateGate(10)  # 100 ms
    g.offer(1, out.append); g.offer(2, out.append); g.offer(3, out.append)
    assert out == [1]
    time.sleep(0.15)
    assert out == [1, 3]


def test_dispose_drops_pending():
    out = []
    g = RateGate(10)
    g.offer(1, out.append); g.offer(2, out.append)
    g.dispose()
    time.sleep(0.15)
    assert out == [1]


def test_rejects_bad_rate():
    with pytest.raises(Iso21423Error):
        RateGate(0)


def test_immediate_emit_supersedes_pending_and_keeps_spacing():
    """Regression: an offer arriving just after the interval but before the armed timer fired emitted
    immediately and the timer then emitted the stale pending value right behind it (>max_hz bursts)."""
    out = []
    g = RateGate(10)
    g.offer(1, out.append); g.offer(2, out.append)  # 2 pending, timer armed
    time.sleep(0.06)
    g._last -= 0.1  # the interval has elapsed but the timer (due at 100 ms) has not fired yet
    g.offer(3, out.append)
    assert out == [1, 3]
    g.offer(4, out.append)  # within 100 ms of 3: must not ride the old timer
    time.sleep(0.07)  # old timer's due time has passed
    assert out == [1, 3]
    time.sleep(0.15)
    assert out == [1, 3, 4]
