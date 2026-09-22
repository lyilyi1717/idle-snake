// Pure grid search: BFS with portal edges, and flood-fill reachability.
// `blocked[i]` is 1 for an impassable cell. `jump[i]` is the partner cell
// index of a live portal end at i, or -1. Stepping onto a portal end lands
// on its partner, unless the partner is blocked, in which case you land on
// the entry end itself (no teleport), matching the sim's movement rule.

import type { Dir } from './grid';

export interface GridCtx {
  cols: number;
  rows: number;
  blocked: Uint8Array;
  jump?: Int32Array | null;
}

export interface BfsResult {
  /** Head cells after each move (post-teleport), start excluded. */
  path: number[];
  firstDir: Dir;
}

const STEP_DIRS: Dir[] = ['up', 'right', 'down', 'left'];

/** Cell reached by moving `d` from `cell`, or -1 if off-grid. */
export function neighbor(cols: number, rows: number, cell: number, d: number): number {
  const x = cell % cols;
  const y = (cell - x) / cols;
  switch (d) {
    case 0: return y > 0 ? cell - cols : -1;
    case 1: return x < cols - 1 ? cell + 1 : -1;
    case 2: return y < rows - 1 ? cell + cols : -1;
    default: return x > 0 ? cell - 1 : -1;
  }
}

/** Where the head actually ends up when stepping onto `entry`, or -1 if impassable. */
export function landing(ctx: GridCtx, entry: number): number {
  if (entry < 0 || ctx.blocked[entry]) return -1;
  const j = ctx.jump ? ctx.jump[entry] : -1;
  if (j >= 0 && !ctx.blocked[j]) return j;
  return entry;
}

/** Shortest path from `start` to the first cell satisfying `isTarget`. */
export function bfs(ctx: GridCtx, start: number, isTarget: (cell: number) => boolean): BfsResult | null {
  const n = ctx.cols * ctx.rows;
  const parent = new Int32Array(n).fill(-2);
  const firstDir = new Int8Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  parent[start] = -1;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    for (let d = 0; d < 4; d++) {
      const land = landing(ctx, neighbor(ctx.cols, ctx.rows, cur, d));
      if (land < 0 || parent[land] !== -2) continue;
      parent[land] = cur;
      firstDir[land] = cur === start ? d : firstDir[cur];
      if (isTarget(land)) {
        const path: number[] = [];
        for (let c = land; c !== start; c = parent[c]) path.push(c);
        path.reverse();
        return { path, firstDir: STEP_DIRS[firstDir[land]] };
      }
      queue[tail++] = land;
    }
  }
  return null;
}

/** Convenience wrapper matching the spec: path to a single goal cell. */
export function bfsPath(ctx: GridCtx, start: number, goal: number): number[] | null {
  const r = bfs(ctx, start, (c) => c === goal);
  return r ? r.path : null;
}

/** Number of cells reachable from `start`, including `start` itself. */
export function floodCount(ctx: GridCtx, start: number, limit = Infinity): number {
  const n = ctx.cols * ctx.rows;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  seen[start] = 1;
  queue[tail++] = start;
  while (head < tail && tail < limit) {
    const cur = queue[head++];
    for (let d = 0; d < 4; d++) {
      const land = landing(ctx, neighbor(ctx.cols, ctx.rows, cur, d));
      if (land < 0 || seen[land]) continue;
      seen[land] = 1;
      queue[tail++] = land;
    }
  }
  return tail;
}
