// Persistent profile: schema, defaults, and migration from the pre-idle
// save (`nokiaSnake.state.v1`). Storage is injected, so this stays testable.

import type { Pt } from './grid';

export interface PortalPos {
  a: Pt;
  b: Pt;
}

export interface HighScore {
  score: number;
  date: string;
  phi: number;
  zone: number;
}

export interface Profile {
  v: 2;
  coins: number;
  points: number;
  skinMult: number;
  moltCount: number;
  brainTier: number;
  activeBrain: number;
  zone: number;
  maxZone: number;
  skillLevels: Record<string, number>;
  portalPairs: number;
  portalLayout: (PortalPos | null)[];
  unlockedSkins: string[];
  unlockedTrails: string[];
  ownedUpgrades: string[];
  unlockedAchievements: string[];
  unlockedRankTiers: string[];
  settings: { muted: boolean; music: boolean; crt: boolean; skin: string; trail: string };
  stats: {
    runs: number;
    applesEaten: number;
    goldenApplesEaten: number;
    bestScore: number;
    maxLength: number;
    lifetimeCoinsEarned: number;
    lifetimeScore: number;
    activePlaySeconds: number;
    miceCaught: number;
    bestPhi: number;
    jackpots: number;
  };
  highScores: HighScore[];
  lastSeen: number;
  /** Coins per active second measured over the last session, or null before the first one. */
  lastSessionRate: number | null;
  trialRetryUntil: Record<string, number>;
  daily: Record<string, number>;
}

export const SAVE_KEY = 'nokiaSnake.idle.v2';
export const LEGACY_KEY = 'nokiaSnake.state.v1';

export function defaultProfile(now = Date.now()): Profile {
  return {
    v: 2,
    coins: 0,
    points: 0,
    skinMult: 1,
    moltCount: 0,
    brainTier: 1,
    activeBrain: 1,
    zone: 0,
    maxZone: 0,
    skillLevels: {},
    portalPairs: 0,
    portalLayout: [],
    unlockedSkins: ['classic'],
    unlockedTrails: ['none'],
    ownedUpgrades: [],
    unlockedAchievements: [],
    unlockedRankTiers: [],
    settings: { muted: false, music: false, crt: true, skin: 'classic', trail: 'none' },
    stats: {
      runs: 0,
      applesEaten: 0,
      goldenApplesEaten: 0,
      bestScore: 0,
      maxLength: 3,
      lifetimeCoinsEarned: 0,
      lifetimeScore: 0,
      activePlaySeconds: 0,
      miceCaught: 0,
      bestPhi: 0,
      jackpots: 0,
    },
    highScores: [],
    lastSeen: now,
    lastSessionRate: null,
    trialRetryUntil: {},
    daily: {},
  };
}

/** Skill nodes that survive the idle pivot. Anything else in an old save is refunded. */
const KEPT_NODES = new Set([
  'awakenCoil', 'keenAppetite', 'sharpFangs', 'goldenInstinct', 'ravenousGrowth', 'apexPredator',
  'luckyScales', 'heavyPockets', 'frugalForager', 'idleMasteryII', 'serpentsFortune',
]);

type NodeCostFn = (id: string, level: number) => { cost: number; currency: 'coins' | 'points' } | null;

/**
 * Converts a v1 (pre-idle) save. Currencies, cosmetics, achievements, ranks,
 * stats and kept skill levels carry over. Levels in removed nodes (abilities,
 * vitality) are refunded at the price the player paid for them.
 */
export function migrateLegacy(old: any, legacyCost: NodeCostFn, now = Date.now()): Profile {
  const p = defaultProfile(now);
  const eco = old?.economy ?? {};
  const st = old?.stats ?? {};
  p.coins = num(eco.coins);
  p.points = num(eco.points);
  p.unlockedSkins = arr(eco.unlockedSkins, ['classic']);
  p.unlockedTrails = arr(eco.unlockedTrails, ['none']);
  p.ownedUpgrades = arr(eco.ownedUpgrades, []);
  p.unlockedAchievements = arr(eco.unlockedAchievements, []);
  p.unlockedRankTiers = arr(eco.unlockedRankTiers, []);
  const levels: Record<string, number> = eco.skillLevels && typeof eco.skillLevels === 'object' ? eco.skillLevels : {};
  for (const [id, lvl] of Object.entries(levels)) {
    const n = num(lvl);
    if (KEPT_NODES.has(id)) {
      p.skillLevels[id] = n;
      continue;
    }
    for (let l = 0; l < n; l++) {
      const c = legacyCost(id, l);
      if (!c) continue;
      if (c.currency === 'points') p.points += c.cost;
      else p.coins += c.cost;
    }
  }
  if (old?.settings) {
    p.settings.muted = !!old.settings.muted;
    p.settings.crt = old.settings.crtEffect !== false;
    if (typeof old.settings.skin === 'string') p.settings.skin = old.settings.skin;
    if (typeof old.settings.trail === 'string') p.settings.trail = old.settings.trail;
  }
  p.stats.runs = num(st.gamesPlayed);
  p.stats.applesEaten = num(st.applesEaten);
  p.stats.goldenApplesEaten = num(st.goldenApplesEaten);
  p.stats.bestScore = num(st.bestScore);
  p.stats.maxLength = Math.max(3, num(st.maxLength));
  p.stats.lifetimeCoinsEarned = num(st.lifetimeCoinsEarned);
  p.stats.lifetimeScore = num(st.lifetimeScore);
  p.stats.activePlaySeconds = num(st.activePlaySeconds);
  if (Array.isArray(old?.highScores)) {
    p.highScores = old.highScores
      .filter((h: any) => h && typeof h.score === 'number')
      .map((h: any) => ({ score: h.score, date: String(h.date ?? ''), phi: 0, zone: 0 }));
  }
  if (typeof old?.lastSeen === 'number') p.lastSeen = old.lastSeen;
  return p;
}

/** Fills in fields added after a save was written, so old v2 saves keep loading. */
export function normalize(saved: any, now = Date.now()): Profile {
  const d = defaultProfile(now);
  if (!saved || typeof saved !== 'object') return d;
  return {
    ...d,
    ...saved,
    v: 2,
    settings: { ...d.settings, ...(saved.settings ?? {}) },
    stats: { ...d.stats, ...(saved.stats ?? {}) },
    skillLevels: { ...(saved.skillLevels ?? {}) },
    portalLayout: Array.isArray(saved.portalLayout) ? saved.portalLayout : [],
    trialRetryUntil: { ...(saved.trialRetryUntil ?? {}) },
    daily: { ...(saved.daily ?? {}) },
  };
}

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function browserKV(): KV {
  return {
    get: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* storage full or blocked: the game keeps running unsaved */
      }
    },
    remove: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}

export function memoryKV(init: Record<string, string> = {}): KV {
  const m = new Map(Object.entries(init));
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

export function loadProfile(kv: KV, legacyCost: NodeCostFn, now = Date.now()): Profile {
  const parse = (raw: string | null) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const cur = parse(kv.get(SAVE_KEY)) ?? parse(kv.get(SAVE_KEY + '.backup'));
  if (cur) return normalize(cur, now);
  const legacy = parse(kv.get(LEGACY_KEY));
  if (legacy) return migrateLegacy(legacy, legacyCost, now);
  return defaultProfile(now);
}

export function saveProfile(kv: KV, p: Profile) {
  const prev = kv.get(SAVE_KEY);
  if (prev) kv.set(SAVE_KEY + '.backup', prev);
  kv.set(SAVE_KEY, JSON.stringify(p));
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);
const arr = (v: unknown, dflt: string[]) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : dflt);
