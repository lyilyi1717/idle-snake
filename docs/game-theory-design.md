# Nokia Snake — Game Theory & Economy Design

**Status: living reference document.** This is the source of truth for the game-economy /
game-theory design of `nokia-snake`. A dedicated design-consultant agent (resumed via
SendMessage across sessions, not re-derived from scratch) owns this file — on any future
resume, re-read this whole document first, then update sections in place rather than
appending duplicate ones. Code under `js/` and `index.html` is NOT edited by this agent;
every section below is a spec for a later implementation pass, written to be concrete
enough (real formulas, real numbers, real node lists) that an implementer never has to
come back and ask "what did you mean."

Grounded in `js/economy.js` and `js/game.js` as they existed on 2026-09-16/17 (see
`README.md`'s "Reward-loop design" section for the existing ethical-monetization
baseline this document extends, never violates).

Last updated: 2026-09-17.

---

## 0. Conventions used throughout this document

- **Coins** = `economy.coins` / `stats.lifetimeCoinsEarned` (existing).
- **Points** = a NEW second currency, `economy.points` / `stats.lifetimeScore` (see
  §6). "Points" and "score" are the same number stream — score becomes points the
  instant it's earned, in real time, never at run-end (see §6 for why).
- Every new skill-tree node below follows the project's existing cost-curve shape,
  already used by `SKILL_TREE.scoreMastery`:
  `cost(level) = ceil(baseCost * costMultiplier ^ level)`, cost summed to buy from 0
  to maxLevel. `costMultiplier` in the existing code ranges 1.12–1.14; this document
  uses 1.12–1.18 for coin nodes and 1.30–1.40 for points nodes (points nodes are
  fewer, deeper, and meant to feel like deliberate mastery investments — see §4).
- All new node **baseCost** numbers in §5/§8/§9 are given at **1x scale** — i.e., in
  the same absolute range as the existing tree (`40`–`17500`) — for readability and to
  keep relative proportions between nodes legible. §10 derives a global calibration
  multiplier (`CALIBRATION_K_COINS ≈ 25`, `CALIBRATION_K_POINTS ≈ 11`) that the
  implementation pass should apply to every new baseCost to hit the pacing target.
  Treat the 1x numbers in §5/§8/§9 as the *shape*, and §10's multipliers as the
  *scale*.

---

## 1. Frenzy — fill the screen, not just 6 pips

**Current:** `FRENZY.pipCount = 6` (fixed), `pipValue = 8`, grid is dynamic
(20–90 cols × 14–60 rows, computed once at `boot()` from viewport — see `game.js:35-44`).
A fixed pip count of 6 is invisible on a 90×60 board and absurd/crowded on a 20×14 one —
it needs to scale with the actual grid.

### Formula

```
openCells   = COLS * ROWS - snake.length - 1        // -1 for the live food cell
pipCount    = clamp(round(openCells * FRENZY_FILL_FRACTION), FRENZY_PIP_MIN, FRENZY_PIP_MAX)

FRENZY_FILL_FRACTION = 0.50   // half of all open cells get a pip
FRENZY_PIP_MIN        = 40    // floor — even the smallest grid (20x14=280 cells) still feels like "frenzy"
FRENZY_PIP_MAX         = 500   // ceiling — perf + visual-clutter cap for large grids
```

Worked examples:

| Grid | Cols×Rows | Cells | openCells (≈) | 50% | Clamped pipCount |
|---|---|---|---|---|---|
| Smallest | 20×14 | 280 | 265 | 133 | **133** |
| Typical laptop | 48×34 (TARGET_COLS-ish) | 1632 | 1610 | 805 | **500** (capped) |
| Largest | 90×60 | 5400 | 5375 | 2688 | **500** (capped) |

So mid-size and large screens hit the 500 cap and genuinely read as "the whole screen is
scattered with points"; the smallest supported grid still gets 133 pips (47% of its open
cells) — well above the current flat 6, without needing a separate small-grid branch.

### Why this doesn't become a performance or fairness problem

- **Rendering** is a per-pip `fillRect` in `renderFrame()` — trivial even at 500 (Canvas
  batches thousands of these per frame without measurable cost).
- **Placement** (`spawnFrenzyPips()`) currently checks each candidate cell against
  `this.frenzyPips.some(...)` — O(n) per attempt. At pipCount ≤ 500 this is still cheap
  per call, but the implementation pass should switch the pip-occupancy check to a
  `Set` of `"x,y"` keys (O(1) membership) once pipCount routinely exceeds ~100, both for
  the initial fill and the per-pickup top-up in `step()`. Flagging this explicitly so
  the impl agent doesn't rediscover it during a slowdown.
- **Score is not inflated by density.** Pip consumption is bounded by how many cells the
  snake can physically pass over in the 10s `FRENZY.durationSec` window (at the fastest
  tick rate, `MIN_INTERVAL_MS=70ms`, that's a hard ceiling of ~142 cells visited in 10s,
  and realistically far fewer once you account for travel, not just adjacency). A denser
  field increases the *chance* any given path clips a pip, not the *ceiling* on how many
  can be eaten — so raising pipCount from 6 to 500 does not create a mechanical score
  explosion, only visual abundance and slightly better average pip yield per Frenzy
  window. `pipValue` (8) is left unchanged for this reason.
- Frenzy's own trigger odds/cooldown (`FRENZY.chance=0.02`, `minCooldownSpawns=10-18`)
  are unrelated to pip count and are left as-is.

**Implementation note (for the later coding pass, not done here):** recompute
`pipCount` once per `eatFrenzy()` call (frenzy trigger time) from the live `COLS`/`ROWS`
module-scope values — those are already fixed at boot per the existing architecture
comment in `game.js:14-24`, so this is a one-time-per-run-start computation, not a
per-frame one.

---

## 2. Visible generation-rate display

Two distinct rates, shown in two distinct places, because they answer different
questions and have different noise characteristics:

### 2a. In-run **Score/sec** (active-play pace)

- A trailing-window rate, not an instantaneous delta (instantaneous would be spiky/
  unreadable — a single golden apple would make it flicker).
- Implementation: keep a small ring buffer of `{t, score}` samples, pushed every
  250ms from `update()` (game.js already has a per-frame `update(time, delta)`
  hook). Rate = `(score_now - score_at_t-5s) / 5` — a 5-second trailing window,
  recomputed each sample tick.
- Displayed in the existing status bar (`ui.js` `updateStatusBar()`, next to the
  existing `Score:`/`Coins:`/`Spd:` labels) as e.g. `12.4/s`. Only shown while
  `NS.game.isAlive()` — it's meaningless on the start/game-over screen.
- **Why not also show a live "coins/min this run" figure:** in-run coin income is
  bursty and rare (golden apples on a 4-8 spawn cooldown, chili's new small bonus —
  see §7) — a live rate for it would mostly read as "0/min" punctuated by spikes,
  which is *more* confusing than no number at all. Deliberately not built. If this
  is revisited later, do it as a post-run summary ("+42 coins this run"), not a live
  ticker.

### 2b. **Idle coins/hour** (passive pace)

- A pure function of current stats, not a live ring buffer — it doesn't change frame
  to frame, only when `bestScore` or the idle upgrade changes.
- New `economy.js` export:
  ```
  function idleRatePerHour() {
    const upgradeMultiplier = state.economy.ownedUpgrades.includes('idleMultiplier')
      ? UPGRADES.idleMultiplier.multiplier : 1;
    const bestScoreFactor = 1 + state.stats.bestScore / IDLE.bestScoreDivisor; // unchanged, §7
    return 3600 * IDLE.coinsPerSecond * bestScoreFactor * upgradeMultiplier;
  }
  ```
- Shown in two places: (1) a persistent small line in the existing Idle Claim modal
  (`idleModal`) — "Currently earning ~N coins/hour while away" — shown even when the
  claim amount is 0 (so a player checking mid-session can still see their passive
  rate); (2) a line in the Shop modal near the `idleMultiplier` upgrade row, so the
  upgrade's effect ("+50%") is legible against a real number instead of an abstract
  percentage.

### 2c. Milestone progress bar (ties §2 to §3)

- A persistent, always-visible-in-menus progress indicator (NOT crammed into the
  tiny in-game status bar — the Nokia chrome has no room, and it's not relevant
  during active dodging) showing progress toward the *next* order-of-magnitude Rank
  tier from §3, for whichever of the two Rank tracks (coins/score) is closer to its
  next threshold.
- Placement: a new small panel at the top of the existing Badges modal (`btnBadges`
  → `badgesModal`), above the achievement checklist, since Ranks and Achievements
  are both "progression recognition" surfaces (see §3's note on keeping them
  distinct but co-located).
- Content: two thin bars, one per track —
  `Coin Rank: Apple Scout (Lv2) — 340 / 1,000 → Golden Forager`
  `Score Rank: Vine (Lv2) — 4,200 / 10,000 → Python`
  computed from `stats.lifetimeCoinsEarned` / `stats.lifetimeScore` against the
  `RANK_TIERS_COINS` / `RANK_TIERS_SCORE` tables in §3.
- Update cadence: re-render whenever the Badges modal is opened (matches the
  existing `renderBadges()` call-on-open pattern), plus on `snake:gameover` if the
  modal happens to be open (rare, but cheap to wire via the existing `bus` events).

---

## 3. Order-of-magnitude milestone table ("Rank")

Two independent ladders, both ×10-spaced, both derived from stats that already
persist forever (`lifetimeCoinsEarned` exists today; `lifetimeScore` is new, see
§6). Each tier grants a **small, one-time, purely cosmetic/recognition** reward —
deliberately small relative to the threshold (order-of-magnitude thresholds, but
*not* order-of-magnitude rewards — see the ratio column) so Rank reads as
recognition, not a second grind-relief currency faucet. This keeps it consistent
with the project's existing "nothing purchasable is power" ethic even though Ranks
aren't purchases — they're still not allowed to become a stealth power system.

New persisted state: `economy.unlockedRankTiers: []` (mirrors
`unlockedAchievements`, prevents re-granting the coin reward on reload).

### Coin Rank (from `stats.lifetimeCoinsEarned`)

| Tier | Threshold | Name | One-time reward | Reward:Threshold |
|---|---|---|---|---|
| 1 | 10 | Crumb Finder | 5 coins | 50% |
| 2 | 100 | Apple Scout | 15 coins | 15% |
| 3 | 1,000 | Golden Forager | 50 coins | 5% |
| 4 | 10,000 | Coin Serpent | 150 coins | 1.5% |
| 5 | 100,000 | Vault Viper | 500 coins | 0.5% |
| 6 | 1,000,000 | Pixel Tycoon | 1,500 coins + unlocks a unique status-bar coin-icon tint | 0.15% |
| 7 | 10,000,000 | Mythic Coil | 5,000 coins + a permanent title shown in the Scores modal | 0.05% |

(Tier 6 deliberately avoids the name "LCD Legend" — already used by the existing
`score_300` achievement in `ACHIEVEMENTS` — to prevent confusing two different
progression surfaces with the same name.)

**Note on overlap with existing achievements:** `coin_collector` (500 lifetime
coins, +30 coins) is directly superseded by Coin Rank Tier 3 (1,000). Recommend
retiring `coin_collector` from `ACHIEVEMENTS` when Rank ships, rather than running
two redundant "earn N lifetime coins" checks side by side.

### Score Rank (from `stats.lifetimeScore`, new — see §6)

Named on a growth theme (fits "Snake" thematically better than the coin ladder's
foraging theme, and keeps the two ladders visually distinguishable at a glance):

| Tier | Threshold | Name | One-time reward |
|---|---|---|---|
| 1 | 1,000 | Sprout | 10 coins |
| 2 | 10,000 | Vine | 30 coins |
| 3 | 100,000 | Python | 100 coins |
| 4 | 1,000,000 | Anaconda | 300 coins |
| 5 | 10,000,000 | Leviathan | 1,000 coins + unique snake-head glow cosmetic |
| 6 | 100,000,000 | Ouroboros | 3,000 coins + permanent title |

Score Rank rewards pay out in **coins, not points** — deliberately, so the
points-only economy (§6) never gets a side-channel top-up from a system that's
just measuring points already spent/banked. Paying Score Rank in coins also gives
score-focused players a reason to still visit the Shop.

---

## 4. Additive vs. multiplicative — the study and the recommended structure

### What the existing code already does right

`game.js:545-548`'s `effectiveMultiplier()` already implements the textbook pattern:

```
effectiveMultiplier = scoreMultiplier(chili, ≤3x)  ×  (1 + scoreTreeBonus)  ×  (buffActive ? 3 : 1)
```

— three **separate categories**, each internally additive (well, chili and buff are
currently single-source "categories" of one), multiplying together. This is not an
accident; it matches how every idle-game economics source examined treats the
problem:

- **Missions Zanx**, *How Multipliers Stack in Idle RPGs*: "Within the same group →
  additive. Between different groups → multiplicative," with a worked example
  showing `1000 × 1.50 × 1.50 = 2250` (two multiplicative groups, +20%/+30% summed
  additively within a "Global Damage" group, +50% in a separate "Skill Damage"
  group) beating the same total bonuses applied as one additive pool
  (`1000 × 2.00 = 2000`) — i.e., *splitting bonuses into more multiplicative
  categories is strictly stronger than dumping them into one additive pool*, which
  is exactly why this document keeps adding new top-level categories (§5–§7) rather
  than more nodes inside `scoreMastery`.
- **Game Developer, "The Math of Idle Games, Part I"**: cites AdVenture Capitalist's
  cost-growth rate of 1.07 as a representative "moderate" exponential (the existing
  `SKILL_TREE.scoreMastery` nodes use 1.12–1.14, i.e. deliberately a bit steeper —
  appropriate since this game's nodes are far fewer/more impactful per node than
  AdVenture Capitalist's dozens of cheap generators), and separately notes that
  *stacking* multiplicative upgrades (its "own 25/50 buildings → x2" example) exists
  specifically to keep the cost curve from outrunning the player — the same
  functional role this document's Rank tiers and momentum bonuses play here.
- **Envato Tuts+, "Numbers Getting Bigger"** series: frames the core incremental-game
  loop as *accumulation → reinvestment → acceleration*, and stresses that renewed
  engagement comes from **discovering new systems**, not just bigger numbers in an
  old one — the design rationale behind introducing wholly new multiplicative
  categories (Prestige Tree, High-Score Momentum) instead of just adding more nodes
  to `scoreMastery` indefinitely.

### Recommended full category structure going forward

All of the following multiply together; every category is internally additive
(sum of its own bonuses) unless noted as binary/single-source:

| # | Category | Scope | Internal shape | Currency | New in this doc? |
|---|---|---|---|---|---|
| 1 | Chili Stack | run-scoped, resets each run | single compounding value, capped ×3 | n/a (gameplay pickup) | existing, unchanged |
| 2 | Buff | run-scoped, temporary (6s) | binary ×3 | n/a (gameplay pickup) | existing, unchanged |
| 3 | Score Mastery Tree | permanent | additive sum of node bonuses | coins (+1 points capstone) | extended, §5 Branch A |
| 4 | Prestige/Mastery Tree | permanent | additive sum | points (mostly) | **new**, folded into branch capstones rather than a separate tree — see §6 |
| 5 | High-Score Momentum | permanent, passive (not tree-purchased) | single formula, own category | n/a (derived from `bestScore`) | **new**, §7 |

Composed formula (replaces `effectiveMultiplier()`; implementation detail, not
built here):

```
effectiveMultiplier =
    chiliStack               // ≤3x, existing
  × buffMultiplier            // 1 or 3, existing
  × (1 + scoreMasteryBonus)   // existing scoreTreeBonus, extended in §5
  × (1 + prestigeBonus)       // new additive sum from points-priced capstones, §5/§6
  × highScoreMomentum          // new, §7 — 1 + min(bestScore, cap)/divisor
```

**Why High-Score Momentum is its own category and not folded into the tree sum:**
it's earned by *playing well*, not by *spending currency* — keeping it separate
means a brand-new low-coin player who's nonetheless great at the game still gets a
visible, multiplicative reward for skill, independent of how much they've bought
into the tree. Folding it additively into `scoreMasteryBonus` would make it
invisible/diluted at high tree investment; keeping it multiplicative and separate
means it always matters, at every stage — consistent with the missionszanx
"new categories > deeper single category" principle above.

**Abilities are explicitly NOT part of this multiplier stack.** They're a distinct
mechanic type (activatable moves gated by unlock + cooldown, §8), not a scoring
modifier — this mirrors the existing architectural split in `economy.js`'s own
comment (`SKILL_TREE.abilities` "mirrors the CHILI/BUFF/FRENZY split" as a
currency/unlock layer only, with gameplay tuning owned by `game.js`'s `ABILITIES`
const). Keep that split; do not let ability upgrades leak into
`effectiveMultiplier()`.

---

## 5. Skill tree → real branching tree

### Shape

```
                         [ROOT] Awaken the Coil
                                   |
        ┌──────────────┬──────────┴──────────┬──────────────┐
   Branch A          Branch B              Branch C       Branch D
 Score Mastery       Abilities             Economy        Vitality
```

Root: **Awaken the Coil** — cost 25 coins, maxLevel 1, effect: flat +2% score
(folds into `scoreMasteryBonus`). Cheap on purpose — it's a ceremonial gate that
unlocks the branch-view UI, not a real paywall. Every branch below requires Root
owned; individual nodes within a branch have their own prerequisite edges as noted.

This grows the tree from **7 nodes (3+4) to 26 nodes** across root + 4 branches —
meaningfully bigger, per the brief, while keeping every branch's own internal shape
readable (2-4 tiers deep, one clear capstone per branch).

### Branch A — Score Mastery (currency: coins, 1 points capstone)

| Tier | Node | Effect | Currency | baseCost | mult | maxLvl | Prereq |
|---|---|---|---|---|---|---|---|
| 1 | Keen Appetite *(existing)* | +5%/lvl | coins | 40 | 1.12 | 10 | Root |
| 1 | Sharp Fangs *(existing)* | +8%/lvl | coins | 90 | 1.12 | 8 | Root |
| 2 | Golden Instinct *(existing, moved to tier 2)* | +15%/lvl | coins | 200 | 1.14 | 5 | Keen Appetite ≥5 AND Sharp Fangs ≥4 |
| 3 | **Ravenous Growth** *(new)* | +25%/lvl | coins | 900 | 1.16 | 5 | Golden Instinct maxed |
| 4 | **Apex Predator** *(new, capstone)* | +100% flat, one-time | **points** | 6,000 | — | 1 | Ravenous Growth maxed |

All five feed the same `scoreMasteryBonus` additive sum. Fully maxed, Branch A
alone contributes `+5×10 +8×8 +15×5 +25×5 +100 = +414%` → a 5.14× multiplier —
appropriately huge, but it's the branch's true endgame, gated behind the whole
chain plus a points-only capstone.

### Branch B — Abilities & Cooldowns (currency: coins for unlocks, mixed for cooldown reduction — full numeric curves in §8)

| Tier | Node | Effect | Currency | Prereq |
|---|---|---|---|---|
| 1 | Body Toss *(existing unlock)* | unlock ability | coins (150) | Root |
| 1 | Phase Walls *(existing unlock)* | unlock ability | coins (750) | Root |
| 1 | Bigger Bite *(existing unlock)* | unlock ability | coins (3,500) | Root |
| 1 | Auto-Collect *(existing unlock)* | unlock ability | coins (17,500) | Root |
| 2 | Swift Recoil *(new)* | Body Toss cooldown 120s→60s floor | coins | Body Toss |
| 2 | Thinner Walls *(new)* | Phase Walls cooldown 25s→10s | coins | Phase Walls |
| 2 | Longer Fangs *(new)* | Bigger Bite cooldown 20s→10s | coins | Bigger Bite |
| 2 | Extended Instinct *(new)* | Auto-Collect cooldown 30s→15s | coins | Auto-Collect |
| 3 | Porous Scales *(new)* | Phase Walls → 100% uptime | points | Thinner Walls maxed |
| 3 | Ravenous Form *(new)* | Bigger Bite → 100% uptime | points | Longer Fangs maxed |
| 3 | Relentless Pursuit *(new)* | Auto-Collect cooldown 15s→8s floor, pickups 5→7 | points | Extended Instinct maxed |
| 4 | Permeable Scales *(new, capstone)* | Phase Walls becomes passive/always-on | points | Porous Scales maxed |
| 4 | Perpetual Molt *(new, capstone)* | Bigger Bite becomes passive/always-on | points | Ravenous Form maxed |

Full numeric cooldown curves, the Body Toss 60s hard floor, and the "always active"
end-state mechanics are specified in §8 (that's the part of the brief this branch
exists to serve — this table is the tree-shape view of it).

### Branch C — Economy (currency: coins, 1 points capstone)

| Node | Effect | Currency | baseCost | mult | maxLvl |
|---|---|---|---|---|---|
| Lucky Scales | Golden apple chance +0.5%/lvl to both min/max | coins | 300 | 1.13 | 6 |
| Heavy Pockets | Golden apple reward +1/lvl to both min/max | coins | 500 | 1.14 | 5 |
| Frugal Forager | End-of-run bonus divisor 25→20 (−1/lvl, floor 20) | coins | 400 | 1.15 | 5 |
| Idle Mastery II | Idle rate +10%/lvl (stacks with `idleMultiplier` upgrade) | coins | 350 | 1.13 | 5 |
| **Serpent's Fortune** *(capstone)* | Tightens all High-Score Momentum divisors by 15% (see §7) | points | 2,500 | — | 1 |

### Branch D — Vitality (currency: mixed — see §9 for the full design/rationale)

| Node | Effect | Currency | baseCost | mult | maxLvl |
|---|---|---|---|---|---|
| Thick Hide | +1 max Body Toss life/lvl (2→5 total) | **coins** | 2,500 | 1.6 | 3 |
| Quick Regeneration | Tightens the life-regen popup window (see §9) | **points** | 1,800 | 1.4 | 3 |

(Only two nodes for now — Branch D is intentionally the smallest branch; see §9 for
why lives specifically shouldn't be a deep, many-node grind.)

### Currency-split philosophy (answers the brief's "which nodes cost points vs
coins vs a mix, and why")

- **Coins = grind/participation.** Earned by any play style, including idle/AFK.
  Everything a broad, casual player can reach without needing to be *good* at the
  game lives here: unlocks, early tiers, QoL/economy nodes, life-count.
- **Points = skill/active investment.** Points are 1:1 banked score (§6) — they can
  **only** come from actually playing runs and scoring, never from idle, never from
  a coin pack. Every branch's true endgame capstone, and the "approach-zero
  cooldown" endgame ability nodes, are points-priced *on purpose*: they're the
  reward for players who've racked up real score, not just accumulated currency
  over time. This is also the mechanism (not just a policy) that keeps purchases
  from ever buying core power — see §10's purchase-pacing section for how this is
  enforced structurally, not just by convention.
- A few nodes are coins-priced but conceptually "should feel earned" (Thick Hide/
  lives) — kept in coins deliberately (see §9): gating a safety-net resource behind
  a skill-only currency would punish exactly the players who need it most.

---

## 6. Points (score) as a second, persistent currency

### The problem statement, restated

`this.score` in `game.js` is run-local — it resets to 0 in `startGame()`. The brief
requires a durable, spendable "points" balance that (a) persists across runs the
same way `lifetimeCoinsEarned` already does, and (b) can never "vanish" because the
run ended before some banking step happened.

### The resolution: no banking step at all — mirror how coins already work

Coins are never held only in run-local state waiting for a run-end event — golden
apple coins are added immediately, via `economy.addCoins()`, the instant they're
earned (`game.js:525-526`). Points should work identically: **every score increment,
the instant it happens, is mirrored into a permanent balance.** There is no
end-of-run "convert score to points" step to forget, race, or lose — by the time a
run could possibly end (death), every point of score already earned is already
permanently saved (economy.js's `save()` is called on every `addCoins`-style
mutation, so this rides the exact same persistence path that already exists).

### New state (economy.js)

```
economy: {
  ...
  points: 0,           // spendable balance, exactly like `coins`
},
stats: {
  ...
  lifetimeScore: 0,    // never decreases, exactly like `lifetimeCoinsEarned`
}
```

### New functions (mirror `addCoins`/`spendCoins` exactly)

```
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
```

### The single implementation hook (spec for the later coding pass)

`game.js` currently increments `this.score` in five places (normal apple, golden
apple, chili, buff, frenzy pip — all inside `step()`/`eatChili()`/`eatBuff()`).
Replace all five direct `this.score += X` sites with a single helper:

```
addScore(amount) {
  this.score += amount;
  economy.addPoints(amount);   // mirrors every point of run score into the permanent balance, live
}
```

This is the whole mechanism. `this.score` still resets to 0 every run (unchanged —
it's still the correct per-run display/leaderboard number); `economy.points` /
`stats.lifetimeScore` never reset, and are never at risk of loss because they're
never derived from `this.score` after the fact — they're populated in lockstep with
it, in real time, via the exact event that also updates the on-screen score.

**Points balance == lifetime sum of every point of score ever earned, minus
whatever's been spent in the tree.** This is deliberately the most transparent
possible framing for the player: your points are your score, permanently.

### What Score Rank (§3) and the tree (§5) do NOT do to this balance

Score Rank rewards pay in coins, not points (§3) — so the points supply is never
inflated by anything except actual play. Nothing else in this document adds to
`points` except `addScore()`.

---

## 7. High score affecting active-play coin generation

### Current state

Only `computeIdleReward()` scales with `bestScore` (`bestScoreFactor = 1 +
bestScore/150`, uncapped — safe uncapped because it's already bounded by real
elapsed time via `IDLE.capSeconds`).

### Extension — a shared, capped momentum helper

Active-play sources need a **cap**, unlike idle, because they aren't time-bounded —
an uncapped multiplier on a rare-but-repeatable event (goldens) could run away over
a very long single run. New shared internal helper in `economy.js`:

```
function momentumFactor(divisor, cap) {
  const bs = Math.min(state.stats.bestScore, cap);
  return 1 + bs / divisor;
}
```

| Source | Base (bestScore=0) | Divisor | Cap (bestScore) | Max factor | New formula |
|---|---|---|---|---|---|
| Idle coins/sec | `IDLE.coinsPerSecond` (1/45) | 150 | none (time-capped instead) | unbounded | **unchanged** |
| Golden apple reward | `[5,20]` | 300 | 900 | 4× → `[20,80]` | `randInt(round(5*f), round(20*f))` |
| Chili coin bonus *(new)* | `[1,4]` | 450 | 900 | 3× → `[3,12]` | `randInt(round(1*f), round(4*f))` |
| End-of-run bonus | `floor(score/25)` | 250 | 1000 | 5× → `floor(score/5)` | `floor(score/25*f)` |

Notes:

- **Chili currently grants zero coins** (`eatChili()` only adds score) — the brief's
  framing ("golden apples, chili's small bonus...") implies chili should be a coin
  source too, alongside score. This table adds a small, explicitly *small*
  (`[1,4]` base, well under golden's `[5,20]`) coin bonus to `eatChili()`, scaled by
  the same momentum pattern. This is a genuinely new mechanic, flagged as such —
  not a pre-existing behavior this doc is just describing.
- Divisors are chosen to land near existing narrative milestones already in the
  code: golden's divisor (300) matches the `score_300` achievement threshold
  (hitting it exactly doubles golden income, mirroring the existing idle/150↔
  `score_150` tie-in comment at `economy.js:172-176`); chili's (450) and the
  end-of-run bonus's (250) are simple multiples of existing constants (chili's own
  `multiplierStep`-adjacent scale; the run bonus's existing `/25` divisor).
- `Serpent's Fortune` (Branch C capstone, §5) tightens all four divisors by 15%
  (`divisor *= 0.85`) as its single effect — a clean, legible capstone: "your best
  runs make everything else better, faster."

---

## 8. Ability cooldowns and the cooldown-reduction branch

### Current state

`ABILITIES` in `game.js:160-165`: Body Toss has charges but **no time cooldown at
all** between uses (only gated by charge count). Phase Walls (25s), Bigger Bite
(20s), Auto-Collect (30s) all have fixed cooldowns with no reduction path.

### Body Toss — new base cooldown + hard 60s floor

New base cooldown: **120s**, gating how often a charge can be *spent* (independent
of how many charges/lives are in the pool — see §9 for why these stay separate).

**Swift Recoil** node (Branch B): coins, `baseCost 300`, `mult 1.18`, `maxLevel 6`,
`bonusPerLevel = -10s`. Clean, exact arithmetic so the floor lands precisely:

| Level | Cooldown |
|---|---|
| 0 | 120s |
| 1 | 110s |
| 2 | 100s |
| 3 | 90s |
| 4 | 80s |
| 5 | 70s |
| 6 | **60s** |

Implementation must additionally clamp with `Math.max(60, ...)` in code as a
belt-and-suspenders floor — per the brief, **no amount of investment ever goes
below 60s**, and there is deliberately no further node past level 6 for this ability.

### Phase Walls — reduction curve toward always-on

Base: `duration 6s`, `cooldown 25s` (uptime = 6/31 = 19.4%).

**Thinner Walls** (coins, `baseCost 400`, `mult 1.15`, `maxLevel 5`,
`-3s cooldown/lvl`): 25→10s cooldown. Duration unaffected at this tier.

**Porous Scales** (points, `baseCost 1,200`, `mult 1.35`, `maxLevel 5`,
`-2s cooldown/lvl, +2s duration/lvl`, starting from the post-Thinner-Walls
10s/6s baseline):

| Level | Cooldown | Duration | Cycle | Uptime |
|---|---|---|---|---|
| 0 (post Thinner Walls) | 10s | 6s | 16s | 37.5% |
| 1 | 8s | 8s | 16s | 50.0% |
| 2 | 6s | 10s | 16s | 62.5% |
| 3 | 4s | 12s | 16s | 75.0% |
| 4 | 2s | 14s | 16s | 87.5% |
| 5 | 0s | 16s | 16s | **100%** |

At level 5, cooldown is already 0 — mechanically always-reactivatable, i.e.
already-always-on in practice.

**Permeable Scales** (points, one-time, `5,000 points`, requires Porous Scales
maxed) — the formal end-state the brief asks for: **Phase Walls stops being an
activatable ability entirely.** Mechanically: a new permanent boolean
(`this.permanentPhaseWalls = true`, distinct from `this.wrapMode` — must NOT
overwrite the player's actual wrap-mode *setting*, exactly like the existing
"doesn't mutate the real wrap-mode setting" comment on today's Phase Walls already
guarantees) is set once and checked everywhere `this.phaseWallsTimeLeft > 0` is
currently checked (`step()`'s wrap condition, `computeAutoDirection()`'s
`canWrap`). The Phase Walls button disappears from the UI (same `style.display =
'none'` pattern `ui.js` already uses for un-owned abilities) and is replaced by a
static "Phase Walls: Passive" indicator. No keybind, no cooldown, no duration —
it's simply always true from that point on.

### Bigger Bite — identical treatment, same shape

Base: `duration 5s`, `cooldown 20s`.

**Longer Fangs** (coins, `baseCost 350`, `mult 1.15`, `maxLevel 5`, `-2s
cooldown/lvl`): 20→10s.

**Ravenous Form** (points, `baseCost 1,000`, `mult 1.35`, `maxLevel 5`, `-2s
cooldown/lvl, +1s duration/lvl`, from 10s/5s baseline):

| Level | Cooldown | Duration | Cycle | Uptime |
|---|---|---|---|---|
| 0 | 10s | 5s | 15s | 33.3% |
| 1 | 8s | 6s | 14s | 42.9% |
| 2 | 6s | 7s | 13s | 53.8% |
| 3 | 4s | 8s | 12s | 66.7% |
| 4 | 2s | 9s | 11s | 81.8% |
| 5 | 0s | 10s | 10s | **100%** |

**Perpetual Molt** (points, one-time, `4,500 points`, requires Ravenous Form
maxed): Bigger Bite becomes permanently rendered at its scaled size
(`ABILITIES.biggerBite.scale`), no button, no cooldown — trivial to implement
cleanly since Bigger Bite is *already* purely a render-time effect that never
touches hitboxes (`game.js`'s own comment at the render site confirms this), so
"always on" here is just "always draw it scaled," nothing more.

### Auto-Collect — reduction branch WITHOUT an always-on end-state (deliberate exclusion)

Base: `cooldown 30s`, `pickupCount 5`.

**Extended Instinct** (coins, `baseCost 500`, `mult 1.15`, `maxLevel 5`, `-3s/lvl`):
30→15s.

**Relentless Pursuit** (points, `baseCost 1,500`, `mult 1.30`, `maxLevel 4`,
`-1.75s/lvl cooldown, +0.5 pickup/lvl rounded`): 15s → **8s floor**, pickups 5→7.

No capstone makes this "always on." **This is an explicit design decision, not an
oversight**: Phase Walls and Bigger Bite becoming passive turns them into buffs
(permanent wall-passthrough, permanent bigger hitbox-free visual) — the player is
still the one steering. Auto-Collect *removes player input* while active; a
permanent, always-on autopilot would mean the player is no longer playing the game
during those windows, which is categorically different from a passive buff and
would hollow out the core loop. The brief only named Phase Walls and Bigger Bite
for the always-active end-state — this section treats that as intentional scope,
not an omission to "fix" later.

### Cross-reference: does this interact with Body Toss's lives (§9)?

No — by design. See §9's closing note: the cooldown gates *rate of spending* a
charge; the life-regen popup gates *pool size*. Both must independently allow a
toss (charge available AND cooldown expired) for one to happen. This is a
deliberate two-axis limiter (pool + rate), not redundant — without the rate limit,
a life gained mid-crisis via the §9 popup could be spent instantly back-to-back
with an already-available charge, letting a single "found generosity" moment
trivialize two consecutive near-deaths in the same second.

---

## 9. Body Toss redesign — proportional shrink, lives, regen popup

### 9a. Shrink amount: flat 3 → 30% of current length

Replace `ABILITIES.bodyToss.shrinkAmt: 3` with a fraction, mirroring `CHILI`'s
existing shrink logic exactly (`game.js:550-557`, `CHILI.shrinkFraction: 0.3`) —
same shape, same safety clamp:

```
shrinkAmt = Math.min(
  Math.max(1, Math.ceil(this.snake.length * 0.3)),
  Math.max(0, this.snake.length - ABILITIES.bodyToss.minLength)
);
```

`ABILITIES.bodyToss.minLength` stays **3** — identical to `CHILI.minLength` and to
the snake's actual starting length in `startGame()` (`game.js:337-341`). This
confirms the interaction is sound: Body Toss, exactly like Chili, can **never**
reduce the snake below 3 segments and can therefore never be the direct cause of
death, at any snake length. At length 3, `Math.max(0, 3-3)=0` → the clamp correctly
makes the toss a no-op (0 segments removed) rather than erroring or going negative.

**Why proportional (not flat) matters for the lives reframe below:** a flat-3 toss
on a long snake is nearly free; a 30%-of-length toss has a real, escalating cost —
three tosses in a row on a 20-length snake shrink it `20→14→10→7` (ceil'd 30% each
time), with diminishing absolute returns near the floor. This makes spamming lives
self-limiting by design, which is exactly what turns a bailout button into a
believable "life" — see 9b.

### 9b. Charges → "lives"

Keep the existing `bodyTossCharges` mechanism functionally as-is (a depletable pool
gating `useBodyToss()`); reframe it in naming/UI only as **lives**. Recommend
renaming the instance field to `this.lives` in the eventual coding pass for
clarity, since "charges" implies an ammo/resource-spend framing and "lives" is what
the brief (and the intended player-facing framing) wants — a safety net you survive
on, not a consumable you spend for score.

**Base max lives: 2** (unchanged from today's default — day-one balance doesn't
regress).

**Thick Hide** node (Branch D, §5): coins, `baseCost 2,500`, `mult 1.6`,
`maxLevel 3`, `+1 max life/lvl` → **2 → 5 lives**, absolute hard cap at 5.
Cumulative cost to max: `2,500 + 4,000 + 6,400 = 12,900` coins (at 1x scale, before
§10's calibration multiplier).

**Why cap at 5, and why coins not points:** five bailouts per run is generous
without making death optional — and because each toss now costs 30% of current
length (9a), repeated tosses have compounding real cost even with 5 lives
available, so more lives doesn't trivially mean "unkillable," it means "more
*chances* to pay the shrink cost instead of dying." Priced in coins (not points,
unlike most of Branch D's sibling capstones elsewhere) deliberately — see §5's
currency philosophy: gating a safety-net resource behind the skill-only currency
would punish exactly the players who most need more lives (newer, lower-skill
players who die more and score less, and therefore have fewer points).

### 9c. Random life-regen popup, ~every 5 minutes of play

**Bounded, non-probabilistic, deliberately NOT a golden-apple-style variable-ratio
roll.** This is an explicit, considered departure from the golden-apple pattern,
not an inconsistency:

- Golden apples are optional *upside* — variable-ratio reinforcement (a
  probabilistic %-chance-per-spawn) is an appropriate, industry-standard, and
  already-documented-in-this-repo pattern for a bonus reward (see `README.md`'s
  "bounded variable-ratio reinforcement" section).
- A life is *safety-relevant progression the player needs to keep playing* — the
  brief explicitly says this must not be "gated behind pure gambling odds." A
  %-chance-per-tick roll, even bounded, still has a nonzero chance of a very long
  unlucky dry spell, which is the wrong feel for a resource framed as a lifeline.
  Instead: a **deterministic-at-a-jittered-interval timer** — guaranteed to fire
  once the window elapses, with only the window's *length* randomized (not
  whether it fires at all). This is strictly safer/fairer than a probabilistic
  roll while still not being a perfectly predictable, memorizable metronome.

**Design:**

```
POPUP_MIN_SEC = 270   // 4.5 min
POPUP_MAX_SEC = 330   // 5.5 min
```

- New persisted stat: `stats.activePlaySeconds` — accumulated only while
  `this.alive === true` (increment each frame by `delta/1000` in `update()`, mirror
  into `economy` periodically the same way `touchLastSeen()` already runs on an
  interval). This deliberately tracks *active play time*, not wall-clock/idle time
  — the popup is a reward for playing, not for having the tab open.
- Each time the window elapses (`activePlaySeconds` crosses the next threshold, a
  threshold re-drawn uniformly in `[270, 330]` after each fire — same "redraw the
  bound each time" shape as `GOLDEN`'s cooldown, for consistency of pattern, but
  applied to a guaranteed-fire timer instead of a chance-to-fire roll):
  - If `lives < maxLives`: grant `+1 life` immediately.
  - If `lives === maxLives` already: the window is simply consumed/skipped (no
    stockpiling past max, no banking a "missed" grant for later) — keeps the system
    simple and prevents runaway accumulation from an AFK/idle session, though note
    this only counts *active* play time, so idle sessions don't advance this timer
    at all regardless.
- **UX: auto-granted, not a claim-requiring modal.** Unlike the Idle Claim modal
  (which happens at the start/menu screen, where a blocking modal is safe), a life
  regen fires *during* active, fast-reflex gameplay — pausing for a modal click
  here would be actively dangerous UX (could itself cause the death the life was
  meant to prevent). Recommend: auto-apply the `+1 life` the instant the timer
  fires, paired with a non-blocking `showToast('+1 Life!')` (the existing toast
  system already used for Body Toss/Phase Walls/etc. notifications in `ui.js`) —
  zero friction, matches the "found generosity, not a decision point" framing.

**Quick Regeneration** node (Branch D, §5): points, `baseCost 1,800`, `mult 1.4`,
`maxLevel 3`, tightens both bounds by 30s/level:

| Level | Window |
|---|---|
| 0 | 270–330s (avg 5.0 min) |
| 1 | 240–300s (avg 4.5 min) |
| 2 | 210–270s (avg 4.0 min) |
| 3 | 180–240s (avg 3.5 min) |

Still bounded/jittered at every level — the node makes the average faster, never
removes the randomized-window shape, so it can't be turned into a fixed,
memorizable metronome even at max investment.

### 9d. Interaction with §8's cooldown-reduction system

**Deliberately orthogonal**, per the brief's explicit question — see §8's closing
note for the full reasoning: lives (pool size, this section) and the Swift Recoil
cooldown (spend rate, §8) are two independent axes that both gate `useBodyToss()`
simultaneously. Neither section's node touches the other's numbers.

---

## 10. Pacing — organic vs. purchase-nudged progression

### The target, restated

Sustain hourly play sessions across an organic progression arc of roughly **3
years**; a "gentler" purchase path should nudge that down by **15–25%** (≈2.25–2.55
years), never toward the previously-rejected 6× (~6 months) figure. Purchases stay
convenience/pace-only, never core power — and the grind itself must not be sized
around selling relief from it (i.e., the 3-year number has to fall out of an
honest bottom-up model of earn rates vs. costs, not be reverse-engineered from a
desired price point).

**This whole section is a first-pass calibration model, explicitly not a
guarantee.** Every rate below is an estimate (apples/hour, goldens/hour,
score/run) that only real playtesting can confirm — the deliverable here is the
*method* (a bottom-up hourly model + an explicit calibration knob) and *starting
numbers* to playtest against, not a promise that these exact constants are final.

### Assumed session cadence

**4 sessions/week, ~1 hour each** (a plausible, sustainable "hourly sessions"
cadence for a casual browser game — not daily, not rare). This matters a lot
because of `IDLE.capSeconds` (12h cap per claim): with ~42h average gaps between
sessions, every idle claim hits the 12-hour cap, so idle income scales with
*session frequency*, not with total time away.

### Bottom-up hourly income model

**Coins** (blended across the 3-stage journey — early/mid/late `bestScore`):

| Source | Rate |
|---|---|
| Active play (goldens + end-of-run bonus + new chili bonus, blended) | ~800 coins/hr of active play |
| Idle, per 12h-capped claim (blended `bestScoreFactor`, with `idleMultiplier` owned) | ~300 coins/hr-equivalent |

- Active coins/week: `4hr × 800 = 3,200`
- Idle coins/week: `4 claims × 12h × 300 = 14,400` (idle dominates, by genre design
  — this matches the Envato "accumulation/reinvestment" loop description; it's the
  intended shape, not a bug)
- **Total: ≈17,600 coins/week → ≈2,745,600 coins over 156 weeks (3 years)**

**Points** (active-play only — idle generates zero score, so points growth is
strictly bounded by actual play time, by construction of §6's design):

| | Estimate |
|---|---|
| Blended avg score/run (weighted across the 3-year arc) | ~300 |
| Runs/hour | ~8 |
| Points/hr | ~2,400 |

- Points/week: `4 × 2,400 = 9,600`
- **Total: ≈1,497,600 points over 156 weeks**

### Sizing the tree against the budget

Summing every node in §5/§8/§9 at their listed **1x** baseCosts:

- Total coin cost (all branches, all nodes, fully maxed): **≈66,165 coins**
- Total points cost: **≈57,023 points**

Targeting the tree alone consuming **~65%** of the full 3-year budget (leaving
headroom for skins/trails/upgrades/Rank spending and realistic non-optimal play,
not literally 100% min-maxed):

```
target coin budget for the tree   = 0.65 × 2,745,600 ≈ 1,784,640
target points budget for the tree = 0.65 × 1,497,600 ≈   973,440

CALIBRATION_K_COINS  = 1,784,640 / 66,165  ≈ 27   → recommend round to 25
CALIBRATION_K_POINTS =   973,440 / 57,023  ≈ 17   → recommend round to 15
```

**Recommendation: `CALIBRATION_K_COINS = 25`, `CALIBRATION_K_POINTS = 15`.**
Apply as a flat multiplier to every new-node `baseCost` throughout §5/§8/§9 before
implementation (existing `scoreMastery` node costs — Keen Appetite/Sharp Fangs/
Golden Instinct — are left at their current live values; only new nodes get
scaled, to avoid retroactively re-pricing something already shipped and possibly
already partially purchased by a real save file).

This yields a full-completion time (at the ~65%-of-budget target, average pace)
of roughly **2.6–3.1 years** of organic 4×/week hourly play — landing on the
brief's ~3-year target directly from the bottom-up model, not backed into.

### The purchase-driven "gentler" nudge

The only real-money-purchasable items remain exactly what the existing
`MOCK_STORE` already stubs — Coin Packs — and, critically, **coins alone can never
buy a points-gated node** (every branch's true capstone and every "approach-zero
cooldown" endgame ability node is points-priced, §5/§8). This is the structural
enforcement of "never core power": no purchase, at any volume, shortcuts the
points-gated mastery path, because points cannot be bought, full stop, by
construction (§6).

Recommend scaling `MOCK_STORE` pack sizes by the same `CALIBRATION_K_COINS` (25×)
so they stay meaningfully proportioned to the recalibrated economy — otherwise a
"550 coins for $3.99" purchase becomes invisible against a ~1.7M-coin tree budget:

| Pack | Old size | New size (×25, rounded) | Mock price |
|---|---|---|---|
| Small | 100 coins | 2,500 coins | $0.99 (mock, unchanged) |
| Large | 550 coins | 14,000 coins | $3.99 (mock, unchanged) |

To hit **exactly the 15–25% target** (not 6×): 15–25% of the ~1,784,640-coin tree
budget is 267,700–446,000 extra coins across the full journey. At 14,000
coins/large-pack, that's **~19–32 large-pack purchases spread across the ~2.5–3
year organic arc — roughly one purchase every 5–8 weeks**, i.e. a light, occasional
top-up cadence, explicitly NOT a purchase-every-session pattern. This is the
concrete shape of "gentler": infrequent, coin-only, structurally incapable of
touching the points-gated power ceiling.

---

## Sources

- Missions Zanx Online, *How Multipliers Stack in Idle RPGs* —
  https://missionszanx.com/guides/how-multipliers-stack-in-idle-rpgs — the
  "additive within a group, multiplicative between groups" principle and its
  worked 2250-vs-2000 example underpin §4 and the overall category structure in
  §5–§7.
- Missions Zanx Online, *Progression and Scaling in Incremental Games* —
  https://missionszanx.com/guides/progression-and-scaling-in-incremental-games
- Missions Zanx Online, *Idle Game Design: Systems, Mechanics, and Progression* —
  https://missionszanx.com/guides/idle-game-design-systems-mechanics-and-progression
- Game Developer (formerly Gamasutra), *The Math of Idle Games, Part I* —
  https://www.gamedeveloper.com/design/the-math-of-idle-games-part-i — exponential
  cost-curve growth rates (AdVenture Capitalist's 1.07 baseline cited against this
  project's steeper 1.12–1.18/1.30–1.40) and the role of stacking-multiplicative
  upgrades in rebalancing the cost/production seesaw, referenced in §4 and §10.
- Envato Tuts+, *Numbers Getting Bigger: The Design and Math of Incremental Games*
  — https://code.tutsplus.com/numbers-getting-bigger-the-design-and-math-of-incremental-games--cms-24023a
  — the accumulation/reinvestment/acceleration loop and the "discovery of new
  systems drives renewed engagement" framing, cited in §4's rationale for adding
  new multiplicative categories (High-Score Momentum, Prestige capstones) rather
  than deepening existing ones indefinitely.
- Envato Tuts+, *Numbers Getting Even Bigger: The Growing Appeal of Incremental
  Games* — https://code.tutsplus.com/numbers-getting-even-bigger--cms-26854a
- This project's own `README.md` "Reward-loop design" section — the existing,
  already-shipped bounded variable-ratio (golden apples) and non-probabilistic
  calm-claim (idle) patterns this document extends and deliberately contrasts
  against in §9c's life-regen-popup design.

---

## Open questions for the user

These need your input; everything above is a committed, concrete recommendation,
but these specific points genuinely can't be resolved without a decision only you
can make:

1. **§10's calibration constants (K_COINS=25, K_POINTS=15) are a first-pass math
   model, not playtested.** Are you planning an actual playtest pass to measure
   real apples/hour, goldens/hour, and score/run before an implementer bakes these
   in, or should the implementer just ship the model's numbers as-is and tune
   later from real analytics/telemetry (which this game doesn't currently
   collect — worth flagging as a gap if you want data-driven tuning rather than
   re-guessing)?
2. **Retiring the `coin_collector` achievement** (§3) when Rank ships — confirm
   you're fine losing that one achievement-checklist row, or would you rather keep
   both systems fully independent even with the overlap?
3. **Branch D (Vitality) is deliberately the smallest branch (2 nodes)** — should
   it grow further in a later pass (e.g., a third node for something like
   temporary invincibility-frames after a life-regen pickup), or is "just lives +
   regen-tuning" the intended final scope for this branch specifically?
4. **Auto-Collect's exclusion from the "always-on" end-state (§8)** is this
   document's own judgment call (autopilot removing player agency is
   categorically different from a passive buff) — confirm you agree, since it's a
   deviation from treating all 4 abilities identically that the brief didn't
   explicitly settle either way.
5. **Real pricing for the Coin Packs** (§10 only recalibrated their coin *size*,
   keeping the existing mock `$0.99`/`$3.99` price labels unchanged) — when this
   ever gets wired to a real payment provider (per `economy.js`'s existing
   `mockPurchase()` stub/comment), do you want real prices to also change, or stay
   at these same two price points with just bigger coin grants?
