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
