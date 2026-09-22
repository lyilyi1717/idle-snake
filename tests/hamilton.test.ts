import { describe, expect, it } from 'vitest';
import { type Rect, rectArea, shrinkRect } from '../src/core/grid';
import { buildCycle } from '../src/core/hamilton';

function assertCycle(r: Rect, cols: number, rows: number) {
  const cyc = buildCycle(r, cols, rows);
  expect(cyc).not.toBeNull();
  const { order } = cyc!;
  expect(order.length).toBe(rectArea(r));
  expect(new Set(order).size).toBe(order.length);
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    const b = order[(i + 1) % order.length];
    const dx = Math.abs((a % cols) - (b % cols));
    const dy = Math.abs(Math.floor(a / cols) - Math.floor(b / cols));
    expect(dx + dy).toBe(1);
  }
  return cyc!;
}

describe('nested Hamiltonian cycle', () => {
  const sizes: [number, number][] = [[2, 2], [4, 4], [6, 4], [16, 12], [24, 16], [40, 24], [48, 30], [5, 8], [7, 10], [90, 60]];
  for (const [w, h] of sizes) {
    it(`is a valid cycle on ${w}x${h}`, () => {
      assertCycle({ x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, w, h);
    });
  }

  it('returns null when the area is odd', () => {
    expect(buildCycle({ x0: 0, y0: 0, x1: 4, y1: 4 }, 5, 5)).toBeNull();
  });

  it('removing the outer ring leaves exactly the inner cycle, in order', () => {
    const cols = 24, rows = 16;
    let r: Rect = { x0: 0, y0: 0, x1: cols - 1, y1: rows - 1 };
    while (r.x1 - r.x0 >= 3 && r.y1 - r.y0 >= 3) {
      const inner = shrinkRect(r);
      const outer = assertCycle(r, cols, rows);
      const inn = assertCycle(inner, cols, rows);
      const innerSet = new Set(inn.order);
      const filtered = Array.from(outer.order).filter((c) => innerSet.has(c));
      const start = filtered.indexOf(inn.order[0]);
      const rotated = [...filtered.slice(start), ...filtered.slice(0, start)];
      expect(rotated).toEqual(Array.from(inn.order));
      r = inner;
    }
  });
});
