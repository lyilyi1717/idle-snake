# Library requirement check and integration plan

**Status (2026-09-22):** phases 1 and 2 are done. Phase 3 is deferred,
since the save is still well under 10 KB.
- Phase 1: `src/render/pixiRenderer.ts`, with the Canvas 2D fallback in
  `src/render/create.ts`. The CRT filter sits on the stage with an explicit
  `filterArea`; on a child container, layers above the static one went
  missing.
- Phase 2: `src/audio.ts` plus `scripts/make-audio.mjs`. The SFX are
  synthesised rather than sourced, so there's no asset licensing.
- Bundle: `dist/index.html` is about 1.04 MB (259 KB gzipped). Pixi and
  Howler account for about 160 KB of that, and the inlined audio for about
  50 KB.

Old requirement: phaser3-rex-plugins (rexUI), EasyStar.js, Howler.js,
localForage, PixiJS, Excalibur.js.

Checked against the current build (September 2026). The current build has
a pure TypeScript sim core, a Canvas 2D renderer (`src/render/renderer.ts`),
a DOM UI (`src/ui/ui.ts`), Web Audio beeps (`src/audio.ts`), and a
`localStorage` save behind the `KV` adapter (`src/core/profile.ts`).

## Short answer

The list can't be adopted as one stack. It names three separate rendering
engines (Phaser, via rexUI; PixiJS; Excalibur), and they don't layer.

| Library | Latest (npm) | Last publish | Fits this build? | Decision |
|---|---|---|---|---|
| PixiJS | 8.21.0 | Sep 2026 | Yes. A drop-in replacement for `renderer.ts`. | **Adopt** (phase 1) |
| Howler.js | 2.2.4 | Sep 2023 | Yes. Goes behind the `audio.ts` interface. | **Adopt** (phase 2) |
| localForage | 1.10.0 | Jun 2022 | Partly. The save is a few KB, so localStorage is enough today. | **Optional** (phase 3) |
| EasyStar.js | 0.4.4 | Jun 2022 | No. See below. | **Drop** |
| Excalibur.js | 0.32.0 | Sep 2026 | No. A full engine that duplicates the sim and competes with PixiJS. | **Drop** |
| rexUI | phaser3-rex-plugins 1.80.20 / phaser4-rex-plugins 4.2.0 | Mar / 2026 | Only with Phaser. It's a Phaser scene plugin. | **Drop** (unless we go back to Phaser) |

### Does Excalibur work on top of PixiJS?

No. Excalibur is a complete engine: loop, actors, collision, input, scenes.
It draws through its own WebGL graphics context and falls back to Canvas 2D
when frame rate drops. It has **zero runtime dependencies**, and there is no
Pixi backend or pluggable renderer. Using both means two WebGL contexts and
two loops on two canvases. Pick one.

- For this game, **PixiJS wins**. The sim already owns the loop, collision
  and rules, so only a renderer is needed.
- Excalibur would reduce to "a heavier renderer whose engine features we
  don't use".

### Why not EasyStar

- It's A* only. There is no concept of portal or teleport edges, and those
  are core to the Pathfinder and Survivor brains.
- It's async by default (`calculate()` callbacks), which breaks the
  deterministic tick. The sync mode exists but is an afterthought.
- The Survivor brain needs repeated searches against a *virtual* body. The
  in-house `bfs()` does this on typed arrays, and `tests/core.test.ts`
  covers it.
- It has been unmaintained since 2022.

### Why not rexUI

- It needs a Phaser scene. The DOM UI already covers every modal (shop,
  skill tree, brains/zones, badges, scores, setup, offline claim), stays
  accessible, and is responsive through CSS.
- Only relevant if we choose stack B below.

## Two coherent options

- **A (recommended):** the current core, plus PixiJS for rendering, Howler
  for audio, and optionally localForage for saves. The DOM UI stays.
- **B:** Phaser 4 + phaser4-rex-plugins. Phaser brings its own loop, audio
  and storage helpers, so Howler, localForage, PixiJS and Excalibur all
  become redundant. This means rewriting the renderer and UI and bringing
  back the dependency that was just removed. Only worth it if you want
  in-canvas UI (for example, a single-canvas mobile wrapper).

The plan below is for option A.

## Plan (option A)

### Phase 1: PixiJS renderer

Goal: GPU rendering, real glow/CRT shaders and particles, with no
game-logic changes.

1. `npm i pixi.js@^8` (optionally `pixi-filters` for CRT, glow and bloom).
2. Add `src/render/pixiRenderer.ts` with the same public surface as
   `Renderer`: `draw(sim, opts)`, `cellAt(sim, x, y)`, plus `cell`, `ox`,
   `oy`.
   - `Application` initialized once (`await app.init({ canvas, resizeTo:
     lcd, antialias: false, resolution: devicePixelRatio })`). Pixi v8's
     init is async, so `Game.start()` awaits it.
   - Static layer: grid lines, walls and mud go in one `Graphics` that is
     rebuilt only when the run, arena or cell size changes.
   - Dynamic layer: pooled `Sprite`s from a tiny generated texture atlas.
     One quad per snake segment, food, pip, portal end or mouse. Reuse
     them; don't re-create per frame.
   - Floaters use `BitmapText` (Courier-style bitmap font).
   - HUD overlays (combo, burst, Rush, ring bar) use `Text` / `Graphics`
     in a top container.
   - FX:
     - CRT scanline and vignette through `pixi-filters` (`CRTFilter`),
       replacing the CSS pseudo-elements.
     - A particle burst on eat, mouse catch and Molt.
     - Screen shake on shrink.
3. Choose the renderer in `game.ts`: Pixi, with Canvas 2D as a fallback if
   WebGL init throws. Keep `renderer.ts` as that fallback.
4. Acceptance:
   - Same visuals as Canvas 2D (skins, tide, warning ring, drag ghost,
     spikes).
   - 60 fps on a 90×60 board.
   - The drag and tap hit-testing tests still pass.
   - `npm run build` stays single-file. Check the bundle size: Pixi v8
     adds roughly 150–250 KB gzipped depending on tree-shaking, so import
     from subpaths.

### Phase 2: Howler audio

Goal: sampled SFX and music loops, with the beeps kept as a fallback.

1. `npm i howler @types/howler`.
2. Author a single audio sprite (`public/sfx.webm` plus a `.mp3` fallback)
   covering: eat, golden, chili, buff, frenzy, pip, burst, freeze, mouse,
   jam, teleport, shrink, prune, rush, molt, jackpot, badge, coin, click,
   deny.
3. `src/audio.ts` keeps its exported `audio` object and API. Each method
   plays `sprite.play('name')` when the Howl is loaded, and otherwise falls
   back to the current `beep()`.
   - `Howler.mute()` backs `setMuted`.
   - `unlock()` stays as it is (Howler auto-unlocks on the first gesture).
4. Optional: an ambient chiptune loop that speeds up during Rush
   (`howl.rate(1.25)`).
5. Single-file build: inline the sprite as a data URI (vite `assetsInlineLimit`)
   or accept a second file. The 16 MB page limit isn't a concern at
   ~200 KB of audio.
6. Acceptance: every current sound call site still works, the mute toggle
   persists, and there's no audio before the first gesture.

### Phase 3 (optional): localForage saves

Only worth doing if saves grow: replay history, per-run logs, or daily-race
ghosts. Today's profile is under 10 KB.

1. `npm i localforage`. Note `idb-keyval` as a lighter (~600 B)
   alternative with the same benefit.
2. Make `KV` async-capable: `get(): Promise<string | null>`, and so on.
   `loadProfile` / `saveProfile` become async. Tests keep `memoryKV`,
   wrapped in `Promise.resolve`.
3. Boot: `Game` awaits `loadProfile` before the first `newRun`.
   - Migration order: IndexedDB `nokiaSnake.idle.v2`, then localStorage
     `nokiaSnake.idle.v2`, then legacy `nokiaSnake.state.v1`. Copy forward
     on the first successful read.
4. `beforeunload` can't await. Keep a synchronous `localStorage` mirror of
   the latest save for the unload path, and use IndexedDB for the periodic
   autosave.
5. Acceptance: the save survives a reload, migration from each older store
   works (tests), and a private window with IndexedDB blocked falls back to
   localStorage.

### Not planned

EasyStar, Excalibur and rexUI are left out for the reasons above. If
option B (Phaser 4) is ever chosen, rexUI means `phaser4-rex-plugins`, not
`phaser3-rex-plugins`, and phases 1–3 are replaced by a Phaser port of
`renderer.ts` and `ui.ts`.

## Sources

- Excalibur rendering (own WebGL with Canvas fallback): https://excaliburjs.com/docs/performance/
- Engine comparison and benchmark: https://github.com/Shirajuki/js-game-rendering-benchmark, https://app.cinevva.com/guides/web-game-engines-comparison.html
- rexUI for Phaser 4 (`phaser4-rex-plugins`): https://rexrainbow.github.io/phaser3-rex-notes/docs/site/ui-overview/, https://www.npmjs.com/package/phaser3-rex-plugins
- Versions and dependency lists: `npm view` on 2026-09-22. Excalibur 0.32.0 lists no runtime dependencies.
