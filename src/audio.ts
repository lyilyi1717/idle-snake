// Web Audio square-wave beeps, Nokia-3310 in spirit. No audio files. The
// AudioContext is created lazily on the first user gesture (autoplay policy).

let ctx: AudioContext | null = null;
let muted = false;

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

export const audio = {
  setMuted(v: boolean) {
    muted = v;
  },
  isMuted: () => muted,
  unlock() {
    ensureCtx();
  },
  eat: () => beep(880, 55, 0.14),
  golden() {
    beep(660, 60, 0.16);
    beep(990, 70, 0.16, 60);
    beep(1320, 90, 0.16, 130);
  },
  chili() {
    beep(500, 50, 0.14);
    beep(1150, 90, 0.16, 60);
  },
  buff() {
    beep(440, 50, 0.14);
    beep(660, 50, 0.14, 55);
    beep(990, 80, 0.16, 110);
  },
  frenzy() {
    for (let i = 0; i < 5; i++) beep(i % 2 ? 500 : 1000, 35, 0.14, i * 45);
  },
  pip: () => beep(1400, 15, 0.05),
  tap: () => beep(300, 18, 0.05),
  burst: (n: number) => beep(420 + n * 90, 28, 0.07),
  freeze() {
    beep(1600, 40, 0.1);
    beep(1200, 60, 0.1, 50);
  },
  mouse() {
    beep(1200, 30, 0.12);
    beep(1500, 30, 0.12, 40);
    beep(1800, 60, 0.12, 80);
  },
  jam() {
    beep(180, 60, 0.14);
    beep(140, 80, 0.14, 60);
  },
  teleport() {
    beep(1400, 30, 0.08);
    beep(700, 40, 0.08, 35);
  },
  shrink: () => beep(160, 90, 0.1),
  prune() {
    beep(220, 55, 0.16);
    beep(160, 70, 0.16, 60);
  },
  rush() {
    for (let i = 0; i < 4; i++) beep(523 * Math.pow(1.26, i), 45, 0.14, i * 60);
  },
  molt() {
    beep(400, 200, 0.18);
    beep(600, 200, 0.16, 140);
    beep(900, 320, 0.16, 280);
  },
  jackpot() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => beep(f, 90, 0.16, i * 90));
  },
  achievement() {
    beep(523, 90, 0.15);
    beep(659, 90, 0.15, 90);
    beep(784, 140, 0.15, 180);
  },
  coin() {
    beep(950, 40, 0.1);
    beep(1200, 60, 0.1, 40);
  },
  click: () => beep(700, 35, 0.08),
  deny: () => beep(150, 90, 0.12),
};
