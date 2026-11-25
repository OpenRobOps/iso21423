"""2D rigid transform fitting (ports ts-sdk geometry/transform.ts)."""
import math
from dataclasses import dataclass

from .errors import Iso21423Error


@dataclass(frozen=True)
class RigidTransform2D:
    """Rotate by `rotation` radians, then translate by (tx, ty)."""
    rotation: float
    tx: float
    ty: float


def fit_transform(from_pts, to_pts) -> RigidTransform2D:
    """Least-squares rigid fit (Kabsch/Umeyama 2D, no scaling); needs >= 3 equal-length point lists."""
    if len(from_pts) != len(to_pts):
        raise Iso21423Error("fit_transform: point lists must have the same number of points")
    if len(from_pts) < 3:
        raise Iso21423Error("fit_transform: at least 3 reference point pairs are required (Clause 4)")
    n = len(from_pts)
    cfx = sum(p[0] for p in from_pts) / n
    cfy = sum(p[1] for p in from_pts) / n
    ctx = sum(p[0] for p in to_pts) / n
    cty = sum(p[1] for p in to_pts) / n
    cross = dot = 0.0
    for (fx, fy), (tx, ty) in zip(from_pts, to_pts):
        fx, fy, tx, ty = fx - cfx, fy - cfy, tx - ctx, ty - cty
        cross += fx * ty - fy * tx
        dot += fx * tx + fy * ty
    rot = math.atan2(cross, dot)
    c, s = math.cos(rot), math.sin(rot)
    return RigidTransform2D(rot, ctx - (c * cfx - s * cfy), cty - (s * cfx + c * cfy))


def apply_transform(t: RigidTransform2D, p) -> tuple[float, float]:
    c, s = math.cos(t.rotation), math.sin(t.rotation)
    return (c * p[0] - s * p[1] + t.tx, s * p[0] + c * p[1] + t.ty)


def invert_transform(t: RigidTransform2D) -> RigidTransform2D:
    c, s = math.cos(t.rotation), math.sin(t.rotation)
    return RigidTransform2D(-t.rotation, -(c * t.tx + s * t.ty), -(-s * t.tx + c * t.ty))


def transform_yaw(t: RigidTransform2D, yaw: float) -> float:
    """Rotate a yaw by the transform, wrapped to (-pi, pi]."""
    r = yaw + t.rotation
    while r > math.pi:
        r -= 2 * math.pi
    while r <= -math.pi:
        r += 2 * math.pi
    return r
