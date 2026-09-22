// Grid geometry shared by the sim, brains and renderer. Cells are addressed
// by flat index `y * cols + x` wherever performance matters.

export interface Pt {
  x: number;
  y: number;
}

export type Dir = 'up' | 'down' | 'left' | 'right';

export const DIRS: Record<Dir, Pt> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
export const DIR_LIST: Dir[] = ['up', 'right', 'down', 'left'];
export const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** Inclusive rectangle. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const rectW = (r: Rect) => r.x1 - r.x0 + 1;
export const rectH = (r: Rect) => r.y1 - r.y0 + 1;
export const rectArea = (r: Rect) => Math.max(0, rectW(r)) * Math.max(0, rectH(r));
export const inRect = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
export const shrinkRect = (r: Rect, n = 1): Rect => ({ x0: r.x0 + n, y0: r.y0 + n, x1: r.x1 - n, y1: r.y1 - n });
export const rectKey = (r: Rect) => `${r.x0},${r.y0},${r.x1},${r.y1}`;

export function dirBetween(a: Pt, b: Pt): Dir | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 1 && dy === 0) return 'right';
  if (dx === -1 && dy === 0) return 'left';
  if (dx === 0 && dy === 1) return 'down';
  if (dx === 0 && dy === -1) return 'up';
  return null;
}

export const manhattan = (a: Pt, b: Pt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const samePt = (a: Pt | null | undefined, b: Pt | null | undefined) =>
  !!a && !!b && a.x === b.x && a.y === b.y;
