// Game controller: owns the profile, the current run, the frame loop, input,
// saving and offline earnings. The Sim does the rules; this wires them to
// the browser.

import { audio } from './audio';
import { effectiveTier } from './core/brains';
import { BRAIN_NAMES, Meta, SKINS, jackpotFactor, legacyNodeCost } from './core/economy';
import type { Pt } from './core/grid';
import { type KV, SAVE_KEY, LEGACY_KEY, browserKV, loadProfile, saveProfile } from './core/profile';
import { dailyRun, dateKey, normalRun, trialRun, zoneName } from './core/runs';
import { Sim, type SimEvent } from './core/sim';
import { type DragView, type Floater, Renderer } from './render/renderer';
import type { UI } from './ui/ui';

const TARGET_COLS = 48;
const MIN_CELL = 12, MAX_CELL = 28;
const MIN_COLS = 20, MAX_COLS = 90;
const MIN_ROWS = 14, MAX_ROWS = 60;
const MOLT_PAUSE_MS = 1800;
const AUTOSAVE_MS = 10_000;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const even = (n: number) => n - (n % 2);

export type RunKind = { kind: 'normal' } | { kind: 'trial'; tier: number } | { kind: 'daily'; key: string };

export class Game {
  readonly kv: KV = browserKV();
  meta: Meta;
  sim!: Sim;
  run: RunKind = { kind: 'normal' };
  ui!: UI;
  readonly renderer: Renderer;
  private canvas: HTMLCanvasElement;
  private lastFrame = 0;
  private lastSave = 0;
  private restartAt = 0;
  private floaters: Floater[] = [];
  private drag: (DragView & { pointerId: number; moved: boolean }) | null = null;
  private flash: { pt: Pt; until: number } | null = null;
  private sessionCoins = 0;
  private sessionActiveMs = 0;
  private lastCoinsEarned = 0;
  private resetting = false;

  constructor() {
    this.canvas = document.getElementById('board') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.meta = new Meta(loadProfile(this.kv, legacyNodeCost));
    audio.setMuted(this.meta.p.settings.muted);
  }

  start(ui: UI) {
    this.ui = ui;
    this.newRun({ kind: 'normal' });
    this.bindInput();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.persist();
      else this.checkIdle();
    });
    window.addEventListener('beforeunload', () => this.persist());
    this.checkIdle();
    requestAnimationFrame((t) => this.frame(t));
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  private boardSize() {
    const lcd = document.querySelector('.lcd') as HTMLElement;
    const w = lcd?.clientWidth || 800;
    const h = lcd?.clientHeight || 500;
    const cell = clamp(Math.round(w / TARGET_COLS), MIN_CELL, MAX_CELL);
    // Even dimensions guarantee a Hamiltonian cycle for the tier-4 brain.
    return {
      cols: even(clamp(Math.floor(w / cell), MIN_COLS, MAX_COLS)),
      rows: even(clamp(Math.floor(h / cell), MIN_ROWS, MAX_ROWS)),
    };
  }

  newRun(run: RunKind) {
    this.run = run;
    this.restartAt = 0;
    this.drag = null;
    this.floaters = [];
    if (run.kind === 'trial') this.sim = new Sim(trialRun(run.tier));
    else if (run.kind === 'daily') this.sim = new Sim(dailyRun(run.key));
    else {
      const { cols, rows } = this.boardSize();
      this.sim = new Sim(normalRun(this.meta, cols, rows));
      this.saveLayout();
    }
    this.lastCoinsEarned = 0;
    this.ui?.hideOverlay();
    this.ui?.refresh();
  }

  runLabel() {
    const r = this.run;
    if (r.kind === 'trial') return `Trial: ${BRAIN_NAMES[r.tier]}`;
    if (r.kind === 'daily') return `Daily Race ${r.key}`;
    return zoneName(this.sim.cfg.zone);
  }

  moltNow() {
    if (this.sim.over) return;
    this.sim.molt('manual');
  }

  startTrial(tier: number) {
    if (!this.meta.enterTrial(tier, Date.now())) {
      audio.deny();
      return false;
    }
    this.save();
    this.newRun({ kind: 'trial', tier });
    this.ui.toast(`Trial: ${BRAIN_NAMES[tier]} brain. Eat every apple without a Molt.`, 3000);
    return true;
  }

  startDaily() {
    this.newRun({ kind: 'daily', key: dateKey(Date.now()) });
    this.ui.toast('Daily Race: same seed for everyone today. Score until the arena closes.', 3000);
  }

  /** Called when a new portal pair is bought mid-run. */
  portalBought() {
    if (this.run.kind === 'normal') {
      this.sim.addPortalPair();
      this.saveLayout();
    }
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private frame(t: number) {
    const dt = this.lastFrame ? Math.min(250, t - this.lastFrame) : 16;
    this.lastFrame = t;
    const now = performance.now();

    if (!this.sim.over) {
      this.sim.advance(dt);
      if (this.run.kind === 'normal') {
        this.sessionActiveMs += dt;
        this.sessionCoins += this.sim.coinsEarned - this.lastCoinsEarned;
        this.lastCoinsEarned = this.sim.coinsEarned;
      }
    }
    for (const e of this.sim.drainEvents()) this.onEvent(e);
    this.drainNotices();

    if (this.restartAt && now >= this.restartAt) this.newRun({ kind: 'normal' });

    for (const f of this.floaters) f.life -= dt;
    this.floaters = this.floaters.filter((f) => f.life > 0);

    const p = this.meta.p;
    this.renderer.draw(this.sim, {
      skin: SKINS[p.settings.skin] ?? SKINS.classic,
      trail: p.settings.trail,
      crt: p.settings.crt,
      drag: this.drag,
      flash: this.flash,
      floaters: this.floaters,
      now,
    });
    this.ui.tick(now);

    if (now - this.lastSave > AUTOSAVE_MS) this.persist();
    requestAnimationFrame((tt) => this.frame(tt));
  }

  private float(x: number, y: number, text: string, color = 0xf4f9e8) {
    this.floaters.push({ x, y, text, life: 900, color });
    if (this.floaters.length > 30) this.floaters.shift();
  }

  private onEvent(e: SimEvent) {
    const p = this.meta.p;
    switch (e.t) {
      case 'eat':
        if (e.kind === 'golden') audio.golden();
        else if (e.kind === 'chili') audio.chili();
        else if (e.kind === 'buff') audio.buff();
        else if (e.kind === 'frenzy') audio.frenzy();
        else audio.eat();
        if (e.pts > 0) this.float(e.x, e.y, '+' + e.pts);
        break;
      case 'golden':
        if (e.coins) this.ui.toast(`Golden apple! +${e.coins} coins`);
        break;
      case 'pip':
        audio.pip();
        break;
      case 'mouse':
        audio.mouse();
        this.float(e.x, e.y, '+' + e.pts, 0xff9fb2);
        if (this.run.kind === 'normal') {
          p.stats.miceCaught += 1;
          this.meta.dirty = true;
        }
        break;
      case 'freeze':
        audio.freeze();
        this.float(e.x, e.y, '+5s', 0x33d6e0);
        break;
      case 'burst':
        audio.burst(e.n);
        break;
      case 'jam':
        audio.jam();
        this.float(e.x, e.y, 'JAM', 0x33d6e0);
        break;
      case 'rush':
        if (e.on) {
          audio.rush();
          this.ui.toast('RUSH! Taps hit harder and mice swarm for 30 s', 2500);
        }
        break;
      case 'teleport':
        audio.teleport();
        break;
      case 'shrink':
        audio.shrink();
        break;
      case 'collapse':
        this.ui.toast(`Portal pair ${e.pair + 1} collapsed into the tide`);
        break;
      case 'prune':
        audio.prune();
        this.ui.toast(`Pruned ${e.cut} segments`);
        break;
      case 'trialPass':
        this.endTrial(true);
        break;
      case 'molt':
        this.onMolt(e);
        break;
    }
  }

  private onMolt(e: Extract<SimEvent, { t: 'molt' }>) {
    const reason = {
      wall: 'Hit a wall',
      self: 'Bit its own tail',
      swept: 'Swept away by the tide',
      closed: 'The arena closed',
      filled: 'The board is full',
      starved: 'Starved',
      manual: 'Molted by choice',
    }[e.reason];
    if (this.run.kind === 'trial') {
      this.endTrial(false, reason);
      return;
    }
    if (this.run.kind === 'daily') {
      const key = this.run.key;
      const prev = this.meta.p.daily[key] ?? 0;
      const best = Math.max(prev, e.score);
      this.meta.p.daily[key] = best;
      this.meta.dirty = true;
      audio.molt();
      this.ui.showOverlay('Race over', String(e.score), reason, e.score > prev ? 'New best for today!' : `Today's best: ${best}`);
      this.save();
      this.restartAt = performance.now() + MOLT_PAUSE_MS + 800;
      return;
    }
    const tier = effectiveTier(this.sim);
    const { delta, unlocked } = this.meta.applyMolt(e.length, e.phi, this.sim.cfg.zone, tier);
    const run = this.meta.recordRun({
      score: e.score,
      length: e.length,
      applesEaten: this.sim.applesEaten,
      goldenApplesEaten: this.sim.goldenEaten,
      phi: e.phi,
      zone: this.sim.cfg.zone,
    });
    this.meta.checkAchievements();
    const J = jackpotFactor(e.phi, tier);
    if (J === 3) audio.jackpot();
    else audio.molt();
    const title = J === 3 ? 'JACKPOT MOLT!' : 'Molt!';
    const sub = `${reason} · fill ${(e.phi * 100).toFixed(0)}%${J > 1 ? ` · J×${J}` : ''}`;
    const extra = `Skin +${delta.toFixed(3)} → ×${this.meta.p.skinMult.toFixed(2)}${run.bonus ? ` · +${run.bonus} coins` : ''}`;
    this.ui.showOverlay(title, String(e.score), sub, extra);
    if (unlocked !== null) this.ui.toast(`Zone unlocked: ${zoneName(unlocked)} (×${(1 + 0.5 * unlocked).toFixed(1)})`, 3500);
    this.save();
    this.restartAt = performance.now() + MOLT_PAUSE_MS;
  }

  private endTrial(passed: boolean, reason = '') {
    if (this.run.kind !== 'trial') return;
    const tier = this.run.tier;
    if (passed) {
      this.meta.passTrial(tier);
      audio.jackpot();
      this.ui.showOverlay('Trial passed', BRAIN_NAMES[tier], 'New brain unlocked and equipped', 'It takes over from the next run');
    } else {
      audio.molt();
      this.ui.showOverlay('Trial failed', `${this.sim.applesEaten} apples`, reason, 'Retry free for 10 minutes');
    }
    this.save();
    this.restartAt = performance.now() + MOLT_PAUSE_MS + 600;
  }

  private drainNotices() {
    const n = this.meta.notices.shift();
    if (!n) return;
    if (n.kind === 'achievement' || n.kind === 'rank') audio.achievement();
    this.ui.toast(n.text, 2600);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (ev) => {
      audio.unlock();
      const cell = this.renderer.cellAt(this.sim, ev.clientX, ev.clientY);
      if (!cell || this.sim.over) return;
      // Priority: portal end (drag) > mouse > expiring apple > spike > burst.
      const end = this.sim.portalEndAt(cell);
      if (end && this.sim.portals[end.pair].alive) {
        this.drag = { ...end, at: null, valid: false, pointerId: ev.pointerId, moved: false };
        c.setPointerCapture(ev.pointerId);
        return;
      }
      const r = this.sim.tap(cell);
      if (r === 'none') audio.tap();
    });
    c.addEventListener('pointermove', (ev) => {
      if (!this.drag || ev.pointerId !== this.drag.pointerId) return;
      const cell = this.renderer.cellAt(this.sim, ev.clientX, ev.clientY);
      const pr = this.sim.portals[this.drag.pair];
      if (!cell || !pr) return;
      const same = cell.x === pr[this.drag.end].x && cell.y === pr[this.drag.end].y;
      this.drag.moved = this.drag.moved || !same;
      this.drag.at = same ? null : cell;
      this.drag.valid = !same && this.sim.canPlacePortal(this.drag.pair, this.drag.end, cell) && (pr.free || this.sim.portalMoves > 0);
    });
    const endDrag = (ev: PointerEvent) => {
      if (!this.drag || ev.pointerId !== this.drag.pointerId) return;
      const d = this.drag;
      this.drag = null;
      if (!d.at) {
        if (!d.moved) this.sim.tap(this.sim.portals[d.pair][d.end]);
        return;
      }
      if (this.sim.movePortal(d.pair, d.end, d.at)) {
        audio.teleport();
        this.saveLayout();
      } else {
        audio.deny();
        this.flash = { pt: { ...this.sim.portals[d.pair][d.end] }, until: performance.now() + 400 };
        if (!this.sim.portals[d.pair].free && this.sim.portalMoves < 1) this.ui.toast('No portal moves left (+1 every 30 s)');
      }
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', (ev) => {
      if (this.drag && ev.pointerId === this.drag.pointerId) this.drag = null;
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' && !(ev.target instanceof HTMLButtonElement)) {
        ev.preventDefault();
        audio.unlock();
        this.sim.burst();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private saveLayout() {
    if (this.run.kind !== 'normal') return;
    const layout = this.sim.portalLayout();
    const p = this.meta.p;
    for (let i = 0; i < layout.length; i++) p.portalLayout[i] = layout[i];
    this.meta.dirty = true;
  }

  save() {
    if (this.resetting) return;
    saveProfile(this.kv, this.meta.p);
    this.meta.dirty = false;
    this.lastSave = performance.now();
  }

  /** Save with the offline bookkeeping: last-seen time and measured coin rate. */
  persist() {
    if (this.resetting) return;
    const p = this.meta.p;
    if (this.sessionActiveMs >= 30_000) p.lastSessionRate = this.sessionCoins / (this.sessionActiveMs / 1000);
    p.stats.activePlaySeconds += Math.floor(this.sessionActiveMs / 1000) - (this.savedActiveSec ?? 0);
    this.savedActiveSec = Math.floor(this.sessionActiveMs / 1000);
    p.lastSeen = Date.now();
    this.save();
  }
  private savedActiveSec = 0;

  private checkIdle() {
    const r = this.meta.computeIdleReward(Date.now());
    if (r.coins > 0) this.ui.showIdle(r);
    else {
      this.meta.p.lastSeen = Date.now();
    }
  }

  claimIdle() {
    this.meta.claimIdle(Date.now());
    audio.coin();
    this.save();
  }

  resetProgress() {
    this.resetting = true;
    this.kv.remove(SAVE_KEY);
    this.kv.remove(SAVE_KEY + '.backup');
    this.kv.remove(LEGACY_KEY);
    location.reload();
  }
}
