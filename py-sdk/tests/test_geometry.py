import math

import pytest

from iso21423 import Iso21423Error, RigidTransform2D, apply_transform, fit_transform, invert_transform, transform_yaw

SRC = [(0, 0), (10, 0), (0, 10), (3, 7)]


def test_fit_transform_recovers_known_transform():
    t0 = RigidTransform2D(0.5, 2.0, -1.0)
    t = fit_transform(SRC, [apply_transform(t0, p) for p in SRC])
    assert t.rotation == pytest.approx(0.5) and t.tx == pytest.approx(2.0) and t.ty == pytest.approx(-1.0)


def test_invert_roundtrip():
    t = RigidTransform2D(0.7, 3.0, -4.0)
    x, y = apply_transform(invert_transform(t), apply_transform(t, (1.5, 2.5)))
    assert (x, y) == pytest.approx((1.5, 2.5))


def test_fit_transform_needs_three_points():
    with pytest.raises(Iso21423Error):
        fit_transform(SRC[:2], SRC[:2])


def test_fit_transform_length_mismatch():
    with pytest.raises(Iso21423Error):
        fit_transform(SRC, SRC[:3])


def test_transform_yaw_wraps_to_half_open_interval():
    assert transform_yaw(RigidTransform2D(math.pi, 0, 0), 0.5) == pytest.approx(0.5 - math.pi)
    assert transform_yaw(RigidTransform2D(math.pi, 0, 0), 0.0) == pytest.approx(math.pi)
    assert transform_yaw(RigidTransform2D(0.2, 0, 0), -math.pi) == pytest.approx(-math.pi + 0.2)
