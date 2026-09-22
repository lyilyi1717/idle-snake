# Idle Snake (Nokia 3310 style)

An idle clicker built on Snake. The snake steers itself and never dies.
Every run ends in a **Molt**, which banks a permanent Skin multiplier.
You tap for speed, snatch mice and fading apples, place portals, buy
upgrades, and earn smarter brains in Trials.

Design source: `IDLE_PIVOT_TASKS.md` (locked decisions) and
`docs/game-theory-design.md` §4 (multiplier structure).
`docs/idle-implementation-notes.md` records where this build departs from
the spec, and why.

## Running it

```
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest suite for the simulation core
npm run build      # typecheck + dist/index.html (single file, opens from disk)
node scripts/make-audio.mjs   # regenerate the synthesised SFX sprite + music loop
```

Rendering uses PixiJS (WebGL) with a CRT shader, particles and screen shake.
If WebGL can't start, the game falls back to the Canvas 2D renderer; add
`?canvas2d` to the URL to force it. Audio is a Howler sprite of chiptune
SFX synthesised by `scripts/make-audio.mjs`, plus an optional music loop
(Setup → Music). Until the sprite decodes, sounds fall back to Web Audio beeps.

`dist/index.html` inlines all JS and CSS, so you can double-click it
without a server.

## How a run works

- **Autopilot.** A brain picks every move:
  1. Greedy: heads straight for the apple.
  2. Pathfinder: shortest path (BFS) and uses portals.
  3. Survivor: BFS, plus a check that the tail stays reachable. Auto-Prunes when boxed in early.
  4. Hamiltonian: follows a nested Hamiltonian cycle with safe shortcuts.
     It never traps, but it ignores portals and only runs in the Open zone.
- **The tide.** The arena loses one outer ring at a time, and a full board
  closes in about 240 s. Any body left outside the new ring is cut off.
  If the head is outside, the snake Molts.
- **Molt.** A Molt comes from hitting a wall or yourself, the tide, the
  arena closing, a full board, or pressing *Molt Now*. It pays
  `ΔSkin = 0.01·√L·J`, where `J` depends on fill φ = L / free arena cells:
  ×1.5 at φ ≥ 0.75, and ×3 at φ ≥ 0.95. The ×3 needs the Hamiltonian brain.
- **Combo.** Eat within 25 ticks of the last apple to build combo, worth up
  to ×3. The first portal trip per apple adds 10 ticks to the window.
- **Score multiplier** is additive within each category and multiplicative
  across them:
  `chili × buff × (1 + skill tree) × combo × Skin × zone`.
  Every point also adds 0.2 coins.

## Controls

| Input | Effect |
|---|---|
| Tap/click an empty cell, or Space | Speed burst: +10% for 1 s, up to 5 stacks (+30% during a Rush) |
| Tap a mouse (within 1 cell) | Catch it for 50 × multiplier |
| Tap a fading apple | Freeze its timer for +5 s (once per apple) |
| Tap an active spike (Tunnels) | Jam it for 3 s (10 s cooldown) |
| Drag a portal end | Move it. Costs 1 move: 2 per run, +1 every 30 s, max 3. Free for a pair bought this run. |

## Progression

- **Shop:** portal pairs (400 / 1,500 / 6,000 coins; pair 3 needs Tunnels),
  skins, trails, the Offline Snack Stash, and mock coin packs.
- **Skills:**
  - Engine: Quick Scales (+speed), Slow Tide (slower creep), Combo Lure,
    Spare Shears (Prune charges).
  - Score Mastery and Economy: carried over from the pre-idle tree.
- **Brains & Zones:**
  - Brain Trials (500 / 3,000 / 15,000 coins). A fixed 16×12 board where
    only the new brain survives. Retries are free for 10 minutes.
  - Zones: Open, Box, Cross, Tunnels, Spiral (×1, ×1.5, ×2, ×2.5, ×3). A
    Molt at φ ≥ 0.75 in your top zone unlocks the next one.
  - Daily Race: same seed for everyone on a UTC date, fixed loadout, no coins.
- **Events:** a 30 s Rush every 8–12 minutes. Mice appear every 45–90 s.
  15% of apples fade out after 8 s and are worth ×3.
- **Offline:** earns 0.4 × last session's measured coins/s, capped at 12 h.

## Code layout

```
src/core/     pure, deterministic simulation (no DOM, no wall clock)
  sim.ts        run state + advance(dt): ticks, creep, pickups, portals, Molt
  brains.ts     tier 1–4 autopilots
  hamilton.ts   nested Hamiltonian cycles that survive ring shrinks
  pathfind.ts   BFS with portal edges, flood fill
  economy.ts    catalogs + Meta (all profile mutations)
  profile.ts    save schema, v1 → v2 migration, storage adapter
  runs.ts       normal / trial / daily run configs
  zones.ts      zone wall, spike and mud generators
  rng.ts        mulberry32 + string hash, independent streams
src/render/   pixiRenderer.ts (WebGL), renderer.ts (Canvas 2D fallback), common.ts, create.ts
src/assets/   generated sfx.wav + sfx.json sprite map, music.wav
src/ui/       DOM side panel + modals
src/game.ts   controller: loop, input, saving, offline earnings
tests/        Vitest (tune-trials / probe are opt-in balance tools)
```

Saves live in `localStorage` under `nokiaSnake.idle.v2`, with a
`.backup` copy. A pre-idle `nokiaSnake.state.v1` save is migrated on first
load. Currencies, cosmetics, badges and kept skill nodes carry over, and
levels in removed nodes (abilities, vitality) are refunded.

## Monetization stance

Coins are earned only through play. The two Coin Pack rows call
`Meta.mockPurchase()` (`src/core/economy.ts`), which grants coins locally
and charges nothing. That is the single place a real payment provider
would be wired. Entitlements would have to be granted server-side from a
verified webhook, never from a client callback. There are no loot boxes
and no FOMO timers.
