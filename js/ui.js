// ui.js — wires the DOM chrome (Nokia buttons, overlays, shop/badges/
// scores/settings modals, idle-claim popup) to game.js (via NS.game and
// the NS.bus event stream) and economy.js (the source of truth for
// coins/skins/achievements/settings).
(function () {
  'use strict';

  const NS = (window.NS = window.NS || {});
  NS.bus = NS.bus || new EventTarget();
  const economy = NS.economy;
  const audio = NS.audio;
  const bus = NS.bus;

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  let toastTimer = null;
  function showToast(msg, durationMs = 1800) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), durationMs);
  }

  function openModal(id) {
    audio.playUiClick();
    $(id).classList.remove('hidden');
  }
  function closeModal(id) {
    $(id).classList.add('hidden');
  }

  function speedLevel(score) {
    return 1 + Math.floor(score / 40);
  }

  function fmtDuration(sec) {
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // Formats a coins/sec rate as a coins/min readout — early-game rates are
  // fractions of a coin per second (e.g. 0.022/sec), which reads as a
  // meaningless string of decimals; coins/min keeps it to a legible 1-2
  // significant digits across the range this game actually produces.
  function fmtIdleRate(perSec) {
    const perMin = perSec * 60;
    if (perMin >= 10) return `≈${Math.round(perMin)} coins/min`;
    if (perMin >= 1) return `≈${perMin.toFixed(1)} coins/min`;
    return `≈${perMin.toFixed(2)} coins/min`;
  }

  // ---------------------------------------------------------------------
  // Status bar
  // ---------------------------------------------------------------------

  function updateStatusBar(score) {
    const state = economy.getState();
    const multSuffix = lastMultiplier > 1 ? `  ×${lastMultiplier.toFixed(2)}` : '';
    // Live in-run score-rate: reflects the scene's rolling 10s window
    // (see game.js step()), so it's only meaningful while a run is alive
    // and genuinely decays back toward nothing if scoring stalls.
    const scene = NS.game && NS.game._scene;
    const rateSuffix = (scene && scene.alive && scene.scoreRate10s > 0)
      ? `  (+${scene.scoreRate10s} in 10s)`
      : '';
    $('scoreLabel').textContent = `Score: ${score}${multSuffix}${rateSuffix}`;
    $('coinsLabel').textContent = `Coins: ${state.economy.coins}`;
    $('pointsLabel').textContent = `Points: ${state.economy.points}`;
    $('speedLabel').textContent = `Spd: ${speedLevel(score)}`;
    $('idleRateLabel').textContent = `Idle: ${fmtIdleRate(economy.currentIdleRate())}`;
  }

  // ---------------------------------------------------------------------
  // Ability buttons (side panel) — only rendered/visible for abilities
  // the player has actually bought (economy.ownsAbility). Labels show
  // live charges/cooldown, refreshed on a short interval plus whenever
  // the relevant snake:* event fires (see wiring below).
  // ---------------------------------------------------------------------

  function renderAbilityButtons() {
    const scene = NS.game && NS.game._scene;

    const btnBodyToss = $('btnBodyToss');
    const btnPhaseWalls = $('btnPhaseWalls');
    const btnBiggerBite = $('btnBiggerBite');
    const btnAutoCollect = $('btnAutoCollect');

    const ownsBodyToss = economy.ownsAbility('bodyToss');
    const ownsPhaseWalls = economy.ownsAbility('phaseWalls');
    const ownsBiggerBite = economy.ownsAbility('biggerBite');
    const ownsAutoCollect = economy.ownsAbility('autoCollect');

    btnBodyToss.style.display = ownsBodyToss ? '' : 'none';
    btnPhaseWalls.style.display = ownsPhaseWalls ? '' : 'none';
    btnBiggerBite.style.display = ownsBiggerBite ? '' : 'none';
    btnAutoCollect.style.display = ownsAutoCollect ? '' : 'none';

    if (ownsBodyToss) {
      const charges = scene ? scene.bodyTossCharges : 0;
      btnBodyToss.textContent = `Body Toss (${charges})`;
      btnBodyToss.disabled = charges <= 0;
    }
    if (ownsPhaseWalls) {
      const cd = scene ? scene.phaseWallsCooldownLeft : 0;
      btnPhaseWalls.textContent = cd > 0 ? `Phase Walls (${Math.ceil(cd)}s)` : 'Phase Walls (Ready)';
      btnPhaseWalls.disabled = cd > 0;
    }
    if (ownsBiggerBite) {
      const cd = scene ? scene.biggerBiteCooldownLeft : 0;
      btnBiggerBite.textContent = cd > 0 ? `Bigger Bite (${Math.ceil(cd)}s)` : 'Bigger Bite (Ready)';
      btnBiggerBite.disabled = cd > 0;
    }
    if (ownsAutoCollect) {
      const remaining = scene ? scene.autoCollectRemaining : 0;
      const cd = scene ? scene.autoCollectCooldownLeft : 0;
      if (remaining > 0) {
        btnAutoCollect.textContent = `Auto-Collect (Remaining: ${remaining})`;
        btnAutoCollect.disabled = true;
      } else {
        btnAutoCollect.textContent = cd > 0 ? `Auto-Collect (${Math.ceil(cd)}s)` : 'Auto-Collect (Ready)';
        btnAutoCollect.disabled = cd > 0;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Overlay (start / game over)
  // ---------------------------------------------------------------------

  function showStartOverlay() {
    const best = economy.getState().stats.bestScore;
    $('overlayTitle').textContent = 'Snake';
    $('overlaySub').textContent = 'Press Enter or Tap to Start';
    $('overlaySub').classList.add('blink');
    $('overlayScore').textContent = '';
    $('overlayHigh').textContent = best ? `Best: ${best}` : '';
    $('overlayExtra').textContent = '';
    $('overlay').classList.remove('hidden');
  }

  function showGameOverOverlay(detail) {
    $('overlayTitle').textContent = 'Game Over';
    $('overlaySub').textContent = 'Press Enter or Tap to Retry';
    $('overlaySub').classList.add('blink');
    $('overlayScore').textContent = String(detail.score);
    $('overlayHigh').textContent = detail.isHighScore
      ? '★ NEW HIGH SCORE ★'
      : `Best: ${economy.getState().stats.bestScore}`;
    const bits = [];
    if (detail.bonusCoins > 0) bits.push(`+${detail.bonusCoins} coins`);
    if (detail.newAchievements && detail.newAchievements.length) {
      bits.push(`Badge unlocked: ${detail.newAchievements[0].name}`);
    }
    $('overlayExtra').textContent = bits.join(' • ');
    $('overlay').classList.remove('hidden');
  }

  // ---------------------------------------------------------------------
  // Shop
  // ---------------------------------------------------------------------

  function renderShop() {
    const state = economy.getState();
    $('shopCoinBalance').textContent = `Coins: ${state.economy.coins}`;

    const skinsHtml = ['<h2 style="font-size:11px;margin-top:4px;">Skins</h2>']
      .concat(Object.values(economy.SKINS).map((skin) => {
        const owned = economy.ownsSkin(skin.id);
        const selected = state.settings.skin === skin.id;
        let label, action, disabled = false;
        if (selected) { label = 'Equipped'; action = ''; disabled = true; }
        else if (owned) { label = 'Equip'; action = `data-equip-skin="${skin.id}"`; }
        else { label = `Buy ${skin.cost}`; action = `data-buy-skin="${skin.id}"`; disabled = state.economy.coins < skin.cost; }
        return `<div class="row"><div class="meta"><span class="name">${skin.name}</span></div>
          <button class="action ${selected ? 'selected' : ''}" ${action} ${disabled ? 'disabled' : ''}>${label}</button></div>`;
      }));

    const trailsHtml = ['<h2 style="font-size:11px;">Trail Effects</h2>']
      .concat(Object.values(economy.TRAILS).map((trail) => {
        const owned = economy.ownsTrail(trail.id);
        const selected = state.settings.trail === trail.id;
        let label, action, disabled = false;
        if (selected) { label = 'Equipped'; action = ''; disabled = true; }
        else if (owned) { label = 'Equip'; action = `data-equip-trail="${trail.id}"`; }
        else { label = `Buy ${trail.cost}`; action = `data-buy-trail="${trail.id}"`; disabled = state.economy.coins < trail.cost; }
        return `<div class="row"><div class="meta"><span class="name">${trail.name}</span></div>
          <button class="action ${selected ? 'selected' : ''}" ${action} ${disabled ? 'disabled' : ''}>${label}</button></div>`;
      }));

    const upgradesHtml = ['<h2 style="font-size:11px;">Upgrades</h2>']
      .concat(Object.values(economy.UPGRADES).map((up) => {
        const owned = state.economy.ownedUpgrades.includes(up.id);
        const label = owned ? 'Owned' : `Buy ${up.cost}`;
        const disabled = owned || state.economy.coins < up.cost;
        return `<div class="row"><div class="meta"><span class="name">${up.name}</span><span class="desc">${up.desc}</span></div>
          <button class="action" ${owned ? '' : `data-buy-upgrade="${up.id}"`} ${disabled ? 'disabled' : ''}>${label}</button></div>`;
      }));

    const mockHtml = ['<h2 style="font-size:11px;">Coin Packs (demo, no real charge)</h2>']
      .concat(Object.entries(economy.MOCK_STORE).map(([id, item]) => {
        return `<div class="row"><div class="meta"><span class="name">${item.label}</span><span class="desc">${item.priceLabel}</span></div>
          <button class="action" data-mock-purchase="${id}">Buy</button></div>`;
      }));

    $('shopSkinsList').innerHTML = skinsHtml.join('');
    $('shopTrailsList').innerHTML = trailsHtml.join('');
    $('shopUpgradesList').innerHTML = upgradesHtml.join('');
    $('shopMockList').innerHTML = mockHtml.join('');
  }

  function handleShopClick(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    let changed = false;

    if (t.dataset.buySkin) {
      changed = economy.buySkin(t.dataset.buySkin);
      if (changed) {
        economy.setSkin(t.dataset.buySkin);
        withGame((g) => g.setSkin(t.dataset.buySkin));
        audio.playCoin();
      }
    } else if (t.dataset.equipSkin) {
      economy.setSkin(t.dataset.equipSkin);
      withGame((g) => g.setSkin(t.dataset.equipSkin));
      changed = true;
      audio.playUiClick();
    } else if (t.dataset.buyTrail) {
      changed = economy.buyTrail(t.dataset.buyTrail);
      if (changed) { economy.setTrail(t.dataset.buyTrail); audio.playCoin(); }
    } else if (t.dataset.equipTrail) {
      economy.setTrail(t.dataset.equipTrail);
      changed = true;
      audio.playUiClick();
    } else if (t.dataset.buyUpgrade) {
      changed = economy.buyUpgrade(t.dataset.buyUpgrade);
      if (changed) audio.playCoin();
    } else if (t.dataset.mockPurchase) {
      changed = economy.mockPurchase(t.dataset.mockPurchase);
      if (changed) { audio.playCoin(); showToast('Coin pack granted (demo)'); }
    }

    if (changed) {
      renderShop();
      updateStatusBar(NS.game && NS.game.isAlive() ? lastScore : 0);
    }
  }

  // ---------------------------------------------------------------------
  // Skills
  // ---------------------------------------------------------------------

  // Human-readable "Requires: ..." text for a locked node — combines the
  // implicit Root gate (when this node's own branch isn't Root) with the
  // node's own `prereq` conditions (single object or array — see
  // economy.js's SKILL_TREE comment for the shape).
  function requiresText(node, catId) {
    const parts = [];
    if (catId !== 'root' && economy.skillNodeLevel(economy.ROOT_NODE_ID) < 1) {
      parts.push('Awaken the Coil (Root)');
    }
    if (node.prereq) {
      const conds = Array.isArray(node.prereq) ? node.prereq : [node.prereq];
      conds.forEach((cond) => {
        const reqNode = economy.findSkillNode(cond.nodeId);
        const name = reqNode ? reqNode.name : cond.nodeId;
        const minLevel = cond.minLevel != null ? cond.minLevel : 1;
        if (reqNode && reqNode.maxLevel > 1 && minLevel >= reqNode.maxLevel) {
          parts.push(`${name} maxed`);
        } else if (minLevel > 1) {
          parts.push(`${name} ≥ Lv${minLevel}`);
        } else {
          parts.push(`${name} owned`);
        }
      });
    }
    return parts.join(' AND ');
  }

  function renderSkillNodeHtml(node, catId) {
    const state = economy.getState();
    const level = economy.skillNodeLevel(node.id);
    const maxed = level >= node.maxLevel;
    const oneTime = node.maxLevel === 1;
    const currencyKey = node.currency === 'points' ? 'points' : 'coins';
    const currencyLabel = currencyKey === 'points' ? 'PTS' : 'COINS';

    let stateClass, label, buyable = false, extraLine = '';

    if (maxed) {
      stateClass = 'maxed';
      label = oneTime ? 'Owned' : 'MAXED';
    } else if (!economy.nodePrereqMet(node.id)) {
      stateClass = 'locked';
      label = 'Locked';
      extraLine = `<span class="requires">Requires: ${requiresText(node, catId)}</span>`;
    } else {
      const cost = economy.skillNodeCost(node.id);
      const balance = currencyKey === 'points' ? state.economy.points : state.economy.coins;
      const affordable = balance >= cost;
      stateClass = affordable ? 'affordable' : 'unaffordable';
      label = `Buy ${cost}`;
      buyable = affordable;
    }

    const levelSuffix = oneTime ? '' : ` (Lv ${level}/${node.maxLevel})`;
    return `<div class="skill-node ${stateClass}">
        <span class="name">${node.name}${levelSuffix}</span>
        <span class="desc">${node.desc}</span>
        <span class="currency-tag ${currencyKey}">${currencyLabel}</span>
        ${extraLine}
        <button class="action" ${buyable ? `data-buy-skill-node="${node.id}"` : ''} ${buyable ? '' : 'disabled'}>${label}</button>
      </div>`;
  }

  function renderSkills() {
    const state = economy.getState();
    $('skillsCoinBalance').textContent = `Coins: ${state.economy.coins}`;
    $('skillsPointsBalance').textContent = `Points: ${state.economy.points}`;

    const rootNode = economy.SKILL_TREE.root.nodes[0];
    $('skillsRoot').innerHTML = renderSkillNodeHtml(rootNode, 'root');

    const branchIds = ['scoreMastery', 'abilities', 'economyBranch', 'vitality'];
    const branchesHtml = branchIds.map((catId) => {
      const category = economy.SKILL_TREE[catId];
      const nodesHtml = category.nodes.map((node) => renderSkillNodeHtml(node, catId)).join('');
      return `<div class="skill-branch"><h3>${category.name}</h3>${nodesHtml}</div>`;
    }).join('');

    $('skillsBranches').innerHTML = branchesHtml;
  }

  function handleSkillsClick(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!t.dataset.buySkillNode) return;

    const changed = economy.buySkillNode(t.dataset.buySkillNode);
    if (changed) {
      audio.playCoin();
      renderSkills();
      updateStatusBar(NS.game && NS.game.isAlive() ? lastScore : 0);
    }
  }

  // ---------------------------------------------------------------------
  // Badges
  // ---------------------------------------------------------------------

  function renderBadges() {
    const state = economy.getState();
    const html = economy.ACHIEVEMENTS.map((ach) => {
      const unlocked = state.economy.unlockedAchievements.includes(ach.id);
      return `<div class="row"><div class="meta">
          <span class="name">${unlocked ? '✓ ' : '□ '}${ach.name}</span>
          <span class="desc">${ach.desc} (+${ach.coins} coins)</span>
        </div></div>`;
    }).join('');
    $('badgesList').innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // High scores
  // ---------------------------------------------------------------------

  function renderScores() {
    const list = economy.getState().highScores;
    if (!list.length) {
      $('scoresList').innerHTML = '<p style="font-size:11px;color:#4a5a32;">No scores yet — go play!</p>';
      return;
    }
    $('scoresList').innerHTML = list.map((entry, i) => {
      const d = new Date(entry.date);
      const dateStr = isNaN(d.getTime()) ? '' : d.toLocaleDateString();
      return `<div class="row"><div class="meta"><span class="name">#${i + 1} — ${entry.score}</span><span class="desc">${dateStr}</span></div></div>`;
    }).join('');
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  function renderSettings() {
    const s = economy.getState().settings;
    $('toggleWrap').textContent = s.wrapMode ? 'ON' : 'OFF';
    $('toggleCrt').textContent = s.crtEffect ? 'ON' : 'OFF';
    $('toggleMuteSetting').textContent = s.muted ? 'OFF' : 'ON';
  }

  // ---------------------------------------------------------------------
  // Idle claim
  // ---------------------------------------------------------------------

  function maybeShowIdleClaim() {
    const reward = economy.computeIdleReward();
    if (reward.coins <= 0) return;
    $('idleAwayText').textContent = `You were away for ${fmtDuration(reward.elapsedSec)}.`;
    $('idleAmount').textContent = `+${reward.coins} Coins`;
    $('idleRateText').textContent = `Current rate: ${fmtIdleRate(economy.currentIdleRate())}`;
    openModal('idleModal');
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  let lastScore = 0;
  let lastMultiplier = 1;

  // NS.game is only assigned once the Phaser scene's create() has run
  // (a frame or two after `new Phaser.Game()`). Every handler below is
  // deferred (click / bus event), so in normal use it's always ready by
  // the time a human could interact — this guard just protects against
  // a very fast programmatic click (e.g. automated testing) racing boot.
  function withGame(fn) {
    if (NS.game) fn(NS.game);
  }

  function init() {
    renderSettings();
    updateStatusBar(0);
    audio.setMuted(economy.getState().settings.muted);
    $('btnMute').textContent = economy.getState().settings.muted ? 'Unmute' : 'Mute';

    $('overlay').addEventListener('click', () => {
      audio.unlock();
      withGame((g) => { if (!g.isAlive()) g.startGame(); });
    });

    $('btnMute').addEventListener('click', () => {
      const next = !audio.isMuted();
      audio.setMuted(next);
      economy.setMuted(next);
      $('btnMute').textContent = next ? 'Unmute' : 'Mute';
      renderSettings();
    });

    // Menu buttons
    $('btnShop').addEventListener('click', () => { renderShop(); openModal('shopModal'); });
    $('btnSkills').addEventListener('click', () => { renderSkills(); openModal('skillsModal'); });
    $('btnBadges').addEventListener('click', () => { renderBadges(); openModal('badgesModal'); });
    $('btnScores').addEventListener('click', () => { renderScores(); openModal('scoresModal'); });
    $('btnSettings').addEventListener('click', () => { renderSettings(); openModal('settingsModal'); });

    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });

    $('shopModal').addEventListener('click', handleShopClick);
    $('skillsModal').addEventListener('click', handleSkillsClick);

    $('toggleWrap').addEventListener('click', () => {
      const next = !economy.getState().settings.wrapMode;
      economy.setWrapMode(next);
      withGame((g) => g.setWrapMode(next));
      renderSettings();
      audio.playUiClick();
    });
    $('toggleCrt').addEventListener('click', () => {
      const next = !economy.getState().settings.crtEffect;
      economy.setCrtEffect(next);
      withGame((g) => g.setCrtEnabled(next));
      renderSettings();
      audio.playUiClick();
    });
    $('toggleMuteSetting').addEventListener('click', () => {
      const next = !audio.isMuted();
      audio.setMuted(next);
      economy.setMuted(next);
      $('btnMute').textContent = next ? 'Unmute' : 'Mute';
      renderSettings();
    });

    $('btnBodyToss').addEventListener('click', () => withGame((g) => g.useBodyToss()));
    $('btnPhaseWalls').addEventListener('click', () => withGame((g) => g.usePhaseWalls()));
    $('btnBiggerBite').addEventListener('click', () => withGame((g) => g.useBiggerBite()));
    $('btnAutoCollect').addEventListener('click', () => withGame((g) => g.useAutoCollect()));

    $('claimIdleBtn').addEventListener('click', () => {
      economy.claimIdleReward();
      updateStatusBar(lastScore);
      closeModal('idleModal');
      audio.playCoin();
    });

    // Game events
    bus.addEventListener('snake:start', () => {
      $('overlay').classList.add('hidden');
    });

    bus.addEventListener('snake:score', (e) => {
      lastScore = e.detail.score;
      lastMultiplier = e.detail.multiplier || 1;
      updateStatusBar(lastScore);
    });

    bus.addEventListener('snake:golden', (e) => {
      showToast(`Golden Apple! +${e.detail.coins} coins`, 1600);
      updateStatusBar(lastScore);
    });

    bus.addEventListener('snake:chili', (e) => {
      showToast(`Chili! Snake shrinks — Score ×${e.detail.multiplier.toFixed(2)}`, 1600);
      updateStatusBar(lastScore);
    });

    bus.addEventListener('snake:buff', (e) => {
      showToast(`Score Buff! ×3 for ${e.detail.duration}s`, 1600);
      updateStatusBar(lastScore);
    });

    bus.addEventListener('snake:frenzy', (e) => {
      showToast(`Frenzy! Bonus points everywhere for ${e.detail.duration}s`, 1800);
      updateStatusBar(lastScore);
    });

    bus.addEventListener('snake:bodyToss', (e) => {
      const uses = e.detail.chargesLeft === 1 ? '1 use' : `${e.detail.chargesLeft} uses`;
      showToast(`Body Toss! ${uses} left`, 1600);
      renderAbilityButtons();
    });

    bus.addEventListener('snake:phaseWalls', (e) => {
      showToast(`Phase Walls! ${e.detail.duration}s`, 1600);
      renderAbilityButtons();
    });

    bus.addEventListener('snake:biggerBite', (e) => {
      showToast(`Bigger Bite! ${e.detail.duration}s`, 1600);
      renderAbilityButtons();
    });

    bus.addEventListener('snake:autoCollect', (e) => {
      showToast(`Auto-Collect engaged — ${e.detail.remaining} pickups`, 1600);
      renderAbilityButtons();
    });

    bus.addEventListener('snake:autoCollectDone', () => {
      showToast(`Auto-Collect done — you're back in control`, 1800);
      renderAbilityButtons();
    });

    bus.addEventListener('snake:start', () => renderAbilityButtons());

    bus.addEventListener('snake:gameover', (e) => {
      lastScore = 0;
      lastMultiplier = 1;
      updateStatusBar(0);
      showGameOverOverlay(e.detail);
      if (e.detail.newAchievements && e.detail.newAchievements.length) {
        audio.playAchievement();
        showToast(`Badge unlocked: ${e.detail.newAchievements[0].name}`, 2200);
      }
      renderAbilityButtons();
    });

    // Keep the "last seen" timestamp fresh during an active session so the
    // idle/AFK reward only credits genuine time away, not active play.
    window.setInterval(() => economy.touchLastSeen(), 60000);
    window.addEventListener('beforeunload', () => economy.touchLastSeen());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) economy.touchLastSeen();
    });

    // Cooldown/charge readouts on the ability buttons tick down every
    // frame in game.js, so poll at a short interval to keep the labels
    // current without wiring a per-frame event for it. The status bar's
    // live score-rate window decays the same way (ages out with no new
    // pickup events), so it rides the same interval rather than only
    // refreshing on 'snake:score'.
    window.setInterval(() => {
      renderAbilityButtons();
      updateStatusBar(lastScore);
    }, 500);

    showStartOverlay();
    renderAbilityButtons();
    maybeShowIdleClaim();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
