'use strict';
// Waldo Bench results page. Everything is read from data/*.json, written by `uv run python -m waldobench site`.

const $ = (sel, root = document) => root.querySelector(sel);
const SVG = 'http://www.w3.org/2000/svg';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  setAttrs(el, attrs);
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
}
const pct = (x, digits = 0) => `${(100 * x).toFixed(digits)}%`;
// Cost of searching one whole scene, in dollars.
const perScene = (m) => m.usd_per_scene;
const money = (d) => `$${d.toFixed(4)}`;
// Compare at the precision shown, so a millisecond never decides "quickest".
const shownCost = (m) => Number(perScene(m).toFixed(4));
const shownTime = (m) => Number(m.p50_search_s.toFixed(2));
const best = (key) => { const v = Math.min(...models.map(key)); return models.filter((m) => key(m) === v); };
const names = (ms) => ms.map((m) => m.name).join(' and ');
const sec = (x) => `${x.toFixed(2)} s`;
const COLORS = { pick: '#2a78d6', random: '#d8262c', ink: '#111111' };

const measure = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return (text, size = 12, weight = 400) => { ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`; return ctx.measureText(text).width; };
})();

function readYou() {
  try { return JSON.parse(localStorage.getItem('waldo-bench-you') || 'null'); } catch { return null; }
}

let bench, copy, heat, models, byAlias, scenes, sceneById;

Promise.all([
  fetch('data/bench.json').then((r) => r.json()),
  fetch('copy.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
]).then(([b, c]) => {
  bench = b; copy = c || {};
  models = bench.models;
  byAlias = Object.fromEntries(models.map((m) => [m.model, m]));
  scenes = bench.scenes;
  sceneById = Object.fromEntries(scenes.map((sc) => [sc.id, sc]));
  attachTips();
  buildHow();
  buildFacts();
  buildBoard();
  buildCharts();
  buildDecoys();
  buildScenes();
  buildMethod();
  spyNav();
  $('#credit').textContent = `Scenes and labels: ${bench.attribution.paper}. Illustrations: ${bench.attribution.illustrations}. All rights remain with their owners.`;
  fetch('data/heat.json').then((r) => r.json()).then((x) => { heat = x; renderViews(); });
  // Sections are filled in after load, so honour a #hash once they have their real height.
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) requestAnimationFrame(() => target.scrollIntoView());
}).catch(() => {
  // Most likely the data was never built: the page needs `waldobench site`, which needs the runs and the IVSN scenes.
  $('main').prepend(h('p', { class: 'note', style: { padding: '24px 0' },
    text: 'The results data is missing. Build it with `uv run python -m waldobench site` (see the README), then reload.' }));
});

/* ---------- Hover tips ---------- */
// Instant tooltips for anything with data-tip (the browser's own title tooltip is slow and easy to miss).
function attachTips() {
  const tip = h('div', { class: 'hover-tip', role: 'tooltip' });
  document.body.append(tip);
  let current = null;
  const show = (el) => {
    if (current === el) return;
    current = el;
    tip.textContent = el.dataset.tip;
    tip.classList.add('on');
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, ht = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    const top = r.bottom + 8 + ht > innerHeight - 8 ? r.top - ht - 8 : r.bottom + 8;
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  };
  const hide = () => { current = null; tip.classList.remove('on'); };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); else hide(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, { passive: true, capture: true });
}

// The header marks the section on screen; on a phone the nav scrolls so that link stays in view.
function spyNav() {
  const nav = $('.nav');
  const links = [...nav.querySelectorAll('a[href^="#"]')].map((a) => [a, document.getElementById(a.hash.slice(1))]).filter(([, sec]) => sec);
  let current = null, queued = false;
  const update = () => {
    queued = false;
    const line = 120;
    let hit = null;
    for (const [a, sec] of links) if (sec.getBoundingClientRect().top <= line) hit = a;
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) hit = links.at(-1)[0];
    if (hit === current) return;
    if (current) current.removeAttribute('aria-current');
    current = hit;
    if (!hit) return;
    hit.setAttribute('aria-current', 'location');
    const l = hit.offsetLeft - nav.offsetLeft, r = l + hit.offsetWidth;
    if (l < nav.scrollLeft || r > nav.scrollLeft + nav.clientWidth - 24) nav.scrollTo({ left: l - 8, behavior: 'smooth' });
  };
  window.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  update();
  scrollFade(nav);
}

// Fades at the edges of a sideways-scrolling box while there is more to see that way.
function scrollFade(box, left = true) {
  const update = () => {
    box.classList.toggle('fade-r', box.scrollLeft + box.clientWidth < box.scrollWidth - 4);
    box.classList.toggle('fade-l', left && box.scrollLeft > 4);
  };
  box.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// A grid of cards shows its first 2 rows and a button for the rest. On a phone the cards are one swipeable row instead (CSS).
function clampCards(grid, label) {
  const cards = [...grid.children];
  const btn = h('button', { class: 'btn ghost more-btn', type: 'button' });
  let open = false;
  const apply = () => {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const shown = open || matchMedia('(max-width: 640px)').matches ? cards.length : cols * 2;
    cards.forEach((c, i) => { c.hidden = i >= shown; });
    btn.hidden = shown >= cards.length && !open;
    btn.textContent = open ? 'Show fewer' : `Show all ${cards.length} ${label}`;
  };
  btn.addEventListener('click', () => {
    open = !open; apply();
    if (!open) grid.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  grid.after(btn);
  let timer;
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(apply, 120); });
  apply();
}

/* ---------- How it works ---------- */
// The task in 3 pictures: a scene cut into tiles, 1 tile next to the picture of Waldo, the tile that wins.
// It uses the scene most models found, and the tile most of them chose there (a real tile; no model is named).
function buildHow() {
  const sc = matrixOrder()[0], d = bench.dataset;
  const picks = Object.values(sc.picks).filter((p) => p.found && p.box && p.tileImage);
  if (!picks.length) return;
  const votes = new Map();
  for (const p of picks) votes.set(p.box.join(), (votes.get(p.box.join()) || 0) + 1);
  const top = picks.reduce((a, p) => (votes.get(p.box.join()) > votes.get(a.box.join()) ? p : a));
  const scene = (marks) => {
    const svg = s('svg', { viewBox: `0 0 ${sc.width} ${sc.height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    svg.append(...marks);
    return h('div', { class: 'how-shot' }, h('img', { src: sc.thumb, alt: '', width: sc.width, height: sc.height }), svg);
  };
  const ns = { 'vector-effect': 'non-scaling-stroke', fill: 'none' };
  const grid = [];
  for (let x = d.stridePx; x < sc.width; x += d.stridePx) grid.push(s('line', { x1: x, x2: x, y1: 0, y2: sc.height, ...ns }));
  for (let y = d.stridePx; y < sc.height; y += d.stridePx) grid.push(s('line', { x1: 0, x2: sc.width, y1: y, y2: y, ...ns }));
  const [x0, y0, x1, y1] = top.box;
  const box = (cls) => s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: cls, ...ns });
  const step = (n, pic, text) => h('figure', {}, pic, h('figcaption', {}, h('b', { text: n }), text));
  const arrow = () => h('span', { class: 'how-arrow', 'aria-hidden': 'true', text: '→' });
  $('#how').append(
    step('1', scene([s('g', { class: 'how-grid' }, grid), box('how-tile')]), 'Cut each scene into tiles'),
    arrow(),
    step('2', h('div', { class: 'how-pair' }, h('img', { src: top.tileImage, alt: 'One tile' }), h('img', { src: 'assets/reference.jpg', alt: 'The picture of Waldo' })), 'Score every tile: is Waldo in it?'),
    arrow(),
    step('3', scene([box('how-pick')]), 'The top tile is the pick'));
}

/* ---------- Facts ---------- */
function buildFacts() {
  const lead = models[0];
  const cheapest = best(shownCost), quickest = best(shownTime);
  const facts = [
    ['Most found', pct(lead.found_rate), `${lead.name}, ${lead.found} of ${lead.searches}`],
    ['Cheapest', money(perScene(cheapest[0])), `${names(cheapest)}, per scene`],
    ['Quickest', sec(quickest[0].p50_search_s), `${names(quickest)}, median per scene`],
  ];
  $('#facts').append(...facts.map(([label, value, sub]) => h('div', { class: 'fact' },
    h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }), h('div', { class: 'sub', text: sub }))));
}

/* ---------- Leaderboard ---------- */
const rangeText = (ci) => `${Math.round(100 * ci[0])}–${Math.round(100 * ci[1])}%`;
const chevron = () => { const v = s('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' }); v.append(s('path', { d: 'M4 2l4 4-4 4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 })); return v; };

// Sort keys for the leaderboard, best first: most found, cheapest, quickest.
const SORTS = { found: (m) => -m.found_rate, cost: (m) => perScene(m), time: (m) => m.p50_search_s };

// What Jev 1.14's 2 whole-scene methods mean: a tooltip on "(Choice)" and "(yes/no, batched)" in the row name.
const METHOD_TIPS = {
  'one-call': 'Choice: 1 request per scene. All tiles of the scene are the options, and Jev picks 1. TypeSafe documents this method for large images.',
  batched: 'Yes/no, batched: 1 request per scene. The picture of Waldo goes in once, with 1 yes/no question per tile.',
};
function nameCell(m) {
  const name = m.name.replace(/-/g, '\u2011'), cut = name.indexOf(' (');
  if (cut < 0 || !METHOD_TIPS[m.method]) return h('span', { class: 'name', text: name });
  return h('span', { class: 'name' }, name.slice(0, cut), ' ',
    h('span', { class: 'method-tip', tabindex: 0, 'data-tip': METHOD_TIPS[m.method], onclick: (e) => e.stopPropagation(), text: name.slice(cut + 1) }));
}

function buildBoard() {
  const table = $('#board');
  const cheapest = best(shownCost).map((m) => m.model), quickest = best(shownTime).map((m) => m.model);
  // Rows come ordered from results.json: found, then cheaper, then faster. Ties in a sort keep that order.
  const place = (m) => models.indexOf(m);
  // Found, Cost and Median time sort the table: a click puts the best first, a 2nd click reverses it.
  const sortTh = (key, label, cls) => h('th', { class: `r sortable ${cls}`, 'data-sort': key },
    h('button', { type: 'button', class: 'sort', onclick: () => sortBoard(key) }, label, h('span', { class: 'arrow', 'aria-hidden': 'true' })));
  table.append(h('thead', {}, h('tr', {},
    h('th', { text: '#' }), h('th', { text: 'Model' }), sortTh('found', 'Found', ''),
    h('th', { class: 'r range', 'data-tip': '95% interval. On new, similar scenes the found rate will likely be in this range. Ranges that overlap a lot are too close to call.' },
      'Likely range ', h('span', { class: 'info', tabindex: 0, 'aria-label': 'What is the likely range?', text: 'ⓘ' })),
    sortTh('cost', 'Cost / scene', 'hide-sm'), sortTh('time', 'Median time', 'hide-sm'), h('th', {}))));
  // Phones hide the cost and time columns, so a switch above the table does the sorting there (always best first).
  const seg = h('div', { class: 'seg sort-seg', role: 'group', 'aria-label': 'Sort by' },
    [['found', 'Most found'], ['cost', 'Cheapest'], ['time', 'Quickest']].map(([key, label]) => h('button', { type: 'button', 'data-sort': key, onclick: () => sortBoard(key, false) }, label)));
  table.parentElement.before(seg);
  const body = h('tbody');
  table.append(body);
  let sortKey = null, sortDir = 1;
  // Expanded rows move with their model; You and the baselines stay at the bottom; # keeps the found rank.
  function sortBoard(key, flip = true) {
    sortDir = flip && key === sortKey ? -sortDir : 1;
    sortKey = key;
    const by = (r) => byAlias[r.dataset.model];
    const rows = [...body.querySelectorAll('tr.model')]
      .sort((a, b) => sortDir * (SORTS[key](by(a)) - SORTS[key](by(b))) || place(by(a)) - place(by(b)));
    const end = body.querySelector('tr.you');
    for (const r of rows) {
      const detail = r.getAttribute('aria-expanded') === 'true' ? r.nextElementSibling : null;
      end.before(r);
      if (detail) end.before(detail);
    }
    // Found reads high to low when best first; cost and time read low to high.
    const order = (k) => ((k === 'found') === (sortDir > 0) ? 'descending' : 'ascending');
    table.querySelectorAll('th.sortable').forEach((th) => {
      const on = th.dataset.sort === key;
      if (on) th.setAttribute('aria-sort', order(key)); else th.removeAttribute('aria-sort');
      th.querySelector('.arrow').textContent = on ? (order(key) === 'descending' ? '▼' : '▲') : '↕';
    });
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === key && sortDir > 0)));
  }
  for (const m of models) {
    const lead = m.rank === 1;
    const pills = [];
    if (lead) pills.push(h('span', { class: 'pill outline', text: 'Most found' }));
    if (cheapest.includes(m.model)) pills.push(h('span', { class: 'pill outline', text: 'Cheapest' }));
    if (quickest.includes(m.model)) pills.push(h('span', { class: 'pill outline', text: 'Quickest' }));
    const row = h('tr', { class: 'model', tabindex: 0, 'aria-expanded': 'false', 'data-model': m.model },
      h('td', { class: 'rank', text: m.rank }),
      h('td', {}, h('div', {}, nameCell(m), ' ', h('span', { class: 'maker', text: m.maker }), pills.length ? h('span', { class: 'pills' }, ...pills) : null),
        // Non-breaking spaces and hyphens: on a phone a line may only wrap after the dot, never inside a name or between a number and its unit.
        h('div', { class: 'sm-only note num', text: `${money(perScene(m))}\u00a0· ${sec(m.p50_search_s).replace(' ', '\u00a0')} per\u00a0scene` })),
      h('td', { class: 'r found num' }, h('b', { text: pct(m.found_rate) }), h('div', { class: 'of', text: `${m.found} of ${m.searches}` }),
        m.unfinished ? h('div', { class: 'of', text: `${m.unfinished} unfinished` }) : null),
      h('td', { class: 'r range num', 'data-tip': `${m.short} on new, similar scenes: likely ${rangeText(m.found_ci95)}` }, rangeText(m.found_ci95)),
      h('td', { class: 'r num hide-sm', text: money(perScene(m)) }),
      h('td', { class: 'r num hide-sm', text: sec(m.p50_search_s) }),
      h('td', { class: 'chev' }, h('span', { class: 'open-hint' }, h('span', { class: 'misses-n', text: `${m.missesPass1.length} misses` }), chevron())));
    const toggle = () => toggleDetail(row, m);
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    body.append(row);
  }
  // You: straight after the models, boxed, with a clear way in to the game.
  // Your best rounds are 10 scenes, not all 66, so they show as a count with their mode, never as a found rate.
  const you = readYou();
  const rounds = [['normal', 'Normal'], ['hard', 'Hard']].filter(([k]) => you && you[k]).map(([k, label]) => ({ ...you[k], label }));
  const mine = rounds.length > 0;
  const play = () => { location.href = 'play.html'; };
  body.append(h('tr', { class: 'you', tabindex: 0, role: 'link', 'aria-label': 'Play: you against the models', onclick: play, onkeydown: (e) => { if (e.key === 'Enter') play(); } },
    h('td', { class: 'rank', text: '?' }),
    h('td', {}, h('span', { class: 'name', text: 'You' }), mine ? null : h('span', { class: 'pill red', text: 'Your turn' }),
      h('div', { class: 'blurb', text: mine ? `Your best round${rounds.length > 1 ? 's' : ''} of ${rounds[0].n} scenes` : 'Can you beat the models?' })),
    h('td', { class: 'r found num' }, rounds.map((x) => h('div', { class: 'you-round' }, h('b', { text: `${x.found}/${x.n}` }), h('span', { class: 'of', text: x.label })))),
    h('td', { class: 'range' }),
    h('td', { class: 'hide-sm' }),
    h('td', { class: 'hide-sm' }),
    h('td', { class: 'r' }, h('a', { class: 'btn', href: 'play.html', onclick: (e) => e.stopPropagation(), text: mine ? 'Play again →' : 'Play →' }))));
  body.append(h('tr', { class: 'group' }, h('td', { colspan: 7, text: 'Baselines' })));
  const baseline = (name, value) => h('tr', { class: 'baseline' },
    h('td', { class: 'rank', text: '–' }), h('td', {}, h('span', { class: 'name', text: name })),
    h('td', { class: 'r found num' }, h('b', { text: pct(value, 1) })), h('td', { class: 'range' }),
    h('td', { class: 'r hide-sm', text: '–' }), h('td', { class: 'r hide-sm', text: '–' }), h('td', {}));
  body.append(baseline('Random tile', bench.baselines.random['128']));
  body.append(baseline('Middle tile', bench.baselines.middle));
  sortBoard('found');
}

// Expanded row: the tiles a model chose instead of Waldo. Clicking one opens it beside the real Waldo.
function toggleDetail(row, m) {
  const open = row.getAttribute('aria-expanded') === 'true';
  if (open) { row.nextElementSibling.remove(); row.setAttribute('aria-expanded', 'false'); return; }
  row.setAttribute('aria-expanded', 'true');
  const misses = m.missesPass1.map((id) => sceneById[id]);
  const openOne = (sc, target) => openModel(m.model, sc.id, target);
  const grid = h('div', { class: 'misses' }, misses.map((sc) => {
    const pick = sc.picks[m.model];
    return h('figure', { role: 'button', tabindex: 0, title: `Scene ${sc.number}: compare with Waldo`,
      onclick: (e) => openOne(sc, e.currentTarget), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOne(sc, e.currentTarget); } } },
    h('img', { src: pick.tileImage, alt: `Tile ${m.name} chose in scene ${sc.number}`, loading: 'lazy' }),
    h('figcaption', {}, h('b', { text: `Scene ${sc.number}` }), h('span', { text: probLabel(pick.confidence) })));
  }));
  row.after(h('tr', { class: 'detail' }, h('td', { colspan: 7 },
    h('p', { class: 'detail-head' }, h('b', { text: `Missed ${misses.length} of ${scenes.length}.` }), ' Select a tile to compare it with Waldo.'),
    grid)));
}

/* ---------- Charts ---------- */
function chartTip(container) {
  const tip = h('div', { class: 'tip', role: 'status' });
  container.append(tip);
  return {
    show(x, y, title, rows) {
      tip.replaceChildren(h('div', { class: 't', text: title }), ...rows.map((r) => h('div', { class: r.on ? 'row on' : 'row' },
        h('span', {}, r.color ? h('i', { class: 'key', style: { color: r.color } }) : null, r.label), h('b', { text: r.value }))));
      tip.classList.add('on');
      const box = container.getBoundingClientRect();
      const w = tip.offsetWidth, ht = tip.offsetHeight;
      let left = x + 14, top = y - ht / 2;
      if (left + w > box.width) left = x - w - 14;
      top = Math.max(0, Math.min(top, box.height - ht));
      tip.style.left = `${left}px`; tip.style.top = `${top}px`;
    },
    hide() { tip.classList.remove('on'); },
  };
}
// Pointing, tapping and keys for a chart's items (dots, rows or bars). Pointing shows the readout; a click opens the item.
// By touch, the first tap shows the readout and a second tap on the same item opens it. Arrow keys step through the items, Enter opens.
function interact(svg, W, tip, o) {
  let shown = null, before = null, touch = false, fi = -1;
  const scale = () => W / svg.getBoundingClientRect().width;
  const local = (e) => { const b = svg.getBoundingClientRect(), k = W / b.width; return [(e.clientX - b.left) * k, (e.clientY - b.top) * k]; };
  const show = (it) => { shown = it; o.mark(it); const [x, y] = o.at(it), k = scale(); tip.show(x / k, y / k, o.title(it), o.rows(it)); };
  const hide = () => { shown = null; o.mark(null); tip.hide(); };
  const near = (e) => { const it = o.find(...local(e)); svg.style.cursor = it && o.open ? 'pointer' : ''; if (it) show(it); else hide(); };
  svg.addEventListener('pointermove', near);
  svg.addEventListener('pointerdown', (e) => { before = shown; touch = e.pointerType !== 'mouse'; near(e); });
  svg.addEventListener('click', (e) => {
    const it = o.find(...local(e));
    if (it && o.open && (!touch || before === it)) { hide(); o.open(it, svg); }
  });
  // A finger lifting fires pointerleave; keep the tapped item's readout until the next tap.
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && fi >= 0 && o.open) { o.open(o.items[fi], svg); return; }
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    fi = (fi + d + o.items.length) % o.items.length;
    show(o.items[fi]);
  });
  svg.addEventListener('focus', () => { if (svg.matches(':focus-visible')) { fi = 0; show(o.items[0]); } });
  svg.addEventListener('blur', hide);
}

// The leaderboard rows the charts show: every row for now. For one row per model, filter here
// (e.g. m.model === m.base || m.method === 'parallel'); every chart, scene count included, follows.
const charted = () => models;
const chartSvg = (W, H, aria) => s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria });
const openRow = (it, svg) => openModel(it.m.model, null, svg);

// A chart across the whole row is 380 px tall; a half-row chart is about 4/5 as tall as wide (300 to 420 px).
const chartHeight = (W) => (W >= 900 ? 380 : Math.round(Math.max(300, Math.min(420, W * 0.8))));

/* Labelled dots on 2 axes (charts 1 and 2): every model a grey dot with its name beside it, its likely range on hover.
   o: { aria, x: v → 0..1, xTicks: [[v, label]], xTitle, y: [lo, hi], yTicks, notes: [[text, 'tl' | 'br']], square, decorate, pts, tip }. */
function dotPlot(host, o) {
  host.replaceChildren();
  const W = Math.max(300, host.clientWidth), big = W >= 440;
  const M = { l: 44, r: 16, t: 16, b: 48 };
  // A square plot keeps a 45° diagonal, centred, as tall as the chart beside it (full width on a phone); the others stretch to the card.
  const side = o.square ? Math.min(W - M.l - M.r, W < 420 ? Infinity : chartHeight(W) - M.t - M.b) : 0;
  const L = M.l + (side ? Math.max(0, (W - M.l - M.r - side) / 2) : 0);
  const H = side ? side + M.t + M.b : chartHeight(W), R = side ? L + side : W - M.r;
  const x = (v) => L + o.x(v) * (R - L);
  const y = (v) => M.t + (1 - (v - o.y[0]) / (o.y[1] - o.y[0])) * (H - M.t - M.b);
  const svg = chartSvg(W, H, o.aria);
  const grid = s('g', { class: 'grid' });
  for (const t of o.yTicks) {
    grid.append(s('line', { x1: L, x2: R, y1: y(t), y2: y(t) }));
    svg.append(s('text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick-label' }, pct(t)));
  }
  for (const [t, label] of o.xTicks) {
    grid.append(s('line', { x1: x(t), x2: x(t), y1: M.t, y2: H - M.b }));
    svg.append(s('text', { x: x(t), y: H - M.b + 18, 'text-anchor': 'middle', class: 'tick-label' }, label));
  }
  svg.prepend(grid);
  svg.append(s('line', { x1: L, x2: R, y1: H - M.b, y2: H - M.b, stroke: '#cfcfcf' }));
  svg.append(s('text', { x: (L + R) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' }, o.xTitle));
  const dot = big ? 5.5 : 4.5;
  const pts = o.pts.map((p) => ({ ...p, cx: x(p.xv), cy: y(p.yv) }));
  // Labels keep clear of dots and of the corner notes ("↖ …" top left, "… ↘" bottom right).
  const placed = pts.map((p) => ({ x0: p.cx - dot - 1, y0: p.cy - dot - 1, x1: p.cx + dot + 1, y1: p.cy + dot + 1 }));
  for (const [text, corner, cls] of o.notes) {
    const w = text.length * 7.1, end = corner === 'br', bx = end ? R - 8 - w : L + 8, by = end ? H - M.b - 20 : M.t;
    svg.append(s('text', { x: end ? R - 8 : L + 8, y: by + 12, 'text-anchor': end ? 'end' : null, class: `axis-title ${cls || ''}` }, text));
    placed.push({ x0: bx, y0: by, x1: bx + w, y1: by + 14 });
  }
  if (o.decorate) o.decorate(svg, x, y);
  // A dot's likely range shows only while it is pointed at, so the dots carry the chart (unless the chart turns ranges off).
  if (o.ranges !== false) for (const p of pts) svg.append(p.range = s('line', { x1: p.cx, x2: p.cx, y1: y(Math.max(o.y[0], p.m.found_ci95[0])), y2: y(Math.min(o.y[1], p.m.found_ci95[1])), class: 'range-bar', 'stroke-width': big ? 3 : 2.5, 'stroke-linecap': 'round' }));
  for (const p of pts) svg.append(p.dot = s('circle', { cx: p.cx, cy: p.cy, r: dot, fill: p.color || '#6b6b6b', stroke: '#fff', 'stroke-width': 2, class: 'pt' }));
  // Direct labels: right, left, above or below the dot, or a little further out with a thin line back; a label that
  // finds no free spot is left off (the readout names it).
  const clash = (b) => placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0) || b.x0 < L || b.x1 > W - M.r + 4 || b.y0 < M.t || b.y1 > H - M.b;
  const fs = big ? 13 : 12, gap = dot + 5;
  for (const p of [...pts].sort((a, b) => a.m.rank - b.m.rank)) {
    const text = p.m.short, w = measure(text, fs, 400), ht = fs + 2;
    const ring = (r) => [[p.cx + gap + r, p.cy - ht / 2], [p.cx - gap - r - w, p.cy - ht / 2], [p.cx - w / 2, p.cy - gap - 1 - r - ht], [p.cx - w / 2, p.cy + gap + r],
      [p.cx + gap + r, p.cy - ht - 2 - r], [p.cx + gap + r, p.cy + 2 + r], [p.cx - gap - r - w, p.cy - ht - 2 - r], [p.cx - gap - r - w, p.cy + 2 + r]];
    const spot = (W < 480 ? [0] : [0, 14, 28]).flatMap((r) => ring(r).map(([bx, by]) => ({ r, x0: bx, y0: by, x1: bx + w, y1: by + ht }))).find((b) => !clash(b));
    if (!spot) continue;
    placed.push(spot);
    if (spot.r) {
      const lx = Math.max(spot.x0, Math.min(p.cx, spot.x1)), ly = Math.max(spot.y0, Math.min(p.cy, spot.y1));
      const d = Math.hypot(lx - p.cx, ly - p.cy) || 1;
      svg.append(p.leader = s('line', { x1: p.cx + ((lx - p.cx) * (dot + 1.5)) / d, y1: p.cy + ((ly - p.cy) * (dot + 1.5)) / d, x2: lx, y2: ly, stroke: '#cfcfcf', 'stroke-width': 1, class: 'pt' }));
    }
    svg.append(p.label = s('text', { x: spot.x0, y: spot.y0 + fs - 1, class: 'label pt', style: { fontSize: `${fs}px` } }, text));
  }
  // Pointing at a dot fades every other dot and label, and redraws the dot on top, named even when it had no room for a label.
  const lit = s('g', { 'pointer-events': 'none' });
  svg.append(lit);
  const focus = (it) => {
    svg.classList.toggle('focusing', Boolean(it));
    lit.replaceChildren();
    for (const p of pts) for (const el of [p.range, p.dot, p.label, p.leader]) if (el) el.classList.toggle('on', p === it);
    if (!it) return;
    if (o.highlight) o.highlight(lit, it, x, y);
    lit.append(s('circle', { cx: it.cx, cy: it.cy, r: dot + 1, fill: it.color || '#6b6b6b', stroke: '#fff', 'stroke-width': 2 }));
    if (!it.label) {
      const w = measure(it.m.short, fs, 650), right = it.cx + gap + w <= W - M.r;
      lit.append(s('text', { x: right ? it.cx + gap : it.cx - gap, y: it.cy + 4, 'text-anchor': right ? null : 'end', class: 'label strong', style: { fontSize: `${fs}px` } }, it.m.short));
    }
  };
  host.append(svg);
  interact(svg, W, chartTip(host), {
    items: [...pts].sort((a, b) => a.cx - b.cx),
    find: (mx, my) => pts.reduce((best, p) => { const d = Math.hypot(p.cx - mx, p.cy - my); return d < 28 && (!best || d < best.d) ? { p, d } : best; }, null)?.p || null,
    at: (p) => [p.cx, p.cy], title: (p) => p.m.name, rows: o.tip,
    open: openRow, mark: focus,
  });
}

/* 1. Found rate against cost or median time, both on log scales. */
let valueAxis = 'cost';

function drawValue() {
  const byCost = valueAxis === 'cost', val = byCost ? perScene : (m) => m.p50_search_s;
  // The axis runs a little past the cheapest (fastest) and dearest (slowest) model; ticks at 1, 2, 5 × 10ⁿ.
  const shown = charted(), vs = shown.map(val), lo = Math.log10(Math.min(...vs) / 1.3), hi = Math.log10(Math.max(...vs) * 1.3);
  const marks = (byCost ? [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1] : [0.5, 1, 2, 5, 10, 20, 50, 100, 200])
    .filter((t) => Math.log10(t) >= lo && Math.log10(t) <= hi);
  dotPlot($('#value'), {
    aria: byCost ? 'Found rate against cost per scene' : 'Found rate against median time per scene',
    x: (v) => (Math.log10(v) - lo) / (hi - lo), xTicks: marks.map((t) => [t, byCost ? `$${t}` : `${t} s`]),
    xTitle: byCost ? '$ per scene · log' : 'Median time per scene · log',
    y: [0.35, 0.95], yTicks: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9], notes: [[byCost ? '↖ cheaper and better' : '↖ faster and better', 'tl']],
    pts: shown.map((m) => ({ m, xv: val(m), yv: m.found_rate })),
    tip: ({ m }) => [
      { label: 'Found', value: `${pct(m.found_rate)} (${m.found}/${m.searches})` },
      { label: 'Likely range', value: rangeText(m.found_ci95) },
      { label: 'Cost per scene', value: money(perScene(m)) },
      { label: 'Median time', value: sec(m.p50_search_s) }],
  });
}

/* 2. Average confidence (P(yes) of its pick) against found rate. On the diagonal a model is as sure as it is right; below it,
   more sure than right. The readout splits confidence into scenes it found and scenes it missed. Each axis is fitted to the
   dots (10% steps), so the cluster spreads out; the diagonal is still found rate = confidence, just not at 45°.
   Jev 1.14 (Choice) is left out: its figure is a share of 1 vote over every tile, not a yes/no probability. */
// Over- and underconfident: orange below the diagonal, blue above it; within 3 points of it counts as calibrated (grey).
const CAL = { over: '#e0782f', under: '#2a78d6', even: '#8a8a8a' };
const calColor = (gap) => (gap > 0.03 ? CAL.over : gap < -0.03 ? CAL.under : CAL.even);
const gapText = (gap) => `${gap > 0 ? '+' : gap < 0 ? '−' : ''}${Math.abs(Math.round(gap * 100))} pts`;

function drawConfidence() {
  const avg = (ps) => (ps.length ? ps.reduce((a, p) => a + p.confidence, 0) / ps.length : null);
  const cs = charted().filter((m) => m.method !== 'one-call' && m.method !== 'zoom').map((m) => {
    const ps = scenes.map((sc) => sc.picks[m.model]).filter((p) => p.confidence != null);
    const right = ps.filter((p) => p.found), wrong = ps.filter((p) => !p.found);
    return { m, conf: avg(ps), right: avg(right), wrong: avg(wrong), nRight: right.length, nWrong: wrong.length };
  }).filter((c) => c.conf != null);
  const fit = (vs, pad) => [Math.max(0, Math.floor((Math.min(...vs) - pad) * 10) / 10), Math.min(1, Math.ceil((Math.max(...vs) + pad) * 10) / 10)];
  const [x0, x1] = fit(cs.map((c) => c.conf), 0.04), [y0, y1] = fit(cs.map((c) => c.m.found_rate), 0.03);
  const steps = (a, b) => Array.from({ length: Math.round((b - a) * 10) + 1 }, (_, i) => Math.round((a + i / 10) * 10) / 10);
  // The diagonal runs where found rate = confidence inside both ranges.
  const d0 = Math.max(x0, y0), d1 = Math.min(x1, y1);
  dotPlot($('#confidence'), {
    aria: 'Found rate against average confidence for each model',
    x: (v) => (v - x0) / (x1 - x0), xTicks: steps(x0, x1).map((t) => [t, pct(t)]), xTitle: 'Average confidence in its pick',
    y: [y0, y1], yTicks: steps(y0, y1), notes: [['↖ underconfident', 'tl', 'under'], ['overconfident ↘', 'br', 'over']],
    decorate: (svg, x, y) => {
      // The 2 zones: the plot cut along the diagonal (found rate = confidence), behind the grid.
      const cut = (f) => {
        const box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], out = [];
        box.forEach((p, i) => {
          const q = box[(i + 1) % 4], fp = f(p), fq = f(q);
          if (fp <= 0) out.push(p);
          if (fp * fq < 0) { const k = fp / (fp - fq); out.push([p[0] + k * (q[0] - p[0]), p[1] + k * (q[1] - p[1])]); }
        });
        return out.map(([a, b]) => `${x(a)},${y(b)}`).join(' ');
      };
      svg.prepend(s('polygon', { points: cut(([a, b]) => b - a), class: 'zone over' }), s('polygon', { points: cut(([a, b]) => a - b), class: 'zone under' }));
      svg.append(s('line', { x1: x(d0), y1: y(d0), x2: x(d1), y2: y(d1), stroke: '#bdbdbd', 'stroke-width': 1 }));
      // On a phone the zones and corner notes name the diagonal; its own label would run through the model labels.
      if (x(1) - x(x0) < 380) return;
      const at = d0 + 0.02, px = x(at), py = y(at), angle = (Math.atan2(y(d1) - y(d0), x(d1) - x(d0)) * 180) / Math.PI;
      svg.append(s('text', { x: px, y: py - 5, transform: `rotate(${angle} ${px} ${py})`, class: 'tick-label' }, 'perfectly calibrated'));
    },
    pts: cs.map((c) => ({ m: c.m, c, xv: c.conf, yv: c.m.found_rate, color: calColor(c.conf - c.m.found_rate) })),
    // On hover: a dashed line from the dot straight up or down to the diagonal; the readout gives the gap in points.
    ranges: false,
    highlight: (g, p, x, y) => {
      const to = y(Math.max(y0, Math.min(y1, p.c.conf)));
      g.append(s('line', { x1: p.cx, x2: p.cx, y1: p.cy, y2: to, stroke: p.color, 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
    },
    tip: ({ m, c }) => [
      { label: 'Average confidence', value: pct(c.conf) },
      { label: 'Found', value: `${pct(m.found_rate)} (${m.found}/${m.searches})` },
      { label: 'Confidence − found', value: gapText(c.conf - m.found_rate) },
      { label: `Confidence when found (${c.nRight})`, value: c.right == null ? '–' : pct(c.right) },
      { label: `Confidence when missed (${c.nWrong})`, value: c.wrong == null ? '–' : pct(c.wrong) }],
  });
}

/* 3. Found rate by tile size: one grey line per model, from the one-request-per-tile runs (the method every model supports),
   and the random tile in red. Right of the lines, the models' range at 128 px (no model named). Pointing at the chart picks
   out the nearest line in ink, with its name at the end; the readout lists every model at that size. */
function drawTiles() {
  const host = $('#tiles');
  host.replaceChildren();
  const W = Math.max(300, host.clientWidth), H = chartHeight(W), big = W >= 600;
  const M = { l: 44, r: 96, t: 12, b: 48 }, xs = [384, 192, 128];
  const x = (px) => M.l + (xs.indexOf(px) / 2) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - v) * (H - M.t - M.b);
  const at = (m, px) => bench.curve.find((e) => e.model === m.model && e.tile_px === px && e.method === 'parallel');
  const series = charted().filter((m) => m.method === 'parallel' && xs.every((px) => at(m, px)))
    .map((m) => ({ m, points: xs.map((px) => ({ px, v: at(m, px).found_rate })) }));
  const random = xs.map((px) => ({ px, v: bench.baselines.random[String(px)] }));
  const svg = chartSvg(W, H, 'Found rate by tile size for each model');
  const grid = s('g', { class: 'grid' });
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    grid.append(s('line', { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), stroke: t === 0 ? '#cfcfcf' : null }));
    svg.append(s('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick-label' }, pct(t)));
  }
  svg.append(grid);
  for (const px of xs) svg.append(s('text', { x: x(px), y: H - M.b + 18, 'text-anchor': 'middle', class: 'tick-label' }, `${px} px`));
  svg.append(s('text', { x: (M.l + W - M.r) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' }, 'Tile size · smaller →'));
  const line = (pts, color, width) => s('polyline', { points: pts.map((p) => `${x(p.px)},${y(p.v)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const dots = (pts, color, r) => pts.map((p) => s('circle', { cx: x(p.px), cy: y(p.v), r, fill: color, stroke: '#fff', 'stroke-width': 1.5 }));
  for (const sr of series) svg.append(line(sr.points, '#b4b4b4', big ? 2 : 1.5));
  svg.append(line(random, COLORS.random, big ? 2 : 1.5));
  for (const sr of series) svg.append(...dots(sr.points, '#b4b4b4', big ? 3.5 : 3));
  svg.append(...dots(random, COLORS.random, big ? 4 : 3.5));
  const tx = x(128) + 10, ends = series.map((sr) => sr.points[2].v), lo = Math.min(...ends), hi = Math.max(...ends);
  svg.append(s('text', { x: tx, y: y(random[2].v) + 4, class: 'label' }, `Random ${pct(random[2].v, 1)}`));
  const summary = s('text', { x: tx, y: y((lo + hi) / 2) - 4, class: 'label' },
    s('tspan', { x: tx }, `${series.length} models`), s('tspan', { x: tx, dy: 16, class: 'sub' }, `${pct(lo)}–${pct(hi)}`));
  const cross = s('line', { y1: M.t, y2: H - M.b, stroke: '#bdbdbd', 'stroke-width': 1, visibility: 'hidden' });
  const lit = s('g', { 'pointer-events': 'none' });
  svg.append(summary, cross, lit);
  host.append(svg);
  const items = series.flatMap((sr) => sr.points.map((p) => ({ sr, p })));
  interact(svg, W, chartTip(host), {
    items,
    find: (mx, my) => {
      if (mx < M.l - 24 || mx > W - M.r + 24 || my < M.t - 10 || my > H - M.b + 10) return null;
      const px = xs.reduce((b, q) => (Math.abs(x(q) - mx) < Math.abs(x(b) - mx) ? q : b));
      return items.filter((it) => it.p.px === px).reduce((b, it) => (Math.abs(y(it.p.v) - my) < Math.abs(y(b.p.v) - my) ? it : b));
    },
    at: (it) => [x(it.p.px), y(it.p.v)], title: (it) => `${it.p.px} px tiles`,
    rows: (it) => [...items.filter((q) => q.p.px === it.p.px).sort((a, b) => b.p.v - a.p.v)
      .map((q) => ({ label: q.sr.m.short, value: pct(q.p.v), color: '#b4b4b4', on: q === it })),
      { label: 'Random tile', value: pct(bench.baselines.random[String(it.p.px)], 1), color: COLORS.random }],
    open: (it, el) => openModel(it.sr.m.model, null, el),
    mark: (it) => {
      lit.replaceChildren();
      summary.style.visibility = it ? 'hidden' : '';
      cross.setAttribute('visibility', it ? 'visible' : 'hidden');
      if (!it) return;
      cross.setAttribute('x1', x(it.p.px)); cross.setAttribute('x2', x(it.p.px));
      lit.append(line(it.sr.points, COLORS.ink, 2.5), ...dots(it.sr.points, COLORS.ink, 4));
      // The name goes right of the last dot, or above and left of it when it would run off the chart.
      const end = it.sr.points.at(-1), text = `${it.sr.m.short} ${pct(end.v)}`, fits = tx + measure(text, 12, 650) <= W;
      lit.append(s('text', { x: fits ? tx : x(128) - 8, y: fits ? y(end.v) + 4 : y(end.v) - 10, 'text-anchor': fits ? null : 'end', class: 'label strong' }, text));
    },
  });
}

const drawCharts = () => { drawValue(); drawConfidence(); drawTiles(); };

// Legend keys: a dot or a line in a colour.
const dotKey = (label, color) => h('span', {}, h('i', { class: 'dot', style: { background: color } }), label);
const lineKey = (label, color) => h('span', {}, h('i', { style: { background: color } }), label);

function buildCharts() {
  // Chart 1 switches its x-axis between cost and time.
  const title = $('#value-title');
  const buttons = [['cost', 'Cost'], ['time', 'Time']].map(([axis, label]) => h('button', { type: 'button', 'aria-pressed': String(axis === valueAxis),
    onclick: () => {
      valueAxis = axis;
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === buttons.find((x) => x.dataset.axis === axis))));
      title.textContent = `Found rate vs ${axis}`;
      drawValue();
    }, 'data-axis': axis }, label));
  $('#value-switch').append(...buttons);
  drawCharts();
  const legend = (id, ...keys) => $(id).parentElement.append(h('div', { class: 'legend' }, ...keys));
  legend('#confidence', dotKey('Overconfident', CAL.over), dotKey('Within 3 points', CAL.even), dotKey('Underconfident', CAL.under));
  legend('#tiles', lineKey('Model, 1 request per tile', '#b4b4b4'), lineKey('Random tile', COLORS.random),
    h('span', { class: 'note hover-only', text: 'Hover for each model' }), h('span', { class: 'note touch-only', text: 'Tap for each model' }));
  let timer;
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => { drawCharts(); renderViews(); }, 120); });
}

/* ---------- Fooled ---------- */
function modelTags(aliases, cls) {
  return h('div', { class: 'tags' }, aliases.map((a) => h('span', { class: `tag ${cls}`, text: byAlias[a].short })));
}
function buildDecoys() {
  const decoyCopy = copy.decoys || {};
  // Every card names every model, in leaderboard order: red took this spot, green found Waldo, grey missed elsewhere.
  const outcome = (d, m) => (d.models.includes(m.model) ? ['miss', 'took this spot'] : d.foundBy.includes(m.model) ? ['found', 'found Waldo'] : ['plain', 'missed, looked elsewhere']);
  $('#decoys').before(h('div', { class: 'tags decoy-key' },
    h('span', { class: 'tag miss', text: 'Took this spot' }), h('span', { class: 'tag found', text: 'Found Waldo' }), h('span', { class: 'tag plain', text: 'Missed elsewhere' })));
  $('#decoys').append(...bench.decoys.map((d) => {
    const c = decoyCopy[d.id] || {};
    const sc = sceneById[d.scene];
    return h('article', { class: 'card' },
      h('div', { class: 'pair', role: 'button', tabindex: 0, style: { cursor: 'pointer' }, title: `Open scene ${sc.number}`,
        onclick: (e) => openScene(d.scene, null, bench.decoys.map((x) => x.scene), e.currentTarget), onkeydown: (e) => { if (e.key === 'Enter') openScene(d.scene, null, bench.decoys.map((x) => x.scene), e.currentTarget); } },
        h('figure', {}, h('img', { src: d.crop, alt: `Where ${d.fooled} models looked in scene ${sc.number}`, loading: 'lazy' }), h('figcaption', { text: 'Their pick' })),
        h('figure', { class: 'real' }, h('img', { src: sc.waldoCrop, alt: `Waldo in scene ${sc.number}`, loading: 'lazy' }), h('figcaption', { text: 'Waldo' }))),
      h('h3', { text: c.who || `Scene ${sc.number}` }),
      h('div', { class: 'count', style: { margin: '6px 0' }, text: `Fooled ${d.fooled} of ${models.length} · scene ${sc.number}` }),
      h('div', { class: 'tags' }, models.map((m) => {
        const [cls, what] = outcome(d, m);
        return h('button', { type: 'button', class: `tag ${cls}`, title: `${m.short}: ${what}`, text: m.short, onclick: (e) => openModel(m.model, d.scene, e.currentTarget) });
      })));
  }));
  clampCards($('#decoys'), 'spots');
  const hardest = scenes.filter((sc) => sc.foundBy <= 2).sort((a, b) => a.foundBy - b.foundBy || a.number - b.number);
  $('#hardest').append(...hardest.map((sc) => {
    const found = Object.entries(sc.picks).filter(([, p]) => p.found).map(([a]) => a);
    return h('article', { class: 'card' },
      h('div', { class: 'solo', role: 'button', tabindex: 0, style: { cursor: 'pointer' }, onclick: (e) => openScene(sc.id, null, hardest.map((x) => x.id), e.currentTarget), onkeydown: (e) => { if (e.key === 'Enter') openScene(sc.id, null, hardest.map((x) => x.id), e.currentTarget); } },
        h('img', { src: sc.waldoCrop, alt: `Waldo in scene ${sc.number}`, loading: 'lazy' })),
      h('h3', { text: `Scene ${sc.number}` }),
      h('div', { class: 'count', style: { margin: '6px 0' }, text: sc.foundBy ? `Found by ${sc.foundBy} of ${models.length}` : `Found by none of ${models.length}` }),
      found.length ? modelTags(found, 'found') : null);
  }));
}

/* ---------- Scene views ---------- */
// One renderer, two places:
//  - the side panel, opened from a leaderboard tile, a decoy or a hardest-Waldo card;
//  - the scene browser in section 04: a scrolling list of scenes on the left, the chosen scene on the right.
// Model mode: one model's scenes, its pick next to the real Waldo. Scene mode: every model's pick on one scene.
let side = null, browser = null;

function makeView(kind) {
  const el = {
    kicker: h('div', { class: 'kicker' }), title: h('h2', { tabindex: -1 }),
    filters: h('div', { class: 'seg', role: 'group', 'aria-label': 'Which scenes' }), pos: h('span', { class: 'insp-pos num' }),
    prev: h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Previous scene' }, '←'),
    next: h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Next scene' }, '→'),
    verdict: h('div', { class: 'insp-verdict', 'aria-live': 'polite' }),
    img: h('img', { alt: '' }), canvas: h('canvas', { 'aria-hidden': 'true' }),
    overlay: s('svg', { class: 'overlay', preserveAspectRatio: 'none', 'aria-hidden': 'true' }), chips: h('div', { class: 'chips', 'aria-hidden': 'true' }),
    heatToggle: h('input', { type: 'checkbox', checked: true }), legend: h('div', { class: 'insp-legend' }),
    compare: h('div', { class: 'insp-compare' }), switcher: h('div', { class: 'insp-switch' }),
    list: h('ul', { class: 'pick-list' }), strip: h('div', { class: kind === 'browser' ? 'browser-list' : 'insp-strip' }),
    race: h('button', { class: 'btn sm race', type: 'button' }), clock: h('span', { class: 'race-clock num', 'aria-live': 'off' }),
  };
  el.stage = h('div', { class: 'stage' }, el.img, el.canvas, el.overlay, el.chips);
  el.stage.addEventListener('click', () => { if (v.st.front) { v.st.front = null; pickOut(v); } });
  // A tag rebuilt under the pointer (during a race) never gets pointerleave, so leaving the picture also clears the hover.
  el.stage.addEventListener('pointerleave', () => { if (v.st.hover) { v.st.hover = null; pickOut(v); } });
  const v = { kind, el, st: { open: kind === 'browser', mode: 'scene', model: null, filter: 'missed', list: scenes.map((x) => x.id), idx: 0, heatOn: true, opener: null, listSort: null, listDir: 1,
    t: null, racing: false, speed: 1 } };
  el.race.addEventListener('click', () => (v.st.racing ? pauseRace(v) : startRace(v)));
  el.heatToggle.addEventListener('change', () => { v.st.heatOn = el.heatToggle.checked; renderView(v); });
  el.prev.addEventListener('click', () => stepView(v, -1));
  el.next.addEventListener('click', () => stepView(v, 1));
  return v;
}

function buildViews() {
  side = makeView('side');
  const e = side.el;
  e.title.id = 'insp-title';
  e.panel = h('aside', { class: 'inspector', role: 'dialog', 'aria-labelledby': 'insp-title', 'aria-hidden': 'true', inert: true },
    h('div', { class: 'stripe-band' }),
    h('div', { class: 'insp-head' }, h('div', {}, e.kicker, e.title),
      h('button', { class: 'insp-close', type: 'button', 'aria-label': 'Close (Esc)', onclick: closeSide }, '×')),
    h('div', { class: 'insp-bar' }, e.filters, h('div', { class: 'insp-nav' }, e.prev, e.pos, e.next)),
    e.scroll = h('div', { class: 'insp-scroll' }, h('div', { class: 'insp-summary' }, e.compare, e.verdict), e.stage, e.legend, e.switcher, e.list,
      h('div', { class: 'insp-strip-wrap' }, h('div', { class: 'note' }, 'Scenes', h('span', { class: 'kbd-only', text: ' · ← → to move, Esc to close' })), e.strip)));
  // A light backdrop: the page stays visible, and a click on it closes the panel.
  e.scrim = h('div', { class: 'insp-scrim', 'aria-hidden': 'true', onclick: closeSide });
  document.body.append(e.scrim, e.panel);
  // The phone's Back gesture closes the panel instead of leaving the page.
  window.addEventListener('popstate', () => { if (side.st.open) { side.st.pushed = false; hideSide(); } });
  document.addEventListener('keydown', (ev) => {
    if (!side.st.open || ev.target.closest('input, textarea, select, [contenteditable]')) return;
    if (ev.key === 'Escape') closeSide();
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepView(side, -1); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepView(side, 1); }
  });

  browser = makeView('browser');
  browser.st.idx = Math.max(0, browser.st.list.findIndex((id) => !sceneById[id].masked));
  const b = browser.el;
  b.strip.setAttribute('role', 'listbox');
  b.strip.setAttribute('aria-label', 'Scenes');
  b.strip.addEventListener('keydown', (ev) => {
    const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
    if (!d) return;
    ev.preventDefault();
    stepView(browser, d);
    b.strip.children[browser.st.idx].focus();
  });
  // The picture on the left, and beside it the close-ups, the verdict and the list of models.
  b.view = h('div', { class: 'browser-view' },
    h('div', { class: 'browser-head' }, h('div', {}, b.kicker, b.title), h('div', { class: 'insp-nav' }, b.race, b.clock, h('div', { class: 'insp-step' }, b.prev, b.pos, b.next))),
    h('div', { class: 'browser-body' }, h('div', { class: 'browser-picture' }, b.stage, b.legend),
      h('div', { class: 'browser-side' }, b.compare, b.verdict, b.list)));
  $('#browser').append(b.strip, b.view);
  renderView(browser);
  scrollFade(b.strip);
}

function modelList(st) {
  return scenes.filter((sc) => st.filter === 'all' || (st.filter === 'missed') === !sc.picks[st.model].found).map((sc) => sc.id);
}
function openModel(alias, sceneId, opener) {
  // Start on the list that holds the given scene: its finds for a find, otherwise its misses.
  const st = side.st;
  const found = sceneId && sceneById[sceneId].picks[alias].found;
  Object.assign(st, { mode: 'model', model: alias, filter: found ? 'found' : byAlias[alias].missesPass1.length ? 'missed' : 'all', back: null });
  st.list = modelList(st);
  st.idx = Math.max(0, sceneId ? st.list.indexOf(sceneId) : 0);
  showSide(opener);
}
function openScene(sceneId, alias, list, opener, back = null) {
  Object.assign(side.st, { mode: 'scene', model: alias, list: list || scenes.map((x) => x.id), back });
  side.st.idx = Math.max(0, side.st.list.indexOf(sceneId));
  showSide(opener);
}
// Show a scene in the browser (from the matrix), with one model picked out if given.
function browseScene(sceneId, alias) {
  stopRace(browser);
  browser.st.idx = browser.st.list.indexOf(sceneId);
  browser.st.model = alias;
  renderView(browser);
  const box = browser.el.view.getBoundingClientRect();
  if (box.top < 60 || box.top > innerHeight * 0.6) browser.el.view.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function showSide(opener) {
  const st = side.st;
  if (opener) st.opener = opener;
  if (!st.open) { history.pushState({ panel: true }, ''); st.pushed = true; }
  st.open = true;
  document.documentElement.classList.add('panel-open');
  side.el.panel.classList.add('open'); side.el.panel.inert = false; side.el.panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('inspecting');
  side.el.scroll.scrollTop = 0;
  renderView(side);
  side.el.title.focus({ preventScroll: true });
}
function closeSide() {
  if (side.st.pushed) { side.st.pushed = false; history.back(); return; }  // popstate then hides it
  hideSide();
}
function hideSide() {
  side.st.open = false;
  document.documentElement.classList.remove('panel-open');
  side.el.panel.classList.remove('open'); side.el.panel.inert = true; side.el.panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('inspecting');
  document.querySelectorAll('tr.model.selected').forEach((r) => r.classList.remove('selected'));
  if (side.st.opener && document.contains(side.st.opener)) side.st.opener.focus({ preventScroll: true });
}
function stepView(v, d) {
  if (v.st.list.length < 2) return;
  stopRace(v);
  v.st.idx = (v.st.idx + d + v.st.list.length) % v.st.list.length;
  renderView(v);
}
// Race the models: replay recorded search times on one clock. Long races play faster so they last about 15 s.
const raceLength = (sc) => Math.max(...models.map((m) => sc.picks[m.model].seconds || 0));
function startRace(v) {
  const sc = sceneById[v.st.list[v.st.idx]];
  const length = raceLength(sc);
  v.st.speed = Math.max(1, length / 15);
  if (v.st.t == null || v.st.t >= length) { v.st.t = 0; v.st.model = null; }  // a new race shows every model
  v.st.racing = true;
  let last = performance.now(), drawn = 0;
  const tick = (now) => {
    if (!v.st.racing) return;
    v.st.t = Math.min(length, v.st.t + ((now - last) / 1000) * v.st.speed);
    last = now;
    if (v.st.t >= length) v.st.racing = false;
    if (now - drawn > 80 || !v.st.racing) { drawn = now; renderView(v); }
    if (v.st.racing) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  renderView(v);
}
function pauseRace(v) { v.st.racing = false; renderView(v); }
function stopRace(v) { v.st.racing = false; v.st.t = null; }

const renderViews = () => { if (side) renderView(side); if (browser) renderView(browser); };

// A model's confidence in its chosen tile, as a probability to 2 decimals (Jev 1.14: its share of the vote).
const prob = (c) => (c == null ? '–' : c.toFixed(2));
const probLabel = (c) => (c == null ? '' : `Prob. ${prob(c)}`);
const PROB_TIP = 'Probability that Waldo is in the chosen tile';

// Short reading of one model's pick on one scene.
function explain(sc, alias) {
  const m = byAlias[alias], p = sc.picks[alias];
  const sure = probLabel(p.confidence);
  if (p.found) return { ok: true, head: 'Found Waldo', body: sure };
  const d = bench.decoys.find((x) => x.scene === sc.id && x.models.includes(alias));
  const who = d && (copy.decoys || {})[d.id] && copy.decoys[d.id].who;
  const [a, b] = [p.box, sc.truth];
  const tilesAway = Math.max(1, Math.round(Math.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2) / 128));
  return { ok: false, head: who ? `Missed: fell for ${who === 'Wenda' ? 'Wenda' : who.toLowerCase()}` : 'Missed Waldo',
    body: `${tilesAway} tile${tilesAway === 1 ? '' : 's'} from Waldo${sure ? ` · ${sure}` : ''}` };
}

function renderView(v) {
  const { el, st } = v;
  if (!el || !st.open) return;
  const focus = st.model ? byAlias[st.model] : null;
  if (st.mode === 'model') {
    const counts = { missed: focus.missesPass1.length, found: scenes.length - focus.missesPass1.length, all: scenes.length };
    el.filters.replaceChildren(...[['missed', 'Missed'], ['found', 'Found'], ['all', 'All']].map(([key, label]) => h('button', {
      type: 'button', 'aria-pressed': String(st.filter === key), disabled: counts[key] === 0,
      onclick: () => { const current = st.list[st.idx]; st.filter = key; st.list = modelList(st); st.idx = Math.max(0, st.list.indexOf(current)); renderView(v); },
    }, `${label} ${counts[key]}`)));
  }
  el.filters.hidden = st.mode !== 'model';
  if (v.kind === 'side') document.querySelectorAll('tr.model').forEach((r) => r.classList.toggle('selected', st.mode === 'model' && r.dataset.model === st.model));
  const sc = sceneById[st.list[st.idx]];
  const t = st.t, length = raceLength(sc);
  const done = (alias) => t == null || (sc.picks[alias].seconds ?? Infinity) <= t;
  if (v.kind === 'browser') {
    el.race.textContent = st.racing ? '❚❚ Pause' : t == null ? '▶ Race the models' : t < length ? '▶ Resume' : '↺ Race again';
    el.clock.textContent = t == null ? '' : `${t.toFixed(1)} s${st.speed > 1.05 ? ` · ${Math.round(st.speed)}× speed` : ''}`;
  }
  el.pos.textContent = `${st.idx + 1} of ${st.list.length}`;
  el.prev.disabled = el.next.disabled = st.list.length < 2;
  const finished = models.filter((m) => done(m.model)).sort((a, b) => sc.picks[a.model].seconds - sc.picks[b.model].seconds);
  const firstFinder = finished.find((m) => sc.picks[m.model].found);
  const racing = t != null && t < length;
  const foundNow = racing ? finished.filter((m) => sc.picks[m.model].found).length : sc.foundBy;
  if (st.mode === 'model') {
    el.kicker.textContent = `${focus.name} · found ${focus.found} of ${focus.searches}`;
    el.title.textContent = `Scene ${sc.number}`;
  } else {
    el.kicker.textContent = `Scene ${sc.number} of ${scenes.length}`;
    el.title.textContent = racing ? `${foundNow} of ${models.length} found so far`
      : sc.foundBy ? `${sc.foundBy} of ${models.length} found Waldo` : `None of the ${models.length} found Waldo`;
  }

  // Verdict: what happened, in words, before the picture.
  if (t != null && !(focus && done(focus.model))) {
    const arrived = focus && heat ? heat[sc.id].times[focus.model].filter((x) => x <= t).length : 0;
    const lead = firstFinder ? `First find: ${firstFinder.short}, ${sec(sc.picks[firstFinder.model].seconds)}` : t >= length ? 'No model found Waldo' : 'No find yet';
    const status = t >= length ? `Done: ${sc.foundBy} of ${models.length} found Waldo` : `${finished.length} of ${models.length} done`;
    el.verdict.replaceChildren(h('div', { class: 'insp-status race-status' }, status), h('p', { text: focus
      ? `${focus.short}: ${arrived} of ${heat[sc.id].tiles.length} tiles answered · ${lead}` : lead }));
  } else if (focus) {
    const x = explain(sc, focus.model);
    el.verdict.replaceChildren(h('div', { class: `insp-status ${x.ok ? 'ok' : 'bad'}` }, h('span', { class: 'icon', text: x.ok ? '✓' : '✗' }), x.head), h('p', { text: x.body }));
  } else {
    el.verdict.replaceChildren();
  }

  // Picture: the striped box is always Waldo; the solid boxes are the tiles models chose.
  if (el.img.getAttribute('src') !== sc.image) { el.img.src = sc.image; el.img.width = sc.width; el.img.height = sc.height; }
  el.img.alt = `Scene ${sc.number}`;
  el.overlay.setAttribute('viewBox', `0 0 ${sc.width} ${sc.height}`);
  el.overlay.replaceChildren(); el.chips.replaceChildren();
  const ns = { 'vector-effect': 'non-scaling-stroke', fill: 'none' };
  const narrow = el.stage.clientWidth > 0 && el.stage.clientWidth < 520;
  const groups = new Map();
  for (const m of models) {
    const p = sc.picks[m.model];
    if (!p.box || !p.complete || (st.mode === 'model' && m.model !== st.model) || !done(m.model)) continue;
    const key = p.box.join(',');
    if (!groups.has(key)) groups.set(key, { box: p.box, aliases: [], found: p.found });
    groups.get(key).aliases.push(m.model);
  }
  // Tags start at the box's left edge, or end at its right edge near the picture's right side so they are never cut off;
  // placeChips then moves any tag that would crowd another. Point at a tag to pick out its box: it comes to the front
  // and everything else fades. Click to keep it picked out; click again to clear.
  const tag = (box, cls, text, edge, tip = PROB_TIP, key = box.join(',')) => el.chips.append(h('span', {
    class: `chip ${cls}`, text, 'data-key': key, 'data-box': box.join(','), 'data-tip': key === 'waldo' ? null : tip,
    onclick: (e) => { e.stopPropagation(); st.front = st.front === key ? null : key; pickOut(v); },
    onpointerenter: (e) => { if (e.pointerType === 'mouse') { st.hover = key; pickOut(v); } },
    onpointerleave: () => { st.hover = null; pickOut(v); },
    style: { ...(box[2] / sc.width > 0.8 ? { right: `${(1 - box[2] / sc.width) * 100}%` } : { left: `${(box[0] / sc.width) * 100}%` }),
      top: `${(box[edge] / sc.height) * 100}%` } }));
  for (const g of groups.values()) {
    const [x0, y0, x1, y1] = g.box;
    const mine = focus && g.aliases.includes(focus.model);
    const faded = focus && !mine;
    const attrs = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, opacity: faded ? 0.3 : 1 };
    el.overlay.append(s('rect', { ...attrs, ...ns, stroke: '#fff', 'stroke-width': mine ? 6 : 3.5, 'data-key': g.box.join(',') }));
    el.overlay.append(s('rect', { ...attrs, ...ns, stroke: mine ? COLORS.pick : COLORS.ink, 'stroke-width': mine ? 3 : 1.5, 'data-key': g.box.join(',') }));
    if (faded) continue;
    // One tag per chosen tile: "d1-ultra 0.85", the model and its probability that Waldo is in that tile, or each model
    // that chose it on its own line, in leaderboard order, numbers lined up. Near the bottom edge the tag sits above the box.
    const who = mine ? [focus.model] : g.aliases;
    const width = Math.max(...who.map((a) => byAlias[a].short.length));
    const many = who.length >= (narrow ? 2 : 3);
    const text = many ? `${who.length} models` : who.map((a) => `${byAlias[a].short.padEnd(width)} ${prob(sc.picks[a].confidence)}`).join('\n');
    const tip = many ? `${g.found ? 'Found Waldo' : 'Missed'} · prob.\n${who.map((a) => `${byAlias[a].short} ${prob(sc.picks[a].confidence)}`).join('\n')}` : PROB_TIP;
    const above = g.box[3] / sc.height > 0.72;
    tag(g.box, `under${above ? ' above' : ''}${who.length > 1 && !many ? ' stack' : ''}${g.found ? ' found' : ''}${mine ? ' mine' : ''}`, text, above ? 1 : 3, tip);
  }
  const pad = 4, [t0, t1, t2, t3] = sc.truth;
  const truth = { x: t0 - pad, y: t1 - pad, width: t2 - t0 + 2 * pad, height: t3 - t1 + 2 * pad, ...ns, 'data-key': 'waldo' };
  el.overlay.append(s('rect', { ...truth, stroke: '#fff', 'stroke-width': 3.5 }), s('rect', { ...truth, stroke: COLORS.random, 'stroke-width': 2 }),
    s('rect', { ...truth, stroke: '#fff', 'stroke-width': 2, 'stroke-dasharray': '4 4' }));
  tag([t0 - pad, t1 - pad, t2 + pad, t3 + pad], 'waldo', 'Waldo', 1, null, 'waldo');
  drawHeat(el.canvas, sc, focus && st.heatOn ? focus.model : null, t);
  // While the focused model is still searching, follow its best guess so far.
  if (focus && t != null && !done(focus.model) && heat) {
    const data = heat[sc.id], values = data.heat[focus.model], times = data.times[focus.model];
    let best = -1;
    values.forEach((val, i) => { if (val != null && times[i] <= t && (best < 0 || val > values[best])) best = i; });
    if (best >= 0) {
      const [x0, y0, x1, y1] = data.tiles[best];
      el.overlay.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, ...ns, stroke: COLORS.pick, 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
      tag(data.tiles[best], 'under mine', `${focus.short} ${prob(values[best])} so far`, 3);
    }
  }
  placeChips(el.chips, sc);
  pickOut(v);

  // Legend: every mark on the picture, named.
  const swatch = (cls) => h('i', { class: `sw ${cls}` });
  el.legend.replaceChildren(...[
    h('span', {}, swatch('waldo'), 'Waldo'),
    ...(focus ? [h('span', {}, swatch('pick'), `${focus.short}’s pick`)]
      : [h('span', {}, swatch('any'), 'Model pick'), h('span', {}, swatch('tag-found'), 'Found'), h('span', {}, swatch('tag-miss'), 'Missed')]),
    sc.masked ? h('span', {}, swatch('masked'), 'Printed text hidden') : null,
    focus ? h('label', { class: 'toggle' }, el.heatToggle, 'Heat map') : null].filter(Boolean));

  // Close-ups: what the model chose next to the real Waldo.
  const fig = (src, cap, cls = '') => h('figure', { class: cls }, h('img', { src, alt: cap }), h('figcaption', { text: cap }));
  const pick = focus && done(focus.model) && sc.picks[focus.model];
  const compareKey = `${sc.id}|${pick ? focus.model : ''}`;
  if (el.compare.dataset.key !== compareKey) el.compare.dataset.key = compareKey, el.compare.replaceChildren(...(pick && pick.tileImage
    ? [fig(pick.tileImage, 'Its pick', pick.found ? 'ok' : 'bad'), fig(sc.waldoCrop, 'Waldo', 'real')]
    : [fig(sc.waldoCrop, 'Waldo', 'real')]));

  // Model mode: a link to every model on this scene. Scene mode: the list of models to pick from.
  el.switcher.replaceChildren();
  el.list.replaceChildren();
  if (st.mode === 'model') {
    el.switcher.append(h('button', { class: 'linkbtn', type: 'button', onclick: () => openScene(sc.id, st.model, st.list, null, { model: st.model, filter: st.filter }) },
      `${sc.foundBy} of ${models.length} found Waldo · compare all\u00a0→`));
  } else {
    if (st.back) {
      const back = st.back;
      el.switcher.append(h('button', { class: 'linkbtn', type: 'button', onclick: () => {
        Object.assign(st, { mode: 'model', model: back.model, filter: back.filter, back: null });
        st.list = modelList(st); st.idx = Math.max(0, st.list.indexOf(sc.id)); renderView(v);
      } }, `← Back to ${byAlias[back.model].short}`));
    }
    const choose = (alias) => {
      st.model = alias; st.hover = null; renderView(v);
      const r = el.stage.getBoundingClientRect();
      if (Math.min(r.bottom, innerHeight) - Math.max(r.top, 56) < r.height / 2) el.stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const point = (key) => ({ 'data-key': key, onpointerenter: (e) => { if (e.pointerType === 'mouse' && key) { st.hover = key; pickOut(v); } },
      onpointerleave: () => { if (st.hover) { st.hover = null; pickOut(v); } } });
    // Prob. (highest first) and Time (fastest first) sort the list; a 2nd click reverses it. Otherwise, and during
    // a race (so the finish order stays hidden), the list follows the leaderboard.
    const by = t == null && { prob: (m) => -(sc.picks[m.model].confidence ?? -1), time: (m) => sc.picks[m.model].seconds ?? 1e9 }[st.listSort];
    const listed = by ? [...models].sort((a, b) => st.listDir * (by(a) - by(b))) : models;
    const colHead = (key, label, tip) => h('button', { type: 'button', 'data-tip': tip, 'aria-pressed': String(st.listSort === key),
      onclick: (e) => { e.stopPropagation(); st.listDir = st.listSort === key ? -st.listDir : 1; st.listSort = key; renderView(v); } },
    label, st.listSort === key ? ((key === 'prob') === (st.listDir > 0) ? ' ▼' : ' ▲') : '');
    el.list.append(h('li', { 'aria-pressed': String(!focus), tabindex: 0, onclick: () => choose(null), onkeydown: (e) => { if (e.key === 'Enter') choose(null); } },
      h('span', { class: 'who' }, 'All models', h('span', { class: 'muted', text: `${foundNow} found` })),
      h('span', { class: 'cols head' }, colHead('prob', 'Prob.', PROB_TIP), colHead('time', 'Time', 'Seconds to search the whole scene'))),
    ...listed.map((m) => {
      const p = sc.picks[m.model];
      if (!done(m.model)) {
        const pickIt = () => choose(st.model === m.model ? null : m.model);
        return h('li', { 'aria-pressed': String(st.model === m.model), tabindex: 0, onclick: pickIt, onkeydown: (e) => { if (e.key === 'Enter') pickIt(); } },
          h('span', { class: 'who' }, h('span', { class: 'tag plain', text: '…', title: 'searching' }), v.kind === 'browser' ? m.short : m.name),
          h('span', { class: 'race-bar' }, h('i', { style: { width: `${Math.min(100, (100 * t) / p.seconds)}%` } })));
      }
      const state = p.found ? ['✓ Found', 'found'] : ['✗ Missed', 'miss'];
      const pickIt = () => choose(st.model === m.model ? null : m.model);
      return h('li', { 'aria-pressed': String(st.model === m.model), tabindex: 0, onclick: pickIt, onkeydown: (e) => { if (e.key === 'Enter') pickIt(); },
        ...point(p.box && p.complete ? p.box.join(',') : null) },
        h('span', { class: 'who' }, h('span', { class: `tag ${state[1]}`, text: v.kind === 'browser' ? state[0].slice(0, 1) : state[0], title: state[0].slice(2) }), v.kind === 'browser' ? m.short : m.name),
        h('span', { class: 'cols num' }, h('span', { text: prob(p.confidence) }), h('span', { text: p.seconds == null ? '–' : p.seconds.toFixed(2) })));
    }));
  }

  // Scene list: a strip under the side panel, or the scrolling column beside the browser.
  if (v.kind === 'browser') {
    if (!el.strip.children.length) {
      el.strip.append(...st.list.map((id, i) => {
        const x = sceneById[id];
        return h('button', { type: 'button', class: 'b-item', role: 'option', tabindex: -1, 'aria-label': `Scene ${x.number}, found by ${x.foundBy} of ${models.length}`,
          onclick: () => { stopRace(v); st.idx = i; renderView(v); } },
        h('img', { src: x.thumb, alt: '', loading: 'lazy' }),
        h('div', { class: 'cap' }, h('span', { class: 'id', text: `#${x.number}` }),
          h('span', { class: 'meter', title: `Found by ${x.foundBy} of ${models.length}` }, models.map((_, k) => h('i', { class: k < x.foundBy ? 'on' : '' })))));
      }));
    }
    [...el.strip.children].forEach((item, i) => { item.setAttribute('aria-selected', String(i === st.idx)); item.tabIndex = i === st.idx ? 0 : -1; });
    const current = el.strip.children[st.idx];
    // Keep the chosen scene visible in the list (scrolls only the list, never the page).
    const top = current.getBoundingClientRect().top - el.strip.getBoundingClientRect().top + el.strip.scrollTop;
    if (top < el.strip.scrollTop || top + current.offsetHeight > el.strip.scrollTop + el.strip.clientHeight) el.strip.scrollTop = top - el.strip.clientHeight / 3;
    if (el.strip.scrollWidth > el.strip.clientWidth) el.strip.scrollLeft = current.offsetLeft - el.strip.clientWidth / 2 + current.clientWidth / 2;
  } else {
    el.strip.replaceChildren(...st.list.map((id, i) => {
      const x = sceneById[id];
      const status = st.mode === 'model' ? (x.picks[st.model].found ? 'ok' : 'bad') : '';
      return h('button', { type: 'button', class: `strip-item ${status}`, 'aria-current': i === st.idx ? 'true' : null, 'aria-label': `Scene ${x.number}`, onclick: () => { st.idx = i; renderView(v); } },
        h('img', { src: x.thumb, alt: '', loading: 'lazy' }), h('span', { text: `#${x.number}` }));
    }));
    const current = el.strip.children[st.idx];
    if (current) el.strip.scrollLeft = current.offsetLeft - el.strip.clientWidth / 2 + current.clientWidth / 2;
  }
}

// Every tag sits against its own box: below, above, beside (level with its top or bottom) or just inside it. Of those spots, a tag takes one that
// stays in the picture and clear of other tags, preferring the spot that covers the least of other boxes (a tag inside
// a neighbour's box reads as that box's tag). Waldo's tag goes first, then the biggest tags, which have the fewest spots.
// A tag with no free spot goes to the nearest free place and gets a thin line back to its box.
function placeChips(chips, sc) {
  // Height from the scene's own shape: right after a scene change the old picture can still be showing, at its height.
  const W = chips.clientWidth, H = (W * sc.height) / sc.width;
  if (!W) return;
  const kx = W / sc.width, ky = kx, gap = 3;
  const items = [...chips.querySelectorAll('.chip')].map((c) => {
    const [x0, y0, x1, y1] = c.dataset.box.split(',').map(Number);
    return { c, waldo: c.classList.contains('waldo'), w: c.offsetWidth, h: c.offsetHeight, b: { l: x0 * kx, t: y0 * ky, r: x1 * kx, b: y1 * ky } };
  });
  const cover = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const rect = (x, y, it) => ({ l: x, t: y, r: x + it.w, b: y + it.h });
  const inside = (q) => q.l >= 0 && q.t >= 0 && q.r <= W && q.b <= H;
  const placed = [];
  const hit = (q) => placed.find((p) => q.l < p.r - 1 && q.r > p.l + 1 && q.t < p.b - 1 && q.b > p.t + 1);  // tags may touch, never overlap
  items.sort((a, z) => z.waldo - a.waldo || z.w * z.h - a.w * a.h);
  for (const it of items) {
    const { b, w, h } = it;
    const clampX = (v) => Math.max(0, Math.min(v, W - w));
    const x = clampX(b.l + w > W ? b.r - w : b.l), y = Math.max(0, Math.min(b.t, H - h)), y2 = Math.max(0, b.b - h);
    const below = rect(x, b.b + gap, it), above = rect(x, b.t - h - gap, it);
    // Above or below, a tag can line up with the box's left edge, right edge or centre.
    const along = (top) => [x, clampX(b.r - w), clampX((b.l + b.r - w) / 2)].map((left) => rect(left, top, it));
    const [first, second] = b.b / H > 0.72 ? [above.t, below.t] : [below.t, above.t];
    // Waldo's tag always sits on top of his box (under it at the picture's top edge).
    const spots = it.waldo ? [above, below] : [...along(first), ...along(second),
      rect(b.r + gap, y, it), rect(b.l - w - gap, y, it), rect(b.r + gap, y2, it), rect(b.l - w - gap, y2, it), rect(x, b.t + gap, it)];
    // Covering another box costs 3 times the area covered; each step down the list of spots costs 5% of the tag's own area.
    const cost = (q, i) => items.reduce((sum, o) => sum + (o === it ? 0 : 3 * cover(q, o.b)), 0) + i * 0.05 * w * h;
    let spot = spots.map((q, i) => ({ q, c: cost(q, i) })).filter((s) => inside(s.q) && !hit(s.q)).sort((a, z) => a.c - z.c)[0]?.q;
    if (!spot) {
      // No free spot against the box: take the nearest free place in the picture, every 6 px, counting each 1% of
      // the tag over another box as 0.3 px further away, so the line back to the box stays short. In a picture too
      // crowded for any free place, each 1% of the tag over another tag counts as 100 px.
      const gapTo = (q) => Math.hypot(Math.max(0, b.l - q.r, q.l - b.r), Math.max(0, b.t - q.b, q.t - b.b));
      const share = (q, rs) => rs.reduce((sum, r) => sum + cover(q, r), 0) / (w * h);
      let best = Infinity;
      for (let top = 0; top <= Math.max(0, H - h); top += 6) for (let left = 0; left <= Math.max(0, W - w); left += 6) {
        const q = rect(left, top, it);
        const score = gapTo(q) + 30 * share(q, items.filter((o) => o !== it).map((o) => o.b)) + 10000 * share(q, placed);
        if (score < best) { best = score; spot = q; }
      }
    }
    placed.push(spot);
    Object.assign(it.c.style, { left: `${(100 * spot.l) / W}%`, top: `${(100 * spot.t) / H}%`, right: 'auto', transform: 'none' });
    // A tag that ended up away from its box gets a line from its nearest edge to the box.
    const near = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const bx = near((spot.l + spot.r) / 2, b.l, b.r), by = near((spot.t + spot.b) / 2, b.t, b.b);
    const cx = near(bx, spot.l, spot.r), cy = near(by, spot.t, spot.b);
    if (Math.hypot(bx - cx, by - cy) > gap + 2) {
      let svg = chips.querySelector('svg.leaders');
      if (!svg) chips.append(svg = s('svg', { class: 'leaders', 'aria-hidden': 'true' }));
      svg.append(s('line', { x1: cx, y1: cy, x2: bx, y2: by, 'data-key': it.c.dataset.key }));
    }
  }
}

// Highlight the picked-out box and its tag; fade the rest (Waldo's own box always stays visible).
function pickOut(v) {
  const { el, st } = v;
  const key = st.hover || st.front;
  const on = Boolean(key && el.chips.querySelector(`[data-key="${CSS.escape(key)}"]`));
  el.stage.classList.toggle('picking', on);
  el.chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('front', on && c.dataset.key === key));
  el.overlay.querySelectorAll('rect').forEach((r) => r.classList.toggle('sel', on && r.dataset.key === key));
  el.chips.querySelectorAll('.leaders line').forEach((l) => l.classList.toggle('sel', on && l.dataset.key === key));
  el.list.querySelectorAll('li[data-key]').forEach((li) => li.classList.toggle('lit', on && li.dataset.key === key));
}

function drawHeat(canvas, sc, alias, t = null) {
  const data = heat && heat[sc.id];
  if (!alias || !data) { canvas.style.display = 'none'; return; }
  // During a race, only tiles whose answer has already come back count.
  const values = t == null ? data.heat[alias] : data.heat[alias].map((val, i) => (data.times[alias][i] <= t ? val : null));
  const max = Math.max(...data.heat[alias].filter((v) => v != null), 1e-9);
  const cell = 8;
  const cw = Math.ceil(sc.width / cell), ch = Math.ceil(sc.height / cell);
  const grid = new Float32Array(cw * ch);
  data.tiles.forEach((b, i) => {
    const v = values[i];
    if (v == null) return;
    const n = v / max;
    for (let cy = Math.floor(b[1] / cell); cy < Math.min(ch, Math.ceil(b[3] / cell)); cy++)
      for (let cx = Math.floor(b[0] / cell); cx < Math.min(cw, Math.ceil(b[2] / cell)); cx++)
        if (n > grid[cy * cw + cx]) grid[cy * cw + cx] = n;
  });
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(cw, ch);
  for (let i = 0; i < grid.length; i++) {
    image.data[i * 4] = 12; image.data[i * 4 + 1] = 14; image.data[i * 4 + 2] = 20;
    image.data[i * 4 + 3] = Math.round(255 * 0.62 * (1 - Math.sqrt(grid[i])));
  }
  ctx.putImageData(image, 0, 0);
  canvas.style.display = 'block';
}

function buildScenes() {
  buildMatrix();
  buildViews();
}

/* ---------- Model × scene matrix ---------- */
// Columns run from the scene most models found to the one fewest did (ties by scene number).
const matrixOrder = () => [...scenes].sort((a, b) => b.foundBy - a.foundBy || a.number - b.number);

function buildMatrix() {
  const order = matrixOrder(), grid = $('#matrix'), card = $('#matrix-card');
  setAttrs(grid, { role: 'group', 'aria-label': `Found or missed: ${models.length} rows by ${order.length} scenes. Arrow keys move between squares.`,
    style: { gridTemplateColumns: `max-content repeat(${order.length}, var(--cell)) max-content`, gridTemplateRows: `repeat(${models.length}, var(--cell)) auto` } });
  const cells = models.map((m, r) => {
    const row = order.map((sc, c) => {
      const p = sc.picks[m.model];
      const tip = `${m.short} · Scene ${sc.number}: ${p.found ? 'found' : 'missed'}${p.confidence == null ? '' : `, prob. ${prob(p.confidence)}`}`;
      return h('button', { type: 'button', class: p.found ? 'm-cell on' : 'm-cell', tabindex: r || c ? -1 : 0, 'data-r': r, 'data-c': c,
        'data-tip': tip, 'aria-label': tip, onclick: () => browseScene(sc.id, m.model) });
    });
    grid.append(h('div', { class: 'm-label', text: m.short }), ...row,
      h('div', { class: 'm-total num', 'data-tip': `${m.short} found Waldo in ${m.found} of ${m.searches} scenes`, text: m.found }));
    return row;
  });
  // Under each column, a bar as tall as the share of models that found Waldo there.
  grid.append(h('div', { class: 'm-label m-foot', text: 'Found by' }),
    ...order.map((sc) => h('div', { class: 'm-count m-foot', 'data-tip': `Scene ${sc.number}: found by ${sc.foundBy} of ${models.length}` },
      h('i', { style: { height: `${(100 * sc.foundBy) / models.length}%` } }))), h('div'));
  // One tab stop for the whole matrix; arrow keys, Home and End move between squares.
  let stop = cells[0][0];
  grid.addEventListener('focusin', (e) => {
    if (!e.target.matches('.m-cell') || e.target === stop) return;
    stop.tabIndex = -1; stop = e.target; stop.tabIndex = 0;
  });
  grid.addEventListener('keydown', (e) => {
    const d = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0], Home: [0, -Infinity], End: [0, Infinity] }[e.key];
    if (!d || !e.target.matches('.m-cell')) return;
    e.preventDefault();
    const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
    cells[clamp(+e.target.dataset.r + d[0], cells.length - 1)][clamp(+e.target.dataset.c + d[1], order.length - 1)].focus();
  });
  scrollFade(grid.parentElement, false);  // no left fade: the model names stay put on the left
  card.append(h('div', { class: 'chart-foot' },
    h('span', { class: 'm-key note' }, h('span', {}, h('i', { class: 'on' }), 'Found Waldo'), h('span', {}, h('i'), 'Missed')),
    h('span', { class: 'note', text: 'Scenes: most found → fewest' })));
}

/* ---------- Method ---------- */
function buildMethod() {
  const dl = $('#method-list');
  const item = (term, ...body) => { dl.append(h('dt', { text: term }), h('dd', {}, ...body)); };
  const p = (text) => h('p', { text });
  const pre = (text) => h('pre', { class: 'prompt', text });
  const d = bench.dataset;
  item('The task',
    p(`${d.pictures} scenes from the IVSN Waldo set. We cut each scene into ${d.tilePx} px tiles, 1 every ${d.stridePx} px, so the tiles overlap. Each scene has ${d.tilesPerPicture[0]}–${d.tilesPerPicture[1]} tiles, ${d.tiles.toLocaleString()} in all. We enlarge each tile to ${d.sentPx} px before we send it.`),
    p(`${scenes.filter((sc) => sc.masked).length} scenes have printed text, such as titles. We paint it grey, using the masks that come with the dataset.`),
    p('Each labelled Waldo fits inside 1 tile.'));
  item('What each model saw',
    h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } },
      h('img', { src: 'assets/reference.jpg', alt: 'The reference picture of Waldo', style: { width: '96px', borderRadius: '4px' } }),
      h('div', { style: { flex: '1', minWidth: '240px' } },
        p('All models get the same tiles, the same picture of Waldo and the same text. Every model gets 1 request per tile: this picture, the tile and 1 yes/no question (a Noul, through the OpenRouter Decisions API). The Noul gives P(yes). The tile with the highest P(yes) is the answer.'),
        pre(bench.prompts.noul),
        pre(`yes: ${bench.prompts.criteria.true}\nno:  ${bench.prompts.criteria.false}`))),
    h('h3', { class: 'method-sub', text: 'Why Jev 1.14 has 3 rows' }),
    p('We run every model every way its API allows. All 11 models can take 1 tile per request, so every model has that row. Only Jev 1.14 can also take a whole scene in 1 request, because it reads an image inside each question. The other models do not, or accept only a few images per request.'),
    p('So Jev 1.14 has 2 more rows. Yes/no, batched: 1 request per scene, with the picture of Waldo once and 1 yes/no question per tile. It is scored like the per-tile method.'),
    pre(`${bench.prompts.batchedLead} [tile] ${bench.prompts.batchedQuestion}`),
    p('Choice: 1 request per scene, with all tiles of the scene as the options. TypeSafe documents this method for large images.'),
    pre(`${bench.prompts.choiceLead} [reference picture] ${bench.prompts.choiceDetail}`),
    p('The tiles, picture and wording are the same in every method. Decider Flash V1.2 can also take a whole scene, but Perplexity rate-limited those requests so often that the test was not fair, so it has only its per-tile row.'));
  item('Scoring',
    p('Found: the chosen tile touches the labelled Waldo box. If 2 tiles have the same score, a fixed hash selects 1, the same for all models.'),
    p('Confidence: the P(yes) of the chosen tile. For Jev 1.14 (Choice) it is the vote share of the chosen tile, so the confidence chart leaves it out.'),
    p(`Baselines: random tile ${pct(bench.baselines.random['128'], 1)} (the average share of tiles that touch Waldo). Middle tile ${pct(bench.baselines.middle, 1)}.`));
  item('Time',
    p('Median time to search 1 whole scene. We count only successful requests: we measure speed when the model works, not how reliable its provider is.'),
    p('1 request per tile: each model ran alone, 1 scene at a time, with 16 tile requests at a time. Jev 1.14’s whole-scene methods: the time of the 1 request, 1 scene at a time.'));
  item('Uncertainty',
    p('Likely range: where the found rate would probably land on a new set of similar scenes. We re-draw the scenes at random 4,000 times and keep the middle 95%.'),
    p('Each row is 1 run. Asked again with the same requests, d1-ultra, d1 and Jev 1.14 give slightly different answers (2 to 3 scenes per run). The other models give the same answers.'),
    p(`The table shows ${models[0].short}’s lead over each model. Both are measured on the same re-drawn scenes, so the luck of the draw cancels out.`),
    h('table', { class: 'table-view' }, h('thead', {}, h('tr', {}, h('th', { text: `${models[0].short} minus` }), h('th', { text: 'Gap' }), h('th', { text: '95% interval' }))),
      h('tbody', {}, bench.paired.map((g) => h('tr', {}, h('td', { text: byAlias[g.model].name }), h('td', { text: `+${Math.round(g.gap * 100)} pts` }),
        h('td', { text: `${Math.round(g.ci95[0] * 100)} to ${Math.round(g.ci95[1] * 100)}` }))))));
  item('Cost',
    p('The usage.cost that OpenRouter billed for the requests behind the answers, per scene. As for time, attempts that failed and searches we ran again are left out.'),
    h('table', { class: 'table-view' }, h('thead', {}, h('tr', {}, ['Model', 'Per scene', `All ${scenes.length} scenes`].map((t) => h('th', { text: t })))),
      h('tbody', {}, models.map((m) => {
        const billed = perScene(m) * m.searches;
        return h('tr', {}, h('td', { text: m.name }), h('td', { text: money(perScene(m)) }), h('td', { text: `$${billed.toFixed(3)}` }));
      }))));
  item('Models',
    h('table', { class: 'table-view' }, h('thead', {}, h('tr', {}, ['Model', 'OpenRouter id', 'Provider'].map((t) => h('th', { text: t })))),
      h('tbody', {}, models.filter((m, i) => models.findIndex((o) => o.model_id === m.model_id) === i)
        .map((m) => h('tr', {}, h('td', { text: m.baseName || m.name }), h('td', { text: m.model_id, class: 'mono' }), h('td', { text: m.provider }))))));
  item('Reproduce',
    h('p', {}, 'The code is at ', h('a', { href: 'https://github.com/musubipapi/waldo-bench', target: '_blank', rel: 'noopener', text: 'github.com/musubipapi/waldo-bench' }), '. Get Part 1 of the IVSN datasets from the ', h('a', { href: bench.attribution.repository, target: '_blank', rel: 'noopener', text: 'Kreiman lab repository' }), ', then:'),
    pre(['uv run python -m waldobench extract <archive.tar.gz>', 'uv run python -m waldobench prepare --tile 128',
      'uv run python -m waldobench run-tiles    # every model, 1 request per tile',
      'uv run python -m waldobench run-jev      # Jev 1.14, Choice',
      'uv run python -m waldobench run-batched  # Jev 1.14, yes/no batched',
      'uv run python -m waldobench results --runs my-runs.json --output results/mine',
      'uv run python -m waldobench site --runs my-runs.json --results results/mine'].join('\n')));
}
