// The run simulation. Pure: no DOM, no wall clock. Time only advances
// through `advance(dtMs)`, so tests, trials and the daily race are
// deterministic. Real-time systems (creep, bursts, expiry, mouse, Rush,
// portal-move regen) run on sim-time ms; movement runs on ticks.

import { chooseDir, effectiveTier } from './brains';
import { COIN_PER_POINT, MAX_SPEED, comboMult } from './economy';
import { type Dir, DIRS, DIR_LIST, OPPOSITE, type Pt, type Rect, dirBetween, inRect, manhattan, rectH, rectW, samePt, shrinkRect } from './grid';
import { buildCycle } from './hamilton';
import { type GridCtx } from './pathfind';
import type { PortalPos } from './profile';
import { makeStreams, type Rng, type Streams } from './rng';
import { ZONES, type ZoneLayout } from './zones';

export type Mode = 'normal' | 'trial' | 'daily';
export type FoodKind = 'plain' | 'golden' | 'chili' | 'buff' | 'frenzy' | 'expiring';

export interface Food extends Pt {
  kind: FoodKind;
  expiresAt?: number;
  bornAt?: number;
  frozen?: boolean;
}

export interface Portal {
  a: Pt;
  b: Pt;
  alive: boolean;
  /** Free placement: moves don't cost charges (a newly bought pair, until the run ends). */
  free: boolean;
}

export interface Spike extends Pt {
  phase: number;
  jamUntil: number;
  cooldownUntil: number;
}

export interface Mouse extends Pt {
  until: number;
}

export type MoltReason = 'wall' | 'self' | 'swept' | 'closed' | 'filled' | 'starved' | 'manual';

export type SimEvent =
  | { t: 'eat'; kind: FoodKind | 'mouse'; pts: number; x: number; y: number }
  | { t: 'golden'; coins: number }
  | { t: 'pip'; pts: number; x: number; y: number }
  | { t: 'mouse'; how: 'tap' | 'eat'; pts: number; x: number; y: number }
  | { t: 'freeze'; x: number; y: number }
  | { t: 'burst'; n: number }
  | { t: 'jam'; x: number; y: number }
  | { t: 'rush'; on: boolean }
  | { t: 'teleport' }
  | { t: 'shrink'; rings: number }
  | { t: 'collapse'; pair: number }
  | { t: 'prune'; cut: number }
  | { t: 'expired' }
  | { t: 'trialPass' }
  | { t: 'molt'; reason: MoltReason; phi: number; length: number; score: number };

/** Currency hooks. Null in trial/daily runs, which never pay out. */
export interface Rewards {
  addCoins(n: number): void;
  addPoints(n: number): void;
  rollGolden(): boolean;
  goldenReward(): number;
  chiliCoinBonus(): number;
}

export interface RunConfig {
  mode: Mode;
  cols: number;
  rows: number;
  zone: number;
  layout?: ZoneLayout;
  brain: number;
  seed: string | null;
  creep: boolean;
  baseSpeed: number;
  ringIntervalMs: number;
  comboWindow: number;
  pruneCharges: number;
  portals: (PortalPos | null)[];
  treeBonus: number;
  skinMult: number;
  zoneMult: number;
  /** Daily race: the whole score multiplier is pinned to 1. */
  multFixed: boolean;
  /** Golden / chili / buff / frenzy pickups. */
  specials: boolean;
  /** Expiring apples and the mouse. */
  tapPickups: boolean;
  rush: boolean;
  /** Trial runs: apples to eat, growth per apple. */
  apples?: number;
  grow?: number;
  /** Trial runs fail after this many ticks without an apple. */
  starveTicks?: number;
  rewards: Rewards | null;
}

// Pickup tuning carried over from the pre-idle game (chili no longer shrinks).
const CHILI = { chance: 0.045, minCd: 5, maxCd: 9, step: 1.15, max: 3 };
const BUFF = { chance: 0.035, minCd: 6, maxCd: 11, durationMs: 6000, mult: 3 };
const FRENZY = { chance: 0.02, minCd: 10, maxCd: 18, durationMs: 10000, pipValue: 8, fraction: 0.22, min: 10, max: 180 };
const EXPIRING = { chance: 0.15, lifeMs: 8000, freezeMs: 5000, value: 30 };
const MOUSE = { minGapMs: 45000, maxGapMs: 90000, rushGapMs: 5000, lifeMs: 10000, moveEvery: 3, value: 50 };
const RUSH = { minGapMs: 8 * 60000, maxGapMs: 12 * 60000, durationMs: 30000 };
const BURST = { maxStacks: 5, lifeMs: 1000, step: 0.1, rushStep: 0.3 };
const SPIKE = { periodMs: 2000, jamMs: 3000, cooldownMs: 10000 };
const PORTAL = { minSeparation: 10, startMoves: 2, maxMoves: 3, regenMs: 30000 };
const PRUNE_PHI = 0.35;
const TRAIL_LIFE_MS = 450;

export class Sim {
  readonly cfg: RunConfig;
  readonly cols: number;
  readonly rows: number;
  readonly rng: Streams;

  snake: Pt[] = [];
  dir: Dir = 'right';
  growPending = 0;
  food: Food | null = null;
  twin: Food | null = null;
  pips: Pt[] = [];
  mouse: Mouse | null = null;
  arena: Rect;
  rings = 0;
  creepElapsed = 0;

  /** Static walls, flat-indexed. */
  wall: Uint8Array;
  mud: Uint8Array;
  spikes: Spike[] = [];
  spikeAt: Int32Array;
  readonly openBoard: boolean;

  portals: Portal[] = [];
  portalMoves = PORTAL.startMoves;
  private portalRegen = 0;
  portalUsedThisApple = false;

  time = 0;
  tickCount = 0;
  private tickAcc = 0;
  combo = 0;
  comboDeadline = -1;
  bursts: number[] = [];
  buffUntil = 0;
  frenzyUntil = 0;
  chiliMult = 1;
  chiliGlow = 0;
  rushUntil = 0;
  private rushNextAt: number;
  private nextMouseAt: number;
  mudTicks = 0;

  score = 0;
  applesEaten = 0;
  goldenEaten = 0;
  coinsEarned = 0;
  private coinFrac = 0;
  pruneCharges: number;
  applesLeft: number;
  private lastEatTick = 0;
  trail: { x: number; y: number; life: number }[] = [];

  over = false;
  events: SimEvent[] = [];

  private chiliCd: number;
  private buffCd: number;
  private frenzyCd: number;
  private frenzyTarget = FRENZY.min;

  constructor(cfg: RunConfig) {
    this.cfg = cfg;
    this.cols = cfg.cols;
    this.rows = cfg.rows;
    this.rng = makeStreams(cfg.seed);
    const n = cfg.cols * cfg.rows;
    this.arena = { x0: 0, y0: 0, x1: cfg.cols - 1, y1: cfg.rows - 1 };
    this.wall = new Uint8Array(n);
    this.mud = new Uint8Array(n);
    this.spikeAt = new Int32Array(n).fill(-1);
    const layout = cfg.layout ?? ZONES[cfg.zone]?.build(cfg.cols, cfg.rows) ?? { walls: [], spikes: [], mud: [] };
    for (const w of layout.walls) if (this.onBoard(w)) this.wall[this.ci(w)] = 1;
    for (const m of layout.mud) if (this.onBoard(m)) this.mud[this.ci(m)] = 1;
    layout.spikes.forEach((s, i) => {
      if (!this.onBoard(s)) return;
      this.spikeAt[this.ci(s)] = this.spikes.length;
      this.spikes.push({ x: s.x, y: s.y, phase: (i % 2) * 1000, jamUntil: 0, cooldownUntil: 0 });
    });
    this.openBoard = layout.walls.length === 0 && layout.spikes.length === 0 && layout.mud.length === 0;

    const ev = this.rng.events;
    this.chiliCd = ev.int(CHILI.minCd, CHILI.maxCd);
    this.buffCd = ev.int(BUFF.minCd, BUFF.maxCd);
    this.frenzyCd = ev.int(FRENZY.minCd, FRENZY.maxCd);
    this.rushNextAt = ev.int(RUSH.minGapMs, RUSH.maxGapMs);
    this.nextMouseAt = this.rng.mouse.int(MOUSE.minGapMs, MOUSE.maxGapMs);
    this.pruneCharges = cfg.pruneCharges;
    this.applesLeft = cfg.apples ?? Infinity;

    this.placeSnake();
    this.frenzyTarget = Math.max(FRENZY.min, Math.min(FRENZY.max, Math.round((this.freeCells() - 3) * FRENZY.fraction)));
    cfg.portals.forEach((pos) => this.setupPortal(pos, false));
    this.spawnFood();
  }

  // -------------------------------------------------------------------------
  // Geometry helpers
  // -------------------------------------------------------------------------

  ci(p: Pt) {
    return p.y * this.cols + p.x;
  }
  pt(c: number): Pt {
    return { x: c % this.cols, y: Math.floor(c / this.cols) };
  }
  onBoard(p: Pt) {
    return p.x >= 0 && p.y >= 0 && p.x < this.cols && p.y < this.rows;
  }
  inArena(p: Pt, r: Rect = this.arena) {
    return inRect(r, p.x, p.y);
  }
  isWall(p: Pt) {
    return this.onBoard(p) && this.wall[this.ci(p)] === 1;
  }
  spikeActive(s: Spike, t = this.time) {
    return s.jamUntil <= t && Math.floor((t + s.phase) / SPIKE.periodMs) % 2 === 0;
  }
  spikeActiveAt(p: Pt, t = this.time) {
    if (!this.onBoard(p)) return false;
    const i = this.spikeAt[this.ci(p)];
    return i >= 0 && this.spikeActive(this.spikes[i], t);
  }
  onSnake(p: Pt) {
    return this.snake.some((s) => s.x === p.x && s.y === p.y);
  }
  /** Arena cells that aren't walls: the denominator of φ. */
  freeCells(r: Rect = this.arena) {
    let n = 0;
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (!this.wall[y * this.cols + x]) n++;
    return n;
  }
  phi(r: Rect = this.arena) {
    const cells = this.freeCells(r);
    return cells > 0 ? Math.min(1, this.snake.length / cells) : 1;
  }
  portalEndAt(p: Pt): { pair: number; end: 'a' | 'b' } | null {
    for (let i = 0; i < this.portals.length; i++) {
      if (samePt(this.portals[i].a, p)) return { pair: i, end: 'a' };
      if (samePt(this.portals[i].b, p)) return { pair: i, end: 'b' };
    }
    return null;
  }
  isPortalActive(p: Portal) {
    return p.alive && !this.spikeActiveAt(p.a) && !this.spikeActiveAt(p.b);
  }
  /** A cell food, pips or the mouse may occupy. */
  isFreeCell(p: Pt) {
    if (!this.onBoard(p) || !this.inArena(p)) return false;
    const c = this.ci(p);
    if (this.wall[c] || this.spikeAt[c] >= 0) return false;
    if (this.onSnake(p) || this.portalEndAt(p)) return false;
    if (samePt(this.food, p) || samePt(this.twin, p) || samePt(this.mouse, p)) return false;
    return !this.pips.some((q) => samePt(q, p));
  }
  private randomFreeCell(rng: Rng, accept: (p: Pt) => boolean = () => true): Pt | null {
    for (let i = 0; i < 200; i++) {
      const p = { x: rng.int(this.arena.x0, this.arena.x1), y: rng.int(this.arena.y0, this.arena.y1) };
      if (this.isFreeCell(p) && accept(p)) return p;
    }
    const all: Pt[] = [];
    for (let y = this.arena.y0; y <= this.arena.y1; y++)
      for (let x = this.arena.x0; x <= this.arena.x1; x++) {
        const p = { x, y };
        if (this.isFreeCell(p) && accept(p)) all.push(p);
      }
    return all.length ? all[rng.int(0, all.length - 1)] : null;
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private placeSnake() {
    const tier = effectiveTier(this);
    if (tier === 4) {
      const cyc = buildCycle(this.arena, this.cols, this.rows)!;
      const center = Math.floor(this.rows / 2) * this.cols + Math.floor(this.cols / 2);
      const N = cyc.order.length;
      const k = Math.max(2, cyc.idx[center]);
      this.snake = [0, 1, 2].map((j) => this.pt(cyc.order[(k - j + N) % N]));
      this.dir = dirBetween(this.snake[1], this.snake[0]) ?? 'right';
      return;
    }
    // Nearest horizontal run of 4 free cells to the centre: head on the
    // third, body behind it, one free cell of runway ahead.
    const cx = Math.floor(this.cols / 2);
    const cy = Math.floor(this.rows / 2);
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let y = 1; y < this.rows - 1; y++)
      for (let x = 2; x < this.cols - 2; x++) {
        const ok = [-2, -1, 0, 1].every((dx) => {
          const c = y * this.cols + x + dx;
          return !this.wall[c] && this.spikeAt[c] < 0 && !this.mud[c];
        });
        const d = Math.abs(x - cx) + Math.abs(y - cy);
        if (ok && d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    const h = best ?? { x: cx, y: cy };
    this.snake = [h, { x: h.x - 1, y: h.y }, { x: h.x - 2, y: h.y }];
    this.dir = 'right';
  }

  private validPortalCell(p: Pt, ignore?: { pair: number; end: 'a' | 'b' }) {
    if (!this.onBoard(p) || !this.inArena(p)) return false;
    const c = this.ci(p);
    if (this.wall[c] || this.spikeActiveAt(p)) return false;
    if (this.onSnake(p) || samePt(this.food, p) || samePt(this.twin, p)) return false;
    const other = this.portalEndAt(p);
    return !other || (!!ignore && other.pair === ignore.pair && other.end === ignore.end);
  }

  private nearestValid(target: Pt, taken: Pt[]): Pt | null {
    for (let r = 0; r < Math.max(this.cols, this.rows); r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const p = { x: target.x + dx, y: target.y + dy };
          if (this.validPortalCell(p) && !taken.some((q) => samePt(q, p)) && !this.mud[this.ci(p)]) return p;
        }
    return null;
  }

  private setupPortal(pos: PortalPos | null, free: boolean) {
    const k = this.portals.length;
    const valid =
      pos &&
      this.validPortalCell(pos.a) &&
      this.validPortalCell(pos.b) &&
      !samePt(pos.a, pos.b) &&
      manhattan(pos.a, pos.b) >= PORTAL.minSeparation;
    if (valid) {
      this.portals.push({ a: { ...pos!.a }, b: { ...pos!.b }, alive: true, free });
      return;
    }
    // Default spot: arena left-centre and right-centre, staggered per pair.
    const cy = Math.floor((this.arena.y0 + this.arena.y1) / 2) + (k - 1) * 3;
    const a = this.nearestValid({ x: this.arena.x0 + 2, y: cy }, []);
    const b = a && this.nearestValid({ x: this.arena.x1 - 2, y: cy }, [a]);
    if (!a || !b) return;
    this.portals.push({ a, b, alive: true, free: true });
  }

  /** A pair bought mid-run lands at its default spot with free placement. */
  addPortalPair() {
    this.setupPortal(null, true);
  }

  portalLayout(): (PortalPos | null)[] {
    return this.portals.map((p) => ({ a: { ...p.a }, b: { ...p.b } }));
  }

  canPlacePortal(pair: number, end: 'a' | 'b', p: Pt) {
    const pr = this.portals[pair];
    if (!pr || this.over) return false;
    if (!this.validPortalCell(p, { pair, end })) return false;
    const partner = end === 'a' ? pr.b : pr.a;
    return manhattan(p, partner) >= PORTAL.minSeparation;
  }

  movePortal(pair: number, end: 'a' | 'b', p: Pt) {
    const pr = this.portals[pair];
    if (!pr || !this.canPlacePortal(pair, end, p)) return false;
    if (samePt(pr[end], p)) return false;
    if (!pr.free) {
      if (this.portalMoves < 1) return false;
      this.portalMoves -= 1;
    }
    pr[end] = { ...p };
    return true;
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  mult() {
    if (this.cfg.multFixed) return 1;
    const buff = this.time < this.buffUntil ? BUFF.mult : 1;
    return this.chiliMult * buff * (1 + this.cfg.treeBonus) * comboMult(this.combo) * this.cfg.skinMult * this.cfg.zoneMult;
  }

  private addScore(pts: number) {
    if (pts <= 0) return;
    this.score += pts;
    const r = this.cfg.rewards;
    if (!r) return;
    r.addPoints(pts);
    this.coinFrac += pts * COIN_PER_POINT;
    const whole = Math.floor(this.coinFrac);
    if (whole > 0) {
      this.coinFrac -= whole;
      this.addCoins(whole);
    }
  }
  private addCoins(n: number) {
    if (!this.cfg.rewards || n <= 0) return;
    this.cfg.rewards.addCoins(n);
    this.coinsEarned += n;
  }

  // -------------------------------------------------------------------------
  // Speed
  // -------------------------------------------------------------------------

  rushActive() {
    return this.time < this.rushUntil;
  }
  liveBursts() {
    this.bursts = this.bursts.filter((t) => t > this.time);
    return this.bursts.length;
  }
  currentSpeed() {
    const rush = this.rushActive();
    const cap = rush ? MAX_SPEED * 1.5 : MAX_SPEED;
    const step = rush ? BURST.rushStep : BURST.step;
    let s = Math.min(cap, this.cfg.baseSpeed * (1 + step * this.liveBursts()));
    if (this.mudTicks > 0) s *= 0.5;
    return s;
  }
  tickMs() {
    return 1000 / this.currentSpeed();
  }
  ticksToShrink() {
    if (!this.cfg.creep) return Infinity;
    return (this.cfg.ringIntervalMs - this.creepElapsed) / this.tickMs();
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  advance(dtMs: number) {
    if (this.over) return;
    const dt = Math.max(0, Math.min(250, dtMs));
    this.time += dt;
    this.updateTimers(dt);
    if (this.over) return;
    if (this.cfg.creep) {
      this.creepElapsed += dt;
      while (this.creepElapsed >= this.cfg.ringIntervalMs && !this.over) {
        this.creepElapsed -= this.cfg.ringIntervalMs;
        this.shrink();
      }
      if (this.over) return;
    }
    this.tickAcc += dt;
    let guard = 0;
    while (this.tickAcc >= this.tickMs() && !this.over && guard++ < 64) {
      this.tickAcc -= this.tickMs();
      this.tick();
    }
  }

  private updateTimers(dt: number) {
    const t = this.time;
    if (this.chiliGlow > 0) this.chiliGlow = Math.max(0, this.chiliGlow - (dt / 1000) * 2.5);
    if (this.frenzyUntil && t >= this.frenzyUntil) {
      this.frenzyUntil = 0;
      this.pips = [];
    }
    for (const g of this.trail) g.life -= dt;
    this.trail = this.trail.filter((g) => g.life > 0);

    for (const f of [this.food, this.twin]) {
      if (f && f.kind === 'expiring' && t >= f.expiresAt!) {
        this.events.push({ t: 'expired' });
        this.spawnFood('plain');
        break;
      }
    }

    if (this.cfg.rush && !this.rushActive() && t >= this.rushNextAt) {
      this.rushUntil = t + RUSH.durationMs;
      this.rushNextAt = this.rushUntil + this.rng.events.int(RUSH.minGapMs, RUSH.maxGapMs);
      this.nextMouseAt = Math.min(this.nextMouseAt, t + MOUSE.rushGapMs);
      this.events.push({ t: 'rush', on: true });
    } else if (this.rushUntil && !this.rushActive()) {
      this.rushUntil = 0;
      this.events.push({ t: 'rush', on: false });
    }

    if (this.cfg.tapPickups) {
      if (this.mouse && t >= this.mouse.until) this.mouse = null;
      if (!this.mouse && t >= this.nextMouseAt) {
        const head = this.snake[0];
        const p = this.randomFreeCell(this.rng.mouse, (q) => manhattan(q, head) >= 6);
        if (p) this.mouse = { ...p, until: t + MOUSE.lifeMs };
        const gap = this.rushActive() ? MOUSE.rushGapMs : this.rng.mouse.int(MOUSE.minGapMs, MOUSE.maxGapMs);
        this.nextMouseAt = t + gap;
      }
    }

    if (this.portalMoves < PORTAL.maxMoves) {
      this.portalRegen += dt;
      if (this.portalRegen >= PORTAL.regenMs) {
        this.portalRegen -= PORTAL.regenMs;
        this.portalMoves += 1;
      }
    } else {
      this.portalRegen = 0;
    }
  }

  private tick() {
    this.tickCount += 1;
    if (this.combo > 0 && this.tickCount > this.comboDeadline) this.combo = 0;
    if (this.mudTicks > 0) this.mudTicks -= 1;

    let d = chooseDir(this);
    if (d === OPPOSITE[this.dir] && this.snake.length > 1) d = this.dir;
    this.dir = d;
    const head = this.snake[0];
    const step = { x: head.x + DIRS[d].x, y: head.y + DIRS[d].y };

    if (!this.onBoard(step) || !this.inArena(step) || this.isWall(step) || this.spikeActiveAt(step)) {
      this.molt('wall');
      return;
    }

    let land = step;
    let teleported = false;
    const tier = effectiveTier(this);
    const end = tier < 4 ? this.portalEndAt(step) : null;
    if (end) {
      const pr = this.portals[end.pair];
      const partner = end.end === 'a' ? pr.b : pr.a;
      const tail = this.snake[this.snake.length - 1];
      const partnerBody = this.onSnake(partner) && !(samePt(partner, tail) && this.growPending === 0);
      if (this.isPortalActive(pr) && !partnerBody) {
        land = { ...partner };
        teleported = true;
      }
    }

    const eatsFood = samePt(this.food, land) ? this.food : samePt(this.twin, land) ? this.twin : null;
    const eatsMouse = samePt(this.mouse, land);
    const grows = this.growPending > 0 || !!eatsFood || eatsMouse;
    const body = grows ? this.snake : this.snake.slice(0, -1);
    if (body.some((s) => samePt(s, land))) {
      this.molt('self');
      return;
    }

    this.trail.push({ x: head.x, y: head.y, life: TRAIL_LIFE_MS });
    if (this.trail.length > 40) this.trail.shift();
    this.snake.unshift(land);

    if (teleported) {
      this.events.push({ t: 'teleport' });
      if (!this.portalUsedThisApple) {
        this.portalUsedThisApple = true;
        this.comboDeadline += 10;
      }
    }
    if (this.mud[this.ci(land)]) this.mudTicks = 3;

    if (eatsFood) this.eat(eatsFood);
    if (eatsMouse) this.catchMouse('eat');

    if (this.growPending > 0) this.growPending -= 1;
    else this.snake.pop();

    const pip = this.pips.findIndex((p) => samePt(p, land));
    if (pip >= 0) {
      this.pips.splice(pip, 1);
      const pts = Math.round(FRENZY.pipValue * this.mult());
      this.addScore(pts);
      this.events.push({ t: 'pip', pts, x: land.x, y: land.y });
      this.spawnPips();
    }

    if (this.mouse && this.tickCount % MOUSE.moveEvery === 0) this.moveMouse();

    if (this.over) return;
    if (this.cfg.starveTicks && this.tickCount - this.lastEatTick > this.cfg.starveTicks) {
      this.molt('starved');
      return;
    }
    if (this.cfg.mode === 'trial' && this.applesLeft <= 0) {
      this.over = true;
      this.events.push({ t: 'trialPass' });
    }
  }

  private bumpCombo() {
    this.lastEatTick = this.tickCount;
    if (this.tickCount <= this.comboDeadline) this.combo += 1;
    else this.combo = 1;
    this.comboDeadline = this.tickCount + this.cfg.comboWindow;
    this.portalUsedThisApple = false;
  }

  private eat(f: Food) {
    this.bumpCombo();
    this.growPending += this.cfg.grow ?? 1;
    this.applesEaten += 1;
    this.applesLeft -= 1;
    const m = this.mult();
    let pts = 0;
    switch (f.kind) {
      case 'golden': {
        this.goldenEaten += 1;
        pts = Math.round(15 * m);
        const coins = this.cfg.rewards?.goldenReward() ?? 0;
        this.addCoins(coins);
        this.events.push({ t: 'golden', coins });
        break;
      }
      case 'chili': {
        this.chiliMult = Math.min(CHILI.max, Math.round(this.chiliMult * CHILI.step * 100) / 100);
        pts = Math.round(5 * this.mult());
        this.addCoins(this.cfg.rewards?.chiliCoinBonus() ?? 0);
        this.chiliGlow = 1;
        break;
      }
      case 'buff':
        this.buffUntil = this.time + BUFF.durationMs;
        pts = Math.round(10 * this.mult());
        break;
      case 'frenzy':
        this.frenzyUntil = this.time + FRENZY.durationMs;
        break;
      case 'expiring':
        pts = Math.round(EXPIRING.value * m);
        break;
      default:
        pts = Math.round(10 * m);
    }
    this.addScore(pts);
    this.events.push({ t: 'eat', kind: f.kind, pts, x: f.x, y: f.y });
    this.food = null;
    this.twin = null;
    if (this.applesLeft > 0) this.spawnFood();
    if (f.kind === 'frenzy') this.spawnPips();
  }

  private catchMouse(how: 'tap' | 'eat') {
    const m = this.mouse!;
    if (how === 'eat') {
      this.bumpCombo();
      this.growPending += 1;
    }
    const pts = Math.round(MOUSE.value * this.mult());
    this.addScore(pts);
    this.events.push({ t: 'mouse', how, pts, x: m.x, y: m.y });
    this.mouse = null;
  }

  private moveMouse() {
    const m = this.mouse!;
    const head = this.snake[0];
    let best: Pt | null = null;
    let bestD = -1;
    for (const d of DIR_LIST) {
      const p = { x: m.x + DIRS[d].x, y: m.y + DIRS[d].y };
      if (!this.isFreeCell(p)) continue;
      const dist = manhattan(p, head);
      if (dist > bestD) {
        bestD = dist;
        best = p;
      }
    }
    if (best) {
      m.x = best.x;
      m.y = best.y;
    }
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private roll(cd: 'chiliCd' | 'buffCd' | 'frenzyCd', chance: number, min: number, max: number) {
    if (this[cd] > 0) {
      this[cd] -= 1;
      return false;
    }
    const hit = this.rng.special.chance(chance);
    if (hit) this[cd] = this.rng.special.int(min, max);
    return hit;
  }

  spawnFood(force?: FoodKind) {
    this.food = null;
    this.twin = null;
    const p = this.randomFreeCell(this.rng.food);
    if (!p) {
      this.molt('filled');
      return;
    }
    let kind: FoodKind = 'plain';
    if (!force && this.cfg.specials) {
      const r = this.cfg.rewards;
      if (r && r.rollGolden()) kind = 'golden';
      else if (this.roll('chiliCd', CHILI.chance, CHILI.minCd, CHILI.maxCd)) kind = 'chili';
      else if (this.roll('buffCd', BUFF.chance, BUFF.minCd, BUFF.maxCd)) kind = 'buff';
      else if (this.roll('frenzyCd', FRENZY.chance, FRENZY.minCd, FRENZY.maxCd)) kind = 'frenzy';
    }
    if (kind === 'plain' && !force && this.cfg.tapPickups && this.rng.special.chance(EXPIRING.chance)) kind = 'expiring';
    this.food = { ...p, kind };
    if (kind === 'expiring') {
      this.food.expiresAt = this.time + EXPIRING.lifeMs;
      this.food.bornAt = this.time;
    }
    // Specials come with a plain twin: a real choice between the reward and a safe apple.
    if (kind === 'golden' || kind === 'chili' || kind === 'buff') {
      const q = this.randomFreeCell(this.rng.food);
      if (q) this.twin = { ...q, kind: 'plain' };
    }
  }

  private spawnPips() {
    while (this.pips.length < this.frenzyTarget) {
      const p = this.randomFreeCell(this.rng.special);
      if (!p) break;
      this.pips.push(p);
    }
  }

  // -------------------------------------------------------------------------
  // Creep
  // -------------------------------------------------------------------------

  nextArena() {
    return shrinkRect(this.arena);
  }

  private shrink() {
    const next = this.nextArena();
    if (rectW(next) < 2 || rectH(next) < 2) {
      this.molt('closed');
      return;
    }
    if (!this.inArena(this.snake[0], next)) {
      this.molt('swept');
      return;
    }
    this.arena = next;
    this.rings += 1;
    // The tide takes everything from the first segment outside the new ring.
    const cut = this.snake.findIndex((s) => !this.inArena(s));
    if (cut > 0) {
      this.snake.length = cut;
      this.growPending = 0;
    }
    if ((this.food && !this.inArena(this.food)) || (this.twin && !this.inArena(this.twin))) {
      const kept = [this.food, this.twin].find((f) => f && this.inArena(f));
      if (kept) {
        this.food = kept;
        this.twin = null;
      } else this.spawnFood();
    }
    this.pips = this.pips.filter((p) => this.inArena(p));
    if (this.mouse && !this.inArena(this.mouse)) this.mouse = null;
    this.portals.forEach((p, i) => {
      if (p.alive && (!this.inArena(p.a) || !this.inArena(p.b))) {
        p.alive = false;
        this.events.push({ t: 'collapse', pair: i });
      }
    });
    this.events.push({ t: 'shrink', rings: this.rings });
    if (!this.over && this.freeCells() <= this.snake.length) this.molt('filled');
  }

  // -------------------------------------------------------------------------
  // Brain support
  // -------------------------------------------------------------------------

  /**
   * Blocked-cell grid as the brains see it: outside the arena, walls, active
   * (or about-to-be-active) spikes, the body except a tail that will move,
   * and optionally the ring the creep is about to take.
   */
  gridCtx(opts: { avoidRing?: boolean; portals?: boolean } = {}): GridCtx {
    const n = this.cols * this.rows;
    const blocked = new Uint8Array(n);
    const r = opts.avoidRing ? this.nextArena() : this.arena;
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.cols; x++) {
        const c = y * this.cols + x;
        if (!inRect(r, x, y) || this.wall[c]) blocked[c] = 1;
      }
    for (const s of this.spikes) {
      if (this.spikeActive(s) || this.spikeActive(s, this.time + this.tickMs() * 1.5)) blocked[s.y * this.cols + s.x] = 1;
    }
    const keepTail = this.growPending > 0 ? this.snake.length : this.snake.length - 1;
    for (let i = 0; i < keepTail; i++) blocked[this.ci(this.snake[i])] = 1;
    let jump: Int32Array | null = null;
    if (opts.portals !== false && this.portals.length) {
      jump = new Int32Array(n).fill(-1);
      for (const p of this.portals) {
        if (!this.isPortalActive(p)) continue;
        jump[this.ci(p.a)] = this.ci(p.b);
        jump[this.ci(p.b)] = this.ci(p.a);
      }
    }
    return { cols: this.cols, rows: this.rows, blocked, jump };
  }

  targets(includeMouse: boolean): number[] {
    const out: number[] = [];
    if (this.food) out.push(this.ci(this.food));
    if (this.twin) out.push(this.ci(this.twin));
    if (includeMouse && this.mouse) out.push(this.ci(this.mouse));
    return out;
  }

  /** Auto-Prune. Fires only when boxed in early in a run (φ < 0.35). */
  tryPrune() {
    if (this.pruneCharges <= 0 || this.phi() >= PRUNE_PHI || this.snake.length <= 3) return false;
    const L = this.snake.length;
    const cut = Math.min(Math.ceil(0.25 * L), L - 3);
    if (cut <= 0) return false;
    this.snake.length = L - cut;
    this.growPending = 0;
    this.pruneCharges -= 1;
    this.combo = 0;
    this.events.push({ t: 'prune', cut });
    return true;
  }

  // -------------------------------------------------------------------------
  // Player input
  // -------------------------------------------------------------------------

  /** A tap on a board cell. Portal drags are handled by the caller first. */
  tap(p: Pt): 'mouse' | 'freeze' | 'jam' | 'burst' | 'none' {
    if (this.over) return 'none';
    const near = (q: Pt | null) => !!q && Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) <= 1;
    if (this.mouse && near(this.mouse)) {
      this.catchMouse('tap');
      return 'mouse';
    }
    for (const f of [this.food, this.twin]) {
      if (f && f.kind === 'expiring' && !f.frozen && near(f)) {
        f.frozen = true;
        f.expiresAt! += EXPIRING.freezeMs;
        this.events.push({ t: 'freeze', x: f.x, y: f.y });
        return 'freeze';
      }
    }
    if (this.onBoard(p)) {
      const si = this.spikeAt[this.ci(p)];
      const s = si >= 0 ? this.spikes[si] : null;
      if (s && this.spikeActive(s) && this.time >= s.cooldownUntil) {
        s.jamUntil = this.time + SPIKE.jamMs;
        s.cooldownUntil = this.time + SPIKE.cooldownMs;
        this.events.push({ t: 'jam', x: s.x, y: s.y });
        return 'jam';
      }
    }
    return this.burst() ? 'burst' : 'none';
  }

  burst() {
    if (this.over || this.liveBursts() >= BURST.maxStacks) return false;
    this.bursts.push(this.time + BURST.lifeMs);
    this.events.push({ t: 'burst', n: this.bursts.length });
    return true;
  }

  molt(reason: MoltReason) {
    if (this.over) return;
    this.over = true;
    this.events.push({ t: 'molt', reason, phi: this.phi(), length: this.snake.length, score: this.score });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}
