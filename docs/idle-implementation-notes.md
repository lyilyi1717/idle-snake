# Idle pivot: implementation notes

`IDLE_PIVOT_TASKS.md` was written against a different codebase
(`Snake-codestral`: `gameTick()`, `tests/hang-check.js`, EasyStar, B1/D1 skill
ids). None of that exists here. This repo was rebuilt from scratch with a
TypeScript sim core, Canvas 2D rendering and Vitest. The spec's locked
design decisions were kept. Where they conflicted with each other, or with
"never dies", these resolutions apply.

## Deviations and why

| Spec | This build | Why |
|---|---|---|
| Any body segment outside the arena after a shrink → Molt (T12) | The tide **trims** the body from the first outside segment. Only a head outside the ring (**swept**) Molts. | A cycle-following snake always has body on the outer ring, so the spec rule would end nearly every tier-4 run at the first shrink. |
| φ ≥ 0.95 jackpot "only reachable by tier 4" | `J = 3` requires the Hamiltonian brain to be active. Tiers 1–3 cap at 1.5. | Once the creep trims a long snake down to the last rings, any survivor reaches φ ≈ 1. The cap keeps the design intent. |
| T19: zigzag cycle, rebuilt on each shrink, fall back on odd sizes | **Nested** cycles: cycle(R) = cycle(inner R) with the outer ring spliced in. The brain hops to the inner cycle about one ring-length before each shrink. Boards are forced to even dimensions. | A rebuilt cycle leaves the body out of order, and so traps. Shrinking keeps parity, so even sides mean a cycle always exists. |
| Tier 4 "ignores portals" | Tier 4 is portal-**immune**: no teleport on entry. | A Hamiltonian path crosses every cell, so it would teleport constantly. |
| Tier 4 everywhere | Tier 4 runs only on wall-free boards (Open zone, Trial 4). Elsewhere it falls back to tier 3, and the HUD shows "(walls)". | A Hamiltonian cycle on a grid with holes is NP-hard in general. |
| Date.now() for bursts, expiry | Everything runs on sim time. | Deterministic tests and daily seeds, and no drift while paused or hidden. |
| Trials: player can place portals and use buffs | Trials are deterministic (fixed seed, no portals). Taps only change speed. Each trial is tuned so the candidate brain passes and the tier below fails (asserted in tests). | Keeps trials a reliable gate. Portal layouts don't carry over to a 16×12 board. |
| Trial apple count 20 | 20 apples. Growth per apple is 2 / 3 / 6. Trials fail after 600 ticks without an apple (starvation). | With +1 growth, a greedy brain clears 16×12 boards anyway. |
| Mouse "moves away" | The mouse only moves onto free cells (no body, walls, portals or food). | Resolves the research review's collision-hole finding. |
| Wrap mode, Phase Walls, Bigger Bite, Body Toss, Auto-Collect, lives | Removed. Their skill-tree levels are refunded on migration. | Autopilot and "never dies" make them meaningless, and wrap breaks the brains' geometry. |
| — | Added a **Combo Lure** node (+3 combo-window ticks per level) and a **Molt Now** button. | Gives combo play an upgrade path. Voluntary prestige is standard for the genre. |
| Zone unlock: one Molt at φ ≥ 0.75 | **Zone Mastery**: each Molt in the frontier zone banks `clamp((φ−0.10)/0.65, 0, 1)`; the next zone opens at 3 / 8 / 14 / 24 points. | A single-run threshold was a lottery that most brains could never win. The meter turns it into visible, steady progress while still rewarding fill. |
| `ΔSkin = 0.01·√L·J` | Multiplied by `progress` = rings survived / total rings. | Molting instantly, over and over, paid 4–13× better per minute than playing a run out. |
| Zone walls generated across the whole board | Walls, spikes and mud are cleared from the final arena (`coreRect` in `zones.ts`). | In Cross and Tunnels the last rings were cut into dead ends, so φ ≥ 0.75 — and with it the zone ladder — was geometrically impossible. |
| Frenzy pips sized once per run | Pip target recomputed from the room actually left, trimmed on each shrink, and food may take a pip's cell. | Pips sized from the full board swallowed every free cell late in a run and ended 30–50% of runs early at low fill. |
| Pickups spawn anywhere in the arena | After 40% of a ring interval they spawn inside the next ring. | Food in a doomed corridor dragged the snake out to be swept. |
| Pair 3 "needs Zone 3" | Needs Tunnels (zone index 3) unlocked. | Zones are 0-indexed (Open = 0, so its ×1 is `1 + 0.5·0`). |

## Tuning knobs

- `src/core/economy.ts`: `COIN_PER_POINT`, `RUN_CLOCK_MS`, `BRAIN_PRICE`,
  `PORTAL_PRICES`, and the skill-tree costs.
- `src/core/sim.ts`: the pickup, mouse, Rush, burst, spike and portal
  constant blocks at the top.
- Balance probe: `PROBE=out.txt npx vitest run tests/probe.test.ts` prints
  trial outcomes per brain and full-run stats per tier.
- Trial search: `SEARCH=out.txt npx vitest run tests/tune-trials.test.ts`.

Measured after the fill rebalance (48×30, 12 seeds per cell,
`BALANCE=out.txt npx vitest run tests/balance.test.ts`):

| Brain / zone | median φ | φ ≥ 0.75 | mastery per run | ΔSkin per run |
|---|---|---|---|---|
| Survivor, Open | 0.50–0.60 | 17–33% | 0.59–0.73 | 0.066–0.074 |
| Survivor, Box / Cross / Tunnels | 0.40–0.60 | 17–25% | 0.47–0.76 | 0.052–0.067 |
| Survivor, Spiral | 0.48–0.68 | 0–42% | 0.47–0.65 | 0.043–0.083 |
| Hamiltonian, Open | 1.00 | 67% | 0.86–0.96 | 0.147–0.198 |

Molt-Now spam now pays 0.000–0.010 ΔSkin/min against 0.012–0.039 for a full
run, and banks no mastery at all. At roughly 0.5 mastery per run, the ladder
runs about 20 min to Box and some 6 h of active play to Spiral.

Earlier first-pass measurements (before the rebalance):

| Brain | Apples per run | Usual end | Final φ |
|---|---|---|---|
| Greedy | ~45–75 | Self-collision at 110–150 s | < 0.1 |
| Pathfinder / Survivor | ~70–135 | Late self-collision, or survives to the end | 0.1–0.3 median (this line originally overstated it) |
| Hamiltonian | ~40–55 | Always survives to arena close | 0.8–1.0 |

That matches the intended trade: fewer apples than the Pathfinder, but the
jackpot.
