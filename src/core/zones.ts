// Zone layouts: the prestige ladder Open → Box → Cross → Tunnels → Spiral.
// Walls are generated from the board size, so every layout works at any
// screen size. Zone n pays ×(1 + 0.5n).

import type { Pt } from './grid';
import { Rng } from './rng';

export interface ZoneLayout {
  walls: Pt[];
  spikes: Pt[];
  mud: Pt[];
}

export interface ZoneDef {
  id: string;
  name: string;
  mult: number;
  desc: string;
  build: (cols: number, rows: number) => ZoneLayout;
}

const empty = (): ZoneLayout => ({ walls: [], spikes: [], mud: [] });

function box(cols: number, rows: number): ZoneLayout {
  const out = empty();
  const ix = Math.floor(cols * 0.25);
  const iy = Math.floor(rows * 0.25);
  const x0 = ix, x1 = cols - 1 - ix, y0 = iy, y1 = rows - 1 - iy;
  const cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
  const gapX = (x: number) => x >= cx - 2 && x <= cx + 1;
  const gapY = (y: number) => y >= cy - 1 && y <= cy;
  for (let x = x0; x <= x1; x++) {
    if (gapX(x)) continue;
    out.walls.push({ x, y: y0 }, { x, y: y1 });
  }
  for (let y = y0 + 1; y < y1; y++) {
    if (gapY(y)) continue;
    out.walls.push({ x: x0, y }, { x: x1, y });
  }
  return out;
}

function cross(cols: number, rows: number): ZoneLayout {
  const out = empty();
  const cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
  const ix = Math.floor(cols * 0.2), iy = Math.floor(rows * 0.18);
  for (let x = ix; x <= cols - 1 - ix; x++) {
    if (x >= cx - 3 && x <= cx + 2) continue;
    out.walls.push({ x, y: cy - 1 });
  }
  for (let y = iy; y <= rows - 1 - iy; y++) {
    if (y >= cy - 3 && y <= cy + 1) continue;
    out.walls.push({ x: cx, y });
  }
  return out;
}

function tunnels(cols: number, rows: number): ZoneLayout {
  const out = empty();
  const gaps = [Math.floor(cols / 4), Math.floor(cols / 2), Math.floor((3 * cols) / 4)];
  for (let k = 1; k <= 3; k++) {
    const y = Math.floor((rows * k) / 4);
    for (let x = 2; x <= cols - 3; x++) {
      const g = gaps.find((gx) => x === gx || x === gx + 1);
      if (g === undefined) {
        out.walls.push({ x, y });
      } else if (g === gaps[1] || (k === 2 && x === g)) {
        // Middle tunnel on every line is spiked; the centre line also
        // spikes one cell of each side tunnel.
        out.spikes.push({ x, y });
      }
    }
  }
  return out;
}

function spiral(cols: number, rows: number): ZoneLayout {
  const out = empty();
  const cx = Math.floor(cols / 2);
  for (let d = 4, k = 0; cols - 2 * d >= 8 && rows - 2 * d >= 6; d += 4, k++) {
    const x0 = d, x1 = cols - 1 - d, y0 = d, y1 = rows - 1 - d;
    const openTop = k % 2 === 0;
    for (let x = x0; x <= x1; x++) {
      const inGap = x >= cx - 1 && x <= cx;
      if (!(openTop && inGap)) out.walls.push({ x, y: y0 });
      if (!(!openTop && inGap)) out.walls.push({ x, y: y1 });
    }
    for (let y = y0 + 1; y < y1; y++) out.walls.push({ x: x0, y }, { x: x1, y });
  }
  const wallSet = new Set(out.walls.map((p) => p.x + ',' + p.y));
  const rng = new Rng(`mud:${cols}x${rows}`);
  const target = Math.floor(cols * rows * 0.025);
  for (let tries = 0; out.mud.length < target && tries < target * 20; tries++) {
    const p = { x: rng.int(1, cols - 2), y: rng.int(1, rows - 2) };
    const k = p.x + ',' + p.y;
    if (wallSet.has(k)) continue;
    wallSet.add(k);
    out.mud.push(p);
  }
  return out;
}

export const ZONES: ZoneDef[] = [
  { id: 'open', name: 'Open', mult: 1, desc: 'No walls. The only zone where the Hamiltonian brain runs.', build: empty },
  { id: 'box', name: 'Box', mult: 1.5, desc: 'A walled box with four doors.', build: box },
  { id: 'cross', name: 'Cross', mult: 2, desc: 'Four arms split the board.', build: cross },
  { id: 'tunnels', name: 'Tunnels', mult: 2.5, desc: 'Walled rows. Spikes pulse in the tunnels — tap to jam them.', build: tunnels },
  { id: 'spiral', name: 'Spiral', mult: 3, desc: 'Nested rings with mud that slows the head.', build: spiral },
];

export const zoneMult = (n: number) => 1 + 0.5 * n;
