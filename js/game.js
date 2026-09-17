// game.js — Phaser 3 scene: grid movement, input, rendering, speed curve,
// golden-apple spawning (via economy.js), cosmetic trails, CRT overlay.
(function () {
  'use strict';

  const NS = (window.NS = window.NS || {});
  NS.bus = NS.bus || new EventTarget();
  const economy = NS.economy;
  const audio = NS.audio;

  // ---------------------------------------------------------------------
  // Grid / timing constants
  // ---------------------------------------------------------------------
  // CELL/COLS/ROWS/BOARD_W/BOARD_H are computed once at boot() from the
  // actual rendered size of the .lcd container (see boot() below), so the
  // grid fills the available full-bleed screen space instead of being
  // hardcoded. CELL itself adapts to the available space (see boot()),
  // clamped to a chunky-but-sane pixel range so a big monitor doesn't
  // just produce a huge, hard-to-track column count at a fixed pixel
  // size — the board grows by adding more cells within that range, never
  // by CSS-stretching the canvas (which would blur it).
  // These start as placeholder values and are reassigned before the
  // Phaser game is constructed; everything below reads them live (module
  // scope, not `this`), so reassignment before boot is all that's needed.
  let CELL = 16;
  let COLS = 27;
  let ROWS = 21;
  let BOARD_W = COLS * CELL;
  let BOARD_H = ROWS * CELL;

  // Target column count boot() aims for when deriving CELL from the
  // available full-bleed width — tuned by eye for a fullscreen grid-snake
  // game (chunky retro pixels, still enough board to have room to
  // maneuver at speed).
  const TARGET_COLS = 48;
  const MIN_CELL = 12, MAX_CELL = 28;

  // Final sanity bounds on the grid itself, applied after CELL is
  // resolved — these exist only to stop extreme/degenerate viewport
  // sizes (a tiny embedded iframe, an ultrawide monitor) from producing
  // an unplayable grid; any leftover space beyond MAX_COLS/MAX_ROWS is
  // just centered and background-filled (see boot()).
  const MIN_COLS = 20, MAX_COLS = 90;
  const MIN_ROWS = 14, MAX_ROWS = 60;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  const BASE_INTERVAL_MS = 160;
  const MIN_INTERVAL_MS = 70;
  const SPEEDUP_EVERY_SCORE = 40;
  const SPEEDUP_STEP_MS = 8;

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  const SWIPE_THRESHOLD_PX = 18;
  const TRAIL_GHOST_LIFE = 0.45; // seconds
  const MAX_TRAIL_GHOSTS = 40;

  // Chili pepper: a risk/reward pickup. Shrinks the snake (never below
  // MIN_LENGTH, so it can never kill on its own) in exchange for a
  // compounding score multiplier that applies to every food eaten for
  // the rest of the run. Mutually exclusive with golden apples on any
  // given spawn. Not part of the coin economy — pure gameplay mechanic,
  // so its tuning lives here rather than in economy.js.
  const CHILI = {
    chance: 0.045,
    minCooldownSpawns: 5,
    maxCooldownSpawns: 9,
    shrinkFraction: 0.3,
    minLength: 3,
    multiplierStep: 1.15,
    maxMultiplier: 3,
    tintColor: 0xe0432b,
    glowDecayPerSec: 2.5,
  };

  let chiliCooldown = randInt(CHILI.minCooldownSpawns, CHILI.maxCooldownSpawns);

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function rollChili() {
    if (chiliCooldown > 0) {
      chiliCooldown -= 1;
      return false;
    }
    const hit = Math.random() < CHILI.chance;
    if (hit) chiliCooldown = randInt(CHILI.minCooldownSpawns, CHILI.maxCooldownSpawns);
    return hit;
  }

  // Score buff: a temporary (not permanent, unlike chili) ×3 score
  // multiplier pickup. Mutually exclusive with golden/chili on any given
  // spawn. Composes multiplicatively with the chili-driven permanent
  // scoreMultiplier via effectiveMultiplier() — two separate categories
  // (a lasting per-run multiplier vs. a temporary timed one) multiplying
  // together rather than one replacing the other.
  const BUFF = {
    chance: 0.035,
    minCooldownSpawns: 6,
    maxCooldownSpawns: 11,
    durationSec: 6,
    multiplier: 3,
    tintColor: 0x33d6e0, // cyan — distinct from chili's red-orange and golden's near-white
  };

  let buffCooldown = randInt(BUFF.minCooldownSpawns, BUFF.maxCooldownSpawns);

  function rollBuff() {
    if (buffCooldown > 0) {
      buffCooldown -= 1;
      return false;
    }
    const hit = Math.random() < BUFF.chance;
    if (hit) buffCooldown = randInt(BUFF.minCooldownSpawns, BUFF.maxCooldownSpawns);
    return hit;
  }

  // Frenzy: for a window of time, several small bonus "pips" are on the
  // board simultaneously alongside the normal single food, each worth a
  // small amount of score. Mutually exclusive with golden/chili/buff on
  // any given spawn.
  const FRENZY = {
    chance: 0.02,
    minCooldownSpawns: 10,
    maxCooldownSpawns: 18,
    durationSec: 10,
    // Pip count used to be a flat constant here (was 6), which read as
    // sparse on the now-dynamically-sized grid (20-90 cols x 14-60 rows).
    // It's now computed once per run in startGame() as
    // `this.frenzyPipTarget`, sized relative to the actual grid/empty-cell
    // count for that run — see startGame() and the FRENZY_PIP_* tuning
    // below. spawnFrenzyPips() reads this.frenzyPipTarget instead of a
    // fixed pipCount.
    pipValue: 8,
    tintColor: 0xf2c94c, // warm yellow — distinct from the single bigger golden-apple pulse
  };

  // Tuning for the per-run frenzy pip target computed in startGame():
  // roughly this fraction of currently-empty grid cells, bounded so it
  // never becomes a performance problem (FRENZY_PIP_MAX) or too sparse to
  // read as "many points" on a small/mobile grid (FRENZY_PIP_MIN).
  const FRENZY_PIP_FRACTION = 0.22;
  const FRENZY_PIP_MIN = 10;
  const FRENZY_PIP_MAX = 180;

  let frenzyCooldown = randInt(FRENZY.minCooldownSpawns, FRENZY.maxCooldownSpawns);

  function rollFrenzy() {
    if (frenzyCooldown > 0) {
      frenzyCooldown -= 1;
      return false;
    }
    const hit = Math.random() < FRENZY.chance;
    if (hit) frenzyCooldown = randInt(FRENZY.minCooldownSpawns, FRENZY.maxCooldownSpawns);
    return hit;
  }

  // Abilities: skill-tree-gated activatable moves (unlocked once, for
  // Snake Coins, via economy.js's `abilities` SKILL_TREE category —
  // see economy.ownsAbility()). Unlike CHILI/BUFF/FRENZY these are never
  // spawned as food; the player triggers them directly (button/keybind).
  // Gameplay tuning lives here, matching the currency-vs-behavior split
  // already used for the timed pickups above.
  // Base/tier-0 tuning. Body Toss's cooldown and Phase Walls/Bigger
  // Bite/Auto-Collect's cooldown+duration/pickupCount are no longer fixed —
  // they're computed fresh from the player's current skill-tree node levels
  // by the compute*Tuning() helpers below (docs/game-theory-design.md §8).
  // These consts hold only the tier-0 (no nodes owned) baseline numbers the
  // helpers reduce from.
  const ABILITIES = {
    bodyToss: { minLength: 3, baseCooldownSec: 120 },
    phaseWalls: { durationSec: 6, cooldownSec: 25 },
    biggerBite: { durationSec: 5, cooldownSec: 20, scale: 1.6 },
    autoCollect: { pickupCount: 5, cooldownSec: 30 },
  };

  // Base max Body Toss lives (before Thick Hide), and the absolute hard
  // cap on max lives regardless of node investment — §9b.
  const BASE_MAX_LIVES = 2;
  const MAX_LIVES_CAP = 5;

  // Life-regen popup window bounds (§9c), tightened 30s/level off both
  // bounds by Quick Regeneration (maxLevel 3).
  const LIFE_REGEN_MIN_SEC = 270;
  const LIFE_REGEN_MAX_SEC = 330;
  const LIFE_REGEN_STEP_SEC = 30;

  // -------------------------------------------------------------
  // Ability tuning helpers — read the player's current skill-tree node
  // levels (economy.skillNodeLevel) and return the CURRENT effective
  // cooldown/duration/pickup numbers. Computed fresh on every call rather
  // than cached, so they always reflect nodes bought since the last call
  // (see docs/game-theory-design.md §8 for the exact tables these mirror).
  // -------------------------------------------------------------

  function computeMaxLives() {
    return Math.min(MAX_LIVES_CAP, BASE_MAX_LIVES + economy.skillNodeLevel('thickHide'));
  }

  // Swift Recoil: -10s/lvl, maxLevel 6 (120s -> 60s). Belt-and-suspenders
  // Math.max(60, ...) floor per §8 — never below 60s no matter what.
  function computeBodyTossCooldownSec() {
    const lvl = economy.skillNodeLevel('swiftRecoil');
    return Math.max(60, ABILITIES.bodyToss.baseCooldownSec - 10 * lvl);
  }

  // Thinner Walls (-3s cooldown/lvl, maxLevel 5, 25s->10s) then Porous
  // Scales (-2s cooldown/lvl, +2s duration/lvl, maxLevel 5, from the
  // post-Thinner-Walls 10s/6s baseline) — §8's exact table.
  function computePhaseWallsTuning() {
    const thinner = Math.min(economy.skillNodeLevel('thinnerWalls'), 5);
    const porous = Math.min(economy.skillNodeLevel('porousScales'), 5);
    const cooldownSec = Math.max(0, ABILITIES.phaseWalls.cooldownSec - 3 * thinner - 2 * porous);
    const durationSec = ABILITIES.phaseWalls.durationSec + 2 * porous;
    return { cooldownSec, durationSec };
  }

  // Longer Fangs (-2s cooldown/lvl, maxLevel 5, 20s->10s) then Ravenous
  // Form (-2s cooldown/lvl, +1s duration/lvl, maxLevel 5, from the 10s/5s
  // baseline) — §8's exact table.
  function computeBiggerBiteTuning() {
    const longer = Math.min(economy.skillNodeLevel('longerFangs'), 5);
    const ravenous = Math.min(economy.skillNodeLevel('ravenousForm'), 5);
    const cooldownSec = Math.max(0, ABILITIES.biggerBite.cooldownSec - 2 * longer - 2 * ravenous);
    const durationSec = ABILITIES.biggerBite.durationSec + 1 * ravenous;
    return { cooldownSec, durationSec };
  }

  // Extended Instinct (-3s/lvl, maxLevel 5, 30s->15s) then Relentless
  // Pursuit (-1.75s/lvl cooldown floored at 8s, +0.5 pickup/lvl rounded,
  // maxLevel 4, from the 15s baseline) — §8. Deliberately NO capstone/
  // always-on path for Auto-Collect (see §8's explicit reasoning) — there
  // is no node past Relentless Pursuit in economy.js's SKILL_TREE.abilities.
  function computeAutoCollectTuning() {
    const ext = Math.min(economy.skillNodeLevel('extendedInstinct'), 5);
    const rel = Math.min(economy.skillNodeLevel('relentlessPursuit'), 4);
    const afterExtendedInstinct = ABILITIES.autoCollect.cooldownSec - 3 * ext;
    const cooldownSec = Math.max(8, afterExtendedInstinct - 1.75 * rel);
    const pickupCount = ABILITIES.autoCollect.pickupCount + Math.round(0.5 * rel);
    return { cooldownSec, pickupCount };
  }

  // Quick Regeneration tightens both window bounds by 30s/lvl (maxLevel 3,
  // 270-330s -> 180-240s) — §9c's exact table. Still always a randomized
  // window, at every level, never a fixed/memorizable metronome.
  function rollLifeRegenWindowSec() {
    const lvl = Math.min(economy.skillNodeLevel('quickRegeneration'), 3);
    const min = LIFE_REGEN_MIN_SEC - LIFE_REGEN_STEP_SEC * lvl;
    const max = LIFE_REGEN_MAX_SEC - LIFE_REGEN_STEP_SEC * lvl;
    return min + Math.random() * (max - min);
  }

  // Score-phase snake colors — visual-only progression tied to THIS RUN's
  // score (this.score), reset every run at startGame(). Thresholds are
  // deliberately chosen to line up with pacing landmarks the game already
  // uses: SPEEDUP_EVERY_SCORE (40) puts the first speed-up inside
  // "Awakened", and the score_50/score_150/score_300 ACHIEVEMENTS land at
  // "Awakened"/"Thriving"/the start of "Blazing" respectively. Colors are
  // picked to stay legible against all 4 skins' backgrounds (classic olive
  // 0x9bab77, amber 0xdcb14a, ice blue 0xaad4dc, inverted night 0x1a1f14) —
  // see currentPhaseColor()/renderFrame(), which lerp the chili tint FROM
  // whichever phase color is active rather than always from skin.snake*.
  const SCORE_PHASES = [
    { min: 0, name: 'Hatchling', head: 0x464646, body: 0x2e2e2e },
    { min: 10, name: 'Awakened', head: 0x4d7fe6, body: 0x2456c2 },
    { min: 100, name: 'Thriving', head: 0x3fd15f, body: 0x1e8f3a },
    { min: 300, name: 'Blazing', head: 0xffce3f, body: 0xb8860b },
    { min: 600, name: 'Molten', head: 0xff8c42, body: 0xd9581a },
    { min: 1000, name: 'Apex', head: 0xff4040, body: 0xb31217 },
  ];

  function phaseForScore(score) {
    // SCORE_PHASES is sorted ascending by `min`, so the first entry whose
    // min exceeds the score means every later entry would too — the
    // previously-matched phase is the correct (highest-min-that-fits) one.
    let phase = SCORE_PHASES[0];
    for (const p of SCORE_PHASES) {
      if (score >= p.min) phase = p;
      else break;
    }
    return phase;
  }

  function lerpColor(colorA, colorB, t) {
    t = Math.max(0, Math.min(1, t));
    const ar = (colorA >> 16) & 0xff, ag = (colorA >> 8) & 0xff, ab = colorA & 0xff;
    const br = (colorB >> 16) & 0xff, bg = (colorB >> 8) & 0xff, bb = colorB & 0xff;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const b = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | b;
  }

  function emit(name, detail) {
    NS.bus.dispatchEvent(new CustomEvent(name, { detail }));
  }

  class SnakeScene extends Phaser.Scene {
    constructor() {
      super('SnakeScene');
    }

    create() {
      const state = economy.getState();

      this.gfx = this.add.graphics();
      this.crtGfx = this.add.graphics();
      this.crtGfx.setDepth(10);

      this.wrapMode = state.settings.wrapMode;
      this.crtEnabled = state.settings.crtEffect;
      this.currentSkin = economy.SKINS[state.settings.skin] || economy.SKINS.classic;

      this.alive = false;
      this.started = false;
      this.accumulator = 0;
      this.tickInterval = BASE_INTERVAL_MS;
      this.snake = [];
      this.dir = 'right';
      this.nextDir = 'right';
      this.food = null;
      this.foodTwin = null;
      this.score = 0;
      this.applesEaten = 0;
      this.goldenApplesEaten = 0;
      this.scoreMultiplier = 1;
      this.chiliGlow = 0;
      this.buffTimeLeft = 0;
      this.frenzyTimeLeft = 0;
      this.frenzyPips = [];
      this.frenzyPipTarget = FRENZY_PIP_MIN;
      this.trailGhosts = [];
      this.maxLives = computeMaxLives();
      this.lives = economy.ownsAbility('bodyToss') ? this.maxLives : 0;
      this.lives = Math.min(this.lives, this.maxLives);
      this.bodyTossCooldownLeft = 0;
      this.phaseWallsTimeLeft = 0;
      this.phaseWallsCooldownLeft = 0;
      this.permanentPhaseWalls = economy.skillNodeLevel('permeableScales') >= 1;
      this.biggerBiteTimeLeft = 0;
      this.biggerBiteCooldownLeft = 0;
      this.permanentBiggerBite = economy.skillNodeLevel('perpetualMolt') >= 1;
      this.autoCollectRemaining = 0;
      this.autoCollectCooldownLeft = 0;
      this.autoCollectCooldownSec = ABILITIES.autoCollect.cooldownSec;
      this.activePlaySecondsBuffer = 0;
      this.lifeRegenThreshold = economy.getState().stats.activePlaySeconds + rollLifeRegenWindowSec();
      this.scoreEvents = []; // {t, delta} — rolling window for live score-rate readout
      this.scoreRate10s = 0;

      this.applySkin(this.currentSkin);
      this.drawCrtOverlay();
      this.renderFrame(0);

      this.setupKeyboard();
      this.setupSwipe();

      // Public handle so ui.js can drive the scene without a Phaser import.
      NS.game = {
        startGame: () => this.startGame(),
        setDirection: (dir) => this.setDirection(dir),
        // Exposes the live Scene instance for debugging/testing in a
        // console (e.g. forcing ticks when a background/automated tab has
        // its rAF loop throttled by the browser's page-visibility rules).
        // Not used by any shipped UI code path.
        _scene: this,
        setWrapMode: (v) => { this.wrapMode = v; },
        setCrtEnabled: (v) => { this.crtEnabled = v; this.crtGfx.setVisible(v); },
        setSkin: (id) => {
          const skin = economy.SKINS[id];
          if (skin) {
            this.currentSkin = skin;
            this.applySkin(skin);
            this.renderFrame(0);
            const lcd = document.querySelector('.lcd');
            if (lcd) lcd.style.backgroundColor = toCssColor(skin.bg);
          }
        },
        isAlive: () => this.alive,
        useBodyToss: () => this.useBodyToss(),
        usePhaseWalls: () => this.usePhaseWalls(),
        useBiggerBite: () => this.useBiggerBite(),
        useAutoCollect: () => this.useAutoCollect(),
      };

      emit('snake:ready', {});
    }

    applySkin(skin) {
      this.cameras.main.setBackgroundColor(skin.bg);
    }

    drawCrtOverlay() {
      const g = this.crtGfx;
      g.clear();
      g.fillStyle(0x000000, 0.10);
      for (let y = 0; y < BOARD_H; y += 2) {
        g.fillRect(0, y, BOARD_W, 1);
      }
      g.setVisible(this.crtEnabled);
    }

    setupKeyboard() {
      this.input.keyboard.on('keydown', (e) => {
        const key = e.key;
        const map = {
          ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
          w: 'up', s: 'down', a: 'left', d: 'right',
          W: 'up', S: 'down', A: 'left', D: 'right',
        };
        if (map[key]) {
          e.preventDefault();
          this.setDirection(map[key]);
          return;
        }
        if (key === 'Enter' || key === ' ') {
          e.preventDefault();
          audio.unlock();
          if (!this.alive) this.startGame();
          return;
        }
        if (key === '1' || key === '2' || key === '3' || key === '4') {
          e.preventDefault();
          if (key === '1') this.useBodyToss();
          else if (key === '2') this.usePhaseWalls();
          else if (key === '3') this.useBiggerBite();
          else this.useAutoCollect();
        }
      });
    }

    setupSwipe() {
      let startX = 0, startY = 0, tracking = false;
      this.input.on('pointerdown', (p) => {
        audio.unlock();
        startX = p.x; startY = p.y; tracking = true;
      });
      this.input.on('pointerup', (p) => {
        if (!tracking) return;
        tracking = false;
        const dx = p.x - startX;
        const dy = p.y - startY;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX && Math.abs(dy) < SWIPE_THRESHOLD_PX) {
          // Treat as a tap — used to (re)start.
          if (!this.alive) this.startGame();
          return;
        }
        if (Math.abs(dx) > Math.abs(dy)) {
          this.setDirection(dx > 0 ? 'right' : 'left');
        } else {
          this.setDirection(dy > 0 ? 'down' : 'up');
        }
      });
    }

    setDirection(newDir) {
      if (!this.alive) return;
      if (newDir === OPPOSITE[this.dir] && this.snake.length > 1) return;
      if (newDir !== this.nextDir) audio.playTurn();
      this.nextDir = newDir;
    }

    startGame() {
      const midX = Math.floor(COLS / 2);
      const midY = Math.floor(ROWS / 2);
      this.snake = [
        { x: midX, y: midY },
        { x: midX - 1, y: midY },
        { x: midX - 2, y: midY },
      ];
      this.dir = 'right';
      this.nextDir = 'right';
      this.food = null;
      this.foodTwin = null;
      this.score = 0;
      this.applesEaten = 0;
      this.goldenApplesEaten = 0;
      this.scoreMultiplier = 1;
      this.chiliGlow = 0;
      this.buffTimeLeft = 0;
      this.frenzyTimeLeft = 0;
      this.frenzyPips = [];
      // Compute once per run (grid size / starting snake length are stable
      // for the run) rather than per-frame: target ~22% of currently-empty
      // grid cells, clamped to [FRENZY_PIP_MIN, FRENZY_PIP_MAX] so it scales
      // with the dynamic grid size but never gets sparse on a small board or
      // expensive/unplayable on a huge one.
      const emptyCells = COLS * ROWS - this.snake.length;
      const targetPips = Math.round(emptyCells * FRENZY_PIP_FRACTION);
      this.frenzyPipTarget = Math.max(FRENZY_PIP_MIN, Math.min(FRENZY_PIP_MAX, targetPips));
      this.trailGhosts = [];
      // Recompute max lives every run — Thick Hide levels bought since the
      // last run can raise it (2->5); clamp current lives to it in case it
      // would otherwise exceed the new max (§9b).
      this.maxLives = computeMaxLives();
      this.lives = economy.ownsAbility('bodyToss') ? this.maxLives : 0;
      this.lives = Math.min(this.lives, this.maxLives);
      this.bodyTossCooldownLeft = 0;
      this.phaseWallsTimeLeft = 0;
      this.phaseWallsCooldownLeft = 0;
      this.permanentPhaseWalls = economy.skillNodeLevel('permeableScales') >= 1;
      this.biggerBiteTimeLeft = 0;
      this.biggerBiteCooldownLeft = 0;
      this.permanentBiggerBite = economy.skillNodeLevel('perpetualMolt') >= 1;
      this.autoCollectRemaining = 0;
      this.autoCollectCooldownLeft = 0;
      this.autoCollectCooldownSec = ABILITIES.autoCollect.cooldownSec;
      this.activePlaySecondsBuffer = 0;
      this.lifeRegenThreshold = economy.getState().stats.activePlaySeconds + rollLifeRegenWindowSec();
      this.scoreEvents = [];
      this.scoreRate10s = 0;
      this.tickInterval = BASE_INTERVAL_MS;
      this.accumulator = 0;
      this.alive = true;
      this.started = true;

      // Refresh mode/skin from current settings each run in case they
      // changed while on the start/game-over screen.
      const state = economy.getState();
      this.wrapMode = state.settings.wrapMode;
      this.crtEnabled = state.settings.crtEffect;
      this.crtGfx.setVisible(this.crtEnabled);

      this.spawnFood();
      audio.unlock();
      emit('snake:start', {});
      emit('snake:score', { score: this.score, multiplier: this.scoreMultiplier });
    }

    spawnFood() {
      let x, y;
      let attempts = 0;
      do {
        x = Phaser.Math.Between(0, COLS - 1);
        y = Phaser.Math.Between(0, ROWS - 1);
        attempts += 1;
      } while (this.snake.some((s) => s.x === x && s.y === y) && attempts < 500);

      const golden = economy.rollGolden();
      const chili = !golden && rollChili();
      const buff = !golden && !chili && rollBuff();
      const frenzy = !golden && !chili && !buff && rollFrenzy();
      this.food = { x, y, golden, chili, buff, frenzy };

      // Golden/chili/buff spawns also get a plain-apple "twin" at a second
      // empty cell — a real choice between the special reward and a safe
      // guaranteed normal apple. Plain apples and frenzy triggers never get
      // a twin (frenzy already puts many pips on the board by design).
      if (golden || chili || buff) {
        const twinPos = this.pickSecondEmptyCell(x, y);
        this.foodTwin = { x: twinPos.x, y: twinPos.y, golden: false, chili: false, buff: false, frenzy: false };
      } else {
        this.foodTwin = null;
      }
    }

    // Finds a second empty cell for a food twin, using the same
    // non-overlap logic as the primary cell in spawnFood() above, plus
    // exclusion of that primary cell itself so the twin never lands on
    // top of it.
    pickSecondEmptyCell(excludeX, excludeY) {
      let x, y;
      let attempts = 0;
      do {
        x = Phaser.Math.Between(0, COLS - 1);
        y = Phaser.Math.Between(0, ROWS - 1);
        attempts += 1;
      } while (
        (this.snake.some((s) => s.x === x && s.y === y) || (x === excludeX && y === excludeY)) &&
        attempts < 500
      );
      return { x, y };
    }

    spawnFrenzyPips() {
      while (this.frenzyPips.length < this.frenzyPipTarget) {
        let x, y;
        let attempts = 0;
        let ok = false;
        do {
          x = Phaser.Math.Between(0, COLS - 1);
          y = Phaser.Math.Between(0, ROWS - 1);
          attempts += 1;
          const onSnake = this.snake.some((s) => s.x === x && s.y === y);
          const onFood = this.food && this.food.x === x && this.food.y === y;
          const onPip = this.frenzyPips.some((p) => p.x === x && p.y === y);
          ok = !onSnake && !onFood && !onPip;
        } while (!ok && attempts < 500);
        if (!ok) break; // board too full — stop trying rather than loop forever
        this.frenzyPips.push({ x, y });
      }
    }

    update(time, delta) {
      if (!this.alive) {
        this.renderFrame(time);
        return;
      }
      this.accumulator += delta;
      while (this.accumulator >= this.tickInterval) {
        this.accumulator -= this.tickInterval;
        this.step();
        if (!this.alive) break;
      }
      // decay trail ghosts every frame regardless of tick rate
      const dt = delta / 1000;
      this.trailGhosts.forEach((g) => { g.life -= dt; });
      this.trailGhosts = this.trailGhosts.filter((g) => g.life > 0);

      if (this.chiliGlow > 0) {
        this.chiliGlow = Math.max(0, this.chiliGlow - dt * CHILI.glowDecayPerSec);
      }

      if (this.buffTimeLeft > 0) {
        this.buffTimeLeft = Math.max(0, this.buffTimeLeft - dt);
      }

      if (this.frenzyTimeLeft > 0) {
        this.frenzyTimeLeft = Math.max(0, this.frenzyTimeLeft - dt);
        if (this.frenzyTimeLeft === 0) this.frenzyPips = [];
      }

      if (this.phaseWallsTimeLeft > 0) {
        this.phaseWallsTimeLeft = Math.max(0, this.phaseWallsTimeLeft - dt);
      }
      if (this.phaseWallsCooldownLeft > 0) {
        this.phaseWallsCooldownLeft = Math.max(0, this.phaseWallsCooldownLeft - dt);
      }
      if (this.biggerBiteTimeLeft > 0) {
        this.biggerBiteTimeLeft = Math.max(0, this.biggerBiteTimeLeft - dt);
      }
      if (this.biggerBiteCooldownLeft > 0) {
        this.biggerBiteCooldownLeft = Math.max(0, this.biggerBiteCooldownLeft - dt);
      }
      if (this.autoCollectCooldownLeft > 0) {
        this.autoCollectCooldownLeft = Math.max(0, this.autoCollectCooldownLeft - dt);
      }
      if (this.bodyTossCooldownLeft > 0) {
        this.bodyTossCooldownLeft = Math.max(0, this.bodyTossCooldownLeft - dt);
      }

      // Active-play-time tracking for the life-regen popup (§9c). Buffered
      // locally and flushed to economy.js in whole-second chunks rather
      // than every frame, to avoid a localStorage write on every tick —
      // mirrors the existing touchLastSeen()-on-interval pattern's intent
      // (persist periodically, not on every mutation of a fast-changing
      // value). Only reached while this.alive (see the early return above).
      this.activePlaySecondsBuffer += dt;
      if (this.activePlaySecondsBuffer >= 1) {
        const whole = Math.floor(this.activePlaySecondsBuffer);
        this.activePlaySecondsBuffer -= whole;
        economy.addActivePlaySeconds(whole);
        this.maybeRegenLife();
      }

      this.renderFrame(time);
    }

    // Auto-applied, non-blocking life grant — see §9c. Checked against the
    // persisted, ever-increasing stats.activePlaySeconds total; the
    // threshold itself is a per-scene value (this.lifeRegenThreshold),
    // redrawn from the current jittered window every time it fires,
    // whether or not a life was actually granted (no stockpiling past
    // max — the window is simply consumed).
    maybeRegenLife() {
      const total = economy.getState().stats.activePlaySeconds;
      if (total < this.lifeRegenThreshold) return;
      if (this.lives < this.maxLives) {
        this.lives += 1;
        emit('snake:lifeRegen', { lives: this.lives });
      }
      this.lifeRegenThreshold = total + rollLifeRegenWindowSec();
    }

    step() {
      const scoreBefore = this.score;
      if (this.autoCollectRemaining > 0) {
        this.computeAutoDirection();
      }
      this.dir = this.nextDir;
      const vec = DIRS[this.dir];
      const head = this.snake[0];
      let nx = head.x + vec.x;
      let ny = head.y + vec.y;

      if (this.wrapMode || this.phaseWallsTimeLeft > 0 || this.permanentPhaseWalls) {
        nx = (nx + COLS) % COLS;
        ny = (ny + ROWS) % ROWS;
      } else if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
        this.die();
        return;
      }

      const eatingPrimary = this.food && nx === this.food.x && ny === this.food.y;
      const eatingTwin = !eatingPrimary && this.foodTwin && nx === this.foodTwin.x && ny === this.foodTwin.y;
      const willEat = eatingPrimary || eatingTwin;
      const bodyToCheck = willEat ? this.snake : this.snake.slice(0, -1);
      if (bodyToCheck.some((s) => s.x === nx && s.y === ny)) {
        this.die();
        return;
      }

      // Old head becomes a trail ghost before the snake advances.
      this.trailGhosts.push({ x: head.x, y: head.y, life: TRAIL_GHOST_LIFE });
      if (this.trailGhosts.length > MAX_TRAIL_GHOSTS) this.trailGhosts.shift();

      this.snake.unshift({ x: nx, y: ny });

      if (willEat) {
        // Whichever copy (special primary or plain-apple twin) the head
        // landed on this tick is "the one eaten" — apply the effect from
        // its own flags, so choosing the twin over the primary means a
        // normal-apple reward instead of the special one. Clear the twin
        // immediately so it can never linger to be collected for a second
        // reward on a later tick; spawnFood() below fully replaces both
        // this.food and this.foodTwin anyway, but this makes the invariant
        // explicit and holds even if that call is ever reordered.
        const eaten = eatingTwin ? this.foodTwin : this.food;
        this.foodTwin = null;
        this.applesEaten += 1;
        if (eaten.golden) {
          this.goldenApplesEaten += 1;
          this.addScore(Math.round(15 * this.effectiveMultiplier()));
          const coins = economy.goldenReward();
          economy.addCoins(coins);
          audio.playGolden();
          emit('snake:golden', { coins });
        } else if (eaten.chili) {
          this.eatChili();
        } else if (eaten.buff) {
          this.eatBuff();
        } else if (eaten.frenzy) {
          this.eatFrenzy();
        } else {
          this.addScore(Math.round(10 * this.effectiveMultiplier()));
          audio.playEat();
        }
        // Auto-Collect counts any real food pickup above (normal, golden,
        // chili, buff, or the frenzy-triggering food itself) toward its
        // burst — but NOT the small frenzy pips handled separately below,
        // since those are a side pickup layered on top of normal food,
        // not one of the "next 5 pickups" the ability promises.
        if (this.autoCollectRemaining > 0) {
          this.autoCollectRemaining -= 1;
          if (this.autoCollectRemaining === 0) {
            this.autoCollectCooldownLeft = this.autoCollectCooldownSec || computeAutoCollectTuning().cooldownSec;
            emit('snake:autoCollectDone', {});
          }
        }
        this.recalcSpeed();
        this.spawnFood();
        emit('snake:score', { score: this.score, multiplier: this.scoreMultiplier });
      } else {
        this.snake.pop();
      }

      // Frenzy pips: a side pickup layered on top of normal food handling
      // above. Only relevant while frenzy is active; does not grow the
      // snake and does not touch the tail-pop/grow logic already run.
      if (this.frenzyTimeLeft > 0 && this.frenzyPips.length) {
        const pipIndex = this.frenzyPips.findIndex((p) => p.x === nx && p.y === ny);
        if (pipIndex !== -1) {
          this.frenzyPips.splice(pipIndex, 1);
          this.addScore(Math.round(FRENZY.pipValue * this.effectiveMultiplier()));
          audio.playPip();
          this.spawnFrenzyPips();
          emit('snake:score', { score: this.score, multiplier: this.scoreMultiplier });
        }
      }

      // Live score-rate tracking: a rolling window of score gained over the
      // last 10 real seconds, recomputed on every tick (several times a
      // second) regardless of whether this particular tick scored, so the
      // readout genuinely decays as old pickups age out rather than only
      // updating on pickup events. Purely additive/read-only bookkeeping —
      // does not affect scoring, speed, or any other gameplay logic.
      const scoreDelta = this.score - scoreBefore;
      if (scoreDelta > 0) this.scoreEvents.push({ t: this.time.now, delta: scoreDelta });
      const cutoff = this.time.now - 10000;
      while (this.scoreEvents.length && this.scoreEvents[0].t < cutoff) this.scoreEvents.shift();
      this.scoreRate10s = this.scoreEvents.reduce((sum, e) => sum + e.delta, 0);
    }

    // addScore() — the single hook that mirrors every point of run score
    // into the permanent points balance the instant it's earned (see
    // docs/game-theory-design.md §6). this.score still resets to 0 every
    // run; economy.points/stats.lifetimeScore never do.
    addScore(amount) {
      this.score += amount;
      economy.addPoints(amount);
    }

    effectiveMultiplier() {
      const treeBonus = economy.scoreTreeBonus();
      return this.scoreMultiplier * (1 + treeBonus) * (this.buffTimeLeft > 0 ? BUFF.multiplier : 1);
    }

    eatChili() {
      // Shrink toward MIN_LENGTH, never past it, so a chili can never be
      // the direct cause of death.
      const shrinkAmt = Math.min(
        Math.max(1, Math.ceil(this.snake.length * CHILI.shrinkFraction)),
        Math.max(0, this.snake.length - CHILI.minLength)
      );
      for (let i = 0; i < shrinkAmt; i++) this.snake.pop();

      this.scoreMultiplier = Math.min(
        CHILI.maxMultiplier,
        Math.round(this.scoreMultiplier * CHILI.multiplierStep * 100) / 100
      );
      this.addScore(Math.round(5 * this.effectiveMultiplier()));
      // Small NEW coin bonus alongside chili's existing score-only
      // behavior, scaled by High-Score Momentum — see
      // docs/game-theory-design.md §7. Deliberately small ([1,4] base)
      // relative to golden apples ([5,20] base).
      const chiliCoins = economy.chiliCoinBonus();
      economy.addCoins(chiliCoins);
      this.chiliGlow = 1; // brief pulse on top of the persistent multiplier tint
      audio.playChili();
      emit('snake:chili', { multiplier: this.scoreMultiplier, shrinkAmt, coins: chiliCoins });
    }

    eatBuff() {
      this.buffTimeLeft = BUFF.durationSec;
      this.addScore(Math.round(10 * this.effectiveMultiplier()));
      audio.playBuff();
      emit('snake:buff', { duration: BUFF.durationSec });
    }

    eatFrenzy() {
      this.frenzyTimeLeft = FRENZY.durationSec;
      this.spawnFrenzyPips();
      audio.playFrenzy();
      emit('snake:frenzy', { duration: FRENZY.durationSec });
    }

    // -------------------------------------------------------------
    // Abilities — player-triggered, not food-spawned. See ABILITIES
    // const above for tuning. Every method is a safe no-op when the
    // ability isn't owned/available, so callers (UI buttons, keybinds,
    // console testing) never need to guard the call themselves.
    // -------------------------------------------------------------

    useBodyToss() {
      if (!economy.ownsAbility('bodyToss') || !this.alive) return;
      // Two independent gates, both required (§8's closing note): a life
      // available in the pool, AND the spend-rate cooldown expired. Pool
      // size (lives/thickHide) and spend rate (cooldown/swiftRecoil) are
      // deliberately orthogonal — neither substitutes for the other.
      if (this.lives <= 0 || this.bodyTossCooldownLeft > 0) return;
      // Proportional shrink (§9a): 30% of current length, mirroring
      // CHILI's exact shrink-clamp shape so Body Toss can never reduce the
      // snake below minLength (and is therefore never the direct cause of
      // death), at any snake length.
      const shrinkAmt = Math.min(
        Math.max(1, Math.ceil(this.snake.length * 0.3)),
        Math.max(0, this.snake.length - ABILITIES.bodyToss.minLength)
      );
      for (let i = 0; i < shrinkAmt; i++) this.snake.pop();
      this.lives -= 1;
      this.bodyTossCooldownLeft = computeBodyTossCooldownSec();
      audio.playBodyToss();
      emit('snake:bodyToss', { livesLeft: this.lives });
    }

    usePhaseWalls() {
      if (!economy.ownsAbility('phaseWalls') || !this.alive) return;
      // Permeable Scales capstone: passive/always-on, no longer an
      // activatable ability at all — refuse the manual trigger entirely.
      if (this.permanentPhaseWalls || this.phaseWallsCooldownLeft > 0) return;
      const { durationSec, cooldownSec } = computePhaseWallsTuning();
      this.phaseWallsTimeLeft = durationSec;
      this.phaseWallsCooldownLeft = cooldownSec;
      audio.playPhaseWalls();
      emit('snake:phaseWalls', { duration: durationSec });
    }

    useBiggerBite() {
      if (!economy.ownsAbility('biggerBite') || !this.alive) return;
      // Perpetual Molt capstone: passive/always-on, no button, no cooldown.
      if (this.permanentBiggerBite || this.biggerBiteCooldownLeft > 0) return;
      const { durationSec, cooldownSec } = computeBiggerBiteTuning();
      this.biggerBiteTimeLeft = durationSec;
      this.biggerBiteCooldownLeft = cooldownSec;
      audio.playBiggerBite();
      emit('snake:biggerBite', { duration: durationSec });
    }

    useAutoCollect() {
      if (
        !economy.ownsAbility('autoCollect') ||
        !this.alive ||
        this.autoCollectCooldownLeft > 0 ||
        this.autoCollectRemaining > 0
      ) return;
      // No capstone/always-on path here — intentional (§8): autopilot
      // removing player agency is categorically different from a passive
      // buff, so Auto-Collect only ever gets the reduction branch.
      const { cooldownSec, pickupCount } = computeAutoCollectTuning();
      this.autoCollectRemaining = pickupCount;
      this.autoCollectCooldownSec = cooldownSec;
      audio.playAutoCollect();
      emit('snake:autoCollect', { remaining: this.autoCollectRemaining });
    }

    // -------------------------------------------------------------
    // Auto-Collect steering — a simple greedy heuristic (NOT
    // pathfinding: no A*, no lookahead beyond the immediate next
    // cell). Picks the safe candidate direction that gets closest
    // (Manhattan, wrap-aware when wrap/phase-walls is active) to
    // this.food. Mirrors the exact wrap/wall and self-collision
    // rules step() itself already uses so the two never diverge.
    // -------------------------------------------------------------

    isSafeMove(dir, canWrap) {
      const vec = DIRS[dir];
      const head = this.snake[0];
      let nx = head.x + vec.x;
      let ny = head.y + vec.y;

      if (canWrap) {
        nx = (nx + COLS) % COLS;
        ny = (ny + ROWS) % ROWS;
      } else if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
        return false;
      }

      const willEat = this.food && nx === this.food.x && ny === this.food.y;
      const bodyToCheck = willEat ? this.snake : this.snake.slice(0, -1);
      return !bodyToCheck.some((s) => s.x === nx && s.y === ny);
    }

    wrapAwareDistance(nx, ny, canWrap) {
      const dx = Math.abs(nx - this.food.x);
      const dy = Math.abs(ny - this.food.y);
      if (canWrap) {
        return Math.min(dx, COLS - dx) + Math.min(dy, ROWS - dy);
      }
      return dx + dy;
    }

    computeAutoDirection() {
      const canWrap = this.wrapMode || this.phaseWallsTimeLeft > 0 || this.permanentPhaseWalls;

      const candidates = Object.keys(DIRS).filter((d) => {
        if (this.snake.length > 1 && d === OPPOSITE[this.dir]) return false;
        return true;
      });

      const safe = candidates.filter((d) => this.isSafeMove(d, canWrap));

      if (!safe.length) {
        // No safe candidate at all — leave this.nextDir untouched rather
        // than force a doomed move. step()'s own collision check is the
        // only thing that should end the run here, same as any greedy
        // snake bot's honest limitation.
        return;
      }

      if (!this.food) {
        this.nextDir = safe.includes(this.dir) ? this.dir : safe[0];
        return;
      }

      const head = this.snake[0];
      let bestDir = safe[0];
      let bestDist = Infinity;
      safe.forEach((d) => {
        const vec = DIRS[d];
        let nx = head.x + vec.x;
        let ny = head.y + vec.y;
        if (canWrap) {
          nx = (nx + COLS) % COLS;
          ny = (ny + ROWS) % ROWS;
        }
        const dist = this.wrapAwareDistance(nx, ny, canWrap);
        if (dist < bestDist) {
          bestDist = dist;
          bestDir = d;
        }
      });

      this.nextDir = bestDir;
    }

    recalcSpeed() {
      const steps = Math.floor(this.score / SPEEDUP_EVERY_SCORE);
      this.tickInterval = Math.max(MIN_INTERVAL_MS, BASE_INTERVAL_MS - steps * SPEEDUP_STEP_MS);
    }

    die() {
      this.alive = false;
      audio.playDeath();
      const result = economy.recordRunEnd({
        score: this.score,
        length: this.snake.length,
        applesEaten: this.applesEaten,
        goldenApplesEaten: this.goldenApplesEaten,
      });
      emit('snake:gameover', {
        score: this.score,
        length: this.snake.length,
        bonusCoins: result.bonus,
        isHighScore: result.isHighScore,
        newAchievements: result.newAchievements,
        highScores: economy.getState().highScores,
      });
    }

    // -------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------
    renderFrame(time) {
      const g = this.gfx;
      const skin = this.currentSkin;
      g.clear();

      // Faint grid lines for the chunky LCD-pixel look.
      g.lineStyle(1, skin.grid, 0.35);
      for (let cx = 0; cx <= COLS; cx++) {
        g.beginPath();
        g.moveTo(cx * CELL, 0);
        g.lineTo(cx * CELL, BOARD_H);
        g.strokePath();
      }
      for (let cy = 0; cy <= ROWS; cy++) {
        g.beginPath();
        g.moveTo(0, cy * CELL);
        g.lineTo(BOARD_W, cy * CELL);
        g.strokePath();
      }

      // Trail cosmetic effect (behind the snake).
      this.renderTrail(g, skin);

      // Food — the primary special pickup and (when present) its plain-
      // apple twin both render via the same renderFoodItem() helper, which
      // picks the right visual per food object's own flags.
      if (this.food) this.renderFoodItem(g, skin, time, this.food);
      if (this.foodTwin) this.renderFoodItem(g, skin, time, this.foodTwin);

      // Frenzy pips — small, cheap-to-draw bonus markers active alongside
      // the normal food for the duration of a frenzy window.
      if (this.frenzyTimeLeft > 0 && this.frenzyPips.length) {
        const pipPulse = 0.5 + 0.5 * Math.sin(time / 100);
        g.fillStyle(FRENZY.tintColor, 0.6 + 0.4 * pipPulse);
        const pipSize = CELL * 0.4;
        const pipOff = (CELL - pipSize) / 2;
        this.frenzyPips.forEach((p) => {
          g.fillRect(p.x * CELL + pipOff, p.y * CELL + pipOff, pipSize, pipSize);
        });
      }

      // Snake. Persistent tint scales with the current chili multiplier
      // (a lasting "small visual change"); the brief post-pickup pulse
      // rides on top of that as extra juice.
      const heat = (this.scoreMultiplier - 1) / (CHILI.maxMultiplier - 1);
      const tintAmt = Math.min(1, heat * 0.6 + this.chiliGlow * 0.4);
      const phaseColor = this.currentPhaseColor();
      const headColor = tintAmt > 0 ? lerpColor(phaseColor.head, CHILI.tintColor, tintAmt) : phaseColor.head;
      const bodyColor = tintAmt > 0 ? lerpColor(phaseColor.body, CHILI.tintColor, tintAmt * 0.8) : phaseColor.body;
      // Bigger Bite is purely a render-time effect: segments are drawn
      // scaled up around each cell's center. Grid coordinates / hitboxes
      // (this.snake) are never touched, so collision logic is unaffected.
      const biggerBiteActive = this.biggerBiteTimeLeft > 0 || this.permanentBiggerBite;
      const biteSize = (CELL - 2) * ABILITIES.biggerBite.scale;
      this.snake.forEach((seg, i) => {
        g.fillStyle(i === 0 ? headColor : bodyColor, 1);
        if (biggerBiteActive) {
          const cx = seg.x * CELL + CELL / 2;
          const cy = seg.y * CELL + CELL / 2;
          g.fillRect(cx - biteSize / 2, cy - biteSize / 2, biteSize, biteSize);
        } else {
          g.fillRect(seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2);
        }
      });

      if (!this.started) {
        // idle screen: nothing extra to draw, DOM overlay covers it
      }
    }

    // Draws one food item (primary or twin) — identical treatment for
    // both, keyed only off the item's own flags/position, never off
    // whether it happens to be this.food or this.foodTwin.
    renderFoodItem(g, skin, time, food) {
      if (food.golden) {
        const pulse = 0.55 + 0.45 * Math.sin(time / 120);
        g.fillStyle(skin.golden, 0.65 + 0.35 * pulse);
        const pad = 1 + pulse * 1.5;
        g.fillRect(
          food.x * CELL + pad, food.y * CELL + pad,
          CELL - pad * 2, CELL - pad * 2
        );
      } else if (food.chili) {
        const flicker = 0.5 + 0.5 * Math.sin(time / 90);
        g.fillStyle(CHILI.tintColor, 0.85);
        g.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
        g.fillStyle(skin.bg, 0.3 + 0.3 * flicker);
        g.fillRect(food.x * CELL + 4, food.y * CELL + 4, CELL - 8, CELL - 8);
      } else if (food.buff) {
        // Fast pulse, diamond-ish inset — reads distinct from the
        // square golden pulse and the flickering chili.
        const pulse = 0.5 + 0.5 * Math.sin(time / 70);
        g.fillStyle(BUFF.tintColor, 0.75 + 0.25 * pulse);
        const pad = 1 + pulse * 2;
        g.fillRect(
          food.x * CELL + pad, food.y * CELL + pad,
          CELL - pad * 2, CELL - pad * 2
        );
        g.fillStyle(skin.bg, 0.5);
        g.fillRect(food.x * CELL + CELL / 2 - 1, food.y * CELL + 2, 2, CELL - 4);
      } else if (food.frenzy) {
        // Slow, wide pulse with a ring outline so it reads as "many
        // points incoming" rather than another golden apple.
        const pulse = 0.5 + 0.5 * Math.sin(time / 150);
        g.fillStyle(FRENZY.tintColor, 0.5 + 0.3 * pulse);
        g.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
        g.lineStyle(1, FRENZY.tintColor, 0.9);
        g.strokeRect(food.x * CELL + 1, food.y * CELL + 1, CELL - 2, CELL - 2);
      } else {
        g.fillStyle(skin.food, 1);
        g.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
      }
    }

    // Current score-phase base color for the snake (Feature 2) — recomputed
    // live from this.score every render call, never cached, so a phase
    // change takes effect on the exact tick the score crosses a threshold.
    currentPhaseColor() {
      const phase = phaseForScore(this.score);
      return { head: phase.head, body: phase.body };
    }

    renderTrail(g, skin) {
      const state = economy.getState();
      const trailId = state.settings.trail;
      if (trailId === 'none' || !this.trailGhosts.length) return;

      this.trailGhosts.forEach((ghost) => {
        const alpha = Math.max(0, ghost.life / TRAIL_GHOST_LIFE);
        if (trailId === 'dust') {
          g.fillStyle(skin.snake, alpha * 0.5);
          g.fillRect(ghost.x * CELL + 2, ghost.y * CELL + 2, CELL - 4, CELL - 4);
        } else if (trailId === 'sparkle') {
          g.fillStyle(skin.golden, alpha * 0.8);
          const size = 2 + alpha * 2;
          const cx = ghost.x * CELL + CELL / 2;
          const cy = ghost.y * CELL + CELL / 2;
          g.fillRect(cx - size / 2, cy - size / 2, size, size);
        }
      });
    }
  }

  function toCssColor(hex) {
    return '#' + hex.toString(16).padStart(6, '0');
  }

  function boot() {
    // Measure the actual rendered space CSS has given the full-bleed
    // screen (the .lcd flex container is already laid out by this
    // point, even though it's empty — #phaser-mount has no intrinsic
    // size yet). This is a one-time-at-load computation; the grid does
    // not reflow on window resize after this.
    const lcd = document.querySelector('.lcd');
    const availW = lcd ? lcd.clientWidth : BOARD_W;
    const availH = lcd ? lcd.clientHeight : BOARD_H;

    // Derive a candidate cell size from the available width and a
    // target column count, then clamp it to a chunky-but-sane pixel
    // range so the grid can't degrade into either a handful of huge
    // blocks or a hundred-plus tiny, hard-to-track cells.
    const candidateCell = availW / TARGET_COLS;
    CELL = clamp(Math.round(candidateCell), MIN_CELL, MAX_CELL);

    COLS = clamp(Math.floor(availW / CELL), MIN_COLS, MAX_COLS);
    ROWS = clamp(Math.floor(availH / CELL), MIN_ROWS, MAX_ROWS);
    BOARD_W = COLS * CELL;
    BOARD_H = ROWS * CELL;

    // Fill any leftover fractional space around the centered canvas
    // (from flooring COLS/ROWS, or from MAX_COLS/MAX_ROWS clamping on a
    // very large screen) with the currently-equipped skin's background
    // color, so there's no visible gap/mismatch around the board.
    if (lcd) {
      const state = economy.getState();
      const skin = economy.SKINS[state.settings.skin] || economy.SKINS.classic;
      lcd.style.backgroundColor = toCssColor(skin.bg);
    }

    const config = {
      type: Phaser.CANVAS,
      parent: 'phaser-mount',
      width: BOARD_W,
      height: BOARD_H,
      pixelArt: true,
      backgroundColor: '#9bab77',
      scene: [SnakeScene],
    };

    // economy.js already loaded the save file as soon as it executed, so
    // state is ready here without re-reading it.
    // eslint-disable-next-line no-new
    new Phaser.Game(config);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
