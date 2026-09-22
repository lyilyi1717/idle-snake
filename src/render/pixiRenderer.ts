// PixiJS (WebGL) renderer. Same contract as the Canvas 2D fallback, plus
// juice: particles, screen shake and a CRT shader.
//
// Layers, back to front:
//   staticG   bg, off-board shade, tide, grid, walls, mud (rebuilt only when
//             the run, arena, cell size or skin changes)
//   sprites   pooled 1×1 white quads, tinted and scaled: snake, food, pips, trail
//   fxG       small per-frame vector bits: spikes, portals, mouse, ring warning,
//             drag ghost, ring clock
//   particles pooled quads with velocity
//   texts     pooled BitmapText: floaters and the HUD
// All of it sits in `root`, which carries the shake offset; the stage carries
// the CRT filter.

// Only the extensions this renderer uses; skipExtensionImports keeps Pixi
// from pulling in accessibility, events, HTML text and the rest.
import 'pixi.js/app';
import 'pixi.js/graphics';
import 'pixi.js/text-bitmap';
import 'pixi.js/filters';
import { Application, BitmapText, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { CRTFilter } from 'pixi-filters/crt';
import { PORTAL_COLORS, type Skin } from '../core/economy';
import { type Pt, rectKey } from '../core/grid';
import type { Food, Sim, SimEvent } from '../core/sim';
import {
  BUFF_TINT, type BoardRenderer, CHILI_TINT, FRENZY_TINT, type FrameOpts, MOUSE_BODY, MOUSE_EAR, MUD,
  cellFromPoint, fitBoard, snakeColors,
} from './common';

interface Particle {
  s: Sprite;
  vx: number;
  vy: number;
  life: number;
  max: number;
}

const FONT = { fontFamily: 'Courier New, monospace', fontWeight: 'bold' as const, fill: 0xffffff };

class Pool<T extends Container> {
  private items: T[] = [];
  private used = 0;
  constructor(private parent: Container, private make: () => T) {}
  get(): T {
    let it = this.items[this.used];
    if (!it) {
      it = this.make();
      this.items.push(it);
      this.parent.addChild(it);
    }
    this.used++;
    it.visible = true;
    return it;
  }
  /** Hide everything not handed out since the last reset. */
  reset() {
    for (let i = this.used; i < this.items.length; i++) this.items[i].visible = false;
    this.used = 0;
  }
}

export class PixiRenderer implements BoardRenderer {
  readonly kind = 'pixi' as const;
  cell = 16;
  ox = 0;
  oy = 0;
  private w = 0;
  private h = 0;
  private root = new Container();
  private staticG = new Graphics();
  private sprites = new Container();
  private fxG = new Graphics();
  private particleLayer = new Container();
  private texts = new Container();
  private quads: Pool<Sprite>;
  private labels: Pool<BitmapText>;
  private particles: Particle[] = [];
  private particlePool: Sprite[] = [];
  private staticKey = '';
  private staticSim: Sim | null = null;
  private crt = new CRTFilter({ curvature: 0, lineWidth: 1.2, lineContrast: 0.18, noise: 0.06, noiseSize: 1, vignetting: 0.32, vignettingAlpha: 0.75, vignettingBlur: 0.35 });
  private shakeUntil = 0;
  private shakeAmp = 0;
  private lastNow = 0;
  private curSim: Sim | null = null;
  private skin: Skin | null = null;

  private constructor(private app: Application, private host: HTMLElement) {
    app.stage.addChild(this.root);
    this.root.addChild(this.staticG, this.sprites, this.fxG, this.particleLayer, this.texts);
    const quad = () => {
      const s = new Sprite(Texture.WHITE);
      s.roundPixels = true;
      return s;
    };
    this.quads = new Pool(this.sprites, quad);
    this.labels = new Pool(this.texts, () => new BitmapText({ text: '', style: { ...FONT, fontSize: 16 } }));
  }

  static async create(canvas: HTMLCanvasElement, host: HTMLElement): Promise<PixiRenderer> {
    const app = new Application();
    await app.init({
      canvas,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      antialias: false,
      autoStart: false,
      sharedTicker: false,
      preference: 'webgl',
      skipExtensionImports: true,
      backgroundAlpha: 1,
    });
    return new PixiRenderer(app, host);
  }

  cellAt(sim: Sim, clientX: number, clientY: number): Pt | null {
    const r = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    return cellFromPoint(clientX - r.left, clientY - r.top, this, sim.cols, sim.rows);
  }

  private fit(sim: Sim) {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.app.renderer.resize(w, h);
      this.staticKey = '';
    }
    const f = fitBoard(w, h, sim.cols, sim.rows);
    this.cell = f.cell;
    this.ox = f.ox;
    this.oy = f.oy;
  }

  // -------------------------------------------------------------------------
  // Static layer
  // -------------------------------------------------------------------------

  private buildStatic(sim: Sim, skin: Skin) {
    const g = this.staticG;
    const C = this.cell;
    const X = (x: number) => this.ox + x * C;
    const Y = (y: number) => this.oy + y * C;
    g.clear();
    g.rect(0, 0, this.w, this.h).fill({ color: skin.bg });
    g.rect(0, 0, this.w, this.h).fill({ color: skin.text, alpha: 0.45 });
    g.rect(this.ox, this.oy, sim.cols * C, sim.rows * C).fill({ color: skin.bg });

    // The tide, as four bands instead of per-cell rects.
    const a = sim.arena;
    const tide = { color: skin.text, alpha: 0.28 };
    if (a.y0 > 0) g.rect(X(0), Y(0), sim.cols * C, a.y0 * C).fill(tide);
    if (a.y1 < sim.rows - 1) g.rect(X(0), Y(a.y1 + 1), sim.cols * C, (sim.rows - 1 - a.y1) * C).fill(tide);
    if (a.x0 > 0) g.rect(X(0), Y(a.y0), a.x0 * C, (a.y1 - a.y0 + 1) * C).fill(tide);
    if (a.x1 < sim.cols - 1) g.rect(X(a.x1 + 1), Y(a.y0), (sim.cols - 1 - a.x1) * C, (a.y1 - a.y0 + 1) * C).fill(tide);

    for (let x = 0; x <= sim.cols; x++) g.moveTo(X(x) + 0.5, Y(0)).lineTo(X(x) + 0.5, Y(sim.rows));
    for (let y = 0; y <= sim.rows; y++) g.moveTo(X(0), Y(y) + 0.5).lineTo(X(sim.cols), Y(y) + 0.5);
    g.stroke({ width: 1, color: skin.grid, alpha: 0.35 });

    const inset = Math.max(2, C * 0.25);
    for (let c = 0; c < sim.wall.length; c++) {
      const p = sim.pt(c);
      if (sim.wall[c]) {
        g.rect(X(p.x), Y(p.y), C, C).fill({ color: skin.snake, alpha: 0.9 });
        g.rect(X(p.x) + inset, Y(p.y) + inset, C - inset * 2, C - inset * 2).fill({ color: skin.grid, alpha: 0.6 });
      } else if (sim.mud[c]) {
        const d = Math.max(1, C / 8);
        g.rect(X(p.x) + 1, Y(p.y) + 1, C - 2, C - 2).fill({ color: MUD, alpha: 0.35 });
        g.rect(X(p.x) + C * 0.25, Y(p.y) + C * 0.3, d, d).fill({ color: MUD, alpha: 0.7 });
        g.rect(X(p.x) + C * 0.6, Y(p.y) + C * 0.6, d, d).fill({ color: MUD, alpha: 0.7 });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  draw(sim: Sim, o: FrameOpts) {
    this.fit(sim);
    this.curSim = sim;
    this.skin = o.skin;
    const t = o.now;
    const dt = this.lastNow ? Math.min(100, t - this.lastNow) : 16;
    this.lastNow = t;
    const C = this.cell;
    const skin = o.skin;
    const X = (x: number) => this.ox + x * C;
    const Y = (y: number) => this.oy + y * C;

    const key = `${this.w}x${this.h}|${C}|${skin.id}|${rectKey(sim.arena)}`;
    if (key !== this.staticKey || sim !== this.staticSim) {
      this.staticKey = key;
      this.staticSim = sim;
      this.buildStatic(sim, skin);
    }

    // ----- sprites -----
    const quad = (x: number, y: number, w: number, h: number, color: number, alpha = 1) => {
      const s = this.quads.get();
      s.x = x;
      s.y = y;
      s.width = w;
      s.height = h;
      s.tint = color;
      s.alpha = alpha;
    };
    const cellQuad = (p: Pt, pad: number, color: number, alpha = 1) => quad(X(p.x) + pad, Y(p.y) + pad, C - pad * 2, C - pad * 2, color, alpha);

    if (o.trail !== 'none') {
      for (const gh of sim.trail) {
        const a = Math.max(0, gh.life / 450);
        if (o.trail === 'dust') cellQuad(gh, 2, skin.snake, a * 0.5);
        else {
          const sz = 2 + a * 2;
          quad(X(gh.x) + C / 2 - sz / 2, Y(gh.y) + C / 2 - sz / 2, sz, sz, skin.golden, a * 0.8);
        }
      }
    }
    for (const f of [sim.food, sim.twin]) if (f) this.food(f, skin, sim, t, cellQuad);
    if (sim.pips.length) {
      const pulse = 0.5 + 0.5 * Math.sin(t / 100);
      const sz = C * 0.4;
      for (const p of sim.pips) quad(X(p.x) + (C - sz) / 2, Y(p.y) + (C - sz) / 2, sz, sz, FRENZY_TINT, 0.6 + 0.4 * pulse);
    }
    if (sim.mouse) {
      const m = sim.mouse;
      const fade = m.until - sim.time < 2000 ? 0.5 + 0.5 * Math.sin(t / 60) : 1;
      cellQuad(m, Math.max(2, C * 0.2), MOUSE_BODY, fade);
      quad(X(m.x) + C * 0.2, Y(m.y) + C * 0.15, C * 0.2, C * 0.2, MOUSE_EAR, fade);
    }
    const { head, body } = snakeColors(sim);
    for (let i = sim.snake.length - 1; i >= 0; i--) cellQuad(sim.snake[i], 1, i === 0 ? head : body);
    if (sim.snake.length) {
      const h0 = sim.snake[0];
      const e = Math.max(2, Math.floor(C / 6));
      quad(X(h0.x) + C * 0.3 - e / 2, Y(h0.y) + C * 0.35, e, e, skin.bg);
      quad(X(h0.x) + C * 0.7 - e / 2, Y(h0.y) + C * 0.35, e, e, skin.bg);
    }
    if (o.flash && o.flash.until > t) cellQuad(o.flash.pt, 0, CHILI_TINT, 0.6 * ((o.flash.until - t) / 400));
    this.quads.reset();

    // ----- vector fx -----
    const g = this.fxG;
    g.clear();
    const a = sim.arena;
    if (sim.cfg.creep && !sim.over && sim.cfg.ringIntervalMs - sim.creepElapsed < 2500) {
      g.rect(X(a.x0) + C / 2, Y(a.y0) + C / 2, (a.x1 - a.x0) * C, (a.y1 - a.y0) * C).stroke({
        width: Math.max(2, C * 0.18),
        color: CHILI_TINT,
        alpha: 0.25 + 0.25 * Math.sin(t / 90),
      });
    }
    for (const s of sim.spikes) {
      if (sim.spikeActive(s)) {
        g.rect(X(s.x) + 1, Y(s.y) + 1, C - 2, C - 2).fill({ color: CHILI_TINT, alpha: 0.85 });
        g.moveTo(X(s.x) + 3, Y(s.y) + 3).lineTo(X(s.x) + C - 3, Y(s.y) + C - 3);
        g.moveTo(X(s.x) + C - 3, Y(s.y) + 3).lineTo(X(s.x) + 3, Y(s.y) + C - 3);
        g.stroke({ width: Math.max(1, C / 8), color: skin.bg, alpha: 0.9 });
      } else {
        const jammed = s.jamUntil > sim.time;
        g.rect(X(s.x) + 2.5, Y(s.y) + 2.5, C - 5, C - 5).stroke({ width: 1, color: jammed ? BUFF_TINT : CHILI_TINT, alpha: jammed ? 0.9 : 0.45 });
      }
    }
    sim.portals.forEach((p, i) => {
      const col = PORTAL_COLORS[i % PORTAL_COLORS.length];
      const on = sim.isPortalActive(p);
      for (const end of ['a', 'b'] as const) {
        if (o.drag && o.drag.pair === i && o.drag.end === end && o.drag.at) continue;
        const q = p[end];
        const pulse = on ? 0.75 + 0.25 * Math.sin(t / 200 + i) : 0.3;
        g.rect(X(q.x) + 2, Y(q.y) + 2, C - 4, C - 4).stroke({ width: Math.max(2, C / 7), color: col, alpha: pulse });
        if (on) {
          const pad = Math.floor(C * 0.38);
          g.rect(X(q.x) + pad, Y(q.y) + pad, C - pad * 2, C - pad * 2).fill({ color: col, alpha: 0.8 });
        }
      }
    });
    if (sim.mouse) {
      const m = sim.mouse;
      g.moveTo(X(m.x) + C * 0.8, Y(m.y) + C * 0.7).lineTo(X(m.x) + C, Y(m.y) + C * (0.6 + 0.2 * Math.sin(t / 80)));
      g.stroke({ width: 1, color: 0x5a5a5a });
    }
    if (o.drag?.at) {
      const col = o.drag.valid ? PORTAL_COLORS[o.drag.pair % PORTAL_COLORS.length] : CHILI_TINT;
      g.rect(X(o.drag.at.x) + 1, Y(o.drag.at.y) + 1, C - 2, C - 2).stroke({ width: Math.max(2, C / 6), color: col, alpha: 0.95 });
    }
    if (sim.cfg.creep) {
      const k = Math.max(0, 1 - sim.creepElapsed / sim.cfg.ringIntervalMs);
      const bw = sim.cols * C;
      const by = this.oy + sim.rows * C - 3;
      g.rect(this.ox, by, bw, 3).fill({ color: skin.text, alpha: 0.25 });
      g.rect(this.ox, by, bw * k, 3).fill({ color: k < 0.15 ? CHILI_TINT : skin.text, alpha: 0.8 });
    }

    // ----- particles -----
    for (const p of this.particles) {
      p.life -= dt;
      p.s.x += (p.vx * dt) / 1000;
      p.s.y += (p.vy * dt) / 1000;
      p.vy += (240 * dt) / 1000;
      p.s.alpha = Math.max(0, p.life / p.max);
    }
    for (const p of this.particles) if (p.life <= 0) {
      p.s.visible = false;
      this.particlePool.push(p.s);
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    // ----- text -----
    const size = Math.max(11, Math.min(18, Math.round(C * 0.8)));
    const label = (text: string, x: number, y: number, color: number, alpha: number, fontSize: number, center: boolean) => {
      const l = this.labels.get();
      if (l.text !== text) l.text = text;
      if (l.style.fontSize !== fontSize) l.style.fontSize = fontSize;
      l.tint = color;
      l.alpha = alpha;
      l.anchor.set(center ? 0.5 : 0, center ? 0.5 : 0);
      l.x = Math.round(x);
      l.y = Math.round(y);
      return l;
    };
    const floatSize = Math.max(10, Math.round(C * 0.7));
    for (const f of o.floaters) {
      const k = f.life / 900;
      label(f.text, X(f.x) + C / 2, Y(f.y) - (1 - k) * C * 1.6, f.color, Math.min(1, k * 1.5), floatSize, true);
    }
    const lines: string[] = [];
    if (sim.combo >= 2) lines.push(`COMBO x${sim.combo}`);
    const b = sim.bursts.filter((e) => e > sim.time).length;
    if (b > 0) lines.push(`BURST x${b}`);
    if (sim.time < sim.buffUntil) lines.push('SCORE x3');
    if (sim.mudTicks > 0) lines.push('MUD');
    lines.forEach((l, i) => {
      const y = this.oy + 8 + i * (size + 4);
      const lbl = label(l, this.ox + 8, y, skin.text, 1, size, false);
      g.rect(this.ox + 5, y - 2, lbl.width + 6, size + 4).fill({ color: skin.bg, alpha: 0.7 });
    });
    if (sim.rushActive()) {
      label(`RUSH  ${Math.ceil((sim.rushUntil - sim.time) / 1000)}s`, this.ox + (sim.cols * C) / 2, this.oy + 8 + (size + 6) / 2, CHILI_TINT, 0.75 + 0.25 * Math.sin(t / 80), size + 6, true);
    }
    this.labels.reset();

    // ----- shake + CRT -----
    if (t < this.shakeUntil) {
      const k = (this.shakeUntil - t) / 250;
      this.root.x = Math.round((Math.random() * 2 - 1) * this.shakeAmp * k);
      this.root.y = Math.round((Math.random() * 2 - 1) * this.shakeAmp * k);
    } else {
      this.root.x = 0;
      this.root.y = 0;
    }
    // The CRT pass goes on the stage with an explicit filter area. On `root`,
    // with bounds-derived filter area, layers drawn above the static one went
    // missing.
    const stage = this.app.stage;
    if (o.crt) {
      this.crt.time += dt / 1000;
      this.crt.seed = Math.random();
      if (!stage.filters || (stage.filters as unknown[]).length === 0) {
        stage.filterArea = this.app.screen;
        stage.filters = [this.crt];
      }
    } else if (stage.filters && (stage.filters as unknown[]).length) {
      stage.filters = [];
    }

    this.app.render();
  }

  private food(f: Food, skin: Skin, sim: Sim, t: number, cellQuad: (p: Pt, pad: number, color: number, alpha?: number) => void) {
    const C = this.cell;
    switch (f.kind) {
      case 'golden': {
        const pulse = 0.55 + 0.45 * Math.sin(t / 120);
        cellQuad(f, 1 + pulse * 1.5, skin.golden, 0.65 + 0.35 * pulse);
        break;
      }
      case 'chili': {
        const flicker = 0.5 + 0.5 * Math.sin(t / 90);
        cellQuad(f, 2, CHILI_TINT, 0.85);
        cellQuad(f, 4, skin.bg, 0.3 + 0.3 * flicker);
        break;
      }
      case 'buff': {
        const pulse = 0.5 + 0.5 * Math.sin(t / 70);
        cellQuad(f, 1 + pulse * 2, BUFF_TINT, 0.75 + 0.25 * pulse);
        break;
      }
      case 'frenzy': {
        const pulse = 0.5 + 0.5 * Math.sin(t / 150);
        cellQuad(f, 1, FRENZY_TINT, 0.9);
        cellQuad(f, 2, FRENZY_TINT, 0.5 + 0.3 * pulse);
        break;
      }
      case 'expiring': {
        const life = Math.max(0, (f.expiresAt! - sim.time) / 8000);
        const blink = life < 0.25 ? 0.5 + 0.5 * Math.sin(t / 50) : 1;
        if (f.frozen) cellQuad(f, 0, BUFF_TINT, 0.95);
        cellQuad(f, f.frozen ? Math.max(1, C / 10) : 2, FRENZY_TINT, (0.25 + 0.75 * Math.min(1, life)) * blink);
        cellQuad(f, Math.floor(C * 0.35), skin.food, 0.9 * blink);
        break;
      }
      default:
        cellQuad(f, 2, skin.food);
    }
  }

  // -------------------------------------------------------------------------
  // Juice
  // -------------------------------------------------------------------------

  private burstAt(p: Pt, color: number, n: number, speed: number) {
    const C = this.cell;
    for (let i = 0; i < n; i++) {
      let s = this.particlePool.pop();
      if (!s) {
        s = new Sprite(Texture.WHITE);
        this.particleLayer.addChild(s);
      }
      s.visible = true;
      s.tint = color;
      const sz = Math.max(2, Math.round(C / 5));
      s.width = sz;
      s.height = sz;
      s.x = this.ox + p.x * C + C / 2;
      s.y = this.oy + p.y * C + C / 2;
      const ang = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      const max = 350 + Math.random() * 350;
      this.particles.push({ s, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - speed * 0.3, life: max, max });
    }
    if (this.particles.length > 400) {
      for (const q of this.particles.splice(0, this.particles.length - 400)) {
        q.s.visible = false;
        this.particlePool.push(q.s);
      }
    }
  }

  private shake(amp: number) {
    this.shakeAmp = amp;
    this.shakeUntil = this.lastNow + 250;
  }

  fx(e: SimEvent, sim: Sim) {
    const skin = this.skin;
    if (!skin || sim !== this.curSim) return;
    const sp = this.cell * 9;
    switch (e.t) {
      case 'eat': {
        const color = e.kind === 'golden' ? skin.golden : e.kind === 'chili' ? CHILI_TINT : e.kind === 'buff' ? BUFF_TINT : e.kind === 'frenzy' || e.kind === 'expiring' ? FRENZY_TINT : skin.food;
        this.burstAt(e, color, e.kind === 'plain' ? 6 : 14, sp);
        break;
      }
      case 'mouse':
        this.burstAt(e, MOUSE_EAR, 16, sp * 1.2);
        break;
      case 'freeze':
      case 'jam':
        this.burstAt(e, BUFF_TINT, 10, sp * 0.8);
        break;
      case 'shrink':
        this.shake(Math.max(2, this.cell * 0.25));
        break;
      case 'prune':
        if (sim.snake.length) this.burstAt(sim.snake[sim.snake.length - 1], skin.snake, 18, sp);
        break;
      case 'molt': {
        const big = e.phi >= 0.95;
        const step = Math.max(1, Math.floor(sim.snake.length / 30));
        for (let i = 0; i < sim.snake.length; i += step) this.burstAt(sim.snake[i], big ? skin.golden : snakeColors(sim).body, big ? 4 : 2, sp * 1.3);
        this.shake(Math.max(3, this.cell * (big ? 0.6 : 0.35)));
        break;
      }
      case 'trialPass':
        for (let i = 0; i < 24; i++) this.burstAt({ x: Math.floor(Math.random() * sim.cols), y: Math.floor(Math.random() * sim.rows) }, skin.golden, 3, sp);
        break;
    }
  }
}
