import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { masteryGain, moltPayout } from '../src/core/economy';
import { Sim } from '../src/core/sim';
import { ZONES } from '../src/core/zones';
import { baseConfig, moltEvent } from './helpers';

// Opt-in balance sweep: fill distribution, Zone Mastery earned per run, and
// prestige per minute, per brain × zone × upgrade level.
//   BALANCE=out.txt npx vitest run tests/balance.test.ts
const COLS = 48, ROWS = 30, SEEDS = 12;
const RINGS = Math.floor(Math.min(COLS, ROWS) / 2);

function run(brain: number, zone: number, speed: number, tide: number, seed: string) {
  const sim = new Sim(
    baseConfig({
      cols: COLS, rows: ROWS, brain, zone, creep: true, baseSpeed: speed, seed,
      ringIntervalMs: (240_000 / RINGS) * tide, pruneCharges: 1,
    }),
  );
  let i = 0;
  while (!sim.over && i++ < 300_000) sim.advance(sim.tickMs() + 0.001);
  const m = moltEvent(sim)!;
  return {
    phi: m?.phi ?? 0,
    reason: m?.reason ?? 'none',
    length: m?.length ?? 0,
    apples: sim.applesEaten,
    minutes: sim.time / 60_000,
    delta: moltPayout(m?.length ?? 0, m?.phi ?? 0, brain, sim.progress()),
    mastery: masteryGain(m?.phi ?? 0),
  };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

it.skipIf(!process.env.BALANCE)('balance sweep', () => {
  const out: string[] = ['brain zone speed tide | phi med | >=.75 | >=.95 | mastery/run | dSkin/run | dSkin/min | apples | top reasons'];
  for (const brain of [3, 4]) {
    for (let zone = 0; zone < ZONES.length; zone++) {
      for (const [speed, tide] of [[10, 1], [20, 1.75]] as [number, number][]) {
        const rs = Array.from({ length: SEEDS }, (_, s) => run(brain, zone, speed, tide, `b-${s}`));
        const reasons: Record<string, number> = {};
        for (const r of rs) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
        const pct = (f: (r: (typeof rs)[number]) => boolean) => Math.round((rs.filter(f).length / rs.length) * 100);
        const avg = (f: (r: (typeof rs)[number]) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
        out.push(
          [
            `T${brain}`, ZONES[zone].name.padEnd(8), `spd${speed}`, `tide${tide}`, '|',
            median(rs.map((r) => r.phi)).toFixed(2), '|',
            `${pct((r) => r.phi >= 0.75)}%`, '|', `${pct((r) => r.phi >= 0.95)}%`, '|',
            avg((r) => r.mastery).toFixed(2), '|', avg((r) => r.delta).toFixed(3), '|',
            (avg((r) => r.delta) / avg((r) => r.minutes)).toFixed(3), '|',
            avg((r) => r.apples).toFixed(0), '|',
            Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '),
          ].join(' '),
        );
      }
    }
  }
  // Molt-Now spam: how much prestige per minute you get by never playing a run.
  for (const secs of [5, 20, 60]) {
    const sim = new Sim(baseConfig({ cols: COLS, rows: ROWS, brain: 3, creep: true, baseSpeed: 10, ringIntervalMs: 240_000 / RINGS, seed: 'spam' }));
    while (sim.time < secs * 1000 && !sim.over) sim.advance(sim.tickMs() + 0.001);
    const d = moltPayout(sim.snake.length, sim.phi(), 3, sim.progress());
    out.push(`spam ${secs}s: dSkin ${d.toFixed(4)} -> ${((d / secs) * 60).toFixed(4)}/min, mastery ${masteryGain(sim.phi()).toFixed(2)}`);
  }
  writeFileSync(process.env.BALANCE!, out.join('\n'));
});
