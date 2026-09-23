import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Sim } from '../src/core/sim';
import { baseConfig, moltEvent } from './helpers';

// Opt-in diagnostic: how often the Hamiltonian brain ends a run badly (it
// should only ever end on 'closed' or 'filled'), across board sizes, speeds
// and with bursts firing mid-ring.
//   CENSUS=out.txt npx vitest run tests/tier4-census.test.ts
it.skipIf(!process.env.CENSUS)('tier 4 census', () => {
  const out: string[] = [];
  let bad = 0;
  let total = 0;
  for (const [cols, rows] of [[48, 30], [32, 20], [24, 16]] as [number, number][]) {
    for (const speed of [10, 15, 20]) {
      for (let s = 0; s < 12; s++) {
        const sim = new Sim(
          baseConfig({
            cols, rows, brain: 4, creep: true, baseSpeed: speed, seed: `t4-${s}`,
            ringIntervalMs: 240_000 / Math.floor(Math.min(cols, rows) / 2),
          }),
        );
        let i = 0;
        while (!sim.over && i++ < 200_000) {
          sim.advance(sim.tickMs() + 0.001);
          if (i % 37 === 0) sim.burst();
        }
        const m = moltEvent(sim)!;
        total++;
        if (m && m.reason !== 'closed' && m.reason !== 'filled') {
          bad++;
          out.push(`${cols}x${rows} spd${speed} seed${s}: ${m.reason} rings=${sim.rings} phi=${m.phi.toFixed(2)} L=${m.length}`);
        }
      }
    }
  }
  out.unshift(`bad ${bad}/${total}`);
  writeFileSync(process.env.CENSUS!, out.join('\n'));
  expect(bad).toBe(0);
}, 300_000);
