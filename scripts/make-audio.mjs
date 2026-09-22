// Synthesises the game's audio: one SFX sprite and one music loop, as 8-bit
// mono WAV, plus the sprite map Howler needs. No third-party samples.
//   node scripts/make-audio.mjs
// Outputs src/assets/sfx.wav, src/assets/sfx.json, src/assets/music.wav.

import { mkdirSync, writeFileSync } from 'node:fs';

const SFX_RATE = 22050;
const MUSIC_RATE = 16000;

// ---------------------------------------------------------------------------
// Voices. Each returns a Float32Array in [-1, 1].
// ---------------------------------------------------------------------------

function voice(rate, ms, { f = 440, to = f, type = 'square', duty = 0.5, vol = 0.5, attack = 3, decay = 'exp' } = {}) {
  const n = Math.max(1, Math.round((rate * ms) / 1000));
  const out = new Float32Array(n);
  let phase = 0;
  let lfsr = 0x7fff;
  let noiseVal = 0;
  const a = (rate * attack) / 1000;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const freq = f * Math.pow(to / f, k);
    phase += freq / rate;
    const ph = phase % 1;
    let s;
    if (type === 'square') s = ph < duty ? 1 : -1;
    else if (type === 'tri') s = 1 - 4 * Math.abs(ph - 0.5);
    else if (type === 'saw') s = 2 * ph - 1;
    else {
      // NES-style LFSR noise, clocked at `freq`.
      if (Math.floor(phase) !== Math.floor(phase - freq / rate)) {
        const bit = (lfsr ^ (lfsr >> 1)) & 1;
        lfsr = (lfsr >> 1) | (bit << 14);
        noiseVal = lfsr & 1 ? 1 : -1;
      }
      s = noiseVal;
    }
    const env = (i < a ? i / a : 1) * (decay === 'exp' ? Math.pow(0.001, k) : decay === 'lin' ? 1 - k : 1 - k * k * k);
    out[i] = s * env * vol;
  }
  return out;
}

/** Mixes voices placed at millisecond offsets. */
function mix(rate, parts) {
  const len = Math.max(...parts.map(([at, buf]) => Math.round((rate * at) / 1000) + buf.length));
  const out = new Float32Array(len);
  for (const [at, buf] of parts) {
    const o = Math.round((rate * at) / 1000);
    for (let i = 0; i < buf.length; i++) out[o + i] += buf[i];
  }
  return out;
}

const V = (ms, opts) => voice(SFX_RATE, ms, opts);
const arp = (freqs, step, ms, opts) => mix(SFX_RATE, freqs.map((f, i) => [i * step, V(ms, { ...opts, f })]));

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------

const SFX = {
  eat: mix(SFX_RATE, [[0, V(70, { f: 700, to: 1100, duty: 0.25, vol: 0.45 })]]),
  golden: arp([660, 990, 1320, 1760], 55, 110, { duty: 0.25, vol: 0.4 }),
  chili: mix(SFX_RATE, [[0, V(90, { f: 500, to: 260, vol: 0.4 })], [70, V(120, { f: 1150, to: 1400, duty: 0.25, vol: 0.35 })]]),
  buff: arp([440, 660, 990], 50, 100, { type: 'square', duty: 0.125, vol: 0.4 }),
  frenzy: arp([1000, 500, 1000, 500, 1200], 45, 60, { duty: 0.25, vol: 0.35 }),
  pip: V(25, { f: 1500, to: 1800, duty: 0.125, vol: 0.2 }),
  tap: V(22, { f: 300, type: 'tri', vol: 0.35 }),
  burst1: V(40, { f: 420, to: 520, duty: 0.25, vol: 0.25 }),
  burst2: V(40, { f: 510, to: 630, duty: 0.25, vol: 0.25 }),
  burst3: V(40, { f: 600, to: 740, duty: 0.25, vol: 0.25 }),
  burst4: V(40, { f: 690, to: 850, duty: 0.25, vol: 0.25 }),
  burst5: V(50, { f: 780, to: 1000, duty: 0.25, vol: 0.28 }),
  freeze: mix(SFX_RATE, [[0, V(60, { f: 1800, to: 1500, type: 'tri', vol: 0.45 })], [50, V(140, { f: 1200, to: 900, type: 'tri', vol: 0.4 })], [0, V(160, { f: 6000, type: 'noise', vol: 0.06 })]]),
  mouse: arp([1200, 1500, 1800, 2200], 40, 60, { duty: 0.125, vol: 0.32 }),
  jam: mix(SFX_RATE, [[0, V(80, { f: 180, to: 120, vol: 0.4 })], [0, V(120, { f: 900, type: 'noise', vol: 0.25 })]]),
  teleport: mix(SFX_RATE, [[0, V(90, { f: 1600, to: 400, type: 'tri', vol: 0.4 })], [40, V(90, { f: 400, to: 1600, type: 'tri', vol: 0.3 })]]),
  shrink: mix(SFX_RATE, [[0, V(220, { f: 160, to: 70, vol: 0.4, decay: 'lin' })], [0, V(220, { f: 300, type: 'noise', vol: 0.18, decay: 'lin' })]]),
  prune: mix(SFX_RATE, [[0, V(90, { f: 400, type: 'noise', vol: 0.3 })], [60, V(100, { f: 220, to: 150, vol: 0.35 })]]),
  rush: arp([523, 659, 784, 1047, 1319], 60, 90, { duty: 0.25, vol: 0.35 }),
  molt: mix(SFX_RATE, [[0, V(260, { f: 400, to: 600, vol: 0.35, decay: 'lin' })], [140, V(260, { f: 600, to: 900, vol: 0.32, decay: 'lin' })], [280, V(420, { f: 900, to: 1350, type: 'tri', vol: 0.4 })]]),
  jackpot: mix(SFX_RATE, [
    [0, arp([523, 659, 784, 1047, 1319, 1568, 2093], 70, 140, { duty: 0.25, vol: 0.32 })],
    [0, V(700, { f: 131, type: 'tri', vol: 0.4, decay: 'lin' })],
  ]),
  badge: arp([523, 659, 784], 90, 150, { duty: 0.25, vol: 0.35 }),
  coin: mix(SFX_RATE, [[0, V(50, { f: 988, duty: 0.25, vol: 0.3 })], [50, V(140, { f: 1319, duty: 0.25, vol: 0.3 })]]),
  click: V(30, { f: 700, type: 'tri', vol: 0.3 }),
  deny: V(140, { f: 150, to: 110, vol: 0.35 }),
};

// ---------------------------------------------------------------------------
// Music: a 4-bar loop, C minor, 132 bpm. Square bass, triangle arpeggio, noise hats.
// ---------------------------------------------------------------------------

function music() {
  const bpm = 132;
  const beat = 60000 / bpm;
  const sixteenth = beat / 4;
  const bars = 4;
  const total = bars * 4 * beat;
  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const chords = [[48, 51, 55], [44, 48, 51], [46, 50, 53], [43, 47, 50]]; // Cm Ab Bb G
  const parts = [];
  for (let bar = 0; bar < bars; bar++) {
    const ch = chords[bar];
    for (let s = 0; s < 16; s++) {
      const at = (bar * 16 + s) * sixteenth;
      if (s % 4 === 0 || s === 10) parts.push([at, voice(MUSIC_RATE, sixteenth * 1.8, { f: midi(ch[0] - 12), duty: 0.25, vol: 0.22, decay: 'lin' })]);
      const note = ch[[0, 1, 2, 1][s % 4]] + (s >= 8 ? 12 : 0) + 12;
      parts.push([at, voice(MUSIC_RATE, sixteenth * 0.9, { f: midi(note), type: 'tri', vol: 0.18 })]);
      if (s % 2 === 1) parts.push([at, voice(MUSIC_RATE, 30, { f: 8000, type: 'noise', vol: s % 4 === 3 ? 0.07 : 0.04 })]);
      if (s === 4 || s === 12) parts.push([at, voice(MUSIC_RATE, 90, { f: 1200, type: 'noise', vol: 0.12 })]);
    }
  }
  const buf = mix(MUSIC_RATE, parts);
  // Trim or pad to exactly the loop length so it loops seamlessly.
  const n = Math.round((MUSIC_RATE * total) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < buf.length; i++) out[i % n] += buf[i];
  return out;
}

// ---------------------------------------------------------------------------
// WAV (8-bit unsigned PCM, mono)
// ---------------------------------------------------------------------------

function wav(samples, rate) {
  const data = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(128 + Math.tanh(samples[i]) * 127)));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const GAP_MS = 60;
const sprite = {};
const chunks = [];
let cursor = 0;
for (const [name, buf] of Object.entries(SFX)) {
  const ms = (buf.length / SFX_RATE) * 1000;
  sprite[name] = [Math.round((cursor / SFX_RATE) * 1000), Math.ceil(ms)];
  chunks.push(buf, new Float32Array(Math.round((SFX_RATE * GAP_MS) / 1000)));
  cursor += buf.length + Math.round((SFX_RATE * GAP_MS) / 1000);
}
const all = new Float32Array(cursor);
let o = 0;
for (const c of chunks) {
  all.set(c, o);
  o += c.length;
}

mkdirSync('src/assets', { recursive: true });
writeFileSync('src/assets/sfx.wav', wav(all, SFX_RATE));
writeFileSync('src/assets/sfx.json', JSON.stringify(sprite, null, 1) + '\n');
writeFileSync('src/assets/music.wav', wav(music(), MUSIC_RATE));
console.log(`sfx: ${Object.keys(sprite).length} sounds, ${(all.length / SFX_RATE).toFixed(1)} s`);
