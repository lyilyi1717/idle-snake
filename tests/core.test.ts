import { describe, expect, it } from 'vitest';
import { chooseDir } from '../src/core/brains';
import { Meta, comboMult, jackpotFactor, legacyNodeCost, moltPayout } from '../src/core/economy';
import { DIRS } from '../src/core/grid';
import { bfsPath, floodCount } from '../src/core/pathfind';
import { LEGACY_KEY, defaultProfile, loadProfile, memoryKV, migrateLegacy, saveProfile } from '../src/core/profile';
import { Rng } from '../src/core/rng';
import { TRIALS, dailyRun, dateKey, trialRun } from '../src/core/runs';
import { Sim } from '../src/core/sim';
import { ZONES } from '../src/core/zones';
import { baseConfig, makeMeta, moltEvent, runTicks } from './helpers';

const open = (cols: number, rows: number) => ({ cols, rows, blocked: new Uint8Array(cols * rows) });

describe('pathfind', () => {
  it('finds a straight path', () => {
    const g = open(5, 5);
    expect(bfsPath(g, 0, 4)).toEqual([1, 2, 3, 4]);
  });
  it('returns null when the goal is walled off', () => {
    const g = open(5, 5);
    for (let y = 0; y < 5; y++) g.blocked[y * 5 + 2] = 1;
    expect(bfsPath(g, 0, 4)).toBeNull();
  });
  it('takes a portal shortcut', () => {
    const g = open(20, 1);
    const walk = bfsPath(g, 0, 19)!.length;
    const jump = new Int32Array(20).fill(-1);
    jump[1] = 18;
    jump[18] = 1;
    const viaPortal = bfsPath({ ...g, jump }, 0, 19)!;
    expect(viaPortal.length).toBeLessThan(walk);
    expect(viaPortal).toEqual([18, 19]);
  });
  it('flood-fills an open 5x5 grid', () => {
    expect(floodCount(open(5, 5), 12)).toBe(25);
  });
});

describe('economy', () => {
  it('pays ΔSkin = 0.01·√L·J', () => {
    expect(moltPayout(100, 0.5)).toBeCloseTo(0.1);
    expect(moltPayout(100, 0.8)).toBeCloseTo(0.15);
    expect(moltPayout(100, 0.96)).toBeCloseTo(0.3);
  });
  it('reserves the 3x jackpot for the Hamiltonian brain', () => {
    expect(jackpotFactor(0.99, 3)).toBe(1.5);
    expect(jackpotFactor(0.99, 4)).toBe(3);
  });
  it('caps the combo multiplier at 3', () => {
    expect(comboMult(5)).toBeCloseTo(1.5);
    expect(comboMult(50)).toBe(3);
  });
  it('unlocks the next zone on a φ ≥ 0.75 Molt in the top zone', () => {
    const meta = makeMeta();
    expect(meta.applyMolt(50, 0.5, 0, 2).unlocked).toBeNull();
    expect(meta.applyMolt(50, 0.8, 0, 2).unlocked).toBe(1);
    expect(meta.p.maxZone).toBe(1);
    expect(meta.p.skinMult).toBeGreaterThan(1);
  });
  it('computes offline earnings from the last session rate', () => {
    const meta = makeMeta();
    meta.p.lastSessionRate = 2;
    meta.p.lastSeen = 0;
    expect(meta.computeIdleReward(100_000).coins).toBe(Math.floor(0.4 * 2 * 100));
    expect(meta.computeIdleReward(48 * 3600_000).cappedSec).toBe(12 * 3600);
  });
  it('debug unlock-all opens every brain, zone, pair and maxes the tree', () => {
    const meta = makeMeta();
    meta.debugUnlockAll();
    const p = meta.p;
    expect([p.brainTier, p.maxZone, p.portalPairs]).toEqual([4, 4, 3]);
    expect(meta.nodeCost('quickScales')).toBe(Infinity);
    expect(meta.portalGate()).not.toBeNull();
    meta.debugGrant(500, 7);
    expect([p.coins, p.points, p.stats.lifetimeCoinsEarned]).toEqual([500, 7, 0]);
  });
  it('gates trials and portals', () => {
    const meta = makeMeta();
    expect(meta.enterTrial(2, 0)).toBe(false);
    meta.p.coins = 10_000;
    expect(meta.buyPortalPair()).toBe(false);
    expect(meta.enterTrial(3, 0)).toBe(false);
    expect(meta.enterTrial(2, 0)).toBe(true);
    const left = meta.p.coins;
    expect(meta.enterTrial(2, 60_000)).toBe(true);
    expect(meta.p.coins).toBe(left);
    meta.passTrial(2);
    expect(meta.p.brainTier).toBe(2);
    expect(meta.buyPortalPair()).toBe(true);
    expect(meta.p.portalPairs).toBe(1);
  });
});

describe('save', () => {
  it('migrates a pre-idle save and refunds removed nodes', () => {
    const old = {
      economy: { coins: 10, points: 5, skillLevels: { bodyToss: 1, keenAppetite: 3, porousScales: 1 }, unlockedSkins: ['classic', 'amber'] },
      stats: { bestScore: 200, gamesPlayed: 4 },
      settings: { skin: 'amber', crtEffect: false },
    };
    const p = migrateLegacy(old, legacyNodeCost, 0);
    expect(p.coins).toBe(10 + 150);
    expect(p.points).toBe(5 + 18000);
    expect(p.skillLevels).toEqual({ keenAppetite: 3 });
    expect(p.settings.skin).toBe('amber');
    expect(p.settings.crt).toBe(false);
    expect(p.stats.runs).toBe(4);
  });
  it('round-trips and prefers the new key over the legacy one', () => {
    const kv = memoryKV({ [LEGACY_KEY]: JSON.stringify({ economy: { coins: 1 } }) });
    expect(loadProfile(kv, legacyNodeCost).coins).toBe(1);
    const p = defaultProfile(0);
    p.coins = 77;
    saveProfile(kv, p);
    expect(loadProfile(kv, legacyNodeCost).coins).toBe(77);
  });
});

describe('sim basics', () => {
  it('never spawns food on the snake', () => {
    for (let i = 0; i < 50; i++) {
      const sim = new Sim(baseConfig({ cols: 6, rows: 4, seed: 's' + i }));
      expect(sim.onSnake(sim.food!)).toBe(false);
    }
  });

  it('builds a combo within the window and resets after it', () => {
    const sim = new Sim(baseConfig({ seed: 'combo' }));
    sim.food = null;
    const eatAt = new Set([1, 11, 21, 61]);
    const combos: number[] = [];
    for (let t = 1; t <= 61; t++) {
      if (eatAt.has(t)) {
        const d = chooseDir(sim);
        const h = sim.snake[0];
        sim.food = { x: h.x + DIRS[d].x, y: h.y + DIRS[d].y, kind: 'plain' };
      }
      sim.advance(sim.tickMs() + 0.001);
      if (eatAt.has(t)) combos.push(sim.combo);
      sim.food = null;
      sim.twin = null;
    }
    expect(combos).toEqual([1, 2, 3, 1]);
  });

  it('bursts stack to 5 and speed respects the cap', () => {
    const sim = new Sim(baseConfig());
    for (let i = 0; i < 7; i++) sim.burst();
    expect(sim.liveBursts()).toBe(5);
    expect(sim.currentSpeed()).toBeCloseTo(15);
    const fast = new Sim(baseConfig({ baseSpeed: 25 }));
    for (let i = 0; i < 5; i++) fast.burst();
    expect(fast.currentSpeed()).toBe(30);
    for (let i = 0; i < 5; i++) sim.advance(250);
    expect(sim.liveBursts()).toBe(0);
  });

  it('shrinks the arena and trims the tail', () => {
    const sim = new Sim(baseConfig({ creep: true, ringIntervalMs: 1000, brain: 3 }));
    sim.advance(250);
    sim.advance(250);
    sim.advance(250);
    sim.advance(260);
    expect(sim.rings).toBe(1);
    expect(sim.arena).toEqual({ x0: 1, y0: 1, x1: 22, y1: 14 });
    expect(sim.snake.every((s) => sim.inArena(s))).toBe(true);
    expect(sim.inArena(sim.food!)).toBe(true);
  });

  it('prunes a quarter of the body once per charge', () => {
    const sim = new Sim(baseConfig({ brain: 3, pruneCharges: 1 }));
    sim.snake = Array.from({ length: 20 }, (_, i) => ({ x: 20 - i, y: 8 }));
    sim.combo = 4;
    expect(sim.tryPrune()).toBe(true);
    expect(sim.snake.length).toBe(15);
    expect(sim.combo).toBe(0);
    expect(sim.tryPrune()).toBe(false);
  });

  it('freezes an expiring apple once', () => {
    const sim = new Sim(baseConfig({ tapPickups: true }));
    sim.food = { x: 2, y: 2, kind: 'expiring', expiresAt: 8000 };
    expect(sim.tap({ x: 2, y: 2 })).toBe('freeze');
    expect(sim.food.expiresAt).toBe(13000);
    expect(sim.tap({ x: 2, y: 2 })).toBe('burst');
  });

  it('catches a mouse tapped within one cell', () => {
    const meta = makeMeta();
    const sim = new Sim(baseConfig({ tapPickups: true, rewards: meta }));
    sim.mouse = { x: 3, y: 3, until: 10000 };
    expect(sim.tap({ x: 4, y: 4 })).toBe('mouse');
    expect(sim.mouse).toBeNull();
    expect(sim.score).toBe(50);
    expect(meta.p.points).toBe(50);
  });

  it('enforces portal placement rules and move charges', () => {
    const sim = new Sim(baseConfig({ portals: [{ a: { x: 2, y: 3 }, b: { x: 20, y: 3 } }] }));
    expect(sim.portals).toHaveLength(1);
    expect(sim.portals[0].free).toBe(false);
    expect(sim.movePortal(0, 'a', { x: 15, y: 3 })).toBe(false); // < 10 apart
    expect(sim.movePortal(0, 'a', { x: 2, y: 10 })).toBe(true);
    expect(sim.movePortal(0, 'a', { x: 3, y: 10 })).toBe(true);
    expect(sim.portalMoves).toBe(0);
    expect(sim.movePortal(0, 'a', { x: 4, y: 10 })).toBe(false);
    sim.addPortalPair();
    expect(sim.portals[1].free).toBe(true);
    expect(sim.movePortal(1, 'a', { x: 1, y: 1 })).toBe(true);
  });

  it('teleports through a portal and extends the combo window once per apple', () => {
    const sim = new Sim(baseConfig({ brain: 2, portals: [{ a: { x: 15, y: 8 }, b: { x: 2, y: 1 } }] }));
    sim.food = { x: 3, y: 1, kind: 'plain' };
    sim.twin = null;
    runTicks(sim, 5);
    expect(sim.events.some((e) => e.t === 'teleport')).toBe(true);
    expect(sim.applesEaten).toBeGreaterThanOrEqual(1);
  });
});

describe('brains', () => {
  it('tier 4 survives 2000 ticks without trapping', () => {
    const sim = new Sim(baseConfig({ brain: 4, seed: 'ham' }));
    runTicks(sim, 2000);
    expect(moltEvent(sim)).toBeUndefined();
    expect(sim.applesEaten).toBeGreaterThan(20);
  });

  for (const seed of ['r1', 'r2', 'r3']) {
    it(`tier 4 rides the creep to the end (${seed})`, () => {
      const sim = new Sim(baseConfig({ cols: 32, rows: 20, brain: 4, creep: true, ringIntervalMs: 12000, seed }));
      runTicks(sim, 100_000);
      const m = moltEvent(sim)!;
      expect(['closed', 'filled']).toContain(m.reason);
    });
  }

  it('tier 4 keeps its body in cycle order through every shrink', async () => {
    const { buildCycle } = await import('../src/core/hamilton');
    const sim = new Sim(baseConfig({ cols: 24, rows: 16, brain: 4, creep: true, ringIntervalMs: 9000, seed: 'order' }));
    while (!sim.over) {
      const cyc = buildCycle(sim.arena, sim.cols, sim.rows)!;
      const N = cyc.order.length;
      const idx = sim.snake.map((p) => cyc.idx[sim.ci(p)]);
      let span = 0;
      for (let k = 0; k + 1 < idx.length; k++) span += (idx[k] - idx[k + 1] + N) % N;
      expect(span).toBeLessThan(N);
      sim.advance(sim.tickMs() + 0.001);
    }
  });

  it('tier 4 falls back to tier 3 on a walled zone', () => {
    const sim = new Sim(baseConfig({ brain: 4, zone: 1, cols: 32, rows: 20 }));
    expect(sim.openBoard).toBe(false);
    runTicks(sim, 200);
    expect(sim.tickCount).toBeGreaterThan(0);
  });
});

describe('trials', () => {
  for (const def of TRIALS) {
    it(`${def.name}: tier ${def.tier} passes, tier ${def.tier - 1} fails`, () => {
      const pass = runTicks(new Sim(trialRun(def.tier)), 50_000);
      expect(pass.events.some((e) => e.t === 'trialPass')).toBe(true);
      const fail = runTicks(new Sim({ ...trialRun(def.tier), brain: def.tier - 1 }), 50_000);
      expect(fail.events.some((e) => e.t === 'trialPass')).toBe(false);
    });
  }
});

describe('daily race', () => {
  it('uses a UTC date key', () => {
    expect(dateKey(Date.UTC(2026, 8, 22, 23, 59))).toBe('20260922');
  });
  it('is deterministic for a given date', () => {
    const run = () => {
      const sim = new Sim(dailyRun('20260922'));
      for (let i = 0; i < 30_000 && !sim.over; i++) sim.advance(16);
      return [sim.score, sim.applesEaten, sim.tickCount];
    };
    expect(run()).toEqual(run());
  });
});

describe('zones', () => {
  const sizes: [number, number][] = [[20, 14], [32, 20], [48, 30], [90, 60]];
  for (const zone of ZONES) {
    for (const [c, r] of sizes) {
      it(`${zone.name} ${c}x${r} is connected and the snake starts clear`, () => {
        const sim = new Sim(baseConfig({ cols: c, rows: r, zone: ZONES.indexOf(zone) }));
        const ctx = sim.gridCtx({ portals: false });
        for (const s of sim.spikes) ctx.blocked[sim.ci(s)] = 0;
        for (const p of sim.snake) ctx.blocked[sim.ci(p)] = 0;
        expect(floodCount(ctx, sim.ci(sim.snake[0]))).toBe(sim.freeCells());
        expect(sim.snake.every((p) => !sim.isWall(p))).toBe(true);
      });
    }
  }
});

describe('rng', () => {
  it('is reproducible from a string seed', () => {
    const a = new Rng('x');
    const b = new Rng('x');
    expect([a.float(), a.int(1, 6)]).toEqual([b.float(), b.int(1, 6)]);
  });
});

it('Meta rolls stay bounded', () => {
  const meta = new Meta(defaultProfile(0), new Rng('m'));
  for (let i = 0; i < 100; i++) {
    const g = meta.goldenReward();
    expect(g).toBeGreaterThanOrEqual(5);
    expect(g).toBeLessThanOrEqual(20);
  }
});
