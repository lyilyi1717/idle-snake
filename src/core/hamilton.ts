// Nested Hamiltonian cycles for a shrinking rectangular arena.
//
// The arena loses one outer ring per creep step. A plain zigzag cycle would
// have to be rebuilt from scratch after every shrink, and the snake's body
// would no longer be in cycle order, so "tier 4 never traps" would break.
// Instead, cycle(R) is built by taking cycle(R') for the next-inner rectangle
// R' and splicing R's outer ring into one of R''s border edges. Removing the
// ring from cycle(R) therefore gives exactly cycle(R'), in the same order.
// The part of the body that survives a shrink stays in valid cycle order.
//
// A cycle exists only when the area is even. Each shrink removes 2 from both
// width and height, so parity never changes across a run. The board sizing
// forces even dimensions, so the Open zone always has a cycle.

import { type Pt, type Rect, rectH, rectW, rectKey, shrinkRect } from './grid';

export interface Cycle {
  /** Flat cell indices in cycle order. */
  order: Int32Array;
  /** idx[cell] = position in `order`, or -1 when the cell isn't on the cycle. */
  idx: Int32Array;
}

function zigzag(r: Rect): Pt[] | null {
  const w = rectW(r);
  const h = rectH(r);
  if (w < 2 || h < 2 || (w * h) % 2) return null;
  if (h % 2) {
    // Build on the transposed rectangle, then swap back.
    const t = zigzag({ x0: r.y0, y0: r.x0, x1: r.y1, y1: r.x1 });
    return t && t.map((p) => ({ x: p.y, y: p.x }));
  }
  // Column x0 is the return lane; rows y0..y1 sweep back and forth over x0+1..x1.
  const out: Pt[] = [];
  for (let x = r.x0; x <= r.x1; x++) out.push({ x, y: r.y0 });
  for (let k = 1; k < h; k++) {
    const y = r.y0 + k;
    if (k % 2) for (let x = r.x1; x >= r.x0 + 1; x--) out.push({ x, y });
    else for (let x = r.x0 + 1; x <= r.x1; x++) out.push({ x, y });
  }
  for (let y = r.y1; y >= r.y0 + 1; y--) out.push({ x: r.x0, y });
  return out;
}

function ringOf(r: Rect): Pt[] {
  const out: Pt[] = [];
  for (let x = r.x0; x <= r.x1; x++) out.push({ x, y: r.y0 });
  for (let y = r.y0 + 1; y <= r.y1; y++) out.push({ x: r.x1, y });
  for (let x = r.x1 - 1; x >= r.x0; x--) out.push({ x, y: r.y1 });
  for (let y = r.y1 - 1; y >= r.y0 + 1; y--) out.push({ x: r.x0, y });
  return out;
}

function outwardOf(inner: Rect, u: Pt, v: Pt): Pt | null {
  if (u.y === v.y && u.y === inner.y0) return { x: 0, y: -1 };
  if (u.y === v.y && u.y === inner.y1) return { x: 0, y: 1 };
  if (u.x === v.x && u.x === inner.x0) return { x: -1, y: 0 };
  if (u.x === v.x && u.x === inner.x1) return { x: 1, y: 0 };
  return null;
}

function splice(outer: Rect, inner: Rect, innerCycle: Pt[]): Pt[] | null {
  const ring = ringOf(outer);
  const ringPos = new Map<string, number>();
  ring.forEach((p, i) => ringPos.set(p.x + ',' + p.y, i));
  const n = innerCycle.length;
  for (let i = 0; i < n; i++) {
    const u = innerCycle[i];
    const v = innerCycle[(i + 1) % n];
    const out = outwardOf(inner, u, v);
    if (!out) continue;
    const ia = ringPos.get(u.x + out.x + ',' + (u.y + out.y));
    const ib = ringPos.get(v.x + out.x + ',' + (v.y + out.y));
    if (ia === undefined || ib === undefined) continue;
    const R = ring.length;
    // a and b are ring neighbours; walk the long way round from a to b.
    const step = ring[(ia + 1) % R] === ring[ib] ? -1 : 1;
    const path: Pt[] = [];
    for (let k = 0, j = ia; k < R; k++, j = (j + step + R) % R) path.push(ring[j]);
    return [...innerCycle.slice(0, i + 1), ...path, ...innerCycle.slice(i + 1)];
  }
  return null;
}

function nested(r: Rect): Pt[] | null {
  const w = rectW(r);
  const h = rectH(r);
  if (w < 2 || h < 2 || (w * h) % 2) return null;
  if (Math.min(w, h) <= 3) return zigzag(r);
  const inner = shrinkRect(r);
  const innerCycle = nested(inner);
  if (!innerCycle) return zigzag(r);
  return splice(r, inner, innerCycle) ?? zigzag(r);
}

const cache = new Map<string, Cycle | null>();

export function buildCycle(r: Rect, cols: number, rows: number): Cycle | null {
  const key = rectKey(r) + '|' + cols + 'x' + rows;
  if (cache.has(key)) return cache.get(key)!;
  const pts = nested(r);
  let cyc: Cycle | null = null;
  if (pts) {
    const order = new Int32Array(pts.length);
    const idx = new Int32Array(cols * rows).fill(-1);
    pts.forEach((p, i) => {
      const c = p.y * cols + p.x;
      order[i] = c;
      idx[c] = i;
    });
    cyc = { order, idx };
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, cyc);
  return cyc;
}
