// audio.js — Web Audio API square-wave beeps, Nokia-3310-in-spirit.
// No external audio files. AudioContext is created lazily on first user
// gesture (browsers block autoplay of audio contexts otherwise).
(function () {
  'use strict';

  const NS = (window.NS = window.NS || {});

  let ctx = null;
  let muted = false;

  function ensureCtx() {
    if (!ctx) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtor();
    }
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    return ctx;
  }

  /**
   * Play a single square-wave beep.
   * @param {number} freq  frequency in Hz
   * @param {number} durMs duration in milliseconds
   * @param {number} vol   peak gain (0..1)
   * @param {number} delayMs when to start, relative to now (ms)
   */
  function beep(freq, durMs, vol = 0.15, delayMs = 0) {
    if (muted) return;
    const audioCtx = ensureCtx();
    const startAt = audioCtx.currentTime + delayMs / 1000;
    const stopAt = startAt + durMs / 1000;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(vol, startAt);
    // exponential ramp can't target exactly 0, so ramp to a near-silent floor
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(startAt);
    osc.stop(stopAt + 0.02);
  }

  const Audio3310 = {
    setMuted(value) {
      muted = !!value;
    },
    isMuted() {
      return muted;
    },
    unlock() {
      // Call from a click/keydown/touchstart handler to satisfy autoplay
      // policies before the first real sound effect is needed.
      ensureCtx();
    },
    playMove() {
      beep(520, 12, 0.03);
    },
    playEat() {
      beep(880, 55, 0.14);
    },
    playGolden() {
      beep(660, 60, 0.16);
      beep(990, 70, 0.16, 60);
      beep(1320, 90, 0.16, 130);
    },
    playTurn() {
      beep(300, 18, 0.05);
    },
    playDeath() {
      beep(400, 260, 0.22);
      beep(250, 260, 0.26, 120);
      beep(110, 480, 0.3, 260);
    },
    playUiClick() {
      beep(700, 35, 0.08);
    },
    playAchievement() {
      beep(523, 90, 0.15);
      beep(659, 90, 0.15, 90);
      beep(784, 140, 0.15, 180);
    },
    playCoin() {
      beep(950, 40, 0.1);
      beep(1200, 60, 0.1, 40);
    },
    playChili() {
      // Descending "shrink" cue, then a rising ping for the multiplier gain.
      beep(500, 50, 0.14);
      beep(320, 70, 0.14, 55);
      beep(1150, 90, 0.16, 150);
    },
    playBuff() {
      // Quick ascending motif — signals "power up", opposite contour of
      // the descending playChili() cue.
      beep(440, 50, 0.14);
      beep(660, 50, 0.14, 55);
      beep(990, 80, 0.16, 110);
    },
    playFrenzy() {
      // Rapid alternating high/low beeps — "chaos/bonus mode", distinct
      // from the single sustained/ascending cues used elsewhere.
      beep(1000, 35, 0.14, 0);
      beep(500, 35, 0.14, 45);
      beep(1000, 35, 0.14, 90);
      beep(500, 35, 0.14, 135);
      beep(1000, 45, 0.16, 180);
    },
    playPip() {
      // Very short, quiet, cheap tick — fires repeatedly during frenzy.
      beep(1400, 15, 0.05);
    },
    playBodyToss() {
      // Two quick low "thud" beeps — a discard/toss cue, distinct from
      // chili's descending shrink cue (lower register, only two notes,
      // no rising ping afterward since this grants no multiplier).
      beep(220, 55, 0.16);
      beep(160, 70, 0.16, 60);
    },
    playPhaseWalls() {
      // Airy alternating wide-interval beeps — meant to read as
      // "passing through/intangible", distinct from frenzy's rapid
      // even alternation (slower, wider pitch gap, fewer notes).
      beep(1400, 40, 0.12, 0);
      beep(700, 60, 0.12, 90);
      beep(1400, 50, 0.12, 190);
    },
    playBiggerBite() {
      // Low-to-high swelling triad — reads as "growing", slower and
      // deeper than playBuff()'s ascending power-up motif.
      beep(200, 90, 0.16, 0);
      beep(300, 90, 0.16, 80);
      beep(450, 130, 0.18, 170);
    },
    playAutoCollect() {
      // Short "engaging autopilot" arpeggio — four crisp, evenly-spaced
      // ascending notes, faster and more mechanical/clipped than any
      // other ability cue (bodyToss is two low thuds, phaseWalls is a
      // slow wide-interval alternation, biggerBite is a slow swelling
      // triad) so it reads distinctly as "computer taking over".
      beep(523, 30, 0.13, 0);
      beep(659, 30, 0.13, 45);
      beep(784, 30, 0.13, 90);
      beep(1047, 55, 0.15, 135);
    },
  };

  NS.audio = Audio3310;
})();
