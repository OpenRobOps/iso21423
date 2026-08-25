import { describe, it, expect } from 'vitest';
import { fitTransform, applyTransform, invertTransform, transformYaw } from '../src/index.js';

const rot = (p: { x: number; y: number }, th: number, tx: number, ty: number) => ({
  x: Math.cos(th) * p.x - Math.sin(th) * p.y + tx,
  y: Math.sin(th) * p.x + Math.cos(th) * p.y + ty,
});

describe('fitTransform', () => {
  const local = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 7, y: 3 }];
  const TH = Math.PI / 6, TX = 4, TY = -2;
  const ccs = local.map((p) => rot(p, TH, TX, TY));

  it('recovers an exact rotation+translation', () => {
    const t = fitTransform(local, ccs);
    expect(t.rotation).toBeCloseTo(TH, 10);
    expect(t.tx).toBeCloseTo(TX, 10);
    expect(t.ty).toBeCloseTo(TY, 10);
  });

  it('is least-squares under measurement noise', () => {
    const noisy = ccs.map((p, i) => ({ x: p.x + (i % 2 ? 0.01 : -0.01), y: p.y + (i % 2 ? -0.01 : 0.01) }));
    const t = fitTransform(local, noisy);
    expect(t.rotation).toBeCloseTo(TH, 2);
    expect(t.tx).toBeCloseTo(TX, 1);
    expect(t.ty).toBeCloseTo(TY, 1);
  });

  it('rejects fewer than 3 point pairs (Clause 4)', () => {
    expect(() => fitTransform(local.slice(0, 2), ccs.slice(0, 2))).toThrow(/at least 3/);
  });
  it('rejects mismatched lengths', () => {
    expect(() => fitTransform(local, ccs.slice(0, 3))).toThrow(/same number/);
  });
});

describe('apply / invert / yaw', () => {
  const t = { rotation: Math.PI / 2, tx: 1, ty: 2 };
  it('applies rotation then translation', () => {
    const p = applyTransform(t, { x: 3, y: 0 });
    expect(p.x).toBeCloseTo(1, 10);
    expect(p.y).toBeCloseTo(5, 10);
  });
  it('invert ∘ apply is identity', () => {
    const inv = invertTransform(t);
    const p = applyTransform(inv, applyTransform(t, { x: 3, y: -4 }));
    expect(p.x).toBeCloseTo(3, 10);
    expect(p.y).toBeCloseTo(-4, 10);
  });
  it('transforms yaw and wraps to (-π, π]', () => {
    expect(transformYaw(t, Math.PI * 0.75)).toBeCloseTo(-Math.PI * 0.75, 10);
  });
});
