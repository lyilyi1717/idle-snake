// Audio: a Howler sprite of synthesised chiptune SFX (scripts/make-audio.mjs)
// plus an optional music loop. Until the sprite has decoded, or if it fails,
// every sound falls back to a Web Audio square-wave beep, as before.

import { Howl, Howler } from 'howler';
import musicUrl from './assets/music.wav?inline';
import sprite from './assets/sfx.json';
import sfxUrl from './assets/sfx.wav?inline';

type SfxName = keyof typeof sprite;

let ctx: AudioContext | null = null;
let muted = false;
let sfx: Howl | null = null;
let sfxReady = false;
let music: Howl | null = null;
let musicOn = false;

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function beep(freq: number, durMs: number, vol = 0.15, delayMs = 0) {
  if (muted || !ctx) return;
  const c = ensureCtx();
  if (!c) return;
  const startAt = c.currentTime + delayMs / 1000;
  const stopAt = startAt + durMs / 1000;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(vol, startAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
  osc.connect(gain).connect(c.destination);
  osc.start(startAt);
  osc.stop(stopAt + 0.02);
}

function loadSprite() {
  if (sfx) return;
  sfx = new Howl({
    src: [sfxUrl],
    format: ['wav'],
    sprite: sprite as unknown as Record<string, [number, number]>,
    volume: 0.7,
    onload: () => {
      sfxReady = true;
    },
    onloaderror: (_id, err) => console.warn('[audio] sprite failed, using beeps', err),
  });
}

function play(name: SfxName, fallback: () => void) {
  if (muted) return;
  if (sfx && sfxReady) sfx.play(name);
  else fallback();
}

function syncMusic() {
  if (musicOn && !muted) {
    if (!music) music = new Howl({ src: [musicUrl], format: ['wav'], loop: true, volume: 0.35 });
    if (!music.playing()) music.play();
  } else if (music?.playing()) {
    music.pause();
  }
}

export const audio = {
  setMuted(v: boolean) {
    muted = v;
    Howler.mute(v);
    syncMusic();
  },
  isMuted: () => muted,
  setMusic(v: boolean) {
    musicOn = v;
    syncMusic();
  },
  /** Rush speeds the music up. */
  setRush(on: boolean) {
    music?.rate(on ? 1.25 : 1);
  },
  /** Call from a user gesture: satisfies autoplay policy and starts decoding. */
  unlock() {
    ensureCtx();
    loadSprite();
    syncMusic();
  },
  eat: () => play('eat', () => beep(880, 55, 0.14)),
  golden: () => play('golden', () => {
    beep(660, 60, 0.16);
    beep(990, 70, 0.16, 60);
    beep(1320, 90, 0.16, 130);
  }),
  chili: () => play('chili', () => {
    beep(500, 50, 0.14);
    beep(1150, 90, 0.16, 60);
  }),
  buff: () => play('buff', () => {
    beep(440, 50, 0.14);
    beep(990, 80, 0.16, 110);
  }),
  frenzy: () => play('frenzy', () => {
    for (let i = 0; i < 5; i++) beep(i % 2 ? 500 : 1000, 35, 0.14, i * 45);
  }),
  pip: () => play('pip', () => beep(1400, 15, 0.05)),
  tap: () => play('tap', () => beep(300, 18, 0.05)),
  burst: (n: number) => play(`burst${Math.max(1, Math.min(5, n))}` as SfxName, () => beep(420 + n * 90, 28, 0.07)),
  freeze: () => play('freeze', () => {
    beep(1600, 40, 0.1);
    beep(1200, 60, 0.1, 50);
  }),
  mouse: () => play('mouse', () => {
    beep(1200, 30, 0.12);
    beep(1800, 60, 0.12, 80);
  }),
  jam: () => play('jam', () => beep(180, 60, 0.14)),
  teleport: () => play('teleport', () => {
    beep(1400, 30, 0.08);
    beep(700, 40, 0.08, 35);
  }),
  shrink: () => play('shrink', () => beep(160, 90, 0.1)),
  prune: () => play('prune', () => {
    beep(220, 55, 0.16);
    beep(160, 70, 0.16, 60);
  }),
  rush: () => play('rush', () => {
    for (let i = 0; i < 4; i++) beep(523 * Math.pow(1.26, i), 45, 0.14, i * 60);
  }),
  molt: () => play('molt', () => {
    beep(400, 200, 0.18);
    beep(900, 320, 0.16, 280);
  }),
  jackpot: () => play('jackpot', () => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => beep(f, 90, 0.16, i * 90));
  }),
  achievement: () => play('badge', () => {
    beep(523, 90, 0.15);
    beep(784, 140, 0.15, 180);
  }),
  coin: () => play('coin', () => {
    beep(950, 40, 0.1);
    beep(1200, 60, 0.1, 40);
  }),
  click: () => play('click', () => beep(700, 35, 0.08)),
  deny: () => play('deny', () => beep(150, 90, 0.12)),
};
