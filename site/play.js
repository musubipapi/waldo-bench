/* Waldo Bench · Play: you vs. the models.
   Vanilla JS. Reads data/bench.json and local images only. Data-derived strings go through textContent. */
(function () {
  'use strict';

  var CFG = {
    pictures: 10,       // pictures per game
    capSeconds: 90,     // per-picture clock cap, then it is a miss
    square: 128,        // answer square, scene pixels (same as a model tile)
    clickSlop: 6,       // pointer travel (px) below which down/up counts as a click
    guardMs: 500,       // after a picture or a result appears, ignore answer, give up and next this long (double clicks)
    doubleTapMs: 300,   // 2 taps this close in time zoom in instead of answering
    tapZoom: 2,
    maxScale: 6,        // screen px per scene px at full zoom
    zoomStep: 1.5,
    panStep: 90,
    storeKey: 'waldo-bench-you'
  };

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function $(id) { return document.getElementById(id); }

  var el = {
    live: $('live'),
    start: $('start'), round: $('round'), summary: $('summary'),
    modeSeg: $('mode-seg'), countNormal: $('count-normal'), countHard: $('count-hard'), modeDesc: $('mode-desc'),
    startBtn: $('start-btn'), best: $('best'), loadError: $('load-error'),
    roundTitle: $('round-title'), roundBar: $('round-bar'), refThumb: $('ref-thumb'), progText: $('prog-text'), pips: $('pips'),
    timer: $('timer'), timerVal: $('timer-val'), timerCap: $('timer-cap'), tbar: $('tbar'), verdict: $('verdict'),
    zoomOut: $('zoom-out'), zoomIn: $('zoom-in'), zoomFit: $('zoom-fit'), zoomLevel: $('zoom-level'),
    giveUp: $('give-up'), toWaldo: $('to-waldo'), lockIn: $('lock-in'), next: $('next'),
    stage: $('stage'), marks: $('marks'), labels: $('labels'), stageMsg: $('stage-msg'),
    keysRound: $('keys-round'), details: $('details'), cropImg: $('crop-img'), modelsLine: $('models-line'),
    modelTags: $('model-tags'), unfinishedNote: $('unfinished-note'), sceneId: $('scene-id'),
    sumKicker: $('sum-kicker'), sumTitle: $('sum-title'), sumLede: $('sum-lede'), sumBest: $('sum-best'),
    sumBody: $('sum-body'), sumNote: $('sum-note'), again: $('again'), switchBtn: $('switch'), sumGrid: $('sum-grid'),
    thAll: $('th-all'), credit: $('credit')
  };

  var S = {
    data: null,
    models: [],
    scenes: [],
    hardPool: [],
    mode: 'normal',
    screen: 'start',     // start | round | summary
    phase: 'idle',       // idle | loading | round | reveal | done
    game: null,          // { mode, scenes, idx, results }
    scene: null,
    img: $('scene-img'),
    preload: null,
    token: 0,
    t0: 0,
    tick: 0,
    pausedAt: 0,         // clock stopped while the tab is hidden
    readyAt: 0,          // when the picture appeared
    revealAt: 0,         // when the result appeared
    view: { s: 1, tx: 0, ty: 0 },
    fit: 1,
    stageW: 0,
    stageH: 0,
    anim: 0,
    animTo: null,
    overlay: null,
    aim: null,           // the answer square's centre, scene px
    aimBy: '',           // mouse (follows the cursor) | touch (placed by a tap) | key (moved with arrow keys)
    aimEls: null,
    mouse: null,         // last mouse position over the picture, client px
    lastTap: null,
    tapTimer: 0,
    keyNav: false        // last input was Tab: focusing the picture counts as keyboard use
  };

  /* ---------- small helpers ---------- */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmtS(v) { return isNum(v) ? v.toFixed(1) : '–'; }
  function sceneName(sc) { return 'Scene ' + (isNum(sc.number) ? sc.number : sc.id); }
  function median(list) {
    var a = list.filter(isNum).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function ordinal(n) {
    var t = n % 100;
    if (t >= 11 && t <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function overlaps(a, b) {
    // positive-area overlap, the benchmark's scoring rule
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  }
  function overlapArea(a, b) {
    var w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    var h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return w > 0 && h > 0 ? w * h : 0;
  }
  function isBox(b) { return Array.isArray(b) && b.length === 4 && b.every(isNum); }
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgNode(tag, cls) {
    var n = document.createElementNS(SVG_NS, tag);
    if (cls) n.setAttribute('class', cls);
    return n;
  }
  function svgIcon(d) {
    var s = svgNode('svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('aria-hidden', 'true');
    var p = svgNode('path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }
  function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function since(t) { return performance.now() - t; }
  function headerH() { var h = document.querySelector('.top'); return h ? h.offsetHeight : 0; }
  function jumpTo(y) {
    // no smooth scrolling here: the picture has to be in place before the clock matters
    try { window.scrollTo({ top: y, behavior: 'instant' }); } catch (e) { window.scrollTo(0, y); }
  }
  function announce(text) {
    el.live.textContent = '';
    window.setTimeout(function () { el.live.textContent = text; }, 60);
  }
  function pickOf(scene, model) {
    var p = scene && scene.picks ? scene.picks[model.model] : null;
    if (!p) return { box: null, found: false, complete: false, seconds: null, missing: true };
    return {
      box: isBox(p.box) ? p.box : null,
      found: p.found === true,
      complete: p.complete !== false,
      seconds: isNum(p.seconds) ? p.seconds : null,
      confidence: isNum(p.confidence) ? p.confidence : null,
      missing: false
    };
  }
  function foundBy(scene) {
    if (isNum(scene.foundBy)) return scene.foundBy;
    return S.models.filter(function (m) { return pickOf(scene, m).found; }).length;
  }
  function modelCount() { return S.models.length; }
  // Hard: scenes found by fewer than half the models, so "most models missed" stays true
  function hardMax() { return Math.ceil(modelCount() / 2) - 1; }

  /* ---------- storage (best result per mode) ---------- */

  function validRec(r) { return !!r && isNum(r.found) && isNum(r.n); }
  function readStore() {
    var raw;
    try { raw = window.localStorage.getItem(CFG.storeKey); } catch (e) { return null; }   // storage unavailable
    if (!raw) return {};
    try {
      var obj = JSON.parse(raw);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e2) { return {}; }   // unreadable value: start fresh
  }
  function writeStore(obj) {
    try { window.localStorage.setItem(CFG.storeKey, JSON.stringify(obj)); return true; } catch (e) { return false; }
  }
  function isBetter(rec, prev) {
    if (!validRec(prev)) return true;
    if (rec.found !== prev.found) return rec.found > prev.found;
    var a = isNum(rec.medianSeconds) ? rec.medianSeconds : Infinity;
    var b = isNum(prev.medianSeconds) ? prev.medianSeconds : Infinity;
    return a < b;
  }
  function saveBest(mode, rec) {
    var store = readStore();
    if (store === null) return { stored: false };
    var prev = validRec(store[mode]) ? store[mode] : null;
    var better = isBetter(rec, prev);
    var stored = true;
    if (better) {
      store[mode] = rec;
      stored = writeStore(store);
    }
    return { stored: stored, better: better, prev: prev, best: better ? rec : prev };
  }
  function bestText(r) {
    return r.found + ' of ' + r.n + (isNum(r.medianSeconds) ? ', median ' + fmtS(r.medianSeconds) + ' s' : '');
  }
  function modeName(m) { return m === 'hard' ? 'Hard' : 'Normal'; }

  function renderStartBest() {
    var store = readStore();
    clearNode(el.best);
    if (!store) { el.best.hidden = true; return; }
    var parts = ['normal', 'hard'].filter(function (m) { return validRec(store[m]); });
    if (!parts.length) { el.best.hidden = true; return; }
    el.best.appendChild(document.createTextNode('Your best on this device: '));
    parts.forEach(function (m, i) {
      if (i) el.best.appendChild(document.createTextNode(' · '));
      el.best.appendChild(node('b', null, modeName(m)));
      el.best.appendChild(document.createTextNode(' ' + bestText(store[m])));
    });
    el.best.hidden = false;
  }

  /* ---------- start screen ---------- */

  function poolFor(mode) { return mode === 'hard' ? S.hardPool : S.scenes; }

  function setMode(mode) {
    if (mode === 'hard' && !S.hardPool.length) mode = 'normal';
    S.mode = mode;
    Array.prototype.forEach.call(el.modeSeg.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
    if (!S.data) return;
    var pool = poolFor(mode);
    var n = Math.min(CFG.pictures, pool.length);
    if (mode === 'hard') {
      el.modeDesc.textContent = n + ' random scenes that ' + hardMax() + ' or fewer models found.';
    } else {
      el.modeDesc.textContent = n + ' random scenes.';
    }
  }

  function initStart() {
    el.countNormal.textContent = '· ' + S.scenes.length + ' scenes';
    el.countHard.textContent = '· ' + S.hardPool.length + ' scenes most models missed';
    var hardBtn = el.modeSeg.querySelector('[data-mode="hard"]');
    if (!S.hardPool.length) hardBtn.disabled = true;
    var wanted = (location.hash || '').replace('#', '').toLowerCase();
    setMode(wanted === 'hard' ? 'hard' : 'normal');
    el.startBtn.disabled = !S.scenes.length;
    el.startBtn.textContent = 'Start';
    renderStartBest();
  }

  /* ---------- screens ---------- */

  function showScreen(name) {
    S.screen = name;
    $('main').classList.toggle('in-round', name === 'round');
    el.start.hidden = name !== 'start';
    el.round.hidden = name !== 'round';
    el.summary.hidden = name !== 'summary';
  }

  function startGame(mode) {
    if (!S.data) return;
    setMode(mode);
    var pool = poolFor(S.mode);
    if (!pool.length) return;
    var chosen = shuffle(pool.slice()).slice(0, Math.min(CFG.pictures, pool.length));
    S.game = { mode: S.mode, scenes: chosen, idx: 0, results: [] };
    showScreen('round');
    buildPips();
    startRound();
    focusStage();
  }

  function focusStage() {
    S.keyNav = false;   // a focus we move ourselves is not the player choosing the picture
    try { el.stage.focus({ preventScroll: true }); } catch (e) { el.stage.focus(); }
  }

  // Show the bar and the whole picture; on short windows (landscape phones) the bar tucks under the sticky header.
  function placeRound() {
    var y0 = window.pageYOffset || 0;
    var barTop = el.roundBar.getBoundingClientRect().top + y0 - headerH();
    var need = el.stage.getBoundingClientRect().bottom + y0 - window.innerHeight + 4;
    jumpTo(clamp(need, 0, Math.max(0, barTop)));
  }

  function buildPips() {
    clearNode(el.pips);
    for (var i = 0; i < S.game.scenes.length; i++) el.pips.appendChild(document.createElement('i'));
  }
  function updatePips() {
    var g = S.game;
    Array.prototype.forEach.call(el.pips.children, function (p, i) {
      var r = g.results[i];
      p.className = r ? (r.found ? 'found' : 'miss') : (i === g.idx ? 'cur' : '');
    });
  }

  /* ---------- round ---------- */

  function startRound() {
    var g = S.game;
    var sc = g.scenes[g.idx];
    var n = g.scenes.length;
    var token = ++S.token;
    S.scene = sc;
    S.phase = 'loading';
    stopTimer();
    stopAnim();
    clearOverlay();
    window.clearTimeout(S.tapTimer);
    S.tapTimer = 0;
    S.lastTap = null;
    S.aim = null;
    S.aimBy = '';
    makeAim();

    el.progText.textContent = (g.idx + 1) + ' / ' + n;
    el.roundTitle.textContent = 'Picture ' + (g.idx + 1) + ' of ' + n;
    el.timerVal.textContent = '0.0';
    el.timerCap.textContent = ' / ' + CFG.capSeconds + ' s';
    el.tbar.style.transform = '';
    el.timer.classList.remove('late');
    el.timer.hidden = false;
    el.refThumb.hidden = false;
    el.verdict.hidden = true;
    el.giveUp.hidden = false;
    el.lockIn.hidden = false;
    el.toWaldo.hidden = true;
    el.next.hidden = true;
    el.roundBar.classList.remove('is-reveal');
    updateLock();
    el.details.hidden = true;
    el.keysRound.hidden = false;
    el.stage.classList.add('round');
    el.stage.classList.remove('reveal', 'dragging');
    el.stageMsg.textContent = 'Loading picture…';
    el.stageMsg.hidden = false;
    updatePips();

    // A fresh <img> per round so load events always fire, even for a repeated scene.
    var img = new Image();
    img.className = 'scene';
    img.alt = '';
    img.draggable = false;
    img.width = sc.width;
    img.height = sc.height;
    el.stage.replaceChild(img, S.img);
    S.img = img;

    sizeStage();
    S.view = fitView();
    applyView();
    placeRound();

    var settled = false;
    function ready(ok) {
      if (settled || token !== S.token) return;
      settled = true;
      img.classList.add('ready');
      if (ok) {
        el.stageMsg.hidden = true;
      } else {
        el.stageMsg.textContent = 'This picture did not load. Give up to move on.';
      }
      S.phase = 'round';
      S.readyAt = performance.now();
      startTimer();
      if (S.mouse) S.aimBy = 'mouse';   // a mouse resting on the picture gets its square right away
      drawAim();
      announce('Picture ' + (g.idx + 1) + ' of ' + n + '. The clock is running.');
      preloadNext();
    }
    img.onload = function () {
      if (img.decode) img.decode().then(function () { ready(true); }, function () { ready(true); });
      else ready(true);
    };
    img.onerror = function () { ready(false); };
    img.src = sc.image;
  }

  function preloadNext() {
    var g = S.game;
    if (!g || g.idx + 1 >= g.scenes.length) return;
    var p = new Image();
    p.src = g.scenes[g.idx + 1].image;
    S.preload = p;
  }

  function startTimer() {
    stopTimer();
    S.t0 = performance.now();
    S.pausedAt = 0;
    S.tick = window.setInterval(tickTimer, 100);
    tickTimer();
    if (document.hidden) pauseClock();   // the picture came in while the tab was in the background
  }
  function stopTimer() {
    if (S.tick) window.clearInterval(S.tick);
    S.tick = 0;
  }
  function elapsed() { return ((S.pausedAt || performance.now()) - S.t0) / 1000; }
  function tickTimer() {
    if (S.phase !== 'round') return;
    var t = elapsed();
    if (t >= CFG.capSeconds) { finish('timeout'); return; }
    el.timerVal.textContent = (Math.floor(t * 10) / 10).toFixed(1);
    el.tbar.style.transform = 'scaleX(' + (1 - t / CFG.capSeconds).toFixed(4) + ')';
    el.timer.classList.toggle('late', t >= CFG.capSeconds - 10);
  }

  // A hidden tab hides the picture, so the clock stops too.
  function pauseClock() {
    if (S.phase !== 'round' || S.pausedAt) return;
    S.pausedAt = performance.now();
    stopTimer();
  }
  function resumeClock() {
    if (!S.pausedAt) return;
    S.t0 += performance.now() - S.pausedAt;
    S.pausedAt = 0;
    if (S.phase !== 'round') return;
    S.tick = window.setInterval(tickTimer, 100);
    tickTimer();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pauseClock(); else resumeClock();
  });

  // how: 'click' | 'giveup' | 'timeout'
  function finish(how, X, Y) {
    if (S.phase !== 'round') return;
    if (how !== 'timeout' && since(S.readyAt) < CFG.guardMs) return;   // a double click on Next must not answer the new picture
    var sc = S.scene;
    var t = elapsed();
    if (how !== 'timeout' && t >= CFG.capSeconds) how = 'timeout';
    var seconds = how === 'timeout' ? CFG.capSeconds : t;
    S.phase = 'reveal';
    stopTimer();
    var box = null;
    var found = false;
    if (how === 'click') {
      var h = CFG.square / 2;
      box = [X - h, Y - h, X + h, Y + h];
      found = overlaps(box, sc.truth);
    }
    var res = { scene: sc, how: how, found: found, seconds: seconds, box: box, point: how === 'click' ? [X, Y] : null };
    S.game.results.push(res);
    showReveal(res);
  }

  function giveUp() { if (S.phase === 'round') finish('giveup'); }

  // answer at the placed square (a 2nd tap on it, Lock in, or Enter)
  function lockIn() {
    if (S.phase === 'round' && S.aim && (S.aimBy === 'touch' || S.aimBy === 'key')) finish('click', S.aim.X, S.aim.Y);
  }
  function updateLock() {
    el.lockIn.disabled = !(S.phase === 'round' && S.aim && S.aimBy === 'touch');
  }

  /* ---------- reveal ---------- */

  // [short verdict, the rest]; narrower screens show only the short part, so the bar keeps 1 height
  function verdictParts(res) {
    if (res.found) return ['Found it in ' + fmtS(res.seconds) + ' s', ''];
    if (res.how === 'timeout') return ['Time’s up.', ' Waldo was here.'];
    if (res.how === 'giveup') return ['Gave up.', ' Waldo was here.'];
    return ['Missed.', ' Waldo was here.'];
  }

  function showReveal(res) {
    var sc = res.scene;
    var g = S.game;
    var M = modelCount();
    var last = g.idx + 1 >= g.scenes.length;
    var k = S.models.filter(function (m) { return pickOf(sc, m).found; }).length;
    S.revealAt = performance.now();
    window.clearTimeout(S.tapTimer);
    S.tapTimer = 0;

    // top bar: verdict, then how many models found this one
    var vp = verdictParts(res);
    var kind = res.found ? 'found' : (res.how === 'giveup' ? 'gave' : 'miss');
    clearNode(el.verdict);
    el.verdict.className = 'verdict ' + kind;
    var mark = node('span', 'mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.appendChild(svgIcon(kind === 'found' ? 'M3.5 8.5l3 3 6-7' : kind === 'gave' ? 'M4.5 8h7' : 'M4.5 4.5l7 7M11.5 4.5l-7 7'));
    el.verdict.appendChild(mark);
    var vtext = node('span', 'vtext', vp[0]);
    if (vp[1]) vtext.appendChild(node('span', 'hide-md', vp[1]));
    el.verdict.appendChild(vtext);
    var vcount = node('span', 'vcount num', k + ' of ' + M);
    vcount.appendChild(node('span', 'hide-md', ' models'));
    vcount.appendChild(document.createTextNode(' found it'));
    el.verdict.appendChild(vcount);
    el.verdict.hidden = false;
    el.timer.hidden = true;
    el.refThumb.hidden = true;
    el.giveUp.hidden = true;
    el.lockIn.hidden = true;
    el.toWaldo.hidden = false;
    clearNode(el.next);
    if (last) {
      el.next.appendChild(node('span', 'hide-xs', 'See results'));
      el.next.appendChild(node('span', 'xs-only', 'Results'));
    } else {
      var lab = node('span', null, 'Next');   // 1 box, so the button's gap doesn't split the words
      lab.appendChild(node('span', 'hide-xs', ' picture'));
      el.next.appendChild(lab);
    }
    el.next.hidden = false;
    el.roundBar.classList.add('is-reveal');
    updatePips();

    // details under the picture
    var anyUnfinished = false;
    clearNode(el.modelTags);
    S.models.forEach(function (m) {
      var p = pickOf(sc, m);
      var unfinished = !p.missing && !p.complete;
      if (unfinished) anyUnfinished = true;
      var tag = node('span', 'tag ' + (p.found ? 'found' : 'miss'));
      var glyph = node('span', 'g', p.found ? '✓' : '✕');
      glyph.setAttribute('aria-hidden', 'true');
      tag.appendChild(glyph);
      tag.appendChild(document.createTextNode(m.short + (unfinished ? '*' : '') + ' · ' + fmtS(p.seconds) + ' s'));
      tag.appendChild(node('span', 'sr-only', p.found ? ', found' : ', missed'));
      tag.title = m.name + ': ' + (p.found ? 'found' : 'missed') + (unfinished ? ' (unfinished search)' : '') +
        (isNum(p.seconds) ? ', search took ' + fmtS(p.seconds) + ' s' : '');
      el.modelTags.appendChild(tag);
    });
    var modelsLine = 'Found by ' + k + ' of ' + M;
    el.modelsLine.textContent = modelsLine;
    el.unfinishedNote.hidden = !anyUnfinished;
    var cropFig = el.cropImg.parentNode;
    if (sc.waldoCrop) {
      el.cropImg.src = sc.waldoCrop;
      el.cropImg.alt = 'Close-up of Waldo in ' + sceneName(sc).toLowerCase();
      cropFig.hidden = false;
    } else {
      el.cropImg.removeAttribute('src');
      cropFig.hidden = true;
    }
    el.sceneId.textContent = sceneName(sc) + ' · ' + sc.width + ' × ' + sc.height + ' px · labeled Waldo ' +
      Math.round(sc.truth[2] - sc.truth[0]) + ' × ' + Math.round(sc.truth[3] - sc.truth[1]) + ' px';
    el.keysRound.hidden = true;
    el.details.hidden = false;

    // picture
    el.stage.classList.remove('round');
    el.stage.classList.add('reveal');
    buildOverlay(res);
    animateTo(revealView(res), 420);

    var vt = vp[0] + vp[1];
    announce(vt + (/\.$/.test(vt) ? ' ' : '. ') + modelsLine + '.');
    try { el.next.focus({ preventScroll: true }); } catch (e) { el.next.focus(); }
  }

  function nextPicture() {
    if (S.phase !== 'reveal') return;
    if (since(S.revealAt) < CFG.guardMs) return;   // a double click on the answer must not skip the result
    var g = S.game;
    if (g.idx + 1 < g.scenes.length) {
      g.idx++;
      startRound();
      focusStage();
    } else {
      showSummary();
    }
  }

  /* ---------- overlay: Waldo, your square, model tiles ---------- */

  function clearOverlay() {
    clearNode(el.marks);
    clearNode(el.labels);
    S.overlay = null;
    S.aimEls = null;
  }

  /* ---------- the answer square while playing: exactly the region that is scored ---------- */

  function makeAim() {
    var g = svgNode('g', 'aim');
    var halo = svgNode('rect', 'm-you-halo');
    var box = svgNode('rect', 'm-you');
    var dot = svgNode('circle', 'm-dot');
    dot.setAttribute('r', '2.5');
    g.appendChild(halo);
    g.appendChild(box);
    g.appendChild(dot);
    g.style.display = 'none';
    el.marks.appendChild(g);
    S.aimEls = { g: g, halo: halo, box: box, dot: dot };
  }

  function inScene(X, Y) { return X >= 0 && Y >= 0 && X <= S.scene.width && Y <= S.scene.height; }

  // the mouse square follows the cursor through pans and zooms
  function mouseAim() {
    var p = stagePoint(S.mouse.x, S.mouse.y);
    var X = (p.x - S.view.tx) / S.view.s;
    var Y = (p.y - S.view.ty) / S.view.s;
    S.aim = inScene(X, Y) ? { X: X, Y: Y } : null;
  }

  function drawAim() {
    var n = S.aimEls;
    if (!n) return;
    if (S.aimBy === 'mouse' && S.mouse) mouseAim();
    var a = S.aim;
    var show = !!a && S.phase === 'round' && !el.stage.classList.contains('dragging');
    n.g.style.display = show ? '' : 'none';
    if (!show) return;
    var v = S.view;
    var h = CFG.square / 2;
    var b = [(a.X - h) * v.s + v.tx, (a.Y - h) * v.s + v.ty, (a.X + h) * v.s + v.tx, (a.Y + h) * v.s + v.ty];
    setRect(n.halo, b);
    setRect(n.box, b);
    n.dot.setAttribute('cx', (a.X * v.s + v.tx).toFixed(1));
    n.dot.setAttribute('cy', (a.Y * v.s + v.ty).toFixed(1));
  }

  function setAim(X, Y, by) {
    S.aim = { X: clamp(X, 0, S.scene.width), Y: clamp(Y, 0, S.scene.height) };
    S.aimBy = by;
    drawAim();
    updateLock();
  }

  function wrapNames(names, maxChars) {
    var lines = [];
    var cur = '';
    names.forEach(function (nm) {
      var piece = cur ? cur + ', ' + nm : nm;
      if (cur && piece.length > maxChars) { lines.push(cur + ','); cur = nm; } else { cur = piece; }
    });
    if (cur) lines.push(cur);
    return lines.join('\n');
  }

  function rects(classes) {
    return classes.map(function (c) { var r = svgNode('rect', c); el.marks.appendChild(r); return r; });
  }

  function addLabel(text, cls) {
    var l = node('div', 'plabel' + (cls ? ' ' + cls : ''), text);
    el.labels.appendChild(l);
    return l;
  }

  // phones (narrow, or a short stage when turned sideways): no name labels on model tiles; the list under the picture names them
  function namesFit() {
    return !(window.matchMedia && window.matchMedia('(max-width: 640px)').matches) && S.stageH >= 360;
  }

  function buildOverlay(res) {
    clearOverlay();
    var sc = res.scene;
    var items = [];
    var named = namesFit();

    // model tiles, grouped when several models chose the same tile
    var groups = [];
    var byKey = {};
    S.models.forEach(function (m) {
      var p = pickOf(sc, m);
      if (!p.box) return;
      var key = p.box.join(',');
      if (!byKey[key]) { byKey[key] = { box: p.box, names: [] }; groups.push(byKey[key]); }
      // Each model's confidence in its chosen tile: P(yes) for one-request-per-tile models, the share of its vote for Jev.
      var c = p.confidence;
      var share = c == null ? '' : ' ' + (c >= 0.995 ? '>99%' : c < 0.01 ? '<1%' : Math.round(100 * c) + '%');
      byKey[key].names.push(m.short + share + (!p.complete ? '*' : ''));
    });
    groups.forEach(function (gp) {
      items.push({ kind: 'model', box: gp.box, rects: rects(['m-halo', 'm-model']), text: wrapNames(gp.names, 26), cls: '' });
    });

    // your square
    var you = null;
    if (res.box) {
      you = { kind: 'you', box: res.box, rects: rects(['m-you-halo', 'm-you']), text: 'You', cls: 'you' };
      var dot = svgNode('circle', 'm-dot');
      dot.setAttribute('r', '2.5');
      el.marks.appendChild(dot);
      you.dot = dot;
      you.point = res.point;
      items.push(you);
    }

    // the labeled Waldo, on top: ink edge, red stroke, white dashes = stripes
    var waldo = { kind: 'waldo', box: sc.truth, rects: rects(['m-w-ink', 'm-w-red', 'm-w-white']), text: 'Waldo', cls: 'waldo', pad: 3 };
    items.push(waldo);

    // label order: Waldo, You, then models top to bottom
    var order = [waldo];
    if (you) order.push(you);
    if (named) {
      items.filter(function (it) { return it.kind === 'model'; })
        .sort(function (a, b) { return a.box[1] - b.box[1] || a.box[0] - b.box[0]; })
        .forEach(function (it) { order.push(it); });
    }
    order.forEach(function (it) { it.label = addLabel(it.text, it.cls); });
    order.forEach(function (it) { it.lw = it.label.offsetWidth; it.lh = it.label.offsetHeight; });

    S.overlay = { items: items, order: order, waldo: waldo, res: res, named: named };
    layoutOverlay();
  }

  function setRect(r, b) {
    r.setAttribute('x', b[0].toFixed(1));
    r.setAttribute('y', b[1].toFixed(1));
    r.setAttribute('width', Math.max(0, b[2] - b[0]).toFixed(1));
    r.setAttribute('height', Math.max(0, b[3] - b[1]).toFixed(1));
  }

  function layoutOverlay() {
    var o = S.overlay;
    if (!o) return;
    var v = S.view;
    var W = S.stageW;
    var H = S.stageH;
    function scr(b, pad) {
      pad = pad || 0;
      return [b[0] * v.s + v.tx - pad, b[1] * v.s + v.ty - pad, b[2] * v.s + v.tx + pad, b[3] * v.s + v.ty + pad];
    }
    o.items.forEach(function (it) {
      it.scr = scr(it.box, it.pad);
      it.rects.forEach(function (r) { setRect(r, it.scr); });
      if (it.dot) {
        it.dot.setAttribute('cx', (it.point[0] * v.s + v.tx).toFixed(1));
        it.dot.setAttribute('cy', (it.point[1] * v.s + v.ty).toFixed(1));
      }
    });

    // place labels next to their boxes, avoiding each other and Waldo
    var w0 = o.waldo.scr;
    var placed = [];
    var waldoZone = [w0[0] - 3, w0[1] - 3, w0[2] + 3, w0[3] + 3];
    o.order.forEach(function (it) {
      var b = it.scr;
      var lab = it.label;
      var inView = b[2] > 0 && b[0] < W && b[3] > 0 && b[1] < H;
      if (!inView) { lab.style.display = 'none'; return; }
      lab.style.display = '';
      var w = it.lw;
      var h = it.lh;
      var gap = 3;
      var cands = [
        [b[0], b[1] - h - gap], [b[0], b[3] + gap], [b[2] - w, b[1] - h - gap], [b[2] - w, b[3] + gap],
        [b[2] + gap, b[1]], [b[0] - w - gap, b[1]], [b[0] + gap, b[1] + gap], [b[0] + gap, b[3] - h - gap]
      ];
      var best = null;
      var bestCost = Infinity;
      for (var i = 0; i < cands.length; i++) {
        var x = clamp(cands[i][0], 2, W - w - 2);
        var y = clamp(cands[i][1], 2, H - h - 2);
        var r = [x, y, x + w, y + h];
        var cost = (Math.abs(x - cands[i][0]) + Math.abs(y - cands[i][1])) * 2 + i * 0.01;
        for (var j = 0; j < placed.length; j++) cost += overlapArea(r, placed[j]);
        if (it.kind !== 'waldo') cost += overlapArea(r, waldoZone) * 4;
        if (cost < bestCost) { bestCost = cost; best = r; if (cost < 0.1) break; }
      }
      placed.push(best);
      lab.style.transform = 'translate(' + Math.round(best[0]) + 'px,' + Math.round(best[1]) + 'px)';
    });
  }

  /* ---------- view: zoom and pan ---------- */

  function sizeStage() {
    var sc = S.scene;
    if (!sc) return;
    var w = el.stage.clientWidth;
    var natural = w * sc.height / sc.width;
    // room from the stage's top (page coordinates) to the bottom of the window, leaving a peek of what follows
    var top = el.stage.getBoundingClientRect().top + (window.pageYOffset || 0);
    var avail = window.innerHeight - top - 56;
    // the most a window can show: bar right under the sticky header (landscape phones), see placeRound
    var room = window.innerHeight - headerH() - el.roundBar.offsetHeight - 8;
    var h;
    if (w < 640) h = Math.min(natural, room);                            // phones: the picture's own shape, no empty bands
    else h = Math.min(natural, Math.max(avail, Math.min(320, room)));    // desktop: full width unless the window is short
    h = Math.max(120, Math.round(h));
    el.stage.style.height = h + 'px';
    S.stageW = w;
    S.stageH = h;
    S.fit = Math.min(w / sc.width, h / sc.height);
  }

  function maxScale() { return Math.max(CFG.maxScale, S.fit * 4); }
  function clampScale(s) { return clamp(s, S.fit, maxScale()); }

  function clampView(v) {
    var sc = S.scene;
    v.s = clampScale(v.s);
    var sw = sc.width * v.s;
    var sh = sc.height * v.s;
    v.tx = sw <= S.stageW ? (S.stageW - sw) / 2 : clamp(v.tx, S.stageW - sw, 0);
    v.ty = sh <= S.stageH ? (S.stageH - sh) / 2 : clamp(v.ty, S.stageH - sh, 0);
    return v;
  }

  function fitView() { return clampView({ s: S.fit, tx: 0, ty: 0 }); }

  function applyView() {
    var v = S.view;
    if (S.img && S.scene) {
      // size by layout (not a scale transform) so the browser always draws from the full-resolution source
      S.img.style.width = (S.scene.width * v.s).toFixed(2) + 'px';
      S.img.style.height = (S.scene.height * v.s).toFixed(2) + 'px';
      S.img.style.transform = 'translate(' + v.tx.toFixed(2) + 'px,' + v.ty.toFixed(2) + 'px)';
    }
    var rel = v.s / S.fit;
    el.zoomLevel.textContent = (rel < 9.95 ? rel.toFixed(1) : Math.round(rel)) + '×';
    el.zoomOut.setAttribute('aria-disabled', v.s <= S.fit * 1.001 ? 'true' : 'false');
    el.zoomIn.setAttribute('aria-disabled', v.s >= maxScale() * 0.999 ? 'true' : 'false');
    layoutOverlay();
    drawAim();
  }

  function stopAnim() {
    if (S.anim) window.cancelAnimationFrame(S.anim);
    S.anim = 0;
    S.animTo = null;
  }

  function animateTo(target, ms) {
    stopAnim();
    if (reduceMotion || !ms) { S.view = target; applyView(); return; }
    var from = { s: S.view.s, tx: S.view.tx, ty: S.view.ty };
    var t0 = performance.now();
    S.animTo = target;
    function step(now) {
      var k = Math.min(1, (now - t0) / ms);
      var e = 1 - Math.pow(1 - k, 3);
      S.view = clampView({
        s: from.s + (target.s - from.s) * e,
        tx: from.tx + (target.tx - from.tx) * e,
        ty: from.ty + (target.ty - from.ty) * e
      });
      applyView();
      if (k < 1) S.anim = window.requestAnimationFrame(step);
      else { S.anim = 0; S.animTo = null; }
    }
    S.anim = window.requestAnimationFrame(step);
  }

  function canView() { return S.screen === 'round' && (S.phase === 'round' || S.phase === 'reveal'); }

  // px, py relative to the stage; animate for buttons and keys, not for wheel and pinch
  function zoomBy(factor, px, py, animate) {
    if (!canView()) return;
    if (px == null) { px = S.stageW / 2; py = S.stageH / 2; }
    var base = animate && S.animTo ? S.animTo : S.view;
    var ns = clampScale(base.s * factor);
    var X = (px - base.tx) / base.s;
    var Y = (py - base.ty) / base.s;
    var target = clampView({ s: ns, tx: px - X * ns, ty: py - Y * ns });
    if (animate) animateTo(target, 200);
    else { stopAnim(); S.view = target; applyView(); }
  }

  function panBy(dx, dy) {
    if (!canView()) return;
    stopAnim();
    S.view = clampView({ s: S.view.s, tx: S.view.tx + dx, ty: S.view.ty + dy });
    applyView();
  }

  function frameBoxes(boxes, pad, maxRel) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    boxes.forEach(function (b) {
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    });
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    var s = clampScale(Math.min(S.stageW / (x1 - x0), S.stageH / (y1 - y0), S.fit * maxRel));
    var cx = (x0 + x1) / 2;
    var cy = (y0 + y1) / 2;
    return clampView({ s: s, tx: S.stageW / 2 - cx * s, ty: S.stageH / 2 - cy * s });
  }

  function revealView(res) {
    var sc = res.scene;
    var boxes = [sc.truth];
    if (res.box) boxes.push(res.box);
    if (S.stageW >= 640) {
      // wide screens: show every mark at once, zooming in only when they sit close together
      S.models.forEach(function (m) { var p = pickOf(sc, m); if (p.box) boxes.push(p.box); });
      return frameBoxes(boxes, 48, 3);
    }
    // phones: frame Waldo and your answer; Fit shows the rest
    return frameBoxes(boxes, 110, 3);
  }

  function zoomToWaldo() {
    if (S.phase !== 'reveal') return;
    animateTo(frameBoxes([S.scene.truth], 90, 99), 380);
  }

  function onResize() {
    if (S.screen !== 'round' || !S.scene) return;
    var v = S.view;
    var oldW = S.stageW;
    var oldH = S.stageH;
    var oldFit = S.fit;
    var w = el.stage.clientWidth;
    if (!w) return;
    var cx = (oldW / 2 - v.tx) / v.s;
    var cy = (oldH / 2 - v.ty) / v.s;
    var rel = v.s / oldFit;
    sizeStage();
    // turning a phone can change whether model tiles get their names
    if (S.overlay && S.overlay.named !== namesFit()) buildOverlay(S.overlay.res);
    if (S.stageW === oldW && S.stageH === oldH) { applyView(); return; }
    stopAnim();
    var s = clampScale(S.fit * rel);
    S.view = clampView({ s: s, tx: S.stageW / 2 - cx * s, ty: S.stageH / 2 - cy * s });
    applyView();
    if (S.phase === 'round' && el.stage.getBoundingClientRect().bottom > window.innerHeight) placeRound();
  }

  /* ---------- pointer input: drag to pan, pinch to zoom; mouse: click answers; touch: tap places the square, a tap on it answers ---------- */

  var pointers = new Map();
  var gesture = null;     // { type: 'pan', id, x, y } | { type: 'pinch', d0, s0, sx, sy }
  var clickCand = null;   // { id, type, x0, y0, view, ok, phase, token }

  function stagePoint(cx, cy) {
    var r = el.stage.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  }
  function twoPointers() {
    var it = pointers.values();
    return [it.next().value, it.next().value];
  }
  function beginPinch() {
    var ab = twoPointers();
    var a = stagePoint(ab[0].x, ab[0].y);
    var b = stagePoint(ab[1].x, ab[1].y);
    var mx = (a.x + b.x) / 2;
    var my = (a.y + b.y) / 2;
    stopAnim();
    gesture = {
      type: 'pinch',
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      s0: S.view.s,
      sx: (mx - S.view.tx) / S.view.s,
      sy: (my - S.view.ty) / S.view.s
    };
  }

  el.stage.addEventListener('pointerdown', function (e) {
    if (!canView() && S.phase !== 'loading') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    S.keyNav = false;
    if (e.isPrimary) pointers.clear();
    try { el.stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      stopAnim();
      clickCand = {
        id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, ok: true, phase: S.phase, token: S.token,
        view: { s: S.view.s, tx: S.view.tx, ty: S.view.ty }
      };
      gesture = { type: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY };
    } else {
      clickCand = null;
      if (pointers.size === 2) beginPinch();
    }
  });

  el.stage.addEventListener('pointermove', function (e) {
    // the square follows the mouse; only real moves count (browsers also send one when the page changes under a still mouse)
    if (e.pointerType === 'mouse' && (!S.mouse || S.mouse.x !== e.clientX || S.mouse.y !== e.clientY)) {
      S.mouse = { x: e.clientX, y: e.clientY };
      if (S.phase === 'round') { S.aimBy = 'mouse'; drawAim(); updateLock(); }
    }
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    if (gesture.type === 'pan' && gesture.id === e.pointerId) {
      if (clickCand && clickCand.id === e.pointerId &&
          Math.hypot(e.clientX - clickCand.x0, e.clientY - clickCand.y0) >= CFG.clickSlop) {
        clickCand.ok = false;
        el.stage.classList.add('dragging');   // hides the square while panning
      }
      var dx = e.clientX - gesture.x;
      var dy = e.clientY - gesture.y;
      gesture.x = e.clientX;
      gesture.y = e.clientY;
      if (canView()) panBy(dx, dy);
    } else if (gesture.type === 'pinch' && pointers.size >= 2) {
      if (!canView()) return;
      var ab = twoPointers();
      var a = stagePoint(ab[0].x, ab[0].y);
      var b = stagePoint(ab[1].x, ab[1].y);
      var mx = (a.x + b.x) / 2;
      var my = (a.y + b.y) / 2;
      var ns = clampScale(gesture.s0 * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0);
      S.view = clampView({ s: ns, tx: mx - gesture.sx * ns, ty: my - gesture.sy * ns });
      applyView();
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    var c = clickCand;
    if (c && c.id === e.pointerId) {
      clickCand = null;
      if (e.type === 'pointerup' && c.ok && c.token === S.token && pointers.size === 0) {
        if (c.type === 'mouse') clickAt(c); else tapAt(c);
      }
    }
    if (pointers.size === 1) {
      // pinch ended with one finger still down: keep panning with it, never treat it as a click
      var rest = pointers.entries().next().value;
      gesture = { type: 'pan', id: rest[0], x: rest[1].x, y: rest[1].y };
    } else if (pointers.size === 2) {
      beginPinch();
    } else if (pointers.size === 0) {
      gesture = null;
      el.stage.classList.remove('dragging');
      drawAim();
    }
  }
  el.stage.addEventListener('pointerup', endPointer);
  el.stage.addEventListener('pointercancel', endPointer);
  el.stage.addEventListener('lostpointercapture', endPointer);
  el.stage.addEventListener('pointerleave', function (e) {
    if (e.pointerType !== 'mouse') return;
    S.mouse = null;
    if (S.aimBy === 'mouse') { S.aim = null; S.aimBy = ''; drawAim(); }
  });

  // where a click or tap landed: stage px, and scene px in the view it started in
  function downPoint(c) {
    var r = el.stage.getBoundingClientRect();
    var x = c.x0 - r.left;
    var y = c.y0 - r.top;
    return { x: x, y: y, X: (x - c.view.tx) / c.view.s, Y: (y - c.view.ty) / c.view.s };
  }

  // mouse: the click answers right where the square was drawn
  function clickAt(c) {
    var p = downPoint(c);
    if (c.phase === 'round' && S.phase === 'round' && inScene(p.X, p.Y)) finish('click', p.X, p.Y);
  }

  // touch: a tap places the square, a tap on it answers, a double tap zooms in
  function tapAt(c) {
    var p = downPoint(c);
    var now = performance.now();
    var prev = S.lastTap;
    S.lastTap = { t: now, x: p.x, y: p.y };
    if (prev && now - prev.t < CFG.doubleTapMs && Math.hypot(p.x - prev.x, p.y - prev.y) < 40) {
      window.clearTimeout(S.tapTimer);
      S.tapTimer = 0;
      S.lastTap = null;
      zoomBy(CFG.tapZoom, p.x, p.y, true);
      return;
    }
    if (c.phase !== 'round' || S.phase !== 'round' || !inScene(p.X, p.Y)) return;
    var a = S.aim;
    var reach = Math.max(CFG.square / 2, 22 / c.view.s);   // small squares still get a 44 px target
    if (a && S.aimBy === 'touch' && Math.abs(p.X - a.X) <= reach && Math.abs(p.Y - a.Y) <= reach) {
      // answer a moment later: a 2nd tap in that time is a double tap (zoom), not an answer
      S.tapTimer = window.setTimeout(function () { S.tapTimer = 0; lockIn(); }, CFG.doubleTapMs);
      return;
    }
    setAim(p.X, p.Y, 'touch');
  }

  el.stage.addEventListener('wheel', function (e) {
    if (S.screen !== 'round') return;
    if (S.phase === 'reveal' && !e.ctrlKey) return;   // after an answer the wheel scrolls to the results; ctrl+wheel and pinch still zoom
    e.preventDefault();
    if (!canView()) return;
    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= S.stageH;
    var factor = clamp(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), 0.5, 2);
    var p = stagePoint(e.clientX, e.clientY);
    zoomBy(factor, p.x, p.y, false);
  }, { passive: false });

  // Safari trackpad pinch (touch pinches go through pointer events instead)
  var gestureScale = 1;
  el.stage.addEventListener('gesturestart', function (e) { e.preventDefault(); gestureScale = 1; });
  el.stage.addEventListener('gesturechange', function (e) {
    e.preventDefault();
    if (pointers.size > 1 || !isNum(e.scale) || e.scale <= 0) return;
    var p = isNum(e.clientX) ? stagePoint(e.clientX, e.clientY) : { x: S.stageW / 2, y: S.stageH / 2 };
    zoomBy(e.scale / gestureScale, p.x, p.y, false);
    gestureScale = e.scale;
  });
  el.stage.addEventListener('gestureend', function (e) { e.preventDefault(); });

  /* ---------- keyboard ---------- */

  // The keyboard square starts where the mouse square was, or mid-view. Enter answers only once it is shown.
  function armKeys() {
    if (S.phase !== 'round' || S.aimBy === 'key') return;
    var v = S.view;
    var a = S.aim;
    var x = a ? a.X * v.s + v.tx : -1;
    var y = a ? a.Y * v.s + v.ty : -1;
    if (a && x >= 0 && x <= S.stageW && y >= 0 && y <= S.stageH) setAim(a.X, a.Y, 'key');
    else setAim((S.stageW / 2 - v.tx) / v.s, (S.stageH / 2 - v.ty) / v.s, 'key');
  }

  // Arrow keys look around (dx, dy in screen px): the view pans, and where it can't pan further
  // the square itself moves, so Waldos at the edges are reachable.
  function nudge(dx, dy) {
    if (!canView()) return;
    if (S.phase !== 'round') { panBy(-dx, -dy); return; }
    stopAnim();
    armKeys();
    var v = S.view;
    var c = { x: S.stageW / 2, y: S.stageH / 2 };
    var p = { x: S.aim.X * v.s + v.tx, y: S.aim.Y * v.s + v.ty };
    if (p.x < 0 || p.x > S.stageW || p.y < 0 || p.y > S.stageH) p = { x: c.x, y: c.y };   // lost off screen: back to the middle
    var d = { x: dx, y: dy };
    ['x', 'y'].forEach(function (k) {
      // a square off to one side first comes back to the middle
      var back = c[k] - p[k];
      if (d[k] * back > 0) {
        var m = Math.abs(back) < Math.abs(d[k]) ? back : d[k];
        p[k] += m;
        d[k] -= m;
      }
    });
    var nv = clampView({ s: v.s, tx: v.tx - d.x, ty: v.ty - d.y });
    p.x += d.x - (v.tx - nv.tx);   // the part the view could not pan moves the square
    p.y += d.y - (v.ty - nv.ty);
    S.view = nv;
    setAim((p.x - nv.tx) / nv.s, (p.y - nv.ty) / nv.s, 'key');
    applyView();
  }

  // + and - zoom around the keyboard square while there is one
  function keyZoom(factor) {
    if (S.phase === 'round') armKeys();
    var b = S.animTo || S.view;
    var a = S.aimBy === 'key' && S.aim ? S.aim : null;
    zoomBy(factor, a ? a.X * b.s + b.tx : null, a ? a.Y * b.s + b.ty : null, true);
  }

  document.addEventListener('keydown', function (e) {
    S.keyNav = e.key === 'Tab';
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave browser shortcuts alone
    var t = e.target;
    var interactive = !!(t && t.closest && t.closest('button, a, input, select, textarea, [contenteditable="true"]'));
    var key = e.key;

    if (S.screen === 'start') {
      // Enter starts from anywhere on the start screen, mode buttons included (links in the header still work)
      if (key === 'Enter' && (!interactive || el.start.contains(t)) && !e.repeat && S.data && S.scenes.length) {
        e.preventDefault();
        startGame(S.mode);
      }
      return;
    }
    if (S.screen !== 'round') return;

    switch (key) {
      case '+': case '=': case 'Add':
        e.preventDefault(); keyZoom(CFG.zoomStep); return;
      case '-': case '_': case 'Subtract':
        e.preventDefault(); keyZoom(1 / CFG.zoomStep); return;
      case '0':
        e.preventDefault();
        if (canView()) { if (S.phase === 'round') armKeys(); animateTo(fitView(), 260); }
        return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
        // only when focus is on the picture or its controls; elsewhere arrows scroll the page as usual
        if (t !== el.stage && t !== document.body && !el.roundBar.contains(t)) return;
        e.preventDefault();
        if (key === 'ArrowLeft') nudge(-CFG.panStep, 0);
        else if (key === 'ArrowRight') nudge(CFG.panStep, 0);
        else if (key === 'ArrowUp') nudge(0, -CFG.panStep);
        else nudge(0, CFG.panStep);
        return;
      case 'g': case 'G':
        if (S.phase === 'round' && !e.repeat) { e.preventDefault(); giveUp(); }
        return;
      case 'w': case 'W':
        if (S.phase === 'reveal' && !e.repeat) { e.preventDefault(); zoomToWaldo(); }
        return;
      case 'Enter': case ' ': case 'Spacebar':
        if (e.repeat) { if (!interactive) e.preventDefault(); return; }
        if (S.phase === 'reveal' && !interactive) { e.preventDefault(); nextPicture(); return; }
        if (S.phase === 'round' && t === el.stage) {
          e.preventDefault();               // Space never scrolls the page away from the picture
          if (key !== 'Enter') return;
          // a fresh picture's 1st Enter only shows the square, so a double Enter on Next can't answer blind
          if (S.aimBy === 'key' || S.aimBy === 'touch') lockIn(); else armKeys();
        }
        return;
    }
  });

  // Tabbing to the picture shows the keyboard square
  el.stage.addEventListener('focus', function () { if (S.keyNav) armKeys(); });

  /* ---------- summary ---------- */

  function showSummary() {
    var g = S.game;
    S.phase = 'done';
    stopTimer();
    stopAnim();
    clearOverlay();
    var n = g.results.length;
    var M = modelCount();
    var youHits = g.results.map(function (r) { return r.found; });
    var youFound = youHits.filter(Boolean).length;
    // your time to find Waldo: only the scenes you found (null if none)
    var youMed = median(g.results.filter(function (r) { return r.found; }).map(function (r) { return r.seconds; }));

    var rows = [{ you: true, name: 'You', maker: 'Human', found: youFound, hits: youHits, med: youMed, rate: null, order: -1 }];
    S.models.forEach(function (m, i) {
      var hits = [];
      var secs = [];
      g.results.forEach(function (r) {
        var p = pickOf(r.scene, m);
        hits.push(p.found);
        if (isNum(p.seconds)) secs.push(p.seconds);
      });
      rows.push({ you: false, name: m.name, maker: m.maker, found: hits.filter(Boolean).length, hits: hits, med: median(secs), rate: m.found_rate, order: i });
    });
    rows.sort(function (a, b) {
      if (b.found !== a.found) return b.found - a.found;
      var am = isNum(a.med) ? a.med : Infinity;
      var bm = isNum(b.med) ? b.med : Infinity;
      if (am !== bm) return am - bm;
      return a.order - b.order;
    });
    rows.forEach(function (r, i) { r.rank = i && rows[i - 1].found === r.found ? rows[i - 1].rank : i + 1; });
    var youRow = rows.filter(function (r) { return r.you; })[0];
    var tiedWith = rows.filter(function (r) { return !r.you && r.found === youRow.found; });

    el.sumKicker.textContent = 'The human division · ' + modeName(g.mode);
    el.sumTitle.textContent = 'You found ' + youFound + ' of ' + n + '.';
    var lede = 'Rank: ' + ordinal(youRow.rank) + ' of ' + rows.length;
    if (tiedWith.length === 1) lede += ', tied with ' + tiedWith[0].name;
    else if (tiedWith.length > 1 && tiedWith.length <= 3) lede += ', tied with ' + tiedWith.slice(0, -1).map(function (r) { return r.name; }).join(', ') + ' and ' + tiedWith[tiedWith.length - 1].name;
    else if (tiedWith.length > 3) lede += ', tied with ' + tiedWith.length + ' models';
    lede += '.';
    if (isNum(youMed)) lede += ' Median time to find Waldo: ' + fmtS(youMed) + ' s.';
    el.sumLede.textContent = lede;

    // table
    clearNode(el.sumBody);
    var youTr = null;
    rows.forEach(function (r) {
      var tr = node('tr', r.you ? 'you' : '');
      if (r.you) youTr = tr;
      tr.appendChild(node('td', 'rk num', String(r.rank)));
      var who = node('td', 'l');
      who.appendChild(node('span', 'who', r.name));
      if (r.maker) {
        who.appendChild(document.createTextNode(' '));
        who.appendChild(node('span', 'maker', r.maker));
      }
      tr.appendChild(who);
      var fc = node('td', 'fc num');
      fc.appendChild(node('b', null, String(r.found)));
      fc.appendChild(node('span', 'of', ' / ' + n));
      // 1 cell per picture, in play order (same as the pips): green found, red missed
      var meter = node('span', 'meter');
      meter.setAttribute('aria-hidden', 'true');
      r.hits.forEach(function (hit) { meter.appendChild(node('i', hit ? 'found' : 'miss')); });
      fc.appendChild(meter);
      tr.appendChild(fc);
      tr.appendChild(node('td', 'num', isNum(r.med) ? fmtS(r.med) + ' s' : '–'));
      tr.appendChild(node('td', 'num all hide-sm', isNum(r.rate) ? Math.round(r.rate * 100) + '%' : '–'));
      el.sumBody.appendChild(tr);
    });

    // note on timing
    var note = 'Model time: per scene, counting only successful requests (1 request per tile, 16 at a time; whole-scene methods: 1 request). ';
    note += 'Your time: from when the scene appears to your answer, max ' + CFG.capSeconds + ' s. The 2 times are not directly comparable. ';
    note += '“All scenes”: found rate on all ' + S.scenes.length + ' scenes.';
    el.sumNote.textContent = note;

    // best per mode
    var rec = { found: youFound, n: n, medianSeconds: isNum(youMed) ? Math.round(youMed * 100) / 100 : null, at: new Date().toISOString() };
    var saved = saveBest(g.mode, rec);
    clearNode(el.sumBest);
    if (!saved.stored) {
      el.sumBest.hidden = true;
    } else if (saved.better) {
      // a first round, or a round with nothing found, is no "new best"
      if (saved.prev && youFound > 0) {
        el.sumBest.appendChild(node('b', null, 'New best on ' + modeName(g.mode) + '.'));
        el.sumBest.appendChild(document.createTextNode(' Previous best: ' + bestText(saved.prev) + '.'));
      }
      el.sumBest.hidden = !el.sumBest.firstChild;
    } else if (saved.best) {
      el.sumBest.appendChild(document.createTextNode('Your best on ' + modeName(g.mode) + ': '));
      el.sumBest.appendChild(node('b', null, bestText(saved.best)));
      el.sumBest.appendChild(document.createTextNode('.'));
      el.sumBest.hidden = false;
    } else {
      el.sumBest.hidden = true;
    }
    renderStartBest();

    // your pictures
    clearNode(el.sumGrid);
    g.results.forEach(function (r) {
      var sc = r.scene;
      var fig = node('figure', 'scene-tile sum-tile');
      var im = node('img');
      im.src = sc.thumb || sc.image;
      im.alt = sceneName(sc);
      im.loading = 'lazy';
      fig.appendChild(im);
      var cap = node('figcaption');
      var line = node('div', 'cap');
      line.appendChild(node('span', 'id', sceneName(sc)));
      var label = r.found ? 'Found ' + fmtS(r.seconds) + ' s' : (r.how === 'timeout' ? 'Time’s up' : (r.how === 'giveup' ? 'Gave up' : 'Missed'));
      line.appendChild(node('span', 'tag ' + (r.found ? 'found' : 'miss'), label));
      cap.appendChild(line);
      cap.appendChild(node('div', 'sub', 'Found by ' + foundBy(sc) + ' of ' + M));
      fig.appendChild(cap);
      el.sumGrid.appendChild(fig);
    });

    var other = g.mode === 'hard' ? 'normal' : 'hard';
    el.switchBtn.textContent = 'Play ' + modeName(other);
    el.switchBtn.hidden = other === 'hard' && !S.hardPool.length;

    showScreen('summary');
    jumpTo(0);
    // short windows: scroll just enough to show your row
    var below = youTr.getBoundingClientRect().bottom - window.innerHeight + 16;
    if (below > 0) jumpTo(below);
    try { el.sumTitle.focus({ preventScroll: true }); } catch (e) { el.sumTitle.focus(); }
    announce('You found ' + youFound + ' of ' + n + '.' + (isNum(youMed) ? ' Median ' + fmtS(youMed) + ' seconds to find Waldo.' : ''));
  }

  /* ---------- wiring ---------- */

  el.modeSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (b && !b.disabled) setMode(b.getAttribute('data-mode'));
  });
  el.startBtn.addEventListener('click', function () { startGame(S.mode); });
  el.zoomIn.addEventListener('click', function () { zoomBy(CFG.zoomStep, null, null, true); });
  el.zoomOut.addEventListener('click', function () { zoomBy(1 / CFG.zoomStep, null, null, true); });
  el.zoomFit.addEventListener('click', function () { if (canView()) animateTo(fitView(), 260); });
  el.giveUp.addEventListener('click', giveUp);
  el.lockIn.addEventListener('click', lockIn);
  el.toWaldo.addEventListener('click', zoomToWaldo);
  el.next.addEventListener('click', nextPicture);
  el.again.addEventListener('click', function () { startGame(S.game ? S.game.mode : S.mode); });
  el.switchBtn.addEventListener('click', function () {
    startGame(S.game && S.game.mode === 'hard' ? 'normal' : 'hard');
  });

  var resizeQueued = false;
  function queueResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    window.requestAnimationFrame(function () { resizeQueued = false; onResize(); });
  }
  if (window.ResizeObserver) new ResizeObserver(queueResize).observe(el.stage);
  window.addEventListener('resize', queueResize);

  function renderCredit(data) {
    var a = data.attribution || {};
    var ds = data.dataset || {};
    clearNode(el.credit);
    var bits = [];
    if (ds.name) bits.push('Scenes: ' + ds.name + '.');
    if (a.illustrations) bits.push('Illustrations: ' + a.illustrations + '.');
    if (!bits.length) return;
    el.credit.appendChild(document.createTextNode(bits.join(' ') + ' '));
    if (a.doi && /^https:\/\//.test(a.doi)) {
      var link = node('a', null, 'Paper');
      link.href = a.doi;
      link.rel = 'noopener';
      el.credit.appendChild(link);
      el.credit.appendChild(document.createTextNode('.'));
    }
  }

  function init(data) {
    S.data = data;
    S.models = (Array.isArray(data.models) ? data.models : [])
      .filter(function (m) { return m && m.model; })
      .slice()
      .sort(function (a, b) { return (isNum(a.rank) ? a.rank : 99) - (isNum(b.rank) ? b.rank : 99); });
    S.models.forEach(function (m) { m.short = m.short || m.name || m.model; m.name = m.name || m.short; m.maker = m.maker || ''; });
    S.scenes = (Array.isArray(data.scenes) ? data.scenes : []).filter(function (s) {
      return s && s.image && isBox(s.truth) && isNum(s.width) && isNum(s.height) && s.width > 0 && s.height > 0;
    });
    S.hardPool = S.scenes.filter(function (s) { return foundBy(s) <= hardMax(); });
    el.thAll.textContent = 'All ' + S.scenes.length + ' scenes';
    renderCredit(data);
    initStart();
  }

  fetch('data/bench.json')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(init)
    .catch(function () {
      el.startBtn.textContent = 'Start';
      el.startBtn.disabled = true;
      el.loadError.textContent = 'Could not load data/bench.json. Open this page through the local results server, not straight from the file system.';
      el.loadError.hidden = false;
    });
})();
