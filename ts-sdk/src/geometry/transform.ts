import type { Point } from '../types/ccs.js';
import { Iso21423Error } from '../errors.js';

export interface RigidTransform2D { rotation: number; tx: number; ty: number }

export function fitTransform(from: Point[], to: Point[]): RigidTransform2D {
  if (from.length !== to.length) {
    throw new Iso21423Error('fitTransform: point lists must have the same number of points');
  }
  if (from.length < 3) {
    throw new Iso21423Error('fitTransform: at least 3 reference point pairs are required (Clause 4)');
  }
  const n = from.length;
  let cfx = 0, cfy = 0, ctx = 0, cty = 0;
  for (let i = 0; i < n; i++) {
    cfx += from[i]!.x; cfy += from[i]!.y;
    ctx += to[i]!.x; cty += to[i]!.y;
  }
  cfx /= n; cfy /= n; ctx /= n; cty /= n;

  let sumCross = 0, sumDot = 0;
  for (let i = 0; i < n; i++) {
    const fx = from[i]!.x - cfx, fy = from[i]!.y - cfy;
    const tx = to[i]!.x - ctx, ty = to[i]!.y - cty;
    sumCross += fx * ty - fy * tx;
    sumDot += fx * tx + fy * ty;
  }
  const rotation = Math.atan2(sumCross, sumDot);
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return {
    rotation,
    tx: ctx - (cos * cfx - sin * cfy),
    ty: cty - (sin * cfx + cos * cfy),
  };
}

export function applyTransform(t: RigidTransform2D, p: Point): Point {
  const cos = Math.cos(t.rotation), sin = Math.sin(t.rotation);
  return { x: cos * p.x - sin * p.y + t.tx, y: sin * p.x + cos * p.y + t.ty };
}

export function invertTransform(t: RigidTransform2D): RigidTransform2D {
  const cos = Math.cos(t.rotation), sin = Math.sin(t.rotation);
  return {
    rotation: -t.rotation,
    tx: -(cos * t.tx + sin * t.ty),
    ty: -(-sin * t.tx + cos * t.ty),
  };
}

/** Rotates a yaw angle by the transform and wraps the result to (-π, π]. */
export function transformYaw(t: RigidTransform2D, yaw: number): number {
  let r = yaw + t.rotation;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}
