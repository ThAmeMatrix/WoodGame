/* 游戏主控：输入、动画节拍、撤销/提示、进度存档与界面。 */
(function () {
  'use strict';
  const LEVELS = window.WOOD_LEVELS;
  const R = window.WoodRules;
  const S = window.WoodSolver;
  const V = window.WoodView;
  const $ = function (id) { return document.getElementById(id); };
  const STORE = 'woodgame.progress.v1';
  const ANIM_MS = { roll: 205, teleport: 520, fall: 520, win: 1180 };
  window.WoodAnimMs = ANIM_MS;   // 供烟雾测试慢放逐帧检查，正常游玩用默认值
  const DIR_NAME = { U: '↑ 上', D: '↓ 下', L: '← 左', R: '→ 右' };
  const KEYMAP = {
    ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
    w: 'U', s: 'D', a: 'L', d: 'R', W: 'U', S: 'D', A: 'L', D: 'R'
  };

  let progress = { cleared: {}, last: 0, sound: true };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    if (saved && typeof saved === 'object') {
      progress.cleared = saved.cleared || {};
      progress.last = saved.last || 0;
      progress.sound = saved.sound !== false;
    }
  } catch (e) { /* file:// 或隐私模式下静默降级 */ }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(progress)); } catch (e) { /* 忽略 */ }
  }

  let levelIndex = 0;
  let board = null, state = null, view = null;
  let history = [], moves = 0, anim = null, queue = [];
  let won = false, hintCache = null, hintKey = '';
  let audio = null;

  /* ---------- 音效：WebAudio 即时合成，无外部资源 ---------- */
  function ensureAudio() {
    if (!audio) {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (Ctor) audio = new Ctor();
      } catch (e) { audio = null; }
    }
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function tone(freq, dur, type, vol, endFreq) {
    if (!progress.sound) return;
    ensureAudio();
    if (!audio) return;
    const now = audio.currentTime;
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, now + dur);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(vol || 0.05, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain); gain.connect(audio.destination);
    osc.start(now); osc.stop(now + dur + 0.03);
  }
  function sfx(kind) {
    if (kind === 'roll') tone(165, 0.13, 'triangle', 0.045, 95);
    else if (kind === 'switch') { tone(620, 0.16, 'sine', 0.05, 980); }
    else if (kind === 'teleport') tone(280, 0.32, 'sine', 0.05, 1250);
    else if (kind === 'fall') tone(230, 0.42, 'sawtooth', 0.045, 62);
    else if (kind === 'click') tone(430, 0.07, 'sine', 0.03);
    else if (kind === 'thud') tone(125, 0.22, 'triangle', 0.06, 62);
    else if (kind === 'win') {
      [523, 659, 784].forEach(function (f, i) {
        setTimeout(function () { tone(f, 0.34, 'sine', 0.055); }, i * 105);
      });
    }
  }

  /* ---------- 界面 ---------- */
  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2100);
  }
  function hideHint() { $('hint-text').classList.remove('show'); }
  function stars(steps, par) {
    return steps <= par ? 3 : (steps <= Math.ceil(par * 1.5) ? 2 : 1);
  }
  function starText(n) { return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }

  function buildLevelList() {
    const list = $('level-list');
    list.innerHTML = '';
    LEVELS.forEach(function (lv, i) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'level-item';
      btn.innerHTML = '<span class="lv-num">' + String(lv.id).padStart(2, '0') + '</span>' +
        '<span class="lv-label"><span class="lv-name">' + lv.name + '</span>' +
        '<span class="lv-chapter">' + lv.chapter + '</span></span>' +
        '<span class="lv-meta"></span>';
      btn.addEventListener('click', function () { sfx('click'); loadLevel(i); });
      list.appendChild(btn);
    });
  }

  /* 119 关只创建一次 DOM，之后每步仅刷新状态，避免重建列表并保留滚动位置。 */
  function refreshLevelList() {
    const rows = $('level-list').children;
    for (let i = 0; i < rows.length; i++) {
      const lv = LEVELS[i], best = progress.cleared[lv.id], btn = rows[i];
      btn.className = 'level-item' + (i === levelIndex ? ' active' : '') + (best ? ' done' : '');
      btn.querySelector('.lv-meta').textContent = best ? '★ ' + best : lv.par + ' 步';
      if (i === levelIndex) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    }
  }

  function renderUI() {
    const lv = LEVELS[levelIndex];
    $('level-name').textContent = String(lv.id).padStart(2, '0') + ' · ' + lv.name;
    $('level-chapter').textContent = lv.chapter;
    $('level-intro').textContent = lv.intro;
    $('level-tip').textContent = lv.tip;
    $('move-count').textContent = moves;
    $('par-count').textContent = lv.par;
    const best = progress.cleared[lv.id];
    $('best-count').textContent = best || '—';
    $('btn-undo').disabled = history.length === 0 || won;
    $('btn-prev').disabled = levelIndex === 0;
    $('btn-next').disabled = levelIndex === LEVELS.length - 1;
    $('progress-text').textContent = Object.keys(progress.cleared).length + ' / ' + LEVELS.length + ' 关';
    $('btn-sound').textContent = progress.sound ? '♪ 音效开' : '♪ 音效关';
    $('btn-sound').setAttribute('aria-pressed', String(progress.sound));
    refreshLevelList();
  }

  function loadLevel(index) {
    levelIndex = Math.max(0, Math.min(LEVELS.length - 1, index));
    const lv = LEVELS[levelIndex];
    board = R.parse(lv);
    state = board.initial.slice();
    history = []; moves = 0; queue = [];
    anim = null; won = false; hintCache = null; hintKey = '';
    if (view) view.setBoard(board);
    else view = new V.BoardView($('stage-canvas'), board);
    progress.last = levelIndex; save();
    hideHint();
    $('win-overlay').classList.remove('show');
    renderUI();
  }

  function showWin() {
    const lv = LEVELS[levelIndex];
    const oldBest = progress.cleared[lv.id];
    const improved = !oldBest || moves < oldBest;
    if (improved) progress.cleared[lv.id] = moves;
    save();
    const n = stars(moves, lv.par);
    const last = levelIndex === LEVELS.length - 1;
    $('win-title').textContent = last ? '全部通关！' : '漂亮，入洞了';
    $('win-stars').textContent = starText(n);
    $('win-stats').innerHTML =
      '<span>本关步数 <b>' + moves + '</b></span>' +
      '<span>最优 <b>' + lv.par + '</b></span>' +
      '<span>个人最佳 <b>' + progress.cleared[lv.id] + '</b></span>' +
      (improved ? '<span class="win-new">新纪录</span>' : '');
    $('win-note').textContent = last
      ? LEVELS.length + ' 座浮岛全部走通了。可以回头挑战更少的步数。'
      : (n === 3 ? '正好是最优解，木块归位得干净利落。' : '还有更短的路线，试试撤销或换个思路。');
    $('win-next').textContent = last ? '回到第一关' : '下一关 →';
    $('win-overlay').classList.add('show');
    renderUI();
  }

  /* ---------- 规则驱动 ---------- */
  function attempt(dir) {
    if (won || !board) return;
    if (anim) { if (queue.length < 8) queue.push(dir); return; }
    hideHint();
    const out = R.step(board, state, dir);
    if (out.result === 'fall' || out.result === 'fragile' || out.result === 'blocked') {
      anim = { type: 'fall', from: state.slice(), dir: dir, t: 0, duration: ANIM_MS.fall };
      toast(out.result === 'fragile'
        ? '橙木碎了！只有横躺压过去才安全。'
        : '掉下去了！这一步不算，已退回原地。');
      sfx('fall');
      return;
    }
    const previous = state.slice();
    history.push(previous);
    state = out.state.slice();
    moves += 1;
    hintCache = null;
    const teleported = out.info.teleported;
    const win = out.result === 'win';
    anim = {
      type: win ? 'win' : (teleported ? 'teleport' : 'roll'),
      from: previous, dir: dir, t: 0,
      duration: win ? ANIM_MS.win : (teleported ? ANIM_MS.teleport : ANIM_MS.roll)
    };
    if (win) won = true;
    if (out.info.fired.length) { sfx('switch'); toast('机关触发 · 吊桥状态改变'); }
    else if (teleported) sfx('teleport');
    else if (win) sfx('click');
    else sfx('roll');
    renderUI();
  }

  function undo() {
    if (won) return;
    if (anim) { if (queue.length < 8) queue.push('UNDO'); return; }
    if (!history.length) return;
    state = history.pop();
    moves = Math.max(0, moves - 1);
    hintCache = null;
    hideHint();
    renderUI();
    sfx('click');
  }
  function showHint() {
    if (won || anim) return;
    const k = state.join(',');
    if (hintKey !== k || !hintCache) {
      hintCache = S.solveFrom(board, state);
      hintKey = k;
    }
    const el = $('hint-text');
    if (!hintCache.path || !hintCache.path.length) {
      el.textContent = '当前局面已无解，撤销几步或重开本关吧。';
    } else {
      el.textContent = '下一步 ' + DIR_NAME[hintCache.path[0]] +
        ' · 之后还需 ' + (hintCache.path.length - 1) + ' 步';
    }
    el.classList.add('show');
  }
  function nextLevel() {
    if (levelIndex < LEVELS.length - 1) loadLevel(levelIndex + 1);
    else loadLevel(0);
  }

  function finishAnim() {
    const finished = anim;
    anim = null;
    if (finished && finished.type === 'win') { showWin(); sfx('win'); }
    if (queue.length) {
      const item = queue.shift();
      if (item === 'UNDO') undo(); else attempt(item);
    }
  }

  /* ---------- 主循环 ---------- */
  let lastTs = 0;
  function frame(ts) {
    const dt = lastTs ? Math.min(60, ts - lastTs) : 16;
    lastTs = ts;
    if (anim) {
      anim.t += dt / anim.duration;
      if (anim.type === 'win' && !anim.thud && anim.t > 0.86) {
        anim.thud = true;
        sfx('thud');
      }
      if (anim.t >= 1) finishAnim();
    }
    if (view) view.render(state, anim, ts);
    requestAnimationFrame(frame);
  }

  /* ---------- 输入 ---------- */
  function bind() {
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (KEYMAP[e.key]) { e.preventDefault(); attempt(KEYMAP[e.key]); return; }
      if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(); }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); loadLevel(levelIndex); }
      else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); showHint(); }
      else if (e.key === 'Escape') { $('win-overlay').classList.remove('show'); }
      else if (e.key === ' ' && won) { e.preventDefault(); nextLevel(); }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-dir]'), function (btn) {
      btn.addEventListener('click', function () { attempt(btn.getAttribute('data-dir')); });
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-reset').addEventListener('click', function () { sfx('click'); loadLevel(levelIndex); });
    $('btn-hint').addEventListener('click', showHint);
    $('btn-prev').addEventListener('click', function () { loadLevel(levelIndex - 1); });
    $('btn-next').addEventListener('click', function () { loadLevel(levelIndex + 1); });
    $('btn-sound').addEventListener('click', function () {
      progress.sound = !progress.sound; save(); renderUI();
      if (progress.sound) sfx('click');
    });
    const jumpInput = $('level-jump-input');
    function jumpToLevel() {
      const n = parseInt(jumpInput.value, 10);
      if (!isFinite(n) || n < 1 || n > LEVELS.length) return;
      loadLevel(n - 1);
      const btn = $('level-list').children[n - 1];
      if (btn && btn.scrollIntoView) btn.scrollIntoView({ block: 'nearest' });
      sfx('click');
    }
    jumpInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); jumpToLevel(); }
    });
    $('btn-jump').addEventListener('click', jumpToLevel);
    $('win-next').addEventListener('click', nextLevel);
    $('win-retry').addEventListener('click', function () { loadLevel(levelIndex); });
    $('win-close').addEventListener('click', function () { $('win-overlay').classList.remove('show'); });

    // 触摸滑动
    const canvas = $('stage-canvas');
    let touch = null;
    canvas.addEventListener('touchstart', function (e) {
      const t = e.changedTouches[0];
      touch = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    canvas.addEventListener('touchend', function (e) {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
      touch = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      // 等距四象限：u 是「右上/左下」轴，v 是「右下/左上」轴
      const u = dx - dy, v = dx + dy;
      attempt(Math.abs(u) > Math.abs(v) ? (u > 0 ? 'R' : 'L') : (v > 0 ? 'D' : 'U'));
    }, { passive: true });

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () { if (view) view.resize(); });
      ro.observe($('canvas-wrap'));
    } else {
      window.addEventListener('resize', function () { if (view) view.resize(); });
    }
  }

  function init() {
    bind();
    $('level-jump-input').max = String(LEVELS.length);
    $('level-jump-input').placeholder = '关卡号 1–' + LEVELS.length;
    buildLevelList();
    loadLevel(Math.max(0, Math.min(LEVELS.length - 1, progress.last || 0)));
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})();
