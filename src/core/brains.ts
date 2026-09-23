// Autopilot brains. Every tick the sim asks chooseDir() where to go.
//   Tier 1 Greedy       closest-by-Manhattan safe step
//   Tier 2 Pathfinder   BFS to the nearest target, portal-aware
//   Tier 3 Survivor     BFS + tail-reachability check, tail-chasing, auto-Prune
//   Tier 4 Hamiltonian  nested cycle with safe shortcuts; never traps
// The creep warning makes every tier ≥ 2 stop entering the ring about to go.

import { type Dir, DIRS, DIR_LIST, OPPOSITE, inRect, rectH, rectW } from './grid';
import { buildCycle } from './hamilton';
import { type GridCtx, bfs, floodCount, landing, neighbor } from './pathfind';
import type { Sim } from './sim';

const D_INDEX: Record<Dir, number> = { up: 0, right: 1, down: 2, left: 3 };
const RING_WARN_TICKS = 12;

/** Tier 4 only runs on a wall-free board where a Hamiltonian cycle exists. */
export function effectiveTier(sim: Sim): number {
  const t = sim.cfg.brain;
  if (t < 4) return t;
  if (!sim.openBoard) return 3;
  return buildCycle(sim.arena, sim.cols, sim.rows) ? 4 : 3;
}

export function chooseDir(sim: Sim): Dir {
  switch (effectiveTier(sim)) {
    case 1:
      return greedy(sim);
    case 2:
      return pathfinder(sim);
    case 3:
      return survivor(sim);
    default:
      return hamiltonian(sim) ?? survivor(sim);
  }
}

function candidates(sim: Sim): Dir[] {
  return DIR_LIST.filter((d) => sim.snake.length === 1 || d !== OPPOSITE[sim.dir]);
}

function stepCell(sim: Sim, d: Dir): number {
  return neighbor(sim.cols, sim.rows, sim.ci(sim.snake[0]), D_INDEX[d]);
}

function nearRing(sim: Sim) {
  const next = sim.nextArena();
  return sim.cfg.creep && rectW(next) >= 2 && rectH(next) >= 2 && sim.ticksToShrink() <= RING_WARN_TICKS;
}

function distToTargets(sim: Sim, cell: number, targets: number[]) {
  const x = cell % sim.cols;
  const y = (cell - x) / sim.cols;
  let best = Infinity;
  for (const t of targets) {
    const tx = t % sim.cols;
    const d = Math.abs(tx - x) + Math.abs((t - tx) / sim.cols - y);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tier 1
// ---------------------------------------------------------------------------

function greedy(sim: Sim): Dir {
  const targets = sim.targets(false);
  const tryWith = (ctx: GridCtx) => {
    let best: Dir | null = null;
    let bestD = Infinity;
    for (const d of candidates(sim)) {
      const land = landing(ctx, stepCell(sim, d));
      if (land < 0) continue;
      const dist = targets.length ? distToTargets(sim, land, targets) : 0;
      if (dist < bestD || (dist === bestD && d === sim.dir)) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  };
  if (nearRing(sim)) {
    const d = tryWith(sim.gridCtx({ avoidRing: true }));
    if (d) return d;
  }
  return tryWith(sim.gridCtx()) ?? sim.dir;
}

// ---------------------------------------------------------------------------
// Tier 2
// ---------------------------------------------------------------------------

/** Safe step that keeps the most room open. Used when there's no path. */
function roomiest(sim: Sim, ctx: GridCtx): Dir | null {
  let best: Dir | null = null;
  let bestN = -1;
  for (const d of candidates(sim)) {
    const land = landing(ctx, stepCell(sim, d));
    if (land < 0) continue;
    const n = floodCount(ctx, land);
    if (n > bestN) {
      bestN = n;
      best = d;
    }
  }
  return best;
}

function ctxFor(sim: Sim) {
  const ring = nearRing(sim);
  return { ctx: sim.gridCtx({ avoidRing: ring }), ring };
}

function pathfinder(sim: Sim): Dir {
  const { ctx, ring } = ctxFor(sim);
  const targets = new Set(sim.targets(true));
  const head = sim.ci(sim.snake[0]);
  const r = targets.size ? bfs(ctx, head, (c) => targets.has(c)) : null;
  if (r) return r.firstDir;
  const d = roomiest(sim, ctx) ?? (ring ? roomiest(sim, sim.gridCtx()) : null);
  return d ?? greedy(sim);
}

// ---------------------------------------------------------------------------
// Tier 3
// ---------------------------------------------------------------------------

/** Grid with only the static blockers (arena, walls, spikes, ring), no body. */
function staticCtx(sim: Sim, ctx: GridCtx): GridCtx {
  const blocked = ctx.blocked.slice();
  const keep = sim.growPending > 0 ? sim.snake.length : sim.snake.length - 1;
  for (let i = 0; i < keep; i++) blocked[sim.ci(sim.snake[i])] = 0;
  return { ...ctx, blocked };
}

/**
 * After walking `path` and eating at its end, can the virtual head still
 * reach the virtual tail? If so the snake can always follow its tail out.
 */
function tailReachableAfter(sim: Sim, base: GridCtx, path: number[], grow: number): boolean {
  const body = [...path].reverse().concat(sim.snake.map((p) => sim.ci(p)));
  const len = Math.min(body.length, sim.snake.length + sim.growPending + grow);
  const vbody = body.slice(0, len);
  const vtail = vbody[vbody.length - 1];
  const blocked = base.blocked.slice();
  for (let i = 0; i < vbody.length - 1; i++) blocked[vbody[i]] = 1;
  const ctx = { ...base, blocked };
  if (vbody.length >= sim.freeCells()) return true;
  return !!bfs(ctx, vbody[0], (c) => c === vtail);
}

function survivor(sim: Sim, allowPrune = true): Dir {
  const { ctx, ring } = ctxFor(sim);
  const base = staticCtx(sim, ctx);
  const head = sim.ci(sim.snake[0]);
  const grow = sim.cfg.grow ?? 1;
  const targets = new Set(sim.targets(true));
  const r = targets.size ? bfs(ctx, head, (c) => targets.has(c)) : null;
  if (r && tailReachableAfter(sim, base, r.path, grow)) return r.firstDir;

  // Follow the tail: of the moves that keep the tail reachable, take the
  // one farthest from it (stalls longest while the food moves or frees up).
  let best: Dir | null = null;
  let bestLen = -1;
  for (const d of candidates(sim)) {
    const land = landing(ctx, stepCell(sim, d));
    if (land < 0) continue;
    if (targets.has(land) && !tailReachableAfter(sim, base, [land], grow)) continue;
    const body = [land, ...sim.snake.map((p) => sim.ci(p))];
    const len = sim.snake.length + (sim.growPending > 0 || targets.has(land) ? 1 : 0);
    const vbody = body.slice(0, len);
    const vtail = vbody[vbody.length - 1];
    const blocked = base.blocked.slice();
    for (let i = 0; i < vbody.length - 1; i++) blocked[vbody[i]] = 1;
    const tr = bfs({ ...base, blocked }, land, (c) => c === vtail);
    if (tr && tr.path.length > bestLen) {
      bestLen = tr.path.length;
      best = d;
    }
  }
  if (best) return best;

  // Boxed in. Prune if this is an early trap, then think again.
  const reach = floodCount(ctx, head);
  if (allowPrune && reach < sim.snake.length && sim.tryPrune()) return survivor(sim, false);
  if (r) return r.firstDir;
  return roomiest(sim, ctx) ?? (ring ? roomiest(sim, sim.gridCtx()) : null) ?? greedy(sim);
}

// ---------------------------------------------------------------------------
// Tier 4
// ---------------------------------------------------------------------------

function hamiltonian(sim: Sim): Dir | null {
  const head = sim.snake[0];
  const hc = sim.ci(head);
  const next = sim.nextArena();
  const ringLen = 2 * (rectW(sim.arena) + rectH(sim.arena)) - 4;
  const innerCyc =
    sim.cfg.creep && rectW(next) >= 2 && rectH(next) >= 2 ? buildCycle(next, sim.cols, sim.rows) : null;
  // Bursts and Rush make ticks cheap now but not later. Size the warn window
  // with the base speed, the slowest the run can fall back to, or a run that
  // was fast when it checked can still be on the ring when the tide lands.
  const warn = !!innerCyc && sim.ticksToShrink(sim.cfg.baseSpeed) <= ringLen + 4;
  const ctx = sim.gridCtx({ portals: false });
  const free = (c: number) => c >= 0 && !ctx.blocked[c];
  const toDir = (c: number) => {
    const cx = c % sim.cols;
    const cy = (c - cx) / sim.cols;
    for (const d of DIR_LIST) if (head.x + DIRS[d].x === cx && head.y + DIRS[d].y === cy) return d;
    return null;
  };

  if (warn) {
    // Hop onto the next ring's cycle. Its order matches this one's with the
    // outer ring removed, so the body left after the shrink is still in order.
    const cyc = inRect(next, head.x, head.y) ? innerCyc! : buildCycle(sim.arena, sim.cols, sim.rows)!;
    const N = cyc.order.length;
    const c = cyc.order[(cyc.idx[hc] + 1) % N];
    return free(c) ? toDir(c) : null;
  }

  const cyc = buildCycle(sim.arena, sim.cols, sim.rows)!;
  const N = cyc.order.length;
  const hi = cyc.idx[hc];
  if (hi < 0) return null;
  const dist = (c: number) => (cyc.idx[c] - hi + N) % N;
  let best = cyc.order[(hi + 1) % N];
  let bestD = 1;

  // Shortcuts: jump ahead along the cycle, but only into the empty stretch
  // between head and tail, and never past the food. The body stays in cycle
  // order, so following the cycle afterwards is always safe.
  const L = sim.snake.length + sim.growPending;
  if (L < N * 0.5) {
    const tail = sim.ci(sim.snake[sim.snake.length - 1]);
    const dTail = dist(tail);
    const targets = sim.targets(false);
    const dFood = targets.length ? Math.min(...targets.map(dist)) : 0;
    // The head→tail gap shrinks by (jump − 1) on a shortcut and by the
    // growth of every apple eaten while the tail is stalled. Keep enough slack
    // for the pending growth plus the apple we're heading for. With the creep
    // on, also reserve one ring: hopping onto the inner cycle drops the ring
    // cells from the gap.
    const margin = sim.growPending + (sim.cfg.grow ?? 1) + 3 + (sim.cfg.creep ? ringLen : 0);
    for (let d = 0; d < 4; d++) {
      const c = neighbor(sim.cols, sim.rows, hc, d);
      if (!free(c) || cyc.idx[c] < 0) continue;
      const dc = dist(c);
      if (dc > bestD && dc <= dFood && dc < dTail - margin) {
        bestD = dc;
        best = c;
      }
    }
  }
  return free(best) ? toDir(best) : null;
}
