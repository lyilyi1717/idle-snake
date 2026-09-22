// Run configurations: a normal idle run, a Brain Trial, and the Daily Race.

import { BASE_SPEED, type Meta, RUN_CLOCK_MS } from './economy';
import type { Pt } from './grid';
import type { RunConfig } from './sim';
import { ZONES, zoneMult } from './zones';

export function normalRun(meta: Meta, cols: number, rows: number): RunConfig {
  const p = meta.p;
  const zone = Math.min(p.zone, p.maxZone);
  return {
    mode: 'normal',
    cols,
    rows,
    zone,
    brain: Math.max(1, Math.min(p.activeBrain, p.brainTier)),
    seed: null,
    creep: true,
    baseSpeed: meta.baseSpeed(),
    ringIntervalMs: meta.ringIntervalMs(cols, rows),
    comboWindow: meta.comboWindow(),
    pruneCharges: meta.pruneCharges(),
    portals: Array.from({ length: p.portalPairs }, (_, i) => p.portalLayout[i] ?? null),
    treeBonus: meta.scoreTreeBonus(),
    skinMult: p.skinMult,
    zoneMult: zoneMult(zone),
    multFixed: false,
    specials: true,
    tapPickups: true,
    rush: true,
    rewards: meta,
  };
}

// ---------------------------------------------------------------------------
// Brain Trials: a fixed 16×12 arena, fixed walls, a fixed apple sequence.
// Each is built so the candidate brain clears it and the tier below doesn't.
// ---------------------------------------------------------------------------

export const TRIAL_COLS = 16;
export const TRIAL_ROWS = 12;
/** A trial fails if this many ticks pass without an apple. */
export const TRIAL_STARVE_TICKS = 600;

export interface TrialDef {
  tier: number;
  name: string;
  desc: string;
  apples: number;
  grow: number;
  seed: string;
  walls: Pt[];
}

function line(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const out: Pt[] = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push({ x, y });
  return out;
}

export const TRIALS: TrialDef[] = [
  {
    tier: 2,
    name: 'The Baffles',
    desc: 'Wall baffles hide the apples and every apple grows you by 2. Greedy steering coils into itself.',
    apples: 20,
    grow: 2,
    seed: 'trial-2-7',
    walls: [...line(3, 2, 12, 2), ...line(3, 9, 12, 9), ...line(3, 5, 3, 6), ...line(12, 5, 12, 6), ...line(6, 4, 9, 4), ...line(6, 7, 9, 7)],
  },
  {
    tier: 3,
    name: 'The Feast',
    desc: 'Every apple grows you by 3. Rushing the food boxes you in.',
    apples: 20,
    grow: 3,
    seed: 'trial-3',
    walls: [...line(5, 5, 5, 6), ...line(10, 5, 10, 6)],
  },
  {
    tier: 4,
    name: 'The Coil',
    desc: 'Every apple grows you by 6 on an open board. Only a perfect path survives.',
    apples: 20,
    grow: 6,
    seed: 'trial-4',
    walls: [],
  },
];

export function trialRun(tier: number): RunConfig {
  const def = TRIALS.find((t) => t.tier === tier)!;
  return {
    mode: 'trial',
    cols: TRIAL_COLS,
    rows: TRIAL_ROWS,
    zone: 0,
    layout: { walls: def.walls, spikes: [], mud: [] },
    brain: tier,
    seed: def.seed,
    creep: false,
    baseSpeed: BASE_SPEED,
    ringIntervalMs: RUN_CLOCK_MS,
    comboWindow: 25,
    pruneCharges: tier >= 3 ? 1 : 0,
    portals: [],
    treeBonus: 0,
    skinMult: 1,
    zoneMult: 1,
    multFixed: true,
    specials: false,
    tapPickups: false,
    rush: false,
    apples: def.apples,
    grow: def.grow,
    starveTicks: TRIAL_STARVE_TICKS,
    rewards: null,
  };
}

// ---------------------------------------------------------------------------
// Daily Race: same seed for everyone on a UTC date, fixed loadout.
// ---------------------------------------------------------------------------

export const DAILY_COLS = 40;
export const DAILY_ROWS = 24;

export function dateKey(now: number): string {
  const d = new Date(now);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${mm}${dd}`;
}

export function dailyRun(key: string): RunConfig {
  const rings = Math.floor(Math.min(DAILY_COLS, DAILY_ROWS) / 2);
  return {
    mode: 'daily',
    cols: DAILY_COLS,
    rows: DAILY_ROWS,
    zone: 0,
    brain: 2,
    seed: `daily-${key}`,
    creep: true,
    baseSpeed: BASE_SPEED,
    ringIntervalMs: RUN_CLOCK_MS / rings,
    comboWindow: 25,
    pruneCharges: 0,
    portals: [null],
    treeBonus: 0,
    skinMult: 1,
    zoneMult: 1,
    multFixed: true,
    specials: false,
    tapPickups: true,
    rush: false,
    rewards: null,
  };
}

export const zoneName = (n: number) => ZONES[n]?.name ?? '?';
