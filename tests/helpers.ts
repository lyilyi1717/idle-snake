import { Meta } from '../src/core/economy';
import { defaultProfile } from '../src/core/profile';
import { Rng } from '../src/core/rng';
import { type RunConfig, Sim } from '../src/core/sim';

export function baseConfig(over: Partial<RunConfig> = {}): RunConfig {
  return {
    mode: 'normal',
    cols: 24,
    rows: 16,
    zone: 0,
    brain: 1,
    seed: 'test',
    creep: false,
    baseSpeed: 10,
    ringIntervalMs: 20000,
    comboWindow: 25,
    pruneCharges: 1,
    portals: [],
    treeBonus: 0,
    skinMult: 1,
    zoneMult: 1,
    multFixed: false,
    specials: false,
    tapPickups: false,
    rush: false,
    rewards: null,
    ...over,
  };
}

export function makeMeta() {
  return new Meta(defaultProfile(0), new Rng('meta'));
}

/** Runs ticks one at a time until the run ends or `maxTicks` pass. */
export function runTicks(sim: Sim, maxTicks: number) {
  for (let i = 0; i < maxTicks && !sim.over; i++) sim.advance(sim.tickMs() + 0.001);
  return sim;
}

export function moltEvent(sim: Sim) {
  return sim.events.find((e) => e.t === 'molt') as Extract<Sim['events'][number], { t: 'molt' }> | undefined;
}
