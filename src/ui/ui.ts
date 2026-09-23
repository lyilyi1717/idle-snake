// DOM chrome: side-panel stats, toasts, the Molt card and every modal.

import { audio } from '../audio';
import { effectiveTier } from '../core/brains';
import {
  ACHIEVEMENTS, BRAIN_DESC, BRAIN_NAMES, BRAIN_PRICE, MOCK_STORE, Meta, RANK_TIERS_COINS, RANK_TIERS_SCORE,
  ROOT_NODE_ID, SKILL_TREE, SKINS, type SkillNode, TRAILS, UPGRADES, rankProgress,
} from '../core/economy';
import { TRIALS, dateKey } from '../core/runs';
import { ZONES } from '../core/zones';
import type { Game } from '../game';

const $ = (id: string) => document.getElementById(id)!;

export function fmt(n: number): string {
  if (!isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a < 10_000) return String(Math.floor(n));
  const units = ['K', 'M', 'B', 'T'];
  let v = n;
  let i = -1;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return v.toFixed(v < 100 ? 1 : 0) + units[i];
}

function fmtDuration(sec: number) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

function fmtRate(perSec: number) {
  const perMin = perSec * 60;
  if (perMin >= 10) return `≈${fmt(Math.round(perMin))}/min`;
  return `≈${perMin.toFixed(perMin >= 1 ? 1 : 2)}/min`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function row(name: string, desc: string, button: HTMLElement | null, extraCls = '') {
  const r = el('div', 'row' + (extraCls ? ' ' + extraCls : ''));
  const meta = el('div', 'meta');
  meta.append(el('span', 'name', name));
  if (desc) meta.append(el('span', 'desc', desc));
  r.append(meta);
  if (button) r.append(button);
  return r;
}

function action(label: string, onClick: (() => void) | null, opts: { disabled?: boolean; selected?: boolean } = {}) {
  const b = el('button', 'action' + (opts.selected ? ' selected' : ''), label);
  b.disabled = !!opts.disabled || !onClick;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export class UI {
  private toastTimer = 0;
  private lastHud = 0;
  private lastModal = 0;
  private openId: string | null = null;

  constructor(private game: Game) {
    document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) =>
      b.addEventListener('click', () => this.close(b.dataset.close!)),
    );
    document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach((bd) =>
      bd.addEventListener('click', (ev) => {
        if (ev.target === bd && bd.id !== 'idleModal') this.close(bd.id);
      }),
    );
    const bind = (id: string, modal: string) => $(id).addEventListener('click', () => this.open(modal));
    bind('btnShop', 'shopModal');
    bind('btnSkills', 'skillsModal');
    bind('btnRun', 'runModal');
    bind('btnBadges', 'badgesModal');
    bind('btnScores', 'scoresModal');
    bind('btnSettings', 'settingsModal');
    bind('btnDebug', 'debugModal');
    $('btnMute').addEventListener('click', () => this.setMuted(!this.meta.p.settings.muted));
    $('toggleMuteSetting').addEventListener('click', () => this.setMuted(!this.meta.p.settings.muted));
    $('toggleMusic').addEventListener('click', () => {
      audio.unlock();
      this.meta.p.settings.music = !this.meta.p.settings.music;
      audio.setMusic(this.meta.p.settings.music);
      this.game.save();
      this.refresh();
    });
    $('toggleCrt').addEventListener('click', () => {
      this.meta.p.settings.crt = !this.meta.p.settings.crt;
      this.game.save();
      this.refresh();
    });
    $('btnMolt').addEventListener('click', () => {
      audio.unlock();
      this.game.moltNow();
    });
    $('btnResetProgress').addEventListener('click', () => {
      this.close('settingsModal');
      this.open('resetConfirmModal');
    });
    $('confirmResetBtn').addEventListener('click', () => this.game.resetProgress());
    $('claimIdleBtn').addEventListener('click', () => {
      this.game.claimIdle();
      this.close('idleModal');
      this.refresh();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === '`' && this.openId !== 'idleModal') {
        if (this.openId === 'debugModal') this.close('debugModal');
        else this.open('debugModal');
        return;
      }
      if (ev.key === 'Escape' && this.openId && this.openId !== 'idleModal') this.close(this.openId);
    });
  }

  private get meta(): Meta {
    return this.game.meta;
  }

  // -------------------------------------------------------------------------
  // Chrome
  // -------------------------------------------------------------------------

  toast(msg: string, ms = 1800) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
  }

  showOverlay(title: string, big: string, sub: string, extra: string) {
    $('overlayTitle').textContent = title;
    $('overlayScore').textContent = big;
    $('overlaySub').textContent = sub;
    $('overlayExtra').textContent = extra;
    $('overlay').classList.remove('hidden');
  }
  hideOverlay() {
    $('overlay').classList.add('hidden');
  }

  showIdle(r: { coins: number; elapsedSec: number; cappedSec: number }) {
    const capped = r.cappedSec < r.elapsedSec ? ` (capped at ${fmtDuration(r.cappedSec)})` : '';
    $('idleAwayText').textContent = `You were away for ${fmtDuration(r.elapsedSec)}${capped}.`;
    $('idleAmount').textContent = `+${fmt(r.coins)} Coins`;
    const src = this.meta.p.lastSessionRate ? '40% of your last session rate' : 'the starter trickle';
    $('idleRateText').textContent = `Rate: ${fmtRate(this.meta.idleRate())} (${src}).`;
    this.open('idleModal');
  }

  private setMuted(v: boolean) {
    this.meta.p.settings.muted = v;
    audio.setMuted(v);
    this.game.save();
    this.refresh();
  }

  private open(id: string) {
    audio.unlock();
    audio.click();
    if (this.openId && this.openId !== id) this.close(this.openId);
    this.openId = id;
    $(id).classList.remove('hidden');
    this.renderModal(id);
  }
  private close(id: string) {
    $(id).classList.add('hidden');
    if (this.openId === id) this.openId = null;
  }

  /** Re-render the side panel and whichever modal is open. */
  refresh() {
    this.hud();
    if (this.openId) this.renderModal(this.openId);
    $('btnMute').textContent = this.meta.p.settings.muted ? 'Unmute' : 'Mute';
    $('toggleMuteSetting').textContent = this.meta.p.settings.muted ? 'OFF' : 'ON';
    $('toggleCrt').textContent = this.meta.p.settings.crt ? 'ON' : 'OFF';
    $('toggleMusic').textContent = this.meta.p.settings.music ? 'ON' : 'OFF';
  }

  tick(now: number) {
    if (now - this.lastHud < 150) return;
    this.lastHud = now;
    this.hud();
    // Keep affordability in the open shop/tree live as coins roll in.
    if ((this.openId === 'shopModal' || this.openId === 'skillsModal' || this.openId === 'runModal') && now - this.lastModal > 1000) {
      this.lastModal = now;
      this.renderModal(this.openId);
    }
  }

  private hud() {
    const g = this.game;
    const s = g.sim;
    const p = this.meta.p;
    const set = (id: string, text: string, hot = false) => {
      const e = $(id);
      if (e.textContent !== text) e.textContent = text;
      e.classList.toggle('hot', hot);
    };
    set('scoreLabel', `Score: ${fmt(s.score)}${s.combo >= 2 ? `  ·  combo ${s.combo}` : ''}`, s.combo >= 5);
    set('coinsLabel', `Coins: ${fmt(p.coins)}`);
    set('pointsLabel', `Points: ${fmt(p.points)}`);
    set('skinLabel', `Skin: ×${p.skinMult.toFixed(2)}  ·  ${p.moltCount} molts`);
    const dbg = g.timeScale !== 1 ? `  ·  DEBUG ×${g.timeScale}` : '';
    set('speedLabel', `Spd: ${s.currentSpeed().toFixed(1)}/s  ·  ×${s.mult().toFixed(2)}${dbg}`, s.liveBursts() > 0 || g.timeScale !== 1);
    const tier = effectiveTier(s);
    const tierNote = tier !== s.cfg.brain ? ' (walls)' : '';
    set('brainLabel', `Brain: ${BRAIN_NAMES[tier]}${tierNote}`);
    const prog = this.meta.masteryProgress();
    const mastery = prog && p.zone === p.maxZone ? `  ·  mastery ${prog[0].toFixed(1)}/${prog[1]}` : '';
    set('zoneLabel', `Zone: ${g.runLabel()}${mastery}`, false);
    const ringSec = s.cfg.creep ? Math.ceil((s.cfg.ringIntervalMs - s.creepElapsed) / 1000) : 0;
    set('fillLabel', `Fill: ${(s.phi() * 100).toFixed(0)}%  ·  L ${s.snake.length}${s.cfg.creep ? `  ·  ring ${ringSec}s` : ''}`, s.phi() >= 0.75);
    const prune = tier >= 3 ? `  ·  prune ${s.pruneCharges}` : '';
    set('portalLabel', s.portals.length ? `Portal moves: ${s.portalMoves}${prune}` : `Portals: none${prune}`);
    set('idleRateLabel', `Idle: ${fmtRate(this.meta.idleRate())}`);
    const molt = $('btnMolt') as HTMLButtonElement;
    molt.disabled = s.over;
    molt.textContent = g.run.kind === 'normal' ? 'Molt Now' : g.run.kind === 'trial' ? 'Give Up Trial' : 'End Race';
  }

  // -------------------------------------------------------------------------
  // Modals
  // -------------------------------------------------------------------------

  private renderModal(id: string) {
    switch (id) {
      case 'shopModal':
        return this.renderShop();
      case 'skillsModal':
        return this.renderSkills();
      case 'runModal':
        return this.renderRun();
      case 'badgesModal':
        return this.renderBadges();
      case 'scoresModal':
        return this.renderScores();
      case 'debugModal':
        return this.renderDebug();
    }
  }

  private after(ok: boolean, okMsg?: string) {
    if (ok) {
      audio.coin();
      if (okMsg) this.toast(okMsg);
    } else audio.deny();
    this.game.save();
    this.refresh();
  }

  private renderShop() {
    const m = this.meta;
    const p = m.p;
    $('shopCoinBalance').textContent = `Coins: ${fmt(p.coins)}`;
    const body = $('shopBody');
    body.replaceChildren();

    body.append(el('div', 'section-title', 'Portals'));
    body.append(el('p', 'note', 'Two-way pairs. Drag an end to move it (2 moves per run, +1 every 30 s). Ends die when the tide reaches them. The Hamiltonian brain ignores them.'));
    const gate = m.portalGate();
    const price = m.portalPairPrice();
    const label = gate ? gate : `Pair ${p.portalPairs + 1} of 3`;
    body.append(
      row(label, `Owned: ${p.portalPairs}/3`, action(gate ? 'Locked' : `${fmt(price)} coins`, gate || p.coins < price ? null : () => {
        const ok = m.buyPortalPair();
        if (ok) this.game.portalBought();
        this.after(ok, 'Portal pair placed. Drag its ends to set it up (free this run).');
      })),
    );

    body.append(el('div', 'section-title', 'Skins'));
    for (const s of Object.values(SKINS)) {
      const owned = p.unlockedSkins.includes(s.id);
      const equipped = p.settings.skin === s.id;
      const btn = equipped
        ? action('Equipped', null, { selected: true })
        : owned
          ? action('Equip', () => { p.settings.skin = s.id; this.after(true); })
          : action(`${s.cost} coins`, p.coins >= s.cost ? () => this.after(m.buySkin(s.id)) : null);
      body.append(row(s.name, '', btn));
    }

    body.append(el('div', 'section-title', 'Trails'));
    for (const t of Object.values(TRAILS)) {
      const owned = p.unlockedTrails.includes(t.id);
      const equipped = p.settings.trail === t.id;
      const btn = equipped
        ? action('Equipped', null, { selected: true })
        : owned
          ? action('Equip', () => { p.settings.trail = t.id; this.after(true); })
          : action(`${t.cost} coins`, p.coins >= t.cost ? () => this.after(m.buyTrail(t.id)) : null);
      body.append(row(t.name, '', btn));
    }

    body.append(el('div', 'section-title', 'Upgrades'));
    for (const u of Object.values(UPGRADES)) {
      const owned = p.ownedUpgrades.includes(u.id);
      body.append(row(u.name, u.desc, owned ? action('Owned', null, { selected: true }) : action(`${u.cost} coins`, p.coins >= u.cost ? () => this.after(m.buyUpgrade(u.id)) : null)));
    }

    body.append(el('div', 'section-title', 'Coin packs (mock)'));
    for (const [id, item] of Object.entries(MOCK_STORE)) {
      body.append(row(item.label, item.priceLabel, action('Get', () => this.after(m.mockPurchase(id), `+${item.coins} coins (mock, free)`))));
    }
  }

  private skillNode(n: SkillNode) {
    const m = this.meta;
    const lvl = m.level(n.id);
    const maxed = lvl >= n.maxLevel;
    const prereq = m.nodePrereqMet(n.id);
    const cost = m.nodeCost(n.id);
    const bal = n.currency === 'points' ? m.p.points : m.p.coins;
    const affordable = prereq && !maxed && bal >= cost;
    const box = el('div', 'skill-node' + (maxed ? ' maxed' : !prereq ? ' locked' : affordable ? ' affordable' : ''));
    box.append(el('span', 'name', `${n.name}  ${lvl}/${n.maxLevel}`));
    box.append(el('span', 'desc', n.desc));
    if (!prereq) {
      const reqs: string[] = [];
      const f = m.findNode(n.id)!;
      if (f.branch.requiresRoot && m.level(ROOT_NODE_ID) < 1) reqs.push('Awaken the Coil');
      if (n.brainTier && m.p.brainTier < n.brainTier) reqs.push(`${BRAIN_NAMES[n.brainTier]} brain`);
      for (const c of n.prereq ?? []) if (m.level(c.nodeId) < (c.minLevel ?? 1)) reqs.push(`${m.findNode(c.nodeId)?.node.name} ${c.minLevel ?? 1}`);
      box.append(el('span', 'requires', 'Requires: ' + reqs.join(', ')));
    }
    if (!maxed) box.append(el('span', `currency-tag ${n.currency}`, `${fmt(cost)} ${n.currency}`));
    box.append(action(maxed ? 'Maxed' : 'Buy', affordable ? () => this.after(m.buyNode(n.id)) : null, { selected: maxed }));
    return box;
  }

  private renderSkills() {
    const p = this.meta.p;
    $('skillsCoinBalance').textContent = `Coins: ${fmt(p.coins)}`;
    $('skillsPointsBalance').textContent = `Points: ${fmt(p.points)}`;
    const root = $('skillsRoot');
    const branches = $('skillsBranches');
    root.replaceChildren(...SKILL_TREE[0].nodes.map((n) => this.skillNode(n)));
    branches.replaceChildren(
      ...SKILL_TREE.slice(1).map((b) => {
        const col = el('div', 'skill-branch');
        col.append(el('h3', '', b.name), ...b.nodes.map((n) => this.skillNode(n)));
        return col;
      }),
    );
  }

  private renderRun() {
    const g = this.game;
    const m = this.meta;
    const p = m.p;
    const now = Date.now();
    const body = $('runBody');
    body.replaceChildren();

    body.append(el('div', 'section-title', 'Brain'));
    body.append(el('p', 'note', 'Brains are earned in Trials. Pick any brain you own; the change applies from the next run.'));
    for (let tier = 1; tier <= 4; tier++) {
      const owned = tier <= p.brainTier;
      const current = p.activeBrain === tier;
      let btn: HTMLElement;
      let desc = BRAIN_DESC[tier];
      if (owned) {
        btn = current ? action('Active', null, { selected: true }) : action('Use', () => { p.activeBrain = tier; this.after(true, `${BRAIN_NAMES[tier]} takes over next run`); });
      } else if (tier === p.brainTier + 1) {
        const trial = TRIALS.find((t) => t.tier === tier)!;
        const free = m.trialFree(tier, now);
        desc = `Trial "${trial.name}": ${trial.desc}`;
        const cost = BRAIN_PRICE[tier];
        const canEnter = g.run.kind === 'normal' && (free || p.coins >= cost);
        btn = action(free ? 'Retry free' : `Trial: ${fmt(cost)}`, canEnter ? () => { this.close('runModal'); g.startTrial(tier); } : null);
      } else {
        btn = action('Locked', null);
      }
      body.append(row(`${tier}. ${BRAIN_NAMES[tier]}`, desc, btn, current ? 'current' : owned ? '' : 'locked'));
    }

    body.append(el('div', 'section-title', 'Zone'));
    const prog = m.masteryProgress();
    body.append(el('p', 'note',
      prog
        ? `Molting in your highest zone earns Zone Mastery, weighted by fill: a 75% run is worth a full point, 40% is worth about half. ${ZONES[p.maxZone].name}: ${prog[0].toFixed(2)} / ${prog[1]} towards ${ZONES[p.maxZone + 1].name}. Zone changes apply from the next run.`
        : 'Every zone is unlocked. Zone changes apply from the next run.'));
    ZONES.forEach((z, i) => {
      const unlocked = i <= p.maxZone;
      const current = p.zone === i;
      const btn = !unlocked
        ? action('Locked', null)
        : current
          ? action('Selected', null, { selected: true })
          : action('Select', () => { p.zone = i; this.after(true, `${z.name} from the next run`); });
      body.append(row(`${z.name}  ×${z.mult.toFixed(1)}`, z.desc, btn, current ? 'current' : unlocked ? '' : 'locked'));
    });

    body.append(el('div', 'section-title', 'Daily Race'));
    const key = dateKey(now);
    const best = p.daily[key];
    body.append(el('p', 'note', 'One seeded board for everyone today (UTC). Pathfinder brain, one portal pair, no upgrades, multiplier fixed at 1. No coins; just a score.'));
    body.append(row(`Today ${key}`, best !== undefined ? `Your best: ${fmt(best)}` : 'Not raced yet', action('Race', g.run.kind === 'normal' ? () => { this.close('runModal'); g.startDaily(); } : null)));
  }

  private renderDebug() {
    const g = this.game;
    const m = this.meta;
    const p = m.p;
    const body = $('debugBody');
    body.replaceChildren();
    const btnRow = (items: [string, () => void, boolean?][]) => {
      const r = el('div', 'btn-row');
      for (const [label, fn, selected] of items) r.append(action(label, fn, { selected }));
      return r;
    };
    body.append(el('p', 'note', 'Cheats for testing. Press ` (backtick) to open or close this menu.'));

    body.append(el('div', 'section-title', 'Zone'));
    body.append(el('p', 'note', 'Unlocks the zone and starts a new run there right away, without a Molt payout.'));
    body.append(btnRow(ZONES.map((z, i) => [`${z.name} ×${z.mult}`, () => { g.debugZone(i); this.toast(`Jumped to ${z.name}`); this.refresh(); }, g.run.kind === 'normal' && g.sim.cfg.zone === i] as [string, () => void, boolean])));

    body.append(el('div', 'section-title', 'Game speed'));
    body.append(el('p', 'note', `Speeds up the whole sim: ticks, the tide, timers. Currently ×${g.timeScale}. Offline-rate measuring pauses while it isn't ×1.`));
    body.append(btnRow([0.25, 0.5, 1, 2, 4, 8, 16].map((s) => [`×${s}`, () => { g.timeScale = s; this.refresh(); }, g.timeScale === s] as [string, () => void, boolean])));

    body.append(el('div', 'section-title', 'Unlocks'));
    body.append(btnRow([
      ['Unlock everything', () => {
        m.debugUnlockAll();
        g.save();
        this.toast('Everything unlocked; applies from the next run');
        this.refresh();
      }],
      ['+10K coins', () => { m.debugGrant(10_000, 0); g.save(); this.refresh(); }],
      ['+1M coins', () => { m.debugGrant(1_000_000, 0); g.save(); this.refresh(); }],
      ['+100K points', () => { m.debugGrant(0, 100_000); g.save(); this.refresh(); }],
      ['New run now', () => { g.newRun({ kind: 'normal' }); this.refresh(); }],
    ]));
    body.append(el('p', 'note', `Brain ${BRAIN_NAMES[p.brainTier]} · zones to ${ZONES[p.maxZone].name} · portal pairs ${p.portalPairs}/3 · Skin ×${p.skinMult.toFixed(2)}`));

    body.append(el('div', 'section-title', 'Data'));
    const reset = el('button', 'danger-btn', 'Reset all data (start fresh)');
    reset.addEventListener('click', () => this.open('resetConfirmModal'));
    body.append(reset);
  }

  private renderBadges() {
    const p = this.meta.p;
    const panel = $('rankPanel');
    panel.replaceChildren();
    const ladder = (label: string, tiers: typeof RANK_TIERS_COINS, value: number) => {
      const r = rankProgress(tiers, value);
      const line = el('div', 'rank-line');
      const cur = r.currentTier ? r.currentTier.name : 'Unranked';
      const next = r.nextTier ? ` → ${r.nextTier.name} at ${fmt(r.nextTier.threshold)}` : ' (max)';
      line.append(el('div', 'rank-label', `${label}: ${cur}${next}`));
      const outer = el('div', 'rank-bar-outer');
      const fill = el('div', 'rank-bar-fill');
      const lo = r.currentTier?.threshold ?? 0;
      const hi = r.nextTier?.threshold ?? lo;
      fill.style.width = r.nextTier ? `${Math.min(100, ((value - lo) / Math.max(1, hi - lo)) * 100)}%` : '100%';
      outer.append(fill);
      line.append(outer);
      panel.append(line);
    };
    ladder('Coin rank', RANK_TIERS_COINS, p.stats.lifetimeCoinsEarned);
    ladder('Score rank', RANK_TIERS_SCORE, p.stats.lifetimeScore);
    const list = $('badgesList');
    list.replaceChildren(
      ...ACHIEVEMENTS.map((a) => {
        const got = p.unlockedAchievements.includes(a.id);
        return row(a.name, a.desc, action(got ? 'Earned' : `+${a.coins}`, null, { selected: got }), got ? '' : 'locked');
      }),
    );
  }

  private renderScores() {
    const p = this.meta.p;
    const list = $('scoresList');
    list.replaceChildren();
    if (!p.highScores.length) list.append(el('p', 'note', 'No runs yet.'));
    p.highScores.forEach((h, i) => {
      const d = h.date ? new Date(h.date).toLocaleDateString() : '';
      list.append(row(`${i + 1}. ${fmt(h.score)}`, `${d} · ${ZONES[h.zone]?.name ?? ''} · fill ${(h.phi * 100).toFixed(0)}%`, null));
    });
    const days = Object.entries(p.daily).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);
    if (days.length) {
      list.append(el('div', 'section-title', 'Daily Race'));
      for (const [k, v] of days) list.append(row(k, `Best ${fmt(v)}`, null));
    }
    list.append(el('div', 'section-title', 'Lifetime'));
    const s = p.stats;
    list.append(row('Molts', `${p.moltCount} · best fill ${(s.bestPhi * 100).toFixed(0)}% · jackpots ${s.jackpots}`, null));
    list.append(row('Apples', `${fmt(s.applesEaten)} · golden ${s.goldenApplesEaten} · mice ${s.miceCaught}`, null));
  }
}
