# Nokia 3310 — Snake

A single-page, zero-build Snake game built on [Phaser 3](https://phaser.io) (loaded
from a CDN, `phaser@3.90.0`, the latest 3.x release as of this build), styled as a
Nokia 3310 handset with a monochrome-ish olive/green LCD.

## Running it

There's no build step and nothing to install. Two options:

1. **Static server (recommended):** from this folder run e.g.
   `python -m http.server 8080` and open `http://localhost:8080/`.
2. **Open directly:** double-click `index.html`. This works in most browsers;
   some browser extensions/sandboxes (and some strict `file://` security
   policies) block local scripts from a `file://` URL, in which case use
   option 1.

## Files

- `index.html` — Nokia phone chrome (CSS), the LCD screen (a Phaser mount
  point), on-screen D-pad, and the shop/badges/scores/settings/idle-claim
  modals (plain DOM, not Phaser).
- `js/storage.js` — tiny `localStorage` JSON read/write helper.
- `js/audio.js` — Web Audio API square-wave beep engine (no audio files).
- `js/economy.js` — the entire monetization/reward-loop layer: coins,
  skins, trails, upgrades, achievements, golden-apple odds, idle rewards,
  and the mock purchase stub. This is the file to read to understand the
  economy end to end.
- `js/game.js` — the Phaser 3 `Scene`: grid movement, collision, speed
  curve, input (keyboard + swipe), rendering, CRT overlay.
- `js/ui.js` — wires DOM buttons/modals to `game.js` and `economy.js` via
  a small `EventTarget` bus (`NS.bus`), so the three layers stay decoupled.

## Controls

Arrow keys or WASD to steer; swipe on touch/mobile. Enter, Space, or a tap
on the screen starts/restarts. `M` / the Mute button toggles sound.

## Reward-loop design

This section documents the *why* behind the monetization layer in
`js/economy.js`, and how it satisfies the "ethical, cosmetic-only" brief.

### Golden apples — bounded variable-ratio reinforcement

Every food spawn calls `economy.rollGolden()`. Two things make this a
*bounded* variable-ratio schedule rather than an open-ended gamble:

- **The odds are randomized within a hard range, not fixed.** Each time the
  cooldown clears, the chance for that spawn is redrawn uniformly between
  `GOLDEN.minChance` (7%) and `GOLDEN.maxChance` (16%) — so the player can
  feel the "maybe this one" tension of a variable-ratio schedule, but can
  never memorize an exact interval and never faces an unbounded/rigged
  probability.
- **A hard cooldown caps the drop rate.** `GOLDEN.minCooldownSpawns`/
  `maxCooldownSpawns` (4–8 normal spawns) guarantees goldens can never
  cluster back-to-back, capping how often the reward can fire regardless of
  luck.

When a golden apple is eaten, the coin bonus is `economy.goldenReward()` —
a `randInt(5, 20)`, i.e. also bounded min/max, never unbounded. The golden
apple's score value is only modestly higher than a normal apple (15 vs 10
score); the *real* reward is coins, which can only ever buy cosmetics (see
below), so a lucky golden-apple streak never distorts the leaderboard's
skill signal.

### Soft currency — "Snake Coins," earn-only, cosmetics-only

Coins come from four sources, all gated behind actual play:

1. Golden apples (bounded, see above).
2. A flat end-of-run bonus, `floor(score / 25)`, so ordinary skillful play
   is always worth something even on an unlucky (no-golden) run.
3. Achievement unlocks (one-time, see below).
4. The idle/AFK claim (see below).

Coins can **only** buy: skins (`economy.SKINS`), trail/particle cosmetic
effects (`economy.TRAILS`), and one idle-multiplier convenience upgrade
(`economy.UPGRADES.idleMultiplier`, +50% idle coin rate). None of these
touch snake speed, collision rules, lives, or the score formula — nothing
purchasable makes the game easier or the leaderboard less legitimate.
Coins are never purchasable with real money in this build (see the mock
purchase section below).

### Idle/AFK trickle — a calm retention hook, not a countdown

`economy.computeIdleReward()` reads a `lastSeen` timestamp written to
`localStorage` and, on return, offers a **single, calm, claimable lump
sum** based on real elapsed wall-clock time (`IDLE.coinsPerSecond`,
~1 coin/45s, times the idle-multiplier upgrade if owned). Design choices
that keep this from becoming manipulative:

- **No countdown, no timer, no urgency.** The reward is shown once, on
  return, as a flat "+N coins" — there's nothing to watch tick down and
  nothing that decays if you don't claim it immediately.
- **Capped, not punishing.** `IDLE.capSeconds` (12 hours) caps how much a
  very long absence can earn — the cap protects the economy from runaway
  numbers, but there's no *penalty* for being away longer than that; you
  simply stop accruing past the cap instead of losing anything.
- **A minimum threshold** (`IDLE.minSecondsToShowClaim`, 30s) means a
  simple tab refresh doesn't spam a "reward" modal for a few seconds away.
- The "last seen" timestamp is refreshed periodically during active play
  (`ui.js`, every 60s, plus on tab-hide/unload) so idle credit reflects
  genuine time away from the game, not time spent actively playing.

### Collection / completionism — everything earnable, nothing paywalled

`economy.ACHIEVEMENTS` is a fixed checklist (first bite, score milestones,
golden-apple hunting, a long snake, games played, lifetime coins earned).
Each unlocks once and pays a coin reward. Skins and trails can be earned
either by playing toward achievement coin payouts and then buying them in
the shop, or (for anyone who prefers) by any coins earned via golden
apples/run bonuses — there is no skin, trail, or upgrade that is only
reachable through a real-money purchase. Nothing is artificially
paywalled; everything is reachable through ordinary play in a reasonable
number of sessions.

### Dark patterns explicitly avoided

- No loot boxes and no real-money gambling odds of any kind.
- No FOMO countdown timers anywhere (shop, idle claim, or otherwise).
- No pay-to-skip-frustration mechanic (nothing purchasable reduces
  difficulty or removes friction from the core game).
- No purchasable power: speed, collision rules, and scoring are identical
  for every player regardless of spend.

## Where real payment (Stripe) would be wired

The **only** place in the codebase that represents a real-money
transaction is `economy.mockPurchase(itemId)` in `js/economy.js`, backing
the two "Coin Pack" rows in the in-game Shop. Read the comment directly
above that function for the full integration sketch; in short, a real
build would replace the body of `mockPurchase()` with:

1. **Client** calls a backend endpoint to create a Stripe Checkout
   Session / PaymentIntent for the chosen `itemId`
   (`POST /api/checkout { itemId }`).
2. **Redirect** the browser to the Stripe-hosted checkout URL returned by
   that endpoint (or confirm the PaymentIntent client-side with
   Stripe.js/Elements, if using an embedded flow).
3. **Stripe** redirects back to the app and/or fires a
   `checkout.session.completed` webhook to the backend.
4. **Backend** verifies the webhook signature and *only then* grants the
   item server-side against the player's account — entitlements should
   never be granted from a client-side "success" callback alone, since
   that can be spoofed.
5. **Client** refetches/polls its entitlements and updates local state to
   match the server.

None of that network/payment code exists in this build — `mockPurchase()`
just grants the item locally and instantly, so as shipped the in-game
economy is 100% play-to-earn with no real charges possible.

## Testing performed

- `node --check` was run against every file in `js/` — all pass (syntax
  only; Phaser globals aren't evaluated by `--check`).
- Cross-referenced every DOM `id` used by `js/ui.js` against `index.html`
  (all `$('...')` lookups, every `openModal`/`closeModal` target, and
  every `data-close` attribute) with a small Node script — no missing
  IDs.
- Loaded the page in a real Chrome tab (via a local static server, since
  the browser extension used for testing blocks `file://` navigation) and
  confirmed: Phaser 3.90.0 initializes with **zero console errors**, the
  Nokia chrome/LCD/D-pad/status bar render correctly, and the start
  overlay displays.
- Drove full games through the real, shipped game-loop functions
  (`step()`, `die()`, `spawnFood()`, `recordRunEnd()`,
  `checkAchievements()` — the exact same functions the live render loop
  calls) because the automated browser tab was backgrounded by the OS
  (`document.hidden`), which is throttled/paused by both Phaser's own
  visibility handling and the browser's `requestAnimationFrame` policy —
  a limitation of the headless automation environment, not the game.
  This confirmed, against the real code paths and with assertions on the
  results: eating grows the snake and adds score; golden-apple reward
  amounts always land in the declared `[5, 20]` coin range; wall-collision
  mode kills the snake exactly at the grid boundary; wrap-around mode
  carries the snake to the opposite edge and keeps it alive; dying
  correctly records a high score, computes the `floor(score/25)` bonus,
  unlocks the right achievements with the right coin payouts, and updates
  the DOM game-over overlay text; buying an already-owned skin is
  correctly rejected; `mockPurchase()` grants exactly the stated coin
  amount and nothing else. No console errors were logged during any of
  this.
- Manually traced `js/game.js`'s input handlers (`keydown` key map,
  pointer-based swipe detection, the opposite-direction guard) and the
  fixed-timestep accumulator loop in `update()` line by line to confirm
  correctness independent of the above.

## What was intentionally left out

No build system, no `package.json`, no bundler, and no dependency beyond
the single Phaser CDN `<script>` tag, per the brief. No git repo was
created in this folder.
