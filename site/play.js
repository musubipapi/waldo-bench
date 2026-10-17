/* Waldo Bench · Play: you vs. the models.
   Vanilla JS. Reads data/bench.json and local images only. Data-derived strings go through textContent. */
(function () {
  'use strict';

  var CFG = {
    pictures: 10,       // pictures per game
    hardMaxFound: 5,    // Hard: scenes found by at most this many models
    capSeconds: 90,     // per-picture clock cap, then it is a miss
    square: 128,        // answer square, scene pixels (same as a model tile)
    clickSlop: 6,       // pointer travel (px) below which down/up counts as a click
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
    roundTitle: $('round-title'), roundBar: $('round-bar'), progText: $('prog-text'), pips: $('pips'),
    timer: $('timer'), timerVal: $('timer-val'), verdict: $('verdict'),
    zoomOut: $('zoom-out'), zoomIn: $('zoom-in'), zoomFit: $('zoom-fit'), zoomLevel: $('zoom-level'),
    giveUp: $('give-up'), toWaldo: $('to-waldo'), next: $('next'),
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
    view: { s: 1, tx: 0, ty: 0 },
    fit: 1,
    stageW: 0,
    stageH: 0,
    anim: 0,
    animTo: null,
    overlay: null
  };

  /* ---------- small helpers ---------- */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmtS(v) { return isNum(v) ? v.toFixed(1) : '—'; }
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
    var M = modelCount();
    var pool = poolFor(mode);
    var n = Math.min(CFG.pictures, pool.length);
    if (mode === 'hard') {
      el.modeDesc.textContent = n < CFG.pictures
        ? 'All ' + pool.length + ' scenes that ' + CFG.hardMaxFound + ' or fewer of the ' + M + ' models found, in random order.'
        : n + ' random scenes from the ' + pool.length + ' that ' + CFG.hardMaxFound + ' or fewer of the ' + M + ' models found.';
    } else {
      el.modeDesc.textContent = n + ' random scenes from all ' + pool.length + '.';
    }
  }

  function initStart() {
    var M = modelCount();
    el.countNormal.textContent = '· ' + S.scenes.length + ' scenes';
    el.countHard.textContent = '· ' + S.hardPool.length + ' found by ≤ ' + CFG.hardMaxFound + ' of ' + M;
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
    window.scrollTo(0, 0);
    startRound();
    focusStage();
  }

  function focusStage() {
    try { el.stage.focus({ preventScroll: true }); } catch (e) { el.stage.focus(); }
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

    el.progText.textContent = (g.idx + 1) + ' / ' + n;
    el.roundTitle.textContent = 'Picture ' + (g.idx + 1) + ' of ' + n;
    el.timerVal.textContent = '0.0';
    el.timer.classList.remove('late');
    el.timer.hidden = false;
    el.verdict.hidden = true;
    el.giveUp.hidden = false;
    el.toWaldo.hidden = true;
    el.next.hidden = true;
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
      startTimer();
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
    S.tick = window.setInterval(tickTimer, 100);
    tickTimer();
  }
  function stopTimer() {
    if (S.tick) window.clearInterval(S.tick);
    S.tick = 0;
  }
  function elapsed() { return (performance.now() - S.t0) / 1000; }
  function tickTimer() {
    if (S.phase !== 'round') return;
    var t = elapsed();
    if (t >= CFG.capSeconds) { finish('timeout'); return; }
    el.timerVal.textContent = (Math.floor(t * 10) / 10).toFixed(1);
    el.timer.classList.toggle('late', t >= CFG.capSeconds - 10);
  }

  // how: 'click' | 'giveup' | 'timeout'
  function finish(how, X, Y) {
    if (S.phase !== 'round') return;
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

  /* ---------- reveal ---------- */

  function verdictText(res) {
    if (res.found) return 'Found it in ' + fmtS(res.seconds) + ' s';
    if (res.how === 'timeout') return 'Time’s up. Waldo was here.';
    return 'Missed. Waldo was here.';
  }

  function showReveal(res) {
    var sc = res.scene;
    var g = S.game;
    var M = modelCount();
    var last = g.idx + 1 >= g.scenes.length;

    // top bar
    clearNode(el.verdict);
    el.verdict.className = 'verdict ' + (res.found ? 'found' : 'miss');
    var mark = node('span', 'mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.appendChild(svgIcon(res.found ? 'M3.5 8.5l3 3 6-7' : 'M4.5 4.5l7 7M11.5 4.5l-7 7'));
    el.verdict.appendChild(mark);
    el.verdict.appendChild(node('span', null, verdictText(res)));
    el.verdict.hidden = false;
    el.timer.hidden = true;
    el.giveUp.hidden = true;
    el.toWaldo.hidden = false;
    el.next.textContent = last ? 'See results' : 'Next picture';
    el.next.hidden = false;
    updatePips();

    // details under the picture
    var k = 0;
    var anyUnfinished = false;
    clearNode(el.modelTags);
    S.models.forEach(function (m) {
      var p = pickOf(sc, m);
      if (p.found) k++;
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
    var modelsLine = 'Found by ' + k + ' of ' + M + ' models';
    el.modelsLine.textContent = modelsLine;
    el.unfinishedNote.hidden = !anyUnfinished;
    var cropFig = el.cropImg.parentNode;
    if (sc.waldoCrop) {
      el.cropImg.src = sc.waldoCrop;
      el.cropImg.alt = 'Close-up of Waldo in scene ' + sc.id;
      cropFig.hidden = false;
    } else {
      el.cropImg.removeAttribute('src');
      cropFig.hidden = true;
    }
    el.sceneId.textContent = 'Scene ' + sc.id + ' · ' + sc.width + ' × ' + sc.height + ' px · labeled Waldo ' +
      Math.round(sc.truth[2] - sc.truth[0]) + ' × ' + Math.round(sc.truth[3] - sc.truth[1]) + ' px';
    el.keysRound.hidden = true;
    el.details.hidden = false;

    // picture
    el.stage.classList.remove('round');
    el.stage.classList.add('reveal');
    buildOverlay(res);
    animateTo(revealView(res), 420);

    var vt = verdictText(res);
    announce(vt + (/\.$/.test(vt) ? ' ' : '. ') + modelsLine + '.');
    try { el.next.focus({ preventScroll: true }); } catch (e) { el.next.focus(); }
  }

  function nextPicture() {
    if (S.phase !== 'reveal') return;
    var g = S.game;
    if (g.idx + 1 < g.scenes.length) {
      g.idx++;
      var hdr = document.querySelector('.top');
      if (el.roundBar.getBoundingClientRect().top < (hdr ? hdr.offsetHeight : 0)) window.scrollTo(0, 0);
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

  function buildOverlay(res) {
    clearOverlay();
    var sc = res.scene;
    var items = [];

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
    items.filter(function (it) { return it.kind === 'model'; })
      .sort(function (a, b) { return a.box[1] - b.box[1] || a.box[0] - b.box[0]; })
      .forEach(function (it) { order.push(it); });
    order.forEach(function (it) { it.label = addLabel(it.text, it.cls); });
    order.forEach(function (it) { it.lw = it.label.offsetWidth; it.lh = it.label.offsetHeight; });

    S.overlay = { items: items, order: order, waldo: waldo };
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
    var avail = window.innerHeight - top - (w < 640 ? 24 : 56);
    var h;
    if (w < 640) h = Math.max(natural, Math.min(avail, w));   // phones: a little taller, room to pan when zoomed
    else h = Math.min(natural, Math.max(avail, 320));         // desktop: full width unless the window is short
    h = Math.round(h);
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
    if (S.stageW === oldW && S.stageH === oldH) { applyView(); return; }
    stopAnim();
    var s = clampScale(S.fit * rel);
    S.view = clampView({ s: s, tx: S.stageW / 2 - cx * s, ty: S.stageH / 2 - cy * s });
    applyView();
  }

  /* ---------- pointer input: drag to pan, pinch to zoom, click to answer ---------- */

  var pointers = new Map();
  var gesture = null;     // { type: 'pan', id, x, y } | { type: 'pinch', d0, s0, sx, sy }
  var clickCand = null;   // { id, x0, y0, view, ok }

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
    if (e.isPrimary) pointers.clear();
    try { el.stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      stopAnim();
      clickCand = {
        id: e.pointerId, x0: e.clientX, y0: e.clientY, ok: S.phase === 'round', token: S.token,
        view: { s: S.view.s, tx: S.view.tx, ty: S.view.ty }
      };
      gesture = { type: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY };
    } else {
      clickCand = null;
      if (pointers.size === 2) beginPinch();
    }
  });

  el.stage.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    if (gesture.type === 'pan' && gesture.id === e.pointerId) {
      if (clickCand && clickCand.id === e.pointerId &&
          Math.hypot(e.clientX - clickCand.x0, e.clientY - clickCand.y0) >= CFG.clickSlop) {
        clickCand.ok = false;
        el.stage.classList.add('dragging');
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
      if (e.type === 'pointerup' && c.ok && c.token === S.token && pointers.size === 0 && S.phase === 'round') {
        var r = el.stage.getBoundingClientRect();
        var X = (c.x0 - r.left - c.view.tx) / c.view.s;
        var Y = (c.y0 - r.top - c.view.ty) / c.view.s;
        if (X >= 0 && Y >= 0 && X <= S.scene.width && Y <= S.scene.height) finish('click', X, Y);
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
    }
  }
  el.stage.addEventListener('pointerup', endPointer);
  el.stage.addEventListener('pointercancel', endPointer);
  el.stage.addEventListener('lostpointercapture', endPointer);

  el.stage.addEventListener('wheel', function (e) {
    if (S.screen !== 'round') return;
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

  function answerAtCenter() {
    if (S.phase !== 'round') return;
    var v = S.view;
    var X = clamp((S.stageW / 2 - v.tx) / v.s, 0, S.scene.width);
    var Y = clamp((S.stageH / 2 - v.ty) / v.s, 0, S.scene.height);
    finish('click', X, Y);
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave browser shortcuts alone
    var t = e.target;
    var interactive = !!(t && t.closest && t.closest('button, a, input, select, textarea, [contenteditable="true"]'));
    var key = e.key;

    if (S.screen === 'start') {
      if (key === 'Enter' && !interactive && !e.repeat && S.data && S.scenes.length) {
        e.preventDefault();
        startGame(S.mode);
      }
      return;
    }
    if (S.screen !== 'round') return;

    switch (key) {
      case '+': case '=': case 'Add':
        e.preventDefault(); zoomBy(CFG.zoomStep, null, null, true); return;
      case '-': case '_': case 'Subtract':
        e.preventDefault(); zoomBy(1 / CFG.zoomStep, null, null, true); return;
      case '0':
        e.preventDefault(); if (canView()) animateTo(fitView(), 260); return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
        // pan only when focus is on the picture or its controls; elsewhere arrows scroll the page as usual
        if (t !== el.stage && t !== document.body && !el.roundBar.contains(t)) return;
        e.preventDefault();
        if (key === 'ArrowLeft') panBy(CFG.panStep, 0);
        else if (key === 'ArrowRight') panBy(-CFG.panStep, 0);
        else if (key === 'ArrowUp') panBy(0, CFG.panStep);
        else panBy(0, -CFG.panStep);
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
          if (key === 'Enter') answerAtCenter();
        }
        return;
    }
  });

  /* ---------- summary ---------- */

  function showSummary() {
    var g = S.game;
    S.phase = 'done';
    stopTimer();
    stopAnim();
    clearOverlay();
    var n = g.results.length;
    var M = modelCount();
    var youFound = g.results.filter(function (r) { return r.found; }).length;
    var youMed = median(g.results.map(function (r) { return r.seconds; }));

    var rows = [{ you: true, name: 'You', maker: 'Human', found: youFound, med: youMed, rate: null, order: -1 }];
    S.models.forEach(function (m, i) {
      var f = 0;
      var secs = [];
      g.results.forEach(function (r) {
        var p = pickOf(r.scene, m);
        if (p.found) f++;
        if (isNum(p.seconds)) secs.push(p.seconds);
      });
      rows.push({ you: false, name: m.name, maker: m.maker, found: f, med: median(secs), rate: m.found_rate, order: i });
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
    var lede = 'Your median time was ' + fmtS(youMed) + ' s per picture, misses included. Ranked by pictures found, you ' +
      (tiedWith.length ? 'tie for ' : 'come ') + ordinal(youRow.rank) + ' of ' + rows.length + ' on these ' + n + ' pictures';
    if (tiedWith.length === 1) lede += ', level with ' + tiedWith[0].name;
    else if (tiedWith.length > 1 && tiedWith.length <= 3) lede += ', level with ' + tiedWith.slice(0, -1).map(function (r) { return r.name; }).join(', ') + ' and ' + tiedWith[tiedWith.length - 1].name;
    else if (tiedWith.length > 3) lede += ', level with ' + tiedWith.length + ' models';
    lede += '.';
    el.sumLede.textContent = lede;

    // table
    clearNode(el.sumBody);
    rows.forEach(function (r) {
      var tr = node('tr', r.you ? 'you' : '');
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
      var meter = node('span', 'meter');
      meter.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < n; i++) meter.appendChild(node('i', i < r.found ? 'on' : ''));
      fc.appendChild(meter);
      tr.appendChild(fc);
      tr.appendChild(node('td', 'num', isNum(r.med) ? fmtS(r.med) + ' s' : '—'));
      tr.appendChild(node('td', 'num all hide-sm', isNum(r.rate) ? Math.round(r.rate * 100) + '%' : '—'));
      el.sumBody.appendChild(tr);
    });

    // note on timing
    var ds = S.data.dataset || {};
    var perPic = isNum(ds.tiles) && isNum(ds.pictures) && ds.pictures ? Math.round(ds.tiles / ds.pictures) : 211;
    var oneCall = S.models.filter(function (m) { return m.method && m.method !== 'parallel'; });
    var note = 'Model times are whole-search wall times: about ' + perPic + ' tile requests sent in parallel per picture';
    if (oneCall.length) note += ' (' + oneCall.map(function (m) { return m.name; }).join(', ') + ': one call)';
    note += '. Your time runs from the moment the picture appears to your answer, capped at ' + CFG.capSeconds +
      ' s. Humans and models were not timed under the same conditions, so read the times as context, not a race. ';
    note += 'An unfinished model search counts as a miss. “All ' + S.scenes.length + ' scenes” is each model’s found rate on the full benchmark.';
    el.sumNote.textContent = note;

    // best per mode
    var rec = { found: youFound, n: n, medianSeconds: isNum(youMed) ? Math.round(youMed * 100) / 100 : null, at: new Date().toISOString() };
    var saved = saveBest(g.mode, rec);
    clearNode(el.sumBest);
    if (!saved.stored) {
      el.sumBest.hidden = true;
    } else if (saved.better) {
      el.sumBest.appendChild(node('b', null, 'New best on ' + modeName(g.mode) + '.'));
      if (saved.prev) el.sumBest.appendChild(document.createTextNode(' Previous best: ' + bestText(saved.prev) + '.'));
      el.sumBest.hidden = false;
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
      im.alt = 'Scene ' + sc.id;
      im.loading = 'lazy';
      fig.appendChild(im);
      var cap = node('figcaption');
      var line = node('div', 'cap');
      line.appendChild(node('span', 'id', sc.id));
      var label = r.found ? 'Found ' + fmtS(r.seconds) + ' s' : (r.how === 'timeout' ? 'Time’s up' : (r.how === 'giveup' ? 'Gave up' : 'Missed'));
      line.appendChild(node('span', 'tag ' + (r.found ? 'found' : 'miss'), label));
      cap.appendChild(line);
      cap.appendChild(node('div', 'sub', 'Found by ' + foundBy(sc) + ' of ' + M + ' models'));
      fig.appendChild(cap);
      el.sumGrid.appendChild(fig);
    });

    var other = g.mode === 'hard' ? 'normal' : 'hard';
    el.switchBtn.textContent = 'Play ' + modeName(other);
    el.switchBtn.hidden = other === 'hard' && !S.hardPool.length;

    showScreen('summary');
    window.scrollTo(0, 0);
    try { el.sumTitle.focus({ preventScroll: true }); } catch (e) { el.sumTitle.focus(); }
    announce('You found ' + youFound + ' of ' + n + '. Median ' + fmtS(youMed) + ' seconds.');
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
    S.hardPool = S.scenes.filter(function (s) { return foundBy(s) <= CFG.hardMaxFound; });
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
