import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { trialRun } from '../src/core/runs';
import { Sim } from '../src/core/sim';
import { moltEvent, runTicks } from './helpers';

// Trial tuning search: SEARCH=out.txt npx vitest run tests/dbg.test.ts
it.skipIf(!process.env.SEARCH)('search', () => {
  const out: string[] = [];
  for (const grow of [1, 2, 3]) {
    for (let k = 0; k < 12; k++) {
      const res = [1, 2, 3].map((tier) => {
        const sim = new Sim({ ...trialRun(2), brain: tier, grow, seed: `trial-2-${k}` });
        runTicks(sim, 30000);
        const m = moltEvent(sim);
        return m ? `${m.reason}@${sim.applesEaten}` : 'PASS';
      });
      out.push(`grow ${grow} seed ${k}: ${res.join(' | ')}`);
    }
  }
  writeFileSync(process.env.SEARCH!, out.join('\n'));
});
