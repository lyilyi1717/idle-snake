import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { trialRun } from '../src/core/runs';
import { Sim } from '../src/core/sim';
import { baseConfig, moltEvent, runTicks } from './helpers';

// Balance probe, not a test: PROBE=out.txt npx vitest run tests/probe.test.ts
it.skipIf(!process.env.PROBE)('probe', () => {
  const out: string[] = [];
  for (const trial of [2, 3, 4]) {
    for (const tier of [1, 2, 3, 4]) {
      const sim = new Sim({ ...trialRun(trial), brain: tier });
      runTicks(sim, 20000);
      const m = moltEvent(sim);
      out.push(`trial ${trial} tier ${tier}: eaten ${sim.applesEaten} ${m ? 'MOLT ' + m.reason : sim.over ? 'PASS' : 'timeout'} L=${sim.snake.length}`);
    }
  }
  for (const tier of [1, 2, 3, 4]) {
    for (const seed of ['a', 'b', 'c']) {
      const sim = new Sim(baseConfig({ cols: 48, rows: 30, brain: tier, creep: true, ringIntervalMs: 16000, seed }));
      runTicks(sim, 100000);
      const m = moltEvent(sim);
      out.push(`open tier ${tier} seed ${seed}: eaten ${sim.applesEaten} rings ${sim.rings} t=${(sim.time / 1000).toFixed(0)}s ${m?.reason} phi=${m?.phi.toFixed(2)} L=${m?.length}`);
    }
  }
  writeFileSync(process.env.PROBE!, out.join('\n'));
});
