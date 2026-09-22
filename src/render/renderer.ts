// Canvas 2D renderer. Reads a Sim and draws it; never mutates game state.
// The cell size is fitted to the canvas each frame, so trial and daily
// boards (fixed sizes) and resized windows all just work.

import { PORTAL_COLORS, type Skin } from '../core/economy';
import type { Pt } from '../core/grid';
import type { Food, Sim } from '../core/sim';

const CHILI_TINT = 0xe0432b;
const BUFF_TINT = 0x33d6e0;
const FRENZY_TINT = 0xf2c94c;
const MUD = 0x6b4f2a;

// Score-phase snake colours: visual-only progression tied to this run's score.
const SCORE_PHASES = [
  { min: 0, head: 0x464646, body: 0x2e2e2e },
  { min: 10, head: 0x4d7fe6, body: 0x2456c2 },
  { min: 100, head: 0x3fd15f, body: 0x1e8f3a },
  { min: 300, head: 0xffce3f, body: 0xb8860b },
  { min: 600, head: 0xff8c42, body: 0xd9581a },
  { min: 1000, head: 0xff4040, body: 0xb31217 },
];

const css = (hex: number, a = 1) => `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;

function lerpColor(a: number, b: number, t: number) {
  t = Math.max(0, Math.min(1, t));
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export interface Floater {
  x: number;
  y: number;
  text: string;
  life: number;
  color: number;
}

export interface DragView {
  pair: number;
  end: 'a' | 'b';
  at: Pt | null;
  valid: boolean;
}

export interface FrameOpts {
  skin: Skin;
  trail: string;
  crt: boolean;
  drag: DragView | null;
  flash: { pt: Pt; until: number } | null;
  floaters: Floater[];
  now: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  cell = 16;
  ox = 0;
  oy = 0;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  private fit(sim: Sim) {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w !== this.w || h !== this.h || this.canvas.width !== Math.floor(w * dpr)) {
      this.w = w;
      this.h = h;
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.cell = Math.max(4, Math.floor(Math.min(w / sim.cols, h / sim.rows)));
    this.ox = Math.floor((w - this.cell * sim.cols) / 2);
    this.oy = Math.floor((h - this.cell * sim.rows) / 2);
  }

  /** Client (CSS px) coordinates → board cell, or null when off the board. */
  cellAt(sim: Sim, clientX: number, clientY: number): Pt | null {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left - this.ox) / this.cell);
    const y = Math.floor((clientY - r.top - this.oy) / this.cell);
    return x >= 0 && y >= 0 && x < sim.cols && y < sim.rows ? { x, y } : null;
  }

  draw(sim: Sim, o: FrameOpts) {
    this.fit(sim);
    const g = this.ctx;
    const C = this.cell;
    const skin = o.skin;
    const t = o.now;
    const X = (x: number) => this.ox + x * C;
    const Y = (y: number) => this.oy + y * C;
    const fillCell = (p: Pt, pad: number, color: string) => {
      g.fillStyle = color;
      g.fillRect(X(p.x) + pad, Y(p.y) + pad, C - pad * 2, C - pad * 2);
    };

    // Space around a board smaller than the screen (trials, daily race) is shaded.
    g.fillStyle = css(skin.bg);
    g.fillRect(0, 0, this.w, this.h);
    g.fillStyle = css(skin.text, 0.45);
    g.fillRect(0, 0, this.w, this.h);
    g.fillStyle = css(skin.bg);
    g.fillRect(this.ox, this.oy, sim.cols * C, sim.rows * C);

    // The tide: cells the creep has already taken.
    const a = sim.arena;
    g.fillStyle = css(skin.text, 0.28);
    for (let y = 0; y < sim.rows; y++)
      for (let x = 0; x < sim.cols; x++) if (x < a.x0 || x > a.x1 || y < a.y0 || y > a.y1) g.fillRect(X(x), Y(y), C, C);

    // Warn about the ring that's about to go.
    if (sim.cfg.creep && !sim.over) {
      const msLeft = sim.cfg.ringIntervalMs - sim.creepElapsed;
      if (msLeft < 2500) {
        const pulse = 0.25 + 0.25 * Math.sin(t / 90);
        g.strokeStyle = css(CHILI_TINT, pulse);
        g.lineWidth = Math.max(2, C * 0.18);
        g.strokeRect(X(a.x0) + C / 2, Y(a.y0) + C / 2, (a.x1 - a.x0) * C, (a.y1 - a.y0) * C);
      }
    }

    // Grid lines.
    g.strokeStyle = css(skin.grid, 0.35);
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= sim.cols; x++) {
      g.moveTo(X(x) + 0.5, Y(0));
      g.lineTo(X(x) + 0.5, Y(sim.rows));
    }
    for (let y = 0; y <= sim.rows; y++) {
      g.moveTo(X(0), Y(y) + 0.5);
      g.lineTo(X(sim.cols), Y(y) + 0.5);
    }
    g.stroke();

    // Walls, mud, spikes.
    for (let c = 0; c < sim.wall.length; c++) {
      if (sim.wall[c]) {
        const p = sim.pt(c);
        fillCell(p, 0, css(skin.snake, 0.9));
        fillCell(p, Math.max(2, C * 0.25), css(skin.grid, 0.6));
      } else if (sim.mud[c]) {
        const p = sim.pt(c);
        fillCell(p, 1, css(MUD, 0.35));
        g.fillStyle = css(MUD, 0.7);
        const d = Math.max(1, C / 8);
        g.fillRect(X(p.x) + C * 0.25, Y(p.y) + C * 0.3, d, d);
        g.fillRect(X(p.x) + C * 0.6, Y(p.y) + C * 0.6, d, d);
      }
    }
    for (const s of sim.spikes) {
      const active = sim.spikeActive(s);
      const jammed = s.jamUntil > sim.time;
      if (active) {
        fillCell(s, 1, css(CHILI_TINT, 0.85));
        g.strokeStyle = css(skin.bg, 0.9);
        g.lineWidth = Math.max(1, C / 8);
        g.beginPath();
        g.moveTo(X(s.x) + 3, Y(s.y) + 3);
        g.lineTo(X(s.x) + C - 3, Y(s.y) + C - 3);
        g.moveTo(X(s.x) + C - 3, Y(s.y) + 3);
        g.lineTo(X(s.x) + 3, Y(s.y) + C - 3);
        g.stroke();
      } else {
        g.strokeStyle = jammed ? css(BUFF_TINT, 0.9) : css(CHILI_TINT, 0.45);
        g.lineWidth = 1;
        g.strokeRect(X(s.x) + 2.5, Y(s.y) + 2.5, C - 5, C - 5);
      }
    }

    // Trail.
    if (o.trail !== 'none') {
      for (const gh of sim.trail) {
        const alpha = Math.max(0, gh.life / 450);
        if (o.trail === 'dust') fillCell(gh, 2, css(skin.snake, alpha * 0.5));
        else {
          const sz = 2 + alpha * 2;
          g.fillStyle = css(skin.golden, alpha * 0.8);
          g.fillRect(X(gh.x) + C / 2 - sz / 2, Y(gh.y) + C / 2 - sz / 2, sz, sz);
        }
      }
    }

    // Portals.
    sim.portals.forEach((p, i) => {
      const col = PORTAL_COLORS[i % PORTAL_COLORS.length];
      const on = sim.isPortalActive(p);
      for (const end of ['a', 'b'] as const) {
        if (o.drag && o.drag.pair === i && o.drag.end === end && o.drag.at) continue;
        const q = p[end];
        const pulse = on ? 0.75 + 0.25 * Math.sin(t / 200 + i) : 0.3;
        g.strokeStyle = css(col, pulse);
        g.lineWidth = Math.max(2, C / 7);
        g.strokeRect(X(q.x) + 2, Y(q.y) + 2, C - 4, C - 4);
        if (on) fillCell(q, Math.floor(C * 0.38), css(col, 0.8));
      }
    });

    // Food.
    for (const f of [sim.food, sim.twin]) if (f) this.food(f, skin, sim, t);
    if (sim.pips.length) {
      const pulse = 0.5 + 0.5 * Math.sin(t / 100);
      const sz = C * 0.4;
      g.fillStyle = css(FRENZY_TINT, 0.6 + 0.4 * pulse);
      for (const p of sim.pips) g.fillRect(X(p.x) + (C - sz) / 2, Y(p.y) + (C - sz) / 2, sz, sz);
    }

    // Mouse: grey body, pink ear, a flicking tail line.
    if (sim.mouse) {
      const m = sim.mouse;
      const fading = m.until - sim.time < 2000 ? 0.5 + 0.5 * Math.sin(t / 60) : 1;
      fillCell(m, Math.max(2, C * 0.2), css(0x8a8a8a, fading));
      g.fillStyle = css(0xff9fb2, fading);
      g.fillRect(X(m.x) + C * 0.2, Y(m.y) + C * 0.15, C * 0.2, C * 0.2);
      g.strokeStyle = css(0x5a5a5a, fading);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(X(m.x) + C * 0.8, Y(m.y) + C * 0.7);
      g.lineTo(X(m.x) + C, Y(m.y) + C * (0.6 + 0.2 * Math.sin(t / 80)));
      g.stroke();
    }

    // Snake.
    let phase = SCORE_PHASES[0];
    for (const p of SCORE_PHASES) if (sim.score >= p.min) phase = p;
    const heat = (sim.chiliMult - 1) / 2;
    const tint = Math.min(1, heat * 0.6 + sim.chiliGlow * 0.4);
    const head = tint > 0 ? lerpColor(phase.head, CHILI_TINT, tint) : phase.head;
    const body = tint > 0 ? lerpColor(phase.body, CHILI_TINT, tint * 0.8) : phase.body;
    for (let i = sim.snake.length - 1; i >= 0; i--) fillCell(sim.snake[i], 1, css(i === 0 ? head : body));
    if (sim.snake.length) {
      const h0 = sim.snake[0];
      const e = Math.max(2, Math.floor(C / 6));
      g.fillStyle = css(skin.bg);
      g.fillRect(X(h0.x) + C * 0.3 - e / 2, Y(h0.y) + C * 0.35, e, e);
      g.fillRect(X(h0.x) + C * 0.7 - e / 2, Y(h0.y) + C * 0.35, e, e);
    }

    // Drag ghost and invalid-drop flash.
    if (o.drag?.at) {
      const col = o.drag.valid ? PORTAL_COLORS[o.drag.pair % PORTAL_COLORS.length] : CHILI_TINT;
      g.strokeStyle = css(col, 0.95);
      g.lineWidth = Math.max(2, C / 6);
      g.setLineDash([3, 3]);
      g.strokeRect(X(o.drag.at.x) + 1, Y(o.drag.at.y) + 1, C - 2, C - 2);
      g.setLineDash([]);
    }
    if (o.flash && o.flash.until > t) {
      fillCell(o.flash.pt, 0, css(CHILI_TINT, 0.6 * ((o.flash.until - t) / 400)));
    }

    // Floating score text.
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${Math.max(10, Math.round(C * 0.7))}px "Courier New", monospace`;
    for (const f of o.floaters) {
      const k = f.life / 900;
      g.fillStyle = css(f.color, Math.min(1, k * 1.5));
      g.fillText(f.text, X(f.x) + C / 2, Y(f.y) - (1 - k) * C * 1.6);
    }

    this.hud(sim, skin, t);

    if (o.crt) {
      g.fillStyle = 'rgba(0,0,0,0.10)';
      for (let y = 0; y < this.h; y += 2) g.fillRect(0, y, this.w, 1);
    }
  }

  private food(f: Food, skin: Skin, sim: Sim, t: number) {
    const g = this.ctx;
    const C = this.cell;
    const x = this.ox + f.x * C;
    const y = this.oy + f.y * C;
    const rect = (pad: number, color: string) => {
      g.fillStyle = color;
      g.fillRect(x + pad, y + pad, C - pad * 2, C - pad * 2);
    };
    switch (f.kind) {
      case 'golden': {
        const pulse = 0.55 + 0.45 * Math.sin(t / 120);
        rect(1 + pulse * 1.5, css(skin.golden, 0.65 + 0.35 * pulse));
        break;
      }
      case 'chili': {
        const flicker = 0.5 + 0.5 * Math.sin(t / 90);
        rect(2, css(CHILI_TINT, 0.85));
        rect(4, css(skin.bg, 0.3 + 0.3 * flicker));
        break;
      }
      case 'buff': {
        const pulse = 0.5 + 0.5 * Math.sin(t / 70);
        rect(1 + pulse * 2, css(BUFF_TINT, 0.75 + 0.25 * pulse));
        g.fillStyle = css(skin.bg, 0.5);
        g.fillRect(x + C / 2 - 1, y + 2, 2, C - 4);
        break;
      }
      case 'frenzy': {
        const pulse = 0.5 + 0.5 * Math.sin(t / 150);
        rect(2, css(FRENZY_TINT, 0.5 + 0.3 * pulse));
        g.strokeStyle = css(FRENZY_TINT, 0.9);
        g.lineWidth = 1;
        g.strokeRect(x + 1.5, y + 1.5, C - 3, C - 3);
        break;
      }
      case 'expiring': {
        // Fades out as its 8 s run down; a frozen one gets an ice ring.
        const life = Math.max(0, (f.expiresAt! - sim.time) / 8000);
        const blink = life < 0.25 ? 0.5 + 0.5 * Math.sin(t / 50) : 1;
        rect(2, css(FRENZY_TINT, (0.25 + 0.75 * Math.min(1, life)) * blink));
        rect(Math.floor(C * 0.35), css(skin.food, 0.9 * blink));
        if (f.frozen) {
          g.strokeStyle = css(BUFF_TINT, 0.95);
          g.lineWidth = Math.max(1, C / 10);
          g.strokeRect(x + 0.5, y + 0.5, C - 1, C - 1);
        }
        break;
      }
      default:
        rect(2, css(skin.food));
    }
  }

  private hud(sim: Sim, skin: Skin, t: number) {
    const g = this.ctx;
    const pad = 8;
    const size = Math.max(11, Math.min(18, Math.round(this.cell * 0.8)));
    g.font = `bold ${size}px "Courier New", monospace`;
    g.textBaseline = 'top';
    g.textAlign = 'left';
    const lines: string[] = [];
    if (sim.combo >= 2) lines.push(`COMBO x${sim.combo}`);
    const b = sim.bursts.filter((e) => e > sim.time).length;
    if (b > 0) lines.push(`BURST x${b}`);
    if (sim.time < sim.buffUntil) lines.push('SCORE x3');
    if (sim.mudTicks > 0) lines.push('MUD');
    lines.forEach((l, i) => {
      g.fillStyle = css(skin.bg, 0.7);
      const w = g.measureText(l).width;
      g.fillRect(this.ox + pad - 3, this.oy + pad + i * (size + 4) - 2, w + 6, size + 4);
      g.fillStyle = css(skin.text);
      g.fillText(l, this.ox + pad, this.oy + pad + i * (size + 4));
    });

    // Ring clock: a thin bar along the bottom edge that empties before each shrink.
    if (sim.cfg.creep) {
      const k = 1 - sim.creepElapsed / sim.cfg.ringIntervalMs;
      const bw = sim.cols * this.cell;
      g.fillStyle = css(skin.text, 0.25);
      g.fillRect(this.ox, this.oy + sim.rows * this.cell - 3, bw, 3);
      g.fillStyle = css(k < 0.15 ? CHILI_TINT : skin.text, 0.8);
      g.fillRect(this.ox, this.oy + sim.rows * this.cell - 3, bw * k, 3);
    }

    if (sim.rushActive()) {
      const msg = `RUSH  ${Math.ceil((sim.rushUntil - sim.time) / 1000)}s`;
      g.font = `bold ${size + 6}px "Courier New", monospace`;
      g.textAlign = 'center';
      const cx = this.ox + (sim.cols * this.cell) / 2;
      g.fillStyle = css(CHILI_TINT, 0.75 + 0.25 * Math.sin(t / 80));
      g.fillText(msg, cx, this.oy + pad);
    }
  }
}
