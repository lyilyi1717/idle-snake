# Idle Pivot — Task List (for Codestral via /code-local)

Convert the game into an idle clicker. The snake always steers itself and never
dies. The player taps, triggers buffs, places portals and buys upgrades.

Design sources: this file (decisions below) and
`..\nokia-snake\docs\game-theory-design.md` §4 (the additive-within /
multiplicative-across multiplier structure).

## Rules for every task (read CLAUDE.md "lessons learned" first)

- One task = one aider session. Add ONLY the files listed under **Files**.
- Use `--message-file`, not an inline heredoc. Never put real URLs in prompts.
- Use `diff` format for edits under ~40 lines. For larger changes, split into
  sub-steps anchored on exact existing text. Never ask for a `whole` rewrite of
  `game.js`, which is too big and gets truncated.
- After every task: `node --check` each touched file, then `node tests/hang-check.js`.
  Both must pass. Then `git diff` and check for placeholder comments
  (`// ...`, `// rest of`), duplicated blocks, or a method nested in the wrong scope.
- Commit after each green task: `git commit -m "idle: T<nn> <title>"`.
- Some tasks add a test to `tests/scene-tests.js`, which runs inside
  hang-check's vm context. `check(name, cond, detail)` is available there.

## Locked design decisions

| Topic | Decision |
|---|---|
| Death | None. Hitting a wall or itself, being trapped, or the arena closing all trigger a **Molt** (prestige). |
| Molt payout | `ΔSkin = 0.01 · sqrt(L) · J`. `φ = L / arenaCells`. `J = 3` if φ ≥ 0.95, `1.5` if φ ≥ 0.75, else `1`. `SkinMult = 1 + ΣΔSkin`, its own multiplicative category. |
| Run clock | The arena shrinks inward one ring at a time. Ring interval = `240 / floor(min(cols, rows) / 2)` seconds, so a full board closes in about 240 s at base. |
| Speed | Base 10 ticks/s. **Remove `speed++` per apple.** Speed = base + upgrades + tap burst, hard cap 30. |
| Tap | Tap on an empty cell gives a burst: +10% speed for 1 s per tap, up to 5 stacks (+50%). |
| Combo | Eat within `comboWindow` ticks of the last apple → `combo++`. `comboMult = min(3, 1 + 0.1 · combo)`. Base window 25 ticks. A miss resets combo to 0. |
| Brains | Tier 1 greedy → tier 2 BFS → tier 3 BFS + tail-reachability + auto-Prune → tier 4 Hamiltonian. Tier 4 never traps, is the only way to reach the φ ≥ 0.95 jackpot, and ignores portals. |
| Prune | **Automatic brain behaviour, not a tap.** Unlocked with tier 3. Fires only when a flood-fill says the tail is unreachable AND reachable area < L AND φ < 0.35. Cuts `ceil(0.25·L)` (keeps at least 3). 1 charge per run, +1 per "Spare Shears" level (max +2). Resets combo to 0. |
| Chili | **Remove the 30% shrink.** Keep only the multiplier stack. |
| Tail-proximity / AI personality | **Dropped.** Do not implement. |
| Portals | See the **Portal spec** below. |
| Expiring apple | 15% of spawns. 3x value, lives 8 s, fades out. Tapping it freezes the timer for 5 s (once per apple). |
| Mouse | Spawns every 45–90 s. Moves 1 cell every 3 ticks away from the head. Lives 10 s. A tap within 1 cell catches it for 5 × apple value. The snake can eat it too. |
| Zones | Prestige ladder: Open → Box → Cross → Tunnels → Spiral. Zone n pays `×(1 + 0.5n)`. A φ ≥ 0.75 Molt in zone n unlocks zone n+1. |
| Offline | `offline coins/s = 0.4 × last session's measured coins/s`, capped at 12 h (the existing `IDLE_MAX_SECONDS`). |

### Portal spec

- **Pairs:** two-way. You own them permanently, max 3 on the board. Pair 1 costs 400 coins, pair 2 costs 1,500, pair 3 costs 6,000 and needs Zone 3. Unlocked with brain tier 2.
- **Placement rules:** ends of a pair must be at least 10 cells apart (Manhattan). They can't go on a wall, hazard, snake body, the food cell or another portal end.
- **Persistence:** positions are saved. After each Molt they are restored, and any end outside the arena is dropped.
- **Live moves:** each run starts with 2. You gain +1 every 30 s, up to 3. Dragging one end costs 1 move.
- **Traversal:** when the head enters one end, it exits at the other. The first traversal per apple adds +10 ticks to the combo window. The flag resets when the snake eats.
- **Creep:** when the arena shrinks past either end, the pair collapses (is disabled) for the rest of the run.
- **Hazards:** a pair is disabled while a hazard is active on either end.
- **Pathing:** portals are graph edges in the BFS, and the flood-fill counts reachability through them. Tier 4 (Hamiltonian) ignores them. That is deliberate: it's the trade between the safe jackpot and portal combo income.
- **Input priority on `pointerdown`:** portal end (start drag) > mouse (catch) > expiring apple (freeze) > anything else (tap burst).

---

## Phase 0 — Foundation (no death, always auto)

**T01 — Always-on autopilot, remove steering input**
Files: `js/game.js`, `js/ui.js`, `index.html`
- In `gameTick()` (`game.js:159`), call `this.steerTowardFood()` every tick unconditionally. Delete `runAutoCollectStep()` and its call.
- In `handleKeyDown`, delete the arrow/WASD cases (`case 37/65, 38/87, 39/68, 40/83`). Keep 49–52 (ability keys).
- In `create()`, delete the `pointerup` swipe handler.
- Remove the Auto Play checkbox from `index.html` and `ui.js:238-242`. Leave `getAutoPlay`/`saveAutoPlay` in storage.js unused.

Accept: hang-check passes, and the snake moves by itself with no key input.

**T02 — Remove per-apple speedup, add speed cap**
Files: `js/game.js`
- Delete `this.speed++;` in `checkFoodCollision()`.
- Add the constants `BASE_SPEED = 10` and `MAX_SPEED = 30`. Add a method `currentSpeed()` that returns `Math.min(MAX_SPEED, BASE_SPEED)` for now (T08 and T14 extend it).
- In `update()`, use `1000 / this.currentSpeed()` for the tick interval.

**T03 — Remove chili shrink**
Files: `js/game.js`
- In the `checkFoodCollision()` chili branch, delete the `shrinkAmount` lines and the `splice`. Keep the `chiliStack`, score and sound lines.

**T04 — Food never spawns on the snake**
Files: `js/game.js`
- In `createFood()`, reroll x/y (up to 200 tries) until the cell isn't occupied by any snake segment. Add the helper `isFreeCell(x, y)`, which returns false if any segment is at (x, y). T12 extends it.

**T05 — Skin multiplier storage**
Files: `js/storage.js`, `js/economy.js`
- storage.js: add `getSkinMult()` (default 1) and `saveSkinMult(v)`, stored via `storeValue('snakeSkinMult', ...)`. Also add `getMoltCount()` / `incrementMoltCount()`.
- economy.js: add `moltPayout(length, phi)`, which returns `0.01 * Math.sqrt(length) * J` using the J thresholds from the decisions table.

Test: `moltPayout(100, 0.5) === 0.1`, `moltPayout(100, 0.8) ≈ 0.15`, `moltPayout(100, 0.96) ≈ 0.3`.

**T06 — `gameOver()` becomes `molt()`**
Files: `js/game.js`
- Rename `gameOver` to `molt`, and update the 2 callers in `checkSelfCollision` and `checkWallCollision`.
- Add `return;` after the call inside the `checkSelfCollision` loop. It currently fires once per overlapping segment.
- In `molt()`:
  - Set `this.isGameOver = true` to stop ticks.
  - Keep the high-score, stats and end-of-run-bonus lines.
  - Compute `phi = this.snake.length / (this.cols * this.rows)`. T13 switches this to arena cells.
  - Add `moltPayout(...)` to `getSkinMult()` and save it, then call `incrementMoltCount()`.
  - Set a toast: `'Molt! Skin x' + newMult.toFixed(2)`.
  - Call `this.time.delayedCall(1200, () => this.restartGame())`.
- Delete `showGameOverDialog()` and its call. In `ui.js`, delete the DOM game-over overlay logic that reads `scene.gameOverDialog`, plus its markup in index.html.
- Remove the ENTER / pointerdown "restart if game over" handlers.

Accept: hang-check (update the old game-over dialog checks to assert a Molt happens and the scene restarts).

**T07 — Skin multiplier in scoring**
Files: `js/game.js`
- Change `effectiveMultiplier()` (`game.js:535`) to multiply its current result by `getSkinMult()`.

**T08 — Tap burst**
Files: `js/game.js`
- Add `this.burstExpiries = []` in `create()`.
- In the pointerdown handler, push `Date.now() + 1000` if there are fewer than 5 live entries.
- `currentSpeed()` becomes `Math.min(MAX_SPEED, BASE_SPEED * (1 + 0.1 * liveBurstCount))`, where live entries are expiries later than `Date.now()`. Prune expired ones.
- In `draw()`, show a small "BURST xN" text or bar when N > 0.

**T09 — Remove lives, Body Toss and life regen**
Files: `js/game.js`, `js/economy.js`, `js/ui.js`
- Delete `updateLifeRegen()` and its call. Remove `bodyToss*` fields from `ABILITY_STATE` and `abilityConfig()`, and delete the key-`1` Body Toss branch in `triggerAbility()`.
- Also delete the Auto-Collect ability, since the snake is always automatic: remove key `4`, the `autoCollect*` fields and the `autoCollectRemaining--` in `checkFoodCollision`.
- Remove skill nodes `B1`, `B4`, `B7`, `B8`, `D1`, `D2` from `SKILL_TREE`, and any UI that references them.

Accept: `grep -n "bodyToss\|autoCollect\|D1\|D2" js/*.js` finds nothing. Hang-check passes.

## Phase 1 — Combo chain and shrinking arena

**T10 — Combo chain**
Files: `js/game.js`
- State: `this.combo = 0`, `this.comboDeadline = 0` (tick count), `this.tickCount = 0` (incremented each `gameTick`), `this.comboWindow = 25`.
- On eating: if `tickCount <= comboDeadline`, do `combo++`, else `combo = 1`. Then `comboDeadline = tickCount + comboWindow`.
- In `gameTick`, if `tickCount > comboDeadline` and `combo > 0`, reset `combo = 0`.
- `effectiveMultiplier()` also multiplies by `Math.min(3, 1 + 0.1 * this.combo)`.
- In `draw()`, show "COMBO xN" when combo ≥ 2.

Test: eating at ticks 0, 10 and 20 gives combo 3, and eating again at tick 60 resets it to 1.

**T11 — Arena state and creep timer**
Files: `js/game.js`
- State: `this.arena = { x0: 0, y0: 0, x1: this.cols - 1, y1: this.rows - 1 }`, `this.creepElapsed = 0`, and `this.ringIntervalMs = 240000 / Math.floor(Math.min(this.cols, this.rows) / 2)`.
- In `update()` (real time, not ticks), add delta to `creepElapsed`. When it passes `ringIntervalMs`, shrink each bound by 1 (x0++, y0++, x1--, y1--) and subtract the interval.
- In `drawGrid` / `draw`, fill the cells outside the arena with the skin's grid colour so the walls are visible.

**T12 — Collisions and spawns respect the arena**
Files: `js/game.js`
- In `checkWallCollision()`, a head outside `this.arena` → `molt()`. Phase Walls, wrap mode and passive Phase Walls now wrap inside the arena bounds instead of the full grid.
- Extend `isFreeCell` with an "inside the arena" check. Food and frenzy pips must use `isFreeCell`.
- After each ring shrink, if any snake segment is outside the arena → `molt()`. If the food is outside, call `createFood()`.

**T13 — Arena-closed Molt and φ from the arena**
Files: `js/game.js`
- Add a helper `arenaCells()`, which returns `(x1 - x0 + 1) * (y1 - y0 + 1)`.
- In `molt()`, compute `phi = length / arenaCells()`, using the arena at the moment of the Molt.
- After a shrink, if `arenaCells() <= this.snake.length` → `molt()`.

**T14 — Upgrades: speed and creep slowdown**
Files: `js/economy.js`, `js/game.js`
- Add skill nodes:
  - `E1` "Quick Scales": coins, base 100, ×1.15, max 10, +1 base speed per level.
  - `E2` "Slow Tide": coins, base 250, ×1.25, max 5, +15% ring interval per level.
- Apply them in `currentSpeed()` and `ringIntervalMs`.
- Put them in the tree UI the same way branch A nodes render.

## Phase 2 — Brains and Prune

**T15 — Own pathfinder (replaces EasyStar)**
Files: new `js/pathfind.js`, `index.html` (script tag before game.js), `tests/hang-check.js` (load it)
- `bfsPath(grid, cols, rows, start, goal, portals)`:
  - `grid[y][x]` is 1 for blocked, 0 for free.
  - `portals` is an array of `{a:{x,y}, b:{x,y}, alive}`. A cell that is a live portal end also connects to its partner.
  - Returns an array of `{x, y}` from start to goal, or null.
- `floodCount(grid, cols, rows, start, portals)` returns the number of reachable cells.
- Pure functions: no Phaser, no `this`.

Tests: a straight path, a blocked path returns null, a portal shortcut is shorter than the walk, and floodCount on an open 5×5 grid = 25.

**T16 — Brain tiers 1 and 2**
Files: `js/game.js`, `js/storage.js`
- storage: add `getBrainTier()` (default 1) and `saveBrainTier()`.
- Add `buildBlockGrid()`: arena exterior, snake body except the tail, and zone walls (T31) are all 1.
- `steerTowardFood()`: tier 1 keeps the existing greedy block. Tier ≥ 2 uses `bfsPath` to the food, taking the first step, with greedy as the fallback.
- Delete `aStarStep()`. Remove the easystar script tag from index.html and the easystar checks from hang-check. Leave the vendored file in place.
- For now, tiers can be bought with coins: tier 2 for 500, tier 3 for 3,000, tier 4 for 15,000 (T32 replaces this with Trials).

**T17 — Tier 3: tail-reachability**
Files: `js/game.js`
- For each safe move from the BFS or greedy step, simulate the head moving there and run `floodCount`. If the result < `snake.length`, reject the move.
- If every food-directed move is rejected, follow the tail: `bfsPath` to the current tail cell.
- If that fails too, call `tryPrune()` (T18) and otherwise take any safe move.

**T18 — Auto-Prune and Spare Shears**
Files: `js/game.js`, `js/economy.js`
- `this.pruneCharges = 1 + getSkillLevel('P1')` at the start of each run.
- `tryPrune()`: requires tier ≥ 3, `pruneCharges > 0`, and `this.snake.length / arenaCells() < 0.35`. It cuts `Math.ceil(0.25 * L)` segments from the tail (keeping at least 3), decrements charges, sets `combo = 0`, and shows the toast "Pruned".
- Add node `P1` "Spare Shears": coins, base 300, ×3.0, max 2.

**T19 — Tier 4: Hamiltonian cycle**
Files: `js/game.js`
- `buildCycle(arena)` returns a map from cell to next direction, using a zigzag (boustrophedon) cycle through the arena rectangle. This needs an even width or height; otherwise fall back to tier 3 behaviour for that ring.
- Rebuild the cycle whenever the arena shrinks. At tier 4, `steerTowardFood()` just follows the cycle, and portals and food are ignored.

Accept: in hang-check, a tier-4 snake survives 2,000 ticks with no Molt caused by self-collision.

## Phase 3 — Tap pickups

**T20 — Expiring apples and freeze**
Files: `js/game.js`
- In `createFood()`, 15% of plain-apple spawns become `type: 'expiring'` with `expiresAt = now + 8000` and `frozen = false`.
- If it expires, respawn a normal apple.
- A pointerdown on its cell (convert the pointer to a cell with `cellSize`) sets `expiresAt += 5000` once per apple.
- Eating it scores 30 × the multiplier. Render it fading with alpha based on the time left.

**T21 — Mouse**
Files: `js/game.js`
- `this.mouse = null`. Spawn one every `Phaser.Math.Between(45000, 90000)` ms on a free cell, lasting 10 s.
- Every 3 ticks, move it 1 cell to the free neighbour that is farthest from the head (Manhattan).
- A pointerdown within 1 cell catches it: `addScore(50 * effectiveMultiplier())`, a sound, `mouse = null`. The snake's head reaching its cell does the same.
- Implement the `pointerdown` priority order from the portal spec here as `handlePointerDown(cell)`: mouse → expiring apple → burst. T25 inserts portals at the top.

## Phase 4 — Portals (see Portal spec)

**T22 — Portal state, teleport and draw**
Files: `js/game.js`, `js/storage.js`
- storage: add `getPortalLayout()` / `savePortalLayout(arr)`, where `arr` is `[{a, b}]`, and `getOwnedPortalPairs()`.
- `this.portals = loadPortalLayout` restricted to the pairs you own, each `{a, b, alive: true}`.
- In `moveSnake()`, after the head moves: if it is on the end of a live pair, set the head to the partner end.
- Draw each pair as two hollow squares in the same colour, one colour per pair, dimmed when not alive.

**T23 — Portals in pathing and combo**
Files: `js/game.js`
- Pass `this.portals` to `bfsPath` / `floodCount` (tiers 2–3 only).
- On teleport: if `!this.portalUsedThisApple`, then `comboDeadline += 10` and set the flag. Reset the flag when the snake eats.

**T24 — Collapse and hazard disable**
Files: `js/game.js`
- After a ring shrink, set `alive = false` on any pair with an end outside the arena.
- `isPortalActive(p)` = `p.alive` AND no active hazard on either end (hazards come in T30; stub it to `p.alive` for now).

**T25 — Drag placement and move charges**
Files: `js/game.js`
- `this.portalMoves = 2` at the start of a run; add +1 every 30 s, up to 3. Show "Moves: N" in the HUD.
- pointerdown on a portal end starts a drag; pointerup on a valid cell moves that end and spends 1 move. A valid cell follows the placement rules and must be inside the arena.
- On an invalid drop, snap the end back and flash it red.
- Save the layout after every move.

**T26 — Buying pairs and the free first placement**
Files: `js/economy.js`, `js/ui.js`
- Shop entries for pairs 1–3 at the prices and gates from the spec.
- A newly bought pair spawns at 2 default valid cells (the arena's left-centre and right-centre, or the nearest free cells) and can be dragged without spending moves until the run ends.

## Phase 5 — Zones and Brain Trials

**T27 — Zone layouts**
Files: new `js/zones.js`, `index.html`, `js/game.js`
- `ZONES = [{ id, name, walls: fn(cols, rows) -> [{x, y}], mult }]` for Open, Box, Cross, Tunnels and Spiral. Walls are generated from cols/rows, not hardcoded, so they work on any screen size.
- Walls count as blocked in `buildBlockGrid()`, `isFreeCell` and the head collision check (a hit → `molt()`).
- storage: add `getZone()` / `saveZone()` and `getMaxZone()`.

**T28 — Zone progression**
Files: `js/game.js`, `js/ui.js`
- A Molt with φ ≥ 0.75 in zone `n == maxZone` unlocks `n+1`.
- The Setup panel gets a zone selector limited to `≤ maxZone`.
- `effectiveMultiplier()` multiplies by the zone's `mult`.

**T29 — Hazards: spikes and mud**
Files: `js/zones.js`, `js/game.js`
- Tunnels zone: spike cells that are active 2 s on / 2 s off.
  - An active spike counts as a wall.
  - Tapping it jams it off for 3 s, with a 10 s cooldown per spike.
  - Brains treat it as blocked when active.
- Spiral zone: mud cells that halve speed for 3 ticks after the head enters.
- Wire hazards into `isPortalActive` (T24).

**T30 — Brain Trials**
Files: new `js/trials.js`, `js/game.js`, `js/ui.js`
- 3 trials, one each for tiers 2, 3 and 4. Each is a fixed small arena (for example 16×12) with fixed walls and a fixed apple sequence (20 apples).
- A run in trial mode uses the *candidate* tier's brain. There's no creep; the goal is to eat all 20 without a Molt.
- The player can place portals and use buffs. Entry costs the same as the tier's current coin price; a retry is free for 10 minutes.
- Passing sets `saveBrainTier(k)`. Remove the direct coin purchase added in T16.

## Phase 6 — Events, offline, cleanup

**T31 — Rush event**
Files: `js/game.js`
- Every 8–12 minutes of real play time: a 30 s "RUSH" banner. During a Rush, each tap burst stack gives +30% instead of +10% and the cap rises to `MAX_SPEED * 1.5`, while mice spawn every 5 s.

**T32 — Daily Race**
Files: new `js/daily.js`, `js/game.js`, `js/ui.js`
- Seeded RNG (mulberry32) using `YYYYMMDD` as the seed. It drives the food, mouse and expiring apples.
- Fixed loadout: tier 2 brain, 1 portal pair, no skill-tree effects, and the multiplier fixed at 1.
- The score is the total when the arena closes. The best score per date is saved locally.

**T33 — Offline earnings rework**
Files: `js/economy.js`, `js/game.js`, `js/storage.js`
- Track coins earned and active seconds during the session. Save `lastSessionRate` on `visibilitychange` / `beforeunload`.
- `calculateIdleEarnings()` = `0.4 * lastSessionRate * min(elapsed, IDLE_MAX_SECONDS)`, falling back to the existing formula if there's no rate yet.

**T34 — Tests and README**
Files: `tests/scene-tests.js`, `README.md`, `AGENTS.md`
- Make sure every test added by the tasks above is present and hang-check still passes with the full count.
- README: replace the gameplay and controls sections with the idle loop.
- AGENTS.md: update the "Conventions" entries on game over, Auto Play and EasyStar.

---

## Dependency order

`T01–T09` (in order) → `T10–T14` → `T15 → T16 → T17 → T18 → T19` → `T20 → T21` → `T22 → T23 → T24 → T25 → T26` → `T27 → T28 → T29 → T30` → `T31–T34`.

## Balancing notes (from the game-theory review)

- Prune is dominated as a player choice. A late trap has no room to regrow before the creep ends the run, and an early trap is always worth pruning. So it's a threshold rule, and it lives in the brain.
- Static portals are a solved puzzle (roughly one centre-row pair per layout). The decisions come from the creep: edge ends give a longer shortcut but die sooner. Scarce live moves and portal combo income vs. the Hamiltonian jackpot add more.
- Guards: portal combo credit is once per apple (stops oscillating back and forth). Prune resets the combo (stops prune-farming). Chili no longer shrinks.
- The constants (0.01 Skin coefficient, 240 s creep, the J thresholds) are a first-pass model. Tune them after playing.
