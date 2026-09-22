// Seeded PRNG. mulberry32 for the stream, cyrb53-style string hash for the
// seed, so "20260922" and "20260923" land far apart in seed space.

export type RandFn = () => number;

export function mulberry32(seed: number): RandFn {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

export class Rng {
  private next: RandFn;
  constructor(source: RandFn | number | string = Math.random) {
    if (typeof source === 'function') this.next = source;
    else if (typeof source === 'number') this.next = mulberry32(source);
    else this.next = mulberry32(hashSeed(source));
  }
  float(): number {
    return this.next();
  }
  /** Inclusive integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/**
 * Independent named streams from one seed. Food, mouse and expiring apples
 * each draw from their own stream, so taps or speed changes that alter how
 * often one system rolls never shift another system's sequence.
 */
export function makeStreams(seed: string | null) {
  const mk = (name: string) => (seed === null ? new Rng() : new Rng(seed + ':' + name));
  return {
    food: mk('food'),
    special: mk('special'),
    mouse: mk('mouse'),
    events: mk('events'),
  };
}
export type Streams = ReturnType<typeof makeStreams>;
