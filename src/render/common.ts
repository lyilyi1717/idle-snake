// Shared by the PixiJS renderer and the Canvas 2D fallback: the renderer
// contract, palette constants, and the board-fitting / hit-test math.

import type { Skin } from '../core/economy';
import type { Pt } from '../core/grid';
import type { Sim, SimEvent } from '../core/sim';

export const CHILI_TINT = 0xe0432b;
export const BUFF_TINT = 0x33d6e0;
export const FRENZY_TINT = 0xf2c94c;
export const MUD = 0x6b4f2a;
export const MOUSE_BODY = 0x8a8a8a;
export const MOUSE_EAR = 0xff9fb2;

// Score-phase snake colours: visual-only progression tied to this run's score.
const SCORE_PHASES = [
  { min: 0, head: 0x464646, body: 0x2e2e2e },
  { min: 10, head: 0x4d7fe6, body: 0x2456c2 },
  { min: 100, head: 0x3fd15f, body: 0x1e8f3a },
  { min: 300, head: 0xffce3f, body: 0xb8860b },
  { min: 600, head: 0xff8c42, body: 0xd9581a },
  { min: 1000, head: 0xff4040, body: 0xb31217 },
];

export function lerpColor(a: number, b: number, t: number) {
  t = Math.max(0, Math.min(1, t));
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Head/body colours for the current score phase, tinted by the chili stack. */
export function snakeColors(sim: Sim) {
  let phase = SCORE_PHASES[0];
  for (const p of SCORE_PHASES) if (sim.score >= p.min) phase = p;
  const tint = Math.min(1, ((sim.chiliMult - 1) / 2) * 0.6 + sim.chiliGlow * 0.4);
  return {
    head: tint > 0 ? lerpColor(phase.head, CHILI_TINT, tint) : phase.head,
    body: tint > 0 ? lerpColor(phase.body, CHILI_TINT, tint * 0.8) : phase.body,
  };
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

export interface BoardRenderer {
  readonly kind: 'pixi' | 'canvas2d';
  cell: number;
  ox: number;
  oy: number;
  draw(sim: Sim, o: FrameOpts): void;
  cellAt(sim: Sim, clientX: number, clientY: number): Pt | null;
  /** Juice hook for sim events (particles, shake). Optional per renderer. */
  fx?(e: SimEvent, sim: Sim): void;
}

/** Largest whole-pixel cell that fits, and the offsets that centre the board. */
export function fitBoard(w: number, h: number, cols: number, rows: number) {
  const cell = Math.max(4, Math.floor(Math.min(w / cols, h / rows)));
  return { cell, ox: Math.floor((w - cell * cols) / 2), oy: Math.floor((h - cell * rows) / 2) };
}

/** Canvas-local CSS pixel → board cell, or null when off the board. */
export function cellFromPoint(lx: number, ly: number, fit: { cell: number; ox: number; oy: number }, cols: number, rows: number): Pt | null {
  const x = Math.floor((lx - fit.ox) / fit.cell);
  const y = Math.floor((ly - fit.oy) / fit.cell);
  return x >= 0 && y >= 0 && x < cols && y < rows ? { x, y } : null;
}
