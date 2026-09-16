// economy.js — the whole monetization / reward-loop layer.
//
// Design summary (see README.md for the full write-up):
//   - "Snake Coins" are the only currency. They are earned exclusively by
//     playing (golden apples, end-of-run bonus, achievements, idle claim).
//     They can NEVER be bought with real money in this build.
//   - Coins can only buy cosmetics/convenience: skins, trail effects, and
//     one idle-multiplier upgrade. Nothing purchasable changes snake speed,
//     grants extra lives, or inflates the leaderboard score formula.
//   - Golden apples are a bounded variable-ratio reward: the *chance* to
//     see one, and the coin amount it grants when eaten, are both random
//     within hard min/max caps — never a fixed, memorizable pattern, and
//     never unbounded.
//   - Idle XP/coins trickle in based on real elapsed wall-clock time since
//     the player's last visit (localStorage timestamp), capped, and
//     handed over as one calm claim — no countdown timers, no decay.
//   - Achievements/skins are a completionist checklist, all earnable
//     through ordinary play; nothing is paywalled.
//   - `mockPurchase()` is the ONLY place a real payment provider would
//     ever be wired in, and it is explicitly stubbed to just grant the
//     item locally. See the comment on that function.
(function () {
  'use strict';

  const NS = (window.NS = window.NS || {});
  const storage = NS.storage;

  const STATE_KEY = 'nokiaSnake.state.v1';

  // ---------------------------------------------------------------------
  // Static catalog data
  // ---------------------------------------------------------------------

  const SKINS = {
    classic: {
      id: 'classic',
      name: 'Classic Olive',
      cost: 0,
      unlockedByDefault: true,
      bg: 0x9bab77, // Nokia LCD olive-green
      grid: 0x8ba368,
      snake: 0x2b3a22,
      snakeHead: 0x1f2b18,
      food: 0x4a5a32,
      golden: 0xf4f9e8,
      text: 0x1f2b18,
    },
    amber: {
      id: 'amber',
      name: 'Amber Glow',
      cost: 50,
      bg: 0xdcb14a,
      grid: 0xc79a30,
      snake: 0x3a2405,
      snakeHead: 0x241600,
      food: 0x5c3d08,
      golden: 0xfff3c9,
      text: 0x241600,
    },
    ice: {
      id: 'ice',
      name: 'Ice Blue',
      cost: 75,
      bg: 0xaad4dc,
      grid: 0x8cc0cb,
      snake: 0x123844,
      snakeHead: 0x082026,
      food: 0x235866,
      golden: 0xf2fdff,
      text: 0x082026,
    },
    night: {
      id: 'night',
      name: 'Inverted Night',
      cost: 100,
      bg: 0x1a1f14,
      grid: 0x262d1a,
      snake: 0x9bd94a,
      snakeHead: 0xcdf98a,
      food: 0x6f9c2e,
      golden: 0xffffff,
      text: 0xcdf98a,
    },
  };

  const TRAILS = {
    none: { id: 'none', name: 'No Trail', cost: 0, unlockedByDefault: true },
    sparkle: { id: 'sparkle', name: 'Sparkle Trail', cost: 60 },
    dust: { id: 'dust', name: 'Pixel Dust', cost: 90 },
  };

  const UPGRADES = {
    idleMultiplier: {
      id: 'idleMultiplier',
      name: 'Offline Snack Stash',
      desc: '+50% Snake Coins earned while away',
      cost: 120,
      multiplier: 1.5,
    },
  };

  // Skill tree — permanent, account-wide (not per-run, never reset on
  // death) bonuses/unlocks bought with Snake Coins or Points. This is the
  // real branching tree from docs/game-theory-design.md §5: one Root node,
  // fanning out into 4 branches (A Score Mastery, B Abilities & Cooldowns,
  // C Economy, D Vitality). Every branch's nodes implicitly require Root
  // owned (see nodePrereqMet() below — this is enforced once, centrally,
  // rather than repeated on every node's own `prereq`). A node's own
  // `prereq` (when present) is either a single condition object or an
  // array of them, each `{ nodeId, minLevel }` — `minLevel` omitted means
  // "owned" (level >= 1); `minLevel` equal to the target node's own
  // maxLevel means "maxed". See nodePrereqMet()/prereqConditionMet().
  //
  // Only Root + Branch A (scoreMastery) feed scoreTreeBonus() /
  // effectiveMultiplier() in game.js — see that function below. Every
  // other branch's nodes are purchasable/persist/render correctly here,
  // but their described gameplay effects are NOT wired into game.js yet
  // (see the per-node comments) — that's a later implementation phase.
  //
  // Calibration: every NEW node's baseCost below is the doc's 1x-scale
  // number from §5/§8/§9, multiplied by CALIBRATION_K_COINS (coins) or
  // CALIBRATION_K_POINTS (points) per §0/§10. The 3 pre-existing Score
  // Mastery nodes (Keen Appetite/Sharp Fangs/Golden Instinct) keep their
  // already-shipped, unscaled baseCosts — §10 explicitly says not to
  // retroactively re-price something already live.
  const CALIBRATION_K_COINS = 25;
  const CALIBRATION_K_POINTS = 15;

  const ROOT_NODE_ID = 'awakenCoil';

  const SKILL_TREE = {
    root: {
      id: 'root',
      name: 'Root',
      nodes: [
        {
          id: ROOT_NODE_ID, name: 'Awaken the Coil',
          desc: 'Flat +2% score. A ceremonial gate — unlocks every branch below.',
          baseCost: 25 * CALIBRATION_K_COINS, costMultiplier: 1, bonusPerLevel: 0.02, maxLevel: 1,
          currency: 'coins', prereq: null,
        },
      ],
    },
    // Branch A — Score Mastery. Fully wired: every node here feeds
    // scoreTreeBonus() / effectiveMultiplier() in game.js.
    scoreMastery: {
      id: 'scoreMastery',
      name: 'Branch A — Score Mastery',
      nodes: [
        { id: 'keenAppetite', name: 'Keen Appetite', desc: '+5% score per level', baseCost: 40, costMultiplier: 1.12, bonusPerLevel: 0.05, maxLevel: 10, currency: 'coins', prereq: null },
        { id: 'sharpFangs', name: 'Sharp Fangs', desc: '+8% score per level', baseCost: 90, costMultiplier: 1.12, bonusPerLevel: 0.08, maxLevel: 8, currency: 'coins', prereq: null },
        {
          id: 'goldenInstinct', name: 'Golden Instinct', desc: '+15% score per level', baseCost: 200, costMultiplier: 1.14, bonusPerLevel: 0.15, maxLevel: 5,
          currency: 'coins', prereq: [{ nodeId: 'keenAppetite', minLevel: 5 }, { nodeId: 'sharpFangs', minLevel: 4 }],
        },
        {
          id: 'ravenousGrowth', name: 'Ravenous Growth', desc: '+25% score per level', baseCost: 900 * CALIBRATION_K_COINS, costMultiplier: 1.16, bonusPerLevel: 0.25, maxLevel: 5,
          currency: 'coins', prereq: { nodeId: 'goldenInstinct', minLevel: 5 },
        },
        {
          id: 'apexPredator', name: 'Apex Predator', desc: '+100% score, flat, one-time (capstone)', baseCost: 6000 * CALIBRATION_K_POINTS, costMultiplier: 1, bonusPerLevel: 1.00, maxLevel: 1,
          currency: 'points', prereq: { nodeId: 'ravenousGrowth', minLevel: 5 },
        },
      ],
    },
    // Branch B — Abilities & Cooldowns. Tier-1 nodes are the pre-existing
    // ability unlocks (kept at their live, unscaled costs — currency/unlock
    // side only, gameplay tuning stays in game.js's ABILITIES const, same
    // split as before). Tier 2-4 are new cooldown-reduction/always-on
    // nodes — purchasable/persisted here, and wired into game.js's
    // ABILITIES tuning helpers (see docs/game-theory-design.md §8).
    abilities: {
      id: 'abilities',
      name: 'Branch B — Abilities & Cooldowns',
      nodes: [
        { id: 'bodyToss', name: 'Body Toss', desc: 'Throw part of your tail to instantly shrink — 2 uses per run', baseCost: 150, costMultiplier: 1, maxLevel: 1, currency: 'coins', prereq: null },
        { id: 'phaseWalls', name: 'Phase Walls', desc: 'Pass through the edges for a few seconds, on a cooldown', baseCost: 750, costMultiplier: 1, maxLevel: 1, currency: 'coins', prereq: null },
        { id: 'biggerBite', name: 'Bigger Bite', desc: 'Grow larger for a few seconds, on a cooldown', baseCost: 3500, costMultiplier: 1, maxLevel: 1, currency: 'coins', prereq: null },
        { id: 'autoCollect', name: 'Auto-Collect', desc: 'Auto-steer to the next 5 pickups, then hand control back — on a cooldown', baseCost: 17500, costMultiplier: 1, maxLevel: 1, currency: 'coins', prereq: null },
        {
          id: 'swiftRecoil', name: 'Swift Recoil', desc: 'Body Toss cooldown 120s → 60s floor (-10s/lvl)', // wired in game.js (computeBodyTossCooldownSec) — see §8
          baseCost: 300 * CALIBRATION_K_COINS, costMultiplier: 1.18, maxLevel: 6, currency: 'coins', prereq: { nodeId: 'bodyToss' },
        },
        {
          id: 'thinnerWalls', name: 'Thinner Walls', desc: 'Phase Walls cooldown 25s → 10s (-3s/lvl)', // wired in game.js (computePhaseWallsTuning) — see §8
          baseCost: 400 * CALIBRATION_K_COINS, costMultiplier: 1.15, maxLevel: 5, currency: 'coins', prereq: { nodeId: 'phaseWalls' },
        },
        {
          id: 'longerFangs', name: 'Longer Fangs', desc: 'Bigger Bite cooldown 20s → 10s (-2s/lvl)', // wired in game.js (computeBiggerBiteTuning) — see §8
          baseCost: 350 * CALIBRATION_K_COINS, costMultiplier: 1.15, maxLevel: 5, currency: 'coins', prereq: { nodeId: 'biggerBite' },
        },
        {
          id: 'extendedInstinct', name: 'Extended Instinct', desc: 'Auto-Collect cooldown 30s → 15s (-3s/lvl)', // wired in game.js (computeAutoCollectTuning) — see §8
          baseCost: 500 * CALIBRATION_K_COINS, costMultiplier: 1.15, maxLevel: 5, currency: 'coins', prereq: { nodeId: 'autoCollect' },
        },
        {
          id: 'porousScales', name: 'Porous Scales', desc: 'Phase Walls cooldown → 0s, duration → 16s (100% uptime)', // wired in game.js (computePhaseWallsTuning) — see §8
          baseCost: 1200 * CALIBRATION_K_POINTS, costMultiplier: 1.35, maxLevel: 5, currency: 'points', prereq: { nodeId: 'thinnerWalls', minLevel: 5 },
        },
        {
          id: 'ravenousForm', name: 'Ravenous Form', desc: 'Bigger Bite cooldown → 0s, duration → 10s (100% uptime)', // wired in game.js (computeBiggerBiteTuning) — see §8
          baseCost: 1000 * CALIBRATION_K_POINTS, costMultiplier: 1.35, maxLevel: 5, currency: 'points', prereq: { nodeId: 'longerFangs', minLevel: 5 },
        },
        {
          id: 'relentlessPursuit', name: 'Relentless Pursuit', desc: 'Auto-Collect cooldown 15s → 8s floor, pickups 5 → 7', // wired in game.js (computeAutoCollectTuning) — see §8
          baseCost: 1500 * CALIBRATION_K_POINTS, costMultiplier: 1.30, maxLevel: 4, currency: 'points', prereq: { nodeId: 'extendedInstinct', minLevel: 5 },
        },
        {
          id: 'permeableScales', name: 'Permeable Scales', desc: 'Phase Walls becomes passive/always-on (capstone)', // wired in game.js (this.permanentPhaseWalls) — see §8
          baseCost: 5000 * CALIBRATION_K_POINTS, costMultiplier: 1, maxLevel: 1, currency: 'points', prereq: { nodeId: 'porousScales', minLevel: 5 },
        },
        {
          id: 'perpetualMolt', name: 'Perpetual Molt', desc: 'Bigger Bite becomes passive/always-on (capstone)', // wired in game.js (this.permanentBiggerBite) — see §8
          baseCost: 4500 * CALIBRATION_K_POINTS, costMultiplier: 1, maxLevel: 1, currency: 'points', prereq: { nodeId: 'ravenousForm', minLevel: 5 },
        },
      ],
    },
    // Branch C — Economy. §5's table has no per-node Prereq column beyond
    // the implicit Root gate, so every node here only requires Root owned.
    // Purchasable/persisted here; effects NOT wired into game.js/economy.js
    // gameplay logic yet (effect not yet wired — see docs/game-theory-design.md §7).
    economyBranch: {
      id: 'economyBranch',
      name: 'Branch C — Economy',
      nodes: [
        {
          id: 'luckyScales', name: 'Lucky Scales', desc: 'Golden apple chance +0.5%/lvl to both min/max', // effect not yet wired — see docs/game-theory-design.md §7
          baseCost: 300 * CALIBRATION_K_COINS, costMultiplier: 1.13, maxLevel: 6, currency: 'coins', prereq: null,
        },
        {
          id: 'heavyPockets', name: 'Heavy Pockets', desc: 'Golden apple reward +1/lvl to both min/max', // effect not yet wired — see docs/game-theory-design.md §7
          baseCost: 500 * CALIBRATION_K_COINS, costMultiplier: 1.14, maxLevel: 5, currency: 'coins', prereq: null,
        },
        {
          id: 'frugalForager', name: 'Frugal Forager', desc: 'End-of-run bonus divisor 25 → 20 (-1/lvl, floor 20)', // effect not yet wired — see docs/game-theory-design.md §7
          baseCost: 400 * CALIBRATION_K_COINS, costMultiplier: 1.15, maxLevel: 5, currency: 'coins', prereq: null,
        },
        {
          id: 'idleMasteryII', name: 'Idle Mastery II', desc: 'Idle rate +10%/lvl (stacks with Offline Snack Stash)', // effect not yet wired — see docs/game-theory-design.md §7
          baseCost: 350 * CALIBRATION_K_COINS, costMultiplier: 1.13, maxLevel: 5, currency: 'coins', prereq: null,
        },
        {
          id: 'serpentsFortune', name: "Serpent's Fortune", desc: 'Tightens all High-Score Momentum divisors by 15% (capstone)', // effect not yet wired — see docs/game-theory-design.md §7
          baseCost: 2500 * CALIBRATION_K_POINTS, costMultiplier: 1, maxLevel: 1, currency: 'points', prereq: null,
        },
      ],
    },
    // Branch D — Vitality. Same as Branch C: §5's table has no per-node
    // Prereq column beyond the implicit Root gate. Purchasable/persisted
    // here, and wired into game.js's lives/regen logic (see
    // docs/game-theory-design.md §9).
    vitality: {
      id: 'vitality',
      name: 'Branch D — Vitality',
      nodes: [
        {
          id: 'thickHide', name: 'Thick Hide', desc: '+1 max Body Toss life per level (2 → 5 total)', // wired in game.js (computeMaxLives) — see §9
          baseCost: 2500 * CALIBRATION_K_COINS, costMultiplier: 1.6, maxLevel: 3, currency: 'coins', prereq: null,
        },
        {
          id: 'quickRegeneration', name: 'Quick Regeneration', desc: 'Tightens the life-regen popup window by 30s/lvl', // wired in game.js (rollLifeRegenWindowSec) — see §9
          baseCost: 1800 * CALIBRATION_K_POINTS, costMultiplier: 1.4, maxLevel: 3, currency: 'points', prereq: null,
        },
      ],
    },
  };

  const ACHIEVEMENTS = [
    { id: 'first_bite', name: 'First Bite', desc: 'Eat your first apple', coins: 5,
      check: (s) => s.stats.applesEaten >= 1 },
    { id: 'score_50', name: 'Getting Warmed Up', desc: 'Score 50 in one run', coins: 10,
      check: (s) => s.stats.bestScore >= 50 },
    { id: 'score_150', name: 'Grid Runner', desc: 'Score 150 in one run', coins: 20,
      check: (s) => s.stats.bestScore >= 150 },
    { id: 'score_300', name: 'LCD Legend', desc: 'Score 300 in one run', coins: 35,
      check: (s) => s.stats.bestScore >= 300 },
    { id: 'golden_hunter', name: 'Golden Hunter', desc: 'Eat 5 golden apples', coins: 25,
      check: (s) => s.stats.goldenApplesEaten >= 5 },
    { id: 'marathon', name: 'Marathon', desc: 'Reach a snake length of 20', coins: 20,
      check: (s) => s.stats.maxLength >= 20 },
    { id: 'survivor', name: 'Survivor', desc: 'Play 10 games', coins: 20,
      check: (s) => s.stats.gamesPlayed >= 10 },
    { id: 'coin_collector', name: 'Coin Collector', desc: 'Earn 500 Snake Coins total (lifetime)', coins: 30,
      check: (s) => s.stats.lifetimeCoinsEarned >= 500 },
  ];

  // ---------------------------------------------------------------------
  // Bounded variable-ratio golden-apple tuning
  // ---------------------------------------------------------------------
  const GOLDEN = {
    minChance: 0.07, // 7%
    maxChance: 0.16, // 16% — the *ceiling* itself is randomized per-roll
    minCooldownSpawns: 4, // hard floor: never two goldens back to back
    maxCooldownSpawns: 8,
    minCoinReward: 5,
    maxCoinReward: 20,
  };

  const IDLE = {
    coinsPerSecond: 1 / 45, // ~1 coin per 45s away, before multiplier
    capSeconds: 12 * 60 * 60, // cap reward at 12 real-world hours away
    minSecondsToShowClaim: 30, // don't bother popping the modal for a 5s tab-switch
    // Idle rate scales with the player's best-ever score, separately from
    // (and multiplicatively with) the idleMultiplier upgrade below. 150
    // lines up with the existing `score_150` achievement threshold, so
    // hitting that achievement roughly doubles idle rate — a deliberate,
    // legible tie-in between skilled play and passive reward.
    bestScoreDivisor: 150,
  };

  const HIGH_SCORE_LIMIT = 10;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  function defaultState() {
    return {
      settings: {
        wrapMode: false,
        muted: false,
        crtEffect: true,
        skin: 'classic',
        trail: 'none',
      },
      economy: {
        coins: 0,
        points: 0,
        unlockedSkins: ['classic'],
        unlockedTrails: ['none'],
        ownedUpgrades: [],
        unlockedAchievements: [],
        skillLevels: {},
      },
      stats: {
        gamesPlayed: 0,
        applesEaten: 0,
        goldenApplesEaten: 0,
        bestScore: 0,
        maxLength: 3,
        lifetimeCoinsEarned: 0,
        lifetimeScore: 0,
        activePlaySeconds: 0,
      },
      highScores: [], // [{score, date}]
      lastSeen: Date.now(),
    };
  }

  let state = null;

  function load() {
    const saved = storage.get(STATE_KEY, null);
    const fresh = defaultState();
    if (!saved) {
      state = fresh;
      return state;
    }
    // Shallow-merge so new fields added in later versions of this file
    // don't clobber (or get clobbered by) an older save shape.
    state = {
      settings: Object.assign({}, fresh.settings, saved.settings),
      economy: Object.assign({}, fresh.economy, saved.economy),
      stats: Object.assign({}, fresh.stats, saved.stats),
      highScores: Array.isArray(saved.highScores) ? saved.highScores : [],
      lastSeen: typeof saved.lastSeen === 'number' ? saved.lastSeen : Date.now(),
    };
    return state;
  }

  function save() {
    storage.set(STATE_KEY, state);
  }

  function touchLastSeen() {
    state.lastSeen = Date.now();
    save();
  }

  // ---------------------------------------------------------------------
  // Coins
  // ---------------------------------------------------------------------

  function addCoins(amount) {
    if (amount <= 0) return;
    state.economy.coins += amount;
    state.stats.lifetimeCoinsEarned += amount;
    save();
  }

  function spendCoins(amount) {
    if (amount > state.economy.coins) return false;
    state.economy.coins -= amount;
    save();
    return true;
  }

  // ---------------------------------------------------------------------
  // Points — a second, persistent currency mirroring score 1:1, the
  // instant it's earned (no end-of-run banking step). See
  // docs/game-theory-design.md §6.
  // ---------------------------------------------------------------------

  function addPoints(amount) {
    if (amount <= 0) return;
    state.economy.points += amount;
    state.stats.lifetimeScore += amount;
    save();
  }

  function spendPoints(amount) {
    if (amount > state.economy.points) return false;
    state.economy.points -= amount;
    save();
    return true;
  }

  // ---------------------------------------------------------------------
  // Active-play time — accumulated only while a run is alive (see
  // game.js's update()), used by the Body Toss life-regen popup timer
  // (docs/game-theory-design.md §9c). Mirrored in from game.js periodically
  // rather than every frame, to avoid a localStorage write on every tick.
  // ---------------------------------------------------------------------

  function addActivePlaySeconds(amount) {
    if (amount <= 0) return;
    state.stats.activePlaySeconds += amount;
    save();
  }

  // ---------------------------------------------------------------------
  // Golden apple roll — bounded variable-ratio reinforcement
  // ---------------------------------------------------------------------

  let goldenCooldown = randInt(GOLDEN.minCooldownSpawns, GOLDEN.maxCooldownSpawns);

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Decide whether the NEXT food spawn should be a golden apple.
   * Called once per food spawn. Returns boolean.
   */
  function rollGolden() {
    if (goldenCooldown > 0) {
      goldenCooldown -= 1;
      return false;
    }
    // The chance itself is redrawn within [minChance, maxChance] every
    // time the cooldown clears, so the schedule can't be timed exactly —
    // but it is always bounded, never a pure/unbounded gamble.
    const chance = GOLDEN.minChance + Math.random() * (GOLDEN.maxChance - GOLDEN.minChance);
    const hit = Math.random() < chance;
    if (hit) {
      goldenCooldown = randInt(GOLDEN.minCooldownSpawns, GOLDEN.maxCooldownSpawns);
    }
    return hit;
  }

  function goldenReward() {
    return randInt(GOLDEN.minCoinReward, GOLDEN.maxCoinReward);
  }

  // ---------------------------------------------------------------------
  // Idle / AFK trickle
  // ---------------------------------------------------------------------

  function computeIdleReward() {
    const now = Date.now();
    const elapsedSec = Math.max(0, (now - state.lastSeen) / 1000);
    if (elapsedSec < IDLE.minSecondsToShowClaim) {
      return { coins: 0, elapsedSec, cappedSec: elapsedSec };
    }
    const cappedSec = Math.min(elapsedSec, IDLE.capSeconds);
    const upgradeMultiplier = state.economy.ownedUpgrades.includes('idleMultiplier')
      ? UPGRADES.idleMultiplier.multiplier
      : 1;
    const bestScoreFactor = 1 + state.stats.bestScore / IDLE.bestScoreDivisor;
    const coins = Math.floor(cappedSec * IDLE.coinsPerSecond * bestScoreFactor * upgradeMultiplier);
    return { coins, elapsedSec, cappedSec };
  }

  /**
   * currentIdleRate() — live effective idle coins/sec rate, for display
   * only. Same formula as computeIdleReward() (coinsPerSecond x
   * bestScoreFactor x upgradeMultiplier) but without the elapsed-time or
   * capping logic, since this isn't about an actual claim — it's "how fast
   * would I be earning right now if I walked away". Updates whenever
   * bestScore or the idleMultiplier upgrade changes.
   */
  function currentIdleRate() {
    const upgradeMultiplier = state.economy.ownedUpgrades.includes('idleMultiplier')
      ? UPGRADES.idleMultiplier.multiplier
      : 1;
    const bestScoreFactor = 1 + state.stats.bestScore / IDLE.bestScoreDivisor;
    return IDLE.coinsPerSecond * bestScoreFactor * upgradeMultiplier;
  }

  function claimIdleReward() {
    const reward = computeIdleReward();
    if (reward.coins > 0) {
      addCoins(reward.coins);
    }
    touchLastSeen();
    return reward;
  }

  // ---------------------------------------------------------------------
  // Cosmetics
  // ---------------------------------------------------------------------

  function ownsSkin(id) {
    return state.economy.unlockedSkins.includes(id);
  }
  function ownsTrail(id) {
    return state.economy.unlockedTrails.includes(id);
  }

  function buySkin(id) {
    const skin = SKINS[id];
    if (!skin || ownsSkin(id)) return false;
    if (!spendCoins(skin.cost)) return false;
    state.economy.unlockedSkins.push(id);
    save();
    return true;
  }

  function buyTrail(id) {
    const trail = TRAILS[id];
    if (!trail || ownsTrail(id)) return false;
    if (!spendCoins(trail.cost)) return false;
    state.economy.unlockedTrails.push(id);
    save();
    return true;
  }

  function buyUpgrade(id) {
    const upgrade = UPGRADES[id];
    if (!upgrade || state.economy.ownedUpgrades.includes(id)) return false;
    if (!spendCoins(upgrade.cost)) return false;
    state.economy.ownedUpgrades.push(id);
    save();
    return true;
  }

  // ---------------------------------------------------------------------
  // Skill tree
  // ---------------------------------------------------------------------

  function findSkillNode(nodeId) {
    for (const category of Object.values(SKILL_TREE)) {
      const node = category.nodes.find((n) => n.id === nodeId);
      if (node) return node;
    }
    return null;
  }

  function findSkillNodeCategoryId(nodeId) {
    for (const [catId, category] of Object.entries(SKILL_TREE)) {
      if (category.nodes.some((n) => n.id === nodeId)) return catId;
    }
    return null;
  }

  function skillNodeLevel(nodeId) {
    return state.economy.skillLevels[nodeId] || 0;
  }

  function skillNodeCost(nodeId) {
    const node = findSkillNode(nodeId);
    if (!node) return null;
    const level = skillNodeLevel(nodeId);
    if (level >= node.maxLevel) return Infinity;
    return Math.ceil(node.baseCost * Math.pow(node.costMultiplier, level));
  }

  // A single prereq condition: { nodeId, minLevel }. `minLevel` omitted
  // means "owned" (level >= 1); passing the target node's own maxLevel as
  // minLevel means "maxed". Supports both prereq shapes the doc's §5
  // tables use ("node X owned" / "node X at level >= N or maxed").
  function prereqConditionMet(cond) {
    const minLevel = cond.minLevel != null ? cond.minLevel : 1;
    return skillNodeLevel(cond.nodeId) >= minLevel;
  }

  /**
   * nodePrereqMet(nodeId) — true if a node's prerequisites (its own
   * `prereq`, plus the implicit "Root owned" gate every non-root branch
   * node carries) are satisfied, independent of whether the player can
   * currently afford it or has already maxed it. Used by both
   * buySkillNode() (to refuse a purchase) and the Skills UI (to render
   * locked/unaffordable/affordable/maxed states).
   */
  function nodePrereqMet(nodeId) {
    const node = findSkillNode(nodeId);
    if (!node) return false;
    const catId = findSkillNodeCategoryId(nodeId);
    if (catId !== 'root' && skillNodeLevel(ROOT_NODE_ID) < 1) return false;
    if (!node.prereq) return true;
    const conds = Array.isArray(node.prereq) ? node.prereq : [node.prereq];
    return conds.every(prereqConditionMet);
  }

  function buySkillNode(nodeId) {
    const node = findSkillNode(nodeId);
    if (!node) return false;
    const level = skillNodeLevel(nodeId);
    if (level >= node.maxLevel) return false;
    if (!nodePrereqMet(nodeId)) return false;
    const cost = skillNodeCost(nodeId);
    const spend = node.currency === 'points' ? spendPoints : spendCoins;
    if (!spend(cost)) return false;
    state.economy.skillLevels[nodeId] = level + 1;
    save();
    return true;
  }

  // Only Root + Branch A (scoreMastery) feed the score multiplier — see
  // docs/game-theory-design.md §5. Branch B/C/D nodes are intentionally
  // excluded here; their effects are wired in a later phase.
  function scoreTreeBonus() {
    const rootBonus = SKILL_TREE.root.nodes.reduce(
      (sum, node) => sum + skillNodeLevel(node.id) * node.bonusPerLevel,
      0
    );
    const branchABonus = SKILL_TREE.scoreMastery.nodes.reduce(
      (sum, node) => sum + skillNodeLevel(node.id) * node.bonusPerLevel,
      0
    );
    return rootBonus + branchABonus;
  }

  function ownsAbility(nodeId) {
    return skillNodeLevel(nodeId) >= 1;
  }

  function setWrapMode(value) {
    state.settings.wrapMode = !!value;
    save();
  }

  function setCrtEffect(value) {
    state.settings.crtEffect = !!value;
    save();
  }

  function setMuted(value) {
    state.settings.muted = !!value;
    save();
  }

  function setSkin(id) {
    if (!ownsSkin(id)) return false;
    state.settings.skin = id;
    save();
    return true;
  }

  function setTrail(id) {
    if (!ownsTrail(id)) return false;
    state.settings.trail = id;
    save();
    return true;
  }

  // ---------------------------------------------------------------------
  // Real-money hook — STUBBED. Read this before wiring a payment provider.
  // ---------------------------------------------------------------------
  /**
   * mockPurchase(itemId)
   *
   * This is the ONLY function in the codebase that represents a
   * real-money transaction (e.g. a "Coin Pack" bought with actual cash).
   * Everything else in this file is earned purely by playing.
   *
   * ============================================================
   *  STRIPE INTEGRATION POINT (not wired — mocked on purpose)
   * ============================================================
   *  A real implementation would replace the body below with:
   *    1. Client: call your backend to create a Stripe Checkout
   *       Session / PaymentIntent for `itemId`
   *         const res = await fetch('/api/checkout', {
   *           method: 'POST',
   *           body: JSON.stringify({ itemId }),
   *         });
   *         const { url } = await res.json();
   *    2. Redirect the browser to `url` (Stripe-hosted checkout), or
   *       confirm the PaymentIntent client-side with Stripe.js/Elements.
   *    3. Stripe redirects back / fires a webhook
   *       (checkout.session.completed) to your backend.
   *    4. Backend verifies the webhook signature, THEN — and only
   *       then — grants the item server-side against the player's
   *       account (never trust a client-side "success" callback for
   *       entitlement grants).
   *    5. Client polls/refetches entitlements and updates local state.
   *
   *  None of that network/payment code exists here. This build only
   *  ever grants the item locally, instantly, with no charge, so the
   *  in-game economy stays 100% play-to-earn as shipped.
   */
  function mockPurchase(itemId) {
    const item = MOCK_STORE[itemId];
    if (!item) return false;
    item.grant();
    save();
    console.info(`[mockPurchase] granted "${itemId}" locally — no real payment was made.`);
    return true;
  }

  const MOCK_STORE = {
    coin_pack_small: {
      label: 'Coin Pack — 100 Coins',
      priceLabel: '$0.99 (mock, not charged)',
      grant: () => addCoins(100),
    },
    coin_pack_large: {
      label: 'Coin Pack — 550 Coins',
      priceLabel: '$3.99 (mock, not charged)',
      grant: () => addCoins(550),
    },
  };

  // ---------------------------------------------------------------------
  // Achievements
  // ---------------------------------------------------------------------

  function checkAchievements() {
    const newlyUnlocked = [];
    ACHIEVEMENTS.forEach((ach) => {
      if (state.economy.unlockedAchievements.includes(ach.id)) return;
      if (ach.check(state)) {
        state.economy.unlockedAchievements.push(ach.id);
        addCoins(ach.coins);
        newlyUnlocked.push(ach);
      }
    });
    if (newlyUnlocked.length) save();
    return newlyUnlocked;
  }

  // ---------------------------------------------------------------------
  // Run-end bookkeeping
  // ---------------------------------------------------------------------

  function recordRunEnd({ score, length, applesEaten, goldenApplesEaten }) {
    state.stats.gamesPlayed += 1;
    state.stats.applesEaten += applesEaten;
    state.stats.goldenApplesEaten += goldenApplesEaten;
    state.stats.bestScore = Math.max(state.stats.bestScore, score);
    state.stats.maxLength = Math.max(state.stats.maxLength, length);

    // Flat end-of-run coin bonus so ordinary play (not just golden-apple
    // luck) always earns something toward cosmetics.
    const bonus = Math.floor(score / 25);
    if (bonus > 0) addCoins(bonus);

    const isHighScore = insertHighScore(score);
    const newAchievements = checkAchievements();
    save();
    return { bonus, isHighScore, newAchievements };
  }

  function insertHighScore(score) {
    const entry = { score, date: new Date().toISOString() };
    state.highScores.push(entry);
    state.highScores.sort((a, b) => b.score - a.score);
    const rank = state.highScores.indexOf(entry);
    state.highScores = state.highScores.slice(0, HIGH_SCORE_LIMIT);
    return rank >= 0 && rank < HIGH_SCORE_LIMIT;
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  // Load immediately when this script runs (economy.js is the first module
  // that needs the save file, and it loads before game.js/ui.js in the
  // <script> order), so any code in those later files can safely call
  // economy.getState() from the very top of their own init.
  load();

  NS.economy = {
    SKINS,
    TRAILS,
    UPGRADES,
    SKILL_TREE,
    ACHIEVEMENTS,
    MOCK_STORE,
    load,
    save,
    touchLastSeen,
    getState: () => state,
    addCoins,
    spendCoins,
    addPoints,
    spendPoints,
    addActivePlaySeconds,
    rollGolden,
    goldenReward,
    computeIdleReward,
    currentIdleRate,
    claimIdleReward,
    ownsSkin,
    ownsTrail,
    buySkin,
    buyTrail,
    buyUpgrade,
    findSkillNode,
    skillNodeCost,
    skillNodeLevel,
    nodePrereqMet,
    buySkillNode,
    scoreTreeBonus,
    ownsAbility,
    ROOT_NODE_ID,
    CALIBRATION_K_COINS,
    CALIBRATION_K_POINTS,
    setSkin,
    setTrail,
    setWrapMode,
    setCrtEffect,
    setMuted,
    mockPurchase,
    checkAchievements,
    recordRunEnd,
  };
})();
