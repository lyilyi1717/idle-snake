// Economy: catalogs (skins, trails, skill tree, brains, portals, badges,
// ranks) and the `Meta` wrapper that mutates the persistent Profile.
//
// Multiplier structure (docs/game-theory-design.md §4): each category is
// additive inside itself, and categories multiply together:
//   chili × buff × (1 + skill tree) × combo × skin (Molt prestige) × zone

import type { Profile } from './profile';
import { Rng } from './rng';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const BASE_SPEED = 10;
export const MAX_SPEED = 30;
export const COIN_PER_POINT = 0.2;
export const IDLE_MAX_SECONDS = 12 * 60 * 60;
export const IDLE_MIN_SECONDS = 30;
export const OFFLINE_RATE_FACTOR = 0.4;
export const RUN_CLOCK_MS = 240_000;

export const BRAIN_NAMES = ['', 'Greedy', 'Pathfinder', 'Survivor', 'Hamiltonian'];
export const BRAIN_DESC = [
  '',
  'Heads straight for the apple. Traps itself often.',
  'Shortest path (BFS), portal-aware.',
  'BFS + checks the tail stays reachable. Auto-Prunes when boxed in.',
  'Follows a Hamiltonian cycle with safe shortcuts. Never traps. Ignores portals; Open zone only.',
];
export const BRAIN_PRICE: Record<number, number> = { 2: 500, 3: 3000, 4: 15000 };

export const PORTAL_PRICES = [400, 1500, 6000];
export const PORTAL_COLORS = [0x33d6e0, 0xff7ad9, 0xf2c94c];

// ---------------------------------------------------------------------------
// Molt payout
// ---------------------------------------------------------------------------

/**
 * J factor. The 3× jackpot needs the Hamiltonian brain: once the creep trims
 * a long snake to fit the last few rings, any survivor can hit φ ≥ 0.95, so
 * tiers 1–3 are capped at 1.5×.
 */
export function jackpotFactor(phi: number, tier = 4): number {
  if (phi >= 0.95 && tier >= 4) return 3;
  if (phi >= 0.75) return 1.5;
  return 1;
}

/** ΔSkin = 0.01 · √L · J */
export function moltPayout(length: number, phi: number, tier = 4): number {
  return 0.01 * Math.sqrt(length) * jackpotFactor(phi, tier);
}

export const comboMult = (combo: number) => Math.min(3, 1 + 0.1 * combo);

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

export interface Skin {
  id: string;
  name: string;
  cost: number;
  bg: number;
  grid: number;
  snake: number;
  snakeHead: number;
  food: number;
  golden: number;
  text: number;
}

export const SKINS: Record<string, Skin> = {
  classic: { id: 'classic', name: 'Classic Olive', cost: 0, bg: 0x9bab77, grid: 0x8ba368, snake: 0x2b3a22, snakeHead: 0x1f2b18, food: 0x4a5a32, golden: 0xf4f9e8, text: 0x1f2b18 },
  amber: { id: 'amber', name: 'Amber Glow', cost: 50, bg: 0xdcb14a, grid: 0xc79a30, snake: 0x3a2405, snakeHead: 0x241600, food: 0x5c3d08, golden: 0xfff3c9, text: 0x241600 },
  ice: { id: 'ice', name: 'Ice Blue', cost: 75, bg: 0xaad4dc, grid: 0x8cc0cb, snake: 0x123844, snakeHead: 0x082026, food: 0x235866, golden: 0xf2fdff, text: 0x082026 },
  night: { id: 'night', name: 'Inverted Night', cost: 100, bg: 0x1a1f14, grid: 0x262d1a, snake: 0x9bd94a, snakeHead: 0xcdf98a, food: 0x6f9c2e, golden: 0xffffff, text: 0xcdf98a },
};

export const TRAILS: Record<string, { id: string; name: string; cost: number }> = {
  none: { id: 'none', name: 'No Trail', cost: 0 },
  sparkle: { id: 'sparkle', name: 'Sparkle Trail', cost: 60 },
  dust: { id: 'dust', name: 'Pixel Dust', cost: 90 },
};

export const UPGRADES: Record<string, { id: string; name: string; desc: string; cost: number; multiplier: number }> = {
  idleMultiplier: { id: 'idleMultiplier', name: 'Offline Snack Stash', desc: '+50% coins earned while away', cost: 120, multiplier: 1.5 },
};

export type Currency = 'coins' | 'points';

export interface SkillNode {
  id: string;
  name: string;
  desc: string;
  baseCost: number;
  costMultiplier: number;
  maxLevel: number;
  currency: Currency;
  bonusPerLevel?: number;
  prereq?: { nodeId: string; minLevel?: number }[];
  /** Needs this brain tier owned before it can be bought. */
  brainTier?: number;
}

export interface SkillBranch {
  id: string;
  name: string;
  requiresRoot: boolean;
  nodes: SkillNode[];
}

export const ROOT_NODE_ID = 'awakenCoil';
const K_COINS = 25;
const K_POINTS = 15;

export const SKILL_TREE: SkillBranch[] = [
  {
    id: 'root', name: 'Root', requiresRoot: false,
    nodes: [
      { id: ROOT_NODE_ID, name: 'Awaken the Coil', desc: 'Flat +2% score. Unlocks the Score and Economy branches.', baseCost: 25 * K_COINS, costMultiplier: 1, bonusPerLevel: 0.02, maxLevel: 1, currency: 'coins' },
    ],
  },
  {
    id: 'engine', name: 'Engine', requiresRoot: false,
    nodes: [
      { id: 'quickScales', name: 'Quick Scales', desc: '+1 base speed (ticks/s) per level', baseCost: 100, costMultiplier: 1.15, maxLevel: 10, currency: 'coins' },
      { id: 'slowTide', name: 'Slow Tide', desc: '+15% time between arena rings per level', baseCost: 250, costMultiplier: 1.25, maxLevel: 5, currency: 'coins' },
      { id: 'comboLure', name: 'Combo Lure', desc: '+3 ticks combo window per level', baseCost: 350, costMultiplier: 1.4, maxLevel: 5, currency: 'coins' },
      { id: 'spareShears', name: 'Spare Shears', desc: '+1 auto-Prune charge per run', baseCost: 300, costMultiplier: 3, maxLevel: 2, currency: 'coins', brainTier: 3 },
    ],
  },
  {
    id: 'scoreMastery', name: 'Score Mastery', requiresRoot: true,
    nodes: [
      { id: 'keenAppetite', name: 'Keen Appetite', desc: '+5% score per level', baseCost: 40, costMultiplier: 1.12, bonusPerLevel: 0.05, maxLevel: 10, currency: 'coins' },
      { id: 'sharpFangs', name: 'Sharp Fangs', desc: '+8% score per level', baseCost: 90, costMultiplier: 1.12, bonusPerLevel: 0.08, maxLevel: 8, currency: 'coins' },
      { id: 'goldenInstinct', name: 'Golden Instinct', desc: '+15% score per level', baseCost: 200, costMultiplier: 1.14, bonusPerLevel: 0.15, maxLevel: 5, currency: 'coins', prereq: [{ nodeId: 'keenAppetite', minLevel: 5 }, { nodeId: 'sharpFangs', minLevel: 4 }] },
      { id: 'ravenousGrowth', name: 'Ravenous Growth', desc: '+25% score per level', baseCost: 900 * K_COINS, costMultiplier: 1.16, bonusPerLevel: 0.25, maxLevel: 5, currency: 'coins', prereq: [{ nodeId: 'goldenInstinct', minLevel: 5 }] },
      { id: 'apexPredator', name: 'Apex Predator', desc: '+100% score, one-time capstone', baseCost: 6000 * K_POINTS, costMultiplier: 1, bonusPerLevel: 1, maxLevel: 1, currency: 'points', prereq: [{ nodeId: 'ravenousGrowth', minLevel: 5 }] },
    ],
  },
  {
    id: 'economy', name: 'Economy', requiresRoot: true,
    nodes: [
      { id: 'luckyScales', name: 'Lucky Scales', desc: 'Golden apple chance +0.5% per level', baseCost: 300 * K_COINS, costMultiplier: 1.13, maxLevel: 6, currency: 'coins' },
      { id: 'heavyPockets', name: 'Heavy Pockets', desc: 'Golden apple reward +1 coin per level', baseCost: 500 * K_COINS, costMultiplier: 1.14, maxLevel: 5, currency: 'coins' },
      { id: 'frugalForager', name: 'Frugal Forager', desc: 'Molt coin bonus divisor 25 → 20', baseCost: 400 * K_COINS, costMultiplier: 1.15, maxLevel: 5, currency: 'coins' },
      { id: 'idleMasteryII', name: 'Idle Mastery II', desc: 'Offline earnings +10% per level', baseCost: 350 * K_COINS, costMultiplier: 1.13, maxLevel: 5, currency: 'coins' },
      { id: 'serpentsFortune', name: "Serpent's Fortune", desc: 'High-Score Momentum divisors −15% (capstone)', baseCost: 2500 * K_POINTS, costMultiplier: 1, maxLevel: 1, currency: 'points' },
    ],
  },
];

/** Prices of the nodes removed by the idle pivot, used to refund old saves. */
const LEGACY_NODES: Record<string, [number, number, Currency]> = {
  bodyToss: [150, 1, 'coins'], phaseWalls: [750, 1, 'coins'], biggerBite: [3500, 1, 'coins'], autoCollect: [17500, 1, 'coins'],
  swiftRecoil: [7500, 1.18, 'coins'], thinnerWalls: [10000, 1.15, 'coins'], longerFangs: [8750, 1.15, 'coins'], extendedInstinct: [12500, 1.15, 'coins'],
  porousScales: [18000, 1.35, 'points'], ravenousForm: [15000, 1.35, 'points'], relentlessPursuit: [22500, 1.3, 'points'],
  permeableScales: [75000, 1, 'points'], perpetualMolt: [67500, 1, 'points'],
  thickHide: [62500, 1.6, 'coins'], quickRegeneration: [27000, 1.4, 'points'],
};

export function legacyNodeCost(id: string, level: number) {
  const n = LEGACY_NODES[id];
  if (!n) return null;
  return { cost: Math.ceil(n[0] * Math.pow(n[1], level)), currency: n[2] };
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  coins: number;
  check: (p: Profile) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_bite', name: 'First Bite', desc: 'Eat your first apple', coins: 5, check: (p) => p.stats.applesEaten >= 1 },
  { id: 'score_50', name: 'Getting Warmed Up', desc: 'Score 50 in one run', coins: 10, check: (p) => p.stats.bestScore >= 50 },
  { id: 'score_150', name: 'Grid Runner', desc: 'Score 150 in one run', coins: 20, check: (p) => p.stats.bestScore >= 150 },
  { id: 'score_300', name: 'LCD Legend', desc: 'Score 300 in one run', coins: 35, check: (p) => p.stats.bestScore >= 300 },
  { id: 'golden_hunter', name: 'Golden Hunter', desc: 'Eat 5 golden apples', coins: 25, check: (p) => p.stats.goldenApplesEaten >= 5 },
  { id: 'marathon', name: 'Marathon', desc: 'Reach a snake length of 20', coins: 20, check: (p) => p.stats.maxLength >= 20 },
  { id: 'survivor', name: 'Shed Skin', desc: 'Molt 10 times', coins: 20, check: (p) => p.moltCount >= 10 },
  { id: 'mouser', name: 'Mouser', desc: 'Catch 5 mice', coins: 25, check: (p) => p.stats.miceCaught >= 5 },
  { id: 'packed', name: 'Packed Tight', desc: 'Molt at 75% fill or more', coins: 40, check: (p) => p.stats.bestPhi >= 0.75 },
  { id: 'jackpot', name: 'Ouroboros Jackpot', desc: 'Molt at 95% fill or more', coins: 150, check: (p) => p.stats.jackpots >= 1 },
  { id: 'zone_box', name: 'Out of the Box', desc: 'Unlock the Box zone', coins: 50, check: (p) => p.maxZone >= 1 },
  { id: 'zone_spiral', name: 'Spiral Down', desc: 'Unlock the Spiral zone', coins: 300, check: (p) => p.maxZone >= 4 },
];

export interface RankTier {
  id: string;
  tier: number;
  threshold: number;
  name: string;
  reward: number;
}

export const RANK_TIERS_COINS: RankTier[] = [
  { id: 'coinRank1', tier: 1, threshold: 10, name: 'Crumb Finder', reward: 5 },
  { id: 'coinRank2', tier: 2, threshold: 100, name: 'Apple Scout', reward: 15 },
  { id: 'coinRank3', tier: 3, threshold: 1000, name: 'Golden Forager', reward: 50 },
  { id: 'coinRank4', tier: 4, threshold: 10000, name: 'Coin Serpent', reward: 150 },
  { id: 'coinRank5', tier: 5, threshold: 100000, name: 'Vault Viper', reward: 500 },
  { id: 'coinRank6', tier: 6, threshold: 1000000, name: 'Pixel Tycoon', reward: 1500 },
  { id: 'coinRank7', tier: 7, threshold: 10000000, name: 'Mythic Coil', reward: 5000 },
];

export const RANK_TIERS_SCORE: RankTier[] = [
  { id: 'scoreRank1', tier: 1, threshold: 1000, name: 'Sprout', reward: 10 },
  { id: 'scoreRank2', tier: 2, threshold: 10000, name: 'Vine', reward: 30 },
  { id: 'scoreRank3', tier: 3, threshold: 100000, name: 'Python', reward: 100 },
  { id: 'scoreRank4', tier: 4, threshold: 1000000, name: 'Anaconda', reward: 300 },
  { id: 'scoreRank5', tier: 5, threshold: 10000000, name: 'Leviathan', reward: 1000 },
  { id: 'scoreRank6', tier: 6, threshold: 100000000, name: 'Ouroboros', reward: 3000 },
];

export function rankProgress(tiers: RankTier[], value: number) {
  let currentTier: RankTier | null = null;
  let nextTier: RankTier | null = null;
  for (const t of tiers) {
    if (value >= t.threshold) currentTier = t;
    else {
      nextTier = t;
      break;
    }
  }
  return { currentValue: value, currentTier, nextTier };
}

export const MOCK_STORE: Record<string, { label: string; priceLabel: string; coins: number }> = {
  coin_pack_small: { label: 'Coin Pack — 100 Coins', priceLabel: '$0.99 (mock, not charged)', coins: 100 },
  coin_pack_large: { label: 'Coin Pack — 550 Coins', priceLabel: '$3.99 (mock, not charged)', coins: 550 },
};

const GOLDEN = { minChance: 0.07, maxChance: 0.16, minCooldown: 4, maxCooldown: 8 };
const MOMENTUM = { goldenDivisor: 300, goldenCap: 900, chiliDivisor: 450, chiliCap: 900, runEndDivisor: 250, runEndCap: 1000 };
const IDLE_FALLBACK = { coinsPerSecond: 1 / 45, bestScoreDivisor: 150 };
const HIGH_SCORE_LIMIT = 10;

export interface Notice {
  kind: 'achievement' | 'rank' | 'info';
  text: string;
}

// ---------------------------------------------------------------------------
// Meta: every mutation of the persistent profile goes through here.
// ---------------------------------------------------------------------------

export class Meta {
  notices: Notice[] = [];
  dirty = false;
  private goldenCooldown: number;
  private checkingRanks = false;

  constructor(public p: Profile, private rng: Rng = new Rng()) {
    this.goldenCooldown = rng.int(GOLDEN.minCooldown, GOLDEN.maxCooldown);
  }

  // ----- currencies -----
  addCoins(n: number) {
    if (!(n > 0)) return;
    this.p.coins += n;
    this.p.stats.lifetimeCoinsEarned += n;
    this.dirty = true;
    this.checkRanks();
  }
  spendCoins(n: number) {
    if (n > this.p.coins) return false;
    this.p.coins -= n;
    this.dirty = true;
    return true;
  }
  addPoints(n: number) {
    if (!(n > 0)) return;
    this.p.points += n;
    this.p.stats.lifetimeScore += n;
    this.dirty = true;
    this.checkRanks();
  }
  spendPoints(n: number) {
    if (n > this.p.points) return false;
    this.p.points -= n;
    this.dirty = true;
    return true;
  }
  private spend(currency: Currency, n: number) {
    return currency === 'points' ? this.spendPoints(n) : this.spendCoins(n);
  }

  // ----- skill tree -----
  level(id: string) {
    return this.p.skillLevels[id] || 0;
  }
  findNode(id: string): { node: SkillNode; branch: SkillBranch } | null {
    for (const branch of SKILL_TREE) {
      const node = branch.nodes.find((n) => n.id === id);
      if (node) return { node, branch };
    }
    return null;
  }
  nodeCost(id: string) {
    const f = this.findNode(id);
    if (!f) return Infinity;
    const lvl = this.level(id);
    if (lvl >= f.node.maxLevel) return Infinity;
    return Math.ceil(f.node.baseCost * Math.pow(f.node.costMultiplier, lvl));
  }
  nodePrereqMet(id: string) {
    const f = this.findNode(id);
    if (!f) return false;
    if (f.branch.requiresRoot && this.level(ROOT_NODE_ID) < 1) return false;
    if (f.node.brainTier && this.p.brainTier < f.node.brainTier) return false;
    return (f.node.prereq ?? []).every((c) => this.level(c.nodeId) >= (c.minLevel ?? 1));
  }
  buyNode(id: string) {
    const f = this.findNode(id);
    if (!f || this.level(id) >= f.node.maxLevel || !this.nodePrereqMet(id)) return false;
    if (!this.spend(f.node.currency, this.nodeCost(id))) return false;
    this.p.skillLevels[id] = this.level(id) + 1;
    this.dirty = true;
    return true;
  }
  scoreTreeBonus() {
    let sum = 0;
    for (const b of SKILL_TREE) {
      if (b.id !== 'root' && b.id !== 'scoreMastery') continue;
      for (const n of b.nodes) sum += this.level(n.id) * (n.bonusPerLevel ?? 0);
    }
    return sum;
  }

  // ----- derived tuning -----
  baseSpeed() {
    return BASE_SPEED + this.level('quickScales');
  }
  ringIntervalMs(cols: number, rows: number) {
    const rings = Math.max(1, Math.floor(Math.min(cols, rows) / 2));
    return (RUN_CLOCK_MS / rings) * (1 + 0.15 * this.level('slowTide'));
  }
  comboWindow() {
    return 25 + 3 * this.level('comboLure');
  }
  pruneCharges() {
    return 1 + this.level('spareShears');
  }

  // ----- cosmetics / shop -----
  buySkin(id: string) {
    const s = SKINS[id];
    if (!s || this.p.unlockedSkins.includes(id) || !this.spendCoins(s.cost)) return false;
    this.p.unlockedSkins.push(id);
    return true;
  }
  buyTrail(id: string) {
    const t = TRAILS[id];
    if (!t || this.p.unlockedTrails.includes(id) || !this.spendCoins(t.cost)) return false;
    this.p.unlockedTrails.push(id);
    return true;
  }
  buyUpgrade(id: string) {
    const u = UPGRADES[id];
    if (!u || this.p.ownedUpgrades.includes(id) || !this.spendCoins(u.cost)) return false;
    this.p.ownedUpgrades.push(id);
    return true;
  }
  mockPurchase(id: string) {
    const item = MOCK_STORE[id];
    if (!item) return false;
    this.addCoins(item.coins);
    return true;
  }

  // ----- portals -----
  portalPairPrice(k = this.p.portalPairs) {
    return PORTAL_PRICES[k] ?? Infinity;
  }
  /** Why the next pair can't be bought yet, or null if it can (ignoring price). */
  portalGate(k = this.p.portalPairs): string | null {
    if (k >= PORTAL_PRICES.length) return 'All 3 pairs owned';
    if (this.p.brainTier < 2) return 'Needs the Pathfinder brain';
    if (k === 2 && this.p.maxZone < 3) return 'Needs the Tunnels zone';
    return null;
  }
  buyPortalPair() {
    if (this.portalGate()) return false;
    if (!this.spendCoins(this.portalPairPrice())) return false;
    this.p.portalPairs += 1;
    this.dirty = true;
    return true;
  }

  // ----- trials -----
  static readonly TRIAL_RETRY_MS = 10 * 60 * 1000;
  trialFree(tier: number, now: number) {
    return (this.p.trialRetryUntil[tier] ?? 0) > now;
  }
  /** Pays for a trial attempt unless a free retry is active. */
  enterTrial(tier: number, now: number) {
    if (tier !== this.p.brainTier + 1 || !BRAIN_PRICE[tier]) return false;
    if (this.trialFree(tier, now)) return true;
    if (!this.spendCoins(BRAIN_PRICE[tier])) return false;
    this.p.trialRetryUntil[tier] = now + Meta.TRIAL_RETRY_MS;
    return true;
  }
  passTrial(tier: number) {
    if (tier <= this.p.brainTier) return;
    this.p.brainTier = tier;
    this.p.activeBrain = tier;
    delete this.p.trialRetryUntil[tier];
    this.dirty = true;
    this.notices.push({ kind: 'info', text: `Brain upgraded: ${BRAIN_NAMES[tier]}` });
  }

  // ----- golden apples / momentum -----
  rollGolden() {
    if (this.goldenCooldown > 0) {
      this.goldenCooldown -= 1;
      return false;
    }
    const bonus = 0.005 * this.level('luckyScales');
    const chance = GOLDEN.minChance + bonus + this.rng.float() * (GOLDEN.maxChance - GOLDEN.minChance);
    const hit = this.rng.chance(chance);
    if (hit) this.goldenCooldown = this.rng.int(GOLDEN.minCooldown, GOLDEN.maxCooldown);
    return hit;
  }
  momentum(divisor: number, cap: number) {
    const div = divisor * (this.level('serpentsFortune') >= 1 ? 0.85 : 1);
    return 1 + Math.min(this.p.stats.bestScore, cap) / div;
  }
  goldenReward() {
    const f = this.momentum(MOMENTUM.goldenDivisor, MOMENTUM.goldenCap);
    const h = this.level('heavyPockets');
    return this.rng.int(Math.round((5 + h) * f), Math.round((20 + h) * f));
  }
  chiliCoinBonus() {
    const f = this.momentum(MOMENTUM.chiliDivisor, MOMENTUM.chiliCap);
    return this.rng.int(Math.round(1 * f), Math.round(4 * f));
  }
  runEndBonus(score: number) {
    const f = this.momentum(MOMENTUM.runEndDivisor, MOMENTUM.runEndCap);
    return Math.floor((score / (25 - this.level('frugalForager'))) * f);
  }

  // ----- offline earnings -----
  idleMultiplier() {
    const stash = this.p.ownedUpgrades.includes('idleMultiplier') ? UPGRADES.idleMultiplier.multiplier : 1;
    return stash * (1 + 0.1 * this.level('idleMasteryII'));
  }
  /** Coins/s while away: 0.4 × last session's measured rate, or the old trickle before any session. */
  idleRate() {
    const r = this.p.lastSessionRate;
    const base =
      r !== null && r > 0
        ? OFFLINE_RATE_FACTOR * r
        : IDLE_FALLBACK.coinsPerSecond * (1 + this.p.stats.bestScore / IDLE_FALLBACK.bestScoreDivisor);
    return base * this.idleMultiplier();
  }
  computeIdleReward(now: number) {
    const elapsedSec = Math.max(0, (now - this.p.lastSeen) / 1000);
    const cappedSec = Math.min(elapsedSec, IDLE_MAX_SECONDS);
    if (elapsedSec < IDLE_MIN_SECONDS) return { coins: 0, elapsedSec, cappedSec };
    return { coins: Math.floor(cappedSec * this.idleRate()), elapsedSec, cappedSec };
  }
  claimIdle(now: number) {
    const r = this.computeIdleReward(now);
    if (r.coins > 0) this.addCoins(r.coins);
    this.p.lastSeen = now;
    this.dirty = true;
    return r;
  }

  // ----- run end -----
  recordRun(r: { score: number; length: number; applesEaten: number; goldenApplesEaten: number; phi: number; zone: number }) {
    const s = this.p.stats;
    s.runs += 1;
    s.applesEaten += r.applesEaten;
    s.goldenApplesEaten += r.goldenApplesEaten;
    s.bestScore = Math.max(s.bestScore, r.score);
    s.maxLength = Math.max(s.maxLength, r.length);
    s.bestPhi = Math.max(s.bestPhi, r.phi);
    const bonus = this.runEndBonus(r.score);
    if (bonus > 0) this.addCoins(bonus);
    const entry = { score: r.score, date: new Date().toISOString(), phi: r.phi, zone: r.zone };
    this.p.highScores.push(entry);
    this.p.highScores.sort((a, b) => b.score - a.score);
    const rank = this.p.highScores.indexOf(entry);
    this.p.highScores = this.p.highScores.slice(0, HIGH_SCORE_LIMIT);
    this.dirty = true;
    return { bonus, isHighScore: rank >= 0 && rank < HIGH_SCORE_LIMIT && r.score > 0 };
  }

  /** Applies a Molt's prestige payout and zone unlock. Returns the ΔSkin granted. */
  applyMolt(length: number, phi: number, zone: number, tier: number) {
    const delta = moltPayout(length, phi, tier);
    this.p.skinMult += delta;
    this.p.moltCount += 1;
    if (jackpotFactor(phi, tier) === 3) this.p.stats.jackpots += 1;
    let unlocked: number | null = null;
    if (phi >= 0.75 && zone === this.p.maxZone && zone < 4) {
      this.p.maxZone = zone + 1;
      unlocked = zone + 1;
    }
    this.dirty = true;
    return { delta, unlocked };
  }

  checkAchievements() {
    for (const a of ACHIEVEMENTS) {
      if (this.p.unlockedAchievements.includes(a.id) || !a.check(this.p)) continue;
      this.p.unlockedAchievements.push(a.id);
      this.addCoins(a.coins);
      this.notices.push({ kind: 'achievement', text: `Badge: ${a.name} (+${a.coins})` });
    }
  }

  private checkRanks() {
    if (this.checkingRanks) return;
    this.checkingRanks = true;
    try {
      const grant = (t: RankTier, label: string) => {
        this.p.unlockedRankTiers.push(t.id);
        this.addCoins(t.reward);
        this.notices.push({ kind: 'rank', text: `${label} rank: ${t.name} (+${t.reward})` });
      };
      for (const t of RANK_TIERS_COINS)
        if (!this.p.unlockedRankTiers.includes(t.id) && this.p.stats.lifetimeCoinsEarned >= t.threshold) grant(t, 'Coin');
      for (const t of RANK_TIERS_SCORE)
        if (!this.p.unlockedRankTiers.includes(t.id) && this.p.stats.lifetimeScore >= t.threshold) grant(t, 'Score');
    } finally {
      this.checkingRanks = false;
    }
  }
}
