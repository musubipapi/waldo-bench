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
const shownTime = (m) => Number(m.p50_search_s.toFixed(1));
const best = (key) => { const v = Math.min(...models.map(key)); return models.filter((m) => key(m) === v); };
const names = (ms) => ms.map((m) => m.name).join(' and ');
const sec = (x) => `${x.toFixed(1)} s`;
const COLORS = { lead: '#2a78d6', other: '#c2c2c2', random: '#d8262c', ink: '#111111', hair: '#ececec' };

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
  buildFacts();
  buildBoard();
  buildCharts();
  buildDecoys();
  buildScenes();
  buildMethod();
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
  window.addEventListener('scroll', hide, { passive: true });
}

/* ---------- Facts ---------- */
function buildFacts() {
  const lead = models[0];
  const cheapest = best(shownCost), quickest = best(shownTime);
  const facts = [
    ['Most found', pct(lead.found_rate), `${lead.name}, ${lead.found} of ${lead.searches}`],
    ['Cheapest', money(perScene(cheapest[0])), `${names(cheapest)}, to search one scene`],
    ['Quickest', sec(quickest[0].p50_search_s), `${names(quickest)}, typical search`],
  ];
  $('#facts').append(...facts.map(([label, value, sub]) => h('div', { class: 'fact' },
    h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }), h('div', { class: 'sub', text: sub }))));
}

function outclassed(m) {
  if (!m.beatenBy.length) return null;
  const o = byAlias[m.beatenBy[0]];
  const pairs = [['accuracy', o.found, m.found], ['price', -shownCost(o), -shownCost(m)], ['speed', -shownTime(o), -shownTime(m)]];
  const and = (xs) => xs.join(xs.length === 3 ? ', ' : ' and ').replace(/, (?=[^,]*$)/, ' and ');
  const better = pairs.filter(([, a, b]) => a > b).map(([k]) => k), same = pairs.filter(([, a, b]) => a === b).map(([k]) => k);
  return same.length ? `Matched on ${and(same)} and beaten on ${and(better)} by ${o.short}.` : `Beaten on ${and(better)} by ${o.short}.`;
}

/* ---------- Leaderboard ---------- */
const rangeText = (ci) => `${Math.round(100 * ci[0])}–${Math.round(100 * ci[1])}%`;
const chevron = () => { const v = s('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' }); v.append(s('path', { d: 'M4 2l4 4-4 4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 })); return v; };

function buildBoard() {
  const table = $('#board');
  const cheapest = best(shownCost).map((m) => m.model), quickest = best(shownTime).map((m) => m.model);
  table.append(h('thead', {}, h('tr', {},
    h('th', { text: '#' }), h('th', { text: 'Model' }), h('th', { class: 'r', text: 'Found' }),
    h('th', { class: 'r range', 'data-tip': 'The 95% interval. With only 66 scenes, luck matters: on a fresh set of similar scenes, the found rate would likely land in this range. Ranges that overlap a lot are too close to call.' },
      'Likely range ', h('span', { class: 'info', tabindex: 0, 'aria-label': 'What is the likely range?', text: 'ⓘ' })),
    h('th', { class: 'r hide-sm', text: 'Cost / scene' }), h('th', { class: 'r hide-sm', text: 'Typical search' }), h('th', {}))));
  const body = h('tbody');
  table.append(body);
  for (const m of models) {
    const lead = m.rank === 1;
    const pills = [];
    if (lead) pills.push(h('span', { class: 'pill red', text: 'Most found' }));
    if (cheapest.includes(m.model)) pills.push(h('span', { class: 'pill outline', text: 'Cheapest' }));
    if (quickest.includes(m.model)) pills.push(h('span', { class: 'pill outline', text: 'Quickest' }));
    if (m.method === 'one-call') pills.push(h('span', { class: 'pill outline', text: 'One call' }));
    const note = (copy.models || {})[m.model];
    const row = h('tr', { class: 'model', tabindex: 0, 'aria-expanded': 'false', 'data-model': m.model },
      h('td', { class: 'rank', text: m.rank }),
      h('td', {}, h('div', {}, h('span', { class: 'name', text: m.name }), h('span', { class: 'maker', text: m.maker }), ...pills),
        note ? h('div', { class: 'blurb', text: note }) : null,
        outclassed(m) ? h('div', { class: 'beaten', text: outclassed(m) }) : null,
        h('div', { class: 'sm-only note num', text: `${money(perScene(m))} a scene · ${sec(m.p50_search_s)} typical` })),
      h('td', { class: 'r found num' }, h('b', { text: pct(m.found_rate) }), h('div', { class: 'of', text: `${m.found} of ${m.searches}` }),
        m.unfinished ? h('div', { class: 'of', text: `${m.unfinished} unfinished` }) : null),
      h('td', { class: 'r range num', 'data-tip': `On a fresh set of similar scenes, ${m.short} would likely find Waldo ${rangeText(m.found_ci95)} of the time. It scored ${pct(m.found_rate)} here.` }, rangeText(m.found_ci95)),
      h('td', { class: 'r num hide-sm', text: money(perScene(m)) }),
      h('td', { class: 'r num hide-sm', text: sec(m.p50_search_s) }),
      h('td', { class: 'chev' }, h('span', { class: 'open-hint' }, `${m.missesPass1.length} misses`, chevron())));
    const toggle = () => toggleDetail(row, m);
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    body.append(row);
  }
  // You: straight after the models, boxed, with a clear way in to the game.
  const you = readYou();
  const mine = you && (you.normal || you.hard);
  const mode = you && (you.normal ? 'Normal' : 'Hard');
  const play = () => { location.href = 'play.html'; };
  body.append(h('tr', { class: 'you', tabindex: 0, role: 'link', 'aria-label': 'Play: you against the models', onclick: play, onkeydown: (e) => { if (e.key === 'Enter') play(); } },
    h('td', { class: 'rank', text: '?' }),
    h('td', {}, h('span', { class: 'name', text: 'You' }), h('span', { class: 'pill red', text: 'Your turn' }),
      h('div', { class: 'blurb', text: mine ? `Your best ${mode.toLowerCase()} round. Ten scenes, one click each: can you beat d1-ultra?` : 'Can you beat them? Ten scenes, one click each, against the clock.' })),
    h('td', { class: 'r found num' }, mine ? [h('b', { text: pct(mine.found / mine.n) }), h('div', { class: 'of', text: `${mine.found} of ${mine.n}` })] : null),
    h('td', { class: 'range' }),
    h('td', { class: 'hide-sm' }),
    h('td', { class: 'r num hide-sm', text: mine && mine.medianSeconds != null ? sec(mine.medianSeconds) : '' }),
    h('td', { class: 'r' }, h('a', { class: 'btn', href: 'play.html', onclick: (e) => e.stopPropagation(), text: mine ? 'Play again →' : 'Play →' }))));
  body.append(h('tr', { class: 'group' }, h('td', { colspan: 7, text: 'Baselines' })));
  const baseline = (name, value, blurb) => h('tr', { class: 'baseline' },
    h('td', { class: 'rank', text: '–' }), h('td', {}, h('span', { class: 'name', text: name }), h('div', { class: 'blurb', text: blurb })),
    h('td', { class: 'r found num' }, h('b', { text: pct(value, 1) })), h('td', { class: 'range' }),
    h('td', { class: 'r hide-sm', text: '–' }), h('td', { class: 'r hide-sm', text: '–' }), h('td', {}));
  body.append(baseline('Random tile', bench.baselines.random['128'], 'Any tile, picked blind.'));
  body.append(baseline('Always the middle', bench.baselines.middle, 'The tile nearest the centre of every scene.'));
  const lead = models[0];
  const closest = bench.paired[0];
  $('#board-note').textContent = `Found means the chosen tile overlaps the labelled Waldo. `
    + `Likely range is the 95% interval: on a fresh set of similar scenes, each model's found rate would likely land inside it (from re-drawing the ${bench.dataset.sceneGroups} source illustrations 4,000 times). Ranges that overlap a lot are too close to call. Cost is the billed OpenRouter price to search one whole scene (about 211 tile requests; Jev 1.14: one request holding every tile); typical search is the median wall time for one whole scene with 16 tile requests in flight (Jev 1.14: one request). `
    + `${lead.name}'s lead holds against every model when compared scene by scene: the closest, ${byAlias[closest.model].name}, trails by ${Math.round(100 * closest.gap)} points (95% interval ${Math.round(100 * closest.ci95[0])} to ${Math.round(100 * closest.ci95[1])}).`;
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
    return h('figure', { role: 'button', tabindex: 0, title: `Scene ${sc.number}: see it beside the real Waldo`,
      onclick: (e) => openOne(sc, e.currentTarget), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOne(sc, e.currentTarget); } } },
    h('img', { src: pick.tileImage, alt: `Tile ${m.name} chose in scene ${sc.number}`, loading: 'lazy' }),
    h('figcaption', {}, h('b', { text: `Scene ${sc.number}` }), h('span', { text: sureLabel(m, pick.confidence) })));
  }));
  row.after(h('tr', { class: 'detail' }, h('td', { colspan: 7 },
    h('p', { class: 'detail-head' }, h('b', { text: `Missed ${misses.length} of ${scenes.length}.` }), ' ',
      `Each picture is the tile ${m.short} chose instead of Waldo, and how sure it was. Click one to see it beside the real Waldo.`),
    grid)));
}

/* ---------- Charts ---------- */
function chartTip(container) {
  const tip = h('div', { class: 'tip', role: 'status' });
  container.append(tip);
  return {
    show(x, y, title, rows) {
      tip.replaceChildren(h('div', { class: 't', text: title }), ...rows.map((r) => h('div', { class: 'row' },
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
function curveSeries() {
  const entries = bench.curve;
  return models.map((m) => {
    const points = [];
    for (const px of [384, 192, 128]) {
      let e = entries.find((x) => x.model === m.model && x.tile_px === px && x.method === 'parallel');
      let oneCall = false;
      if (!e) { e = entries.find((x) => x.model === m.model && x.tile_px === px && x.method === 'one-call'); oneCall = !!e; }
      if (e) points.push({ px, v: e.found_rate, oneCall });
    }
    return { model: m, points };
  });
}

function drawCurve() {
  const host = $('#curve');
  host.replaceChildren();
  const W = Math.max(300, host.clientWidth), H = 300;
  const M = { l: 40, r: 118, t: 12, b: 44 };
  const xs = [384, 192, 128];
  const x = (px) => M.l + (xs.indexOf(px) / 2) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - v) * (H - M.t - M.b);
  const series = curveSeries();
  const random = xs.map((px) => ({ px, v: bench.baselines.random[String(px)] }));
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Found rate by tile size for each model' });
  const grid = s('g', { class: 'grid' });
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    grid.append(s('line', { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), stroke: t === 0 ? '#cfcfcf' : COLORS.hair }));
    svg.append(s('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick-label' }, `${t * 100}%`));
  }
  svg.prepend(grid);
  for (const px of xs) svg.append(s('text', { x: x(px), y: H - M.b + 18, 'text-anchor': 'middle', class: 'tick-label' }, `${px} px`));
  svg.append(s('text', { x: (M.l + W - M.r) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' }, 'Tile size · smaller →'));
  const line = (pts, color, width) => s('polyline', { points: pts.map((p) => `${x(p.px)},${y(p.v)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  for (const sr of series.slice(1)) svg.append(line(sr.points, COLORS.other, 1.5));
  svg.append(line(random, COLORS.random, 1.5));
  svg.append(line(series[0].points, COLORS.lead, 2.5));
  for (const sr of series.slice(1)) for (const p of sr.points)
    svg.append(s('circle', { cx: x(p.px), cy: y(p.v), r: 3, fill: p.oneCall ? '#fff' : COLORS.other, stroke: p.oneCall ? '#9a9a9a' : '#fff', 'stroke-width': 1.5 }));
  for (const p of random) svg.append(s('circle', { cx: x(p.px), cy: y(p.v), r: 3.5, fill: COLORS.random, stroke: '#fff', 'stroke-width': 2 }));
  for (const p of series[0].points) svg.append(s('circle', { cx: x(p.px), cy: y(p.v), r: 4.5, fill: COLORS.lead, stroke: '#fff', 'stroke-width': 2 }));
  const lastLead = series[0].points.at(-1), lastRandom = random.at(-1);
  svg.append(s('text', { x: x(128) + 10, y: y(lastLead.v) + 4, class: 'label strong' }, `${series[0].model.short} ${pct(lastLead.v)}`));
  svg.append(s('text', { x: x(128) + 10, y: y(lastRandom.v) + 4, class: 'label' }, `Random ${pct(lastRandom.v, 1)}`));
  const others = series.slice(1).map((sr) => sr.points.at(-1).v);
  const mid = (Math.min(...others) + Math.max(...others)) / 2;
  svg.append(s('text', { x: x(128) + 10, y: y(mid) + 4, class: 'label' }, `${others.length} others`));
  svg.append(s('text', { x: x(128) + 10, y: y(mid) + 18, class: 'tick-label' }, `${pct(Math.min(...others))}–${pct(Math.max(...others))}`));
  // Hover: crosshair snaps to the nearest tile size; the readout lists every series there.
  const cross = s('line', { y1: M.t, y2: H - M.b, stroke: '#bdbdbd', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  const hit = s('rect', { x: M.l - 20, y: M.t, width: W - M.l - M.r + 40, height: H - M.t - M.b, fill: 'transparent', tabindex: 0 });
  svg.append(hit);
  host.append(svg);
  const tip = chartTip(host);
  const show = (px, clientX, clientY) => {
    cross.setAttribute('x1', x(px)); cross.setAttribute('x2', x(px)); cross.setAttribute('visibility', 'visible');
    const rows = series.map((sr) => ({ sr, p: sr.points.find((q) => q.px === px) })).filter((r) => r.p)
      .sort((a, b) => b.p.v - a.p.v)
      .map(({ sr, p }) => ({ label: sr.model.short + (p.oneCall ? ' (one call)' : ''), value: pct(p.v), color: sr.model.rank === 1 ? COLORS.lead : COLORS.other }));
    rows.push({ label: 'Random tile', value: pct(bench.baselines.random[String(px)], 1), color: COLORS.random });
    tip.show(clientX, clientY, `${px} px tiles`, rows);
  };
  const nearest = (evt) => {
    const box = svg.getBoundingClientRect();
    const mx = (evt.clientX - box.left) * (W / box.width);
    return { px: xs.reduce((best, px) => (Math.abs(x(px) - mx) < Math.abs(x(best) - mx) ? px : best), xs[0]), cx: evt.clientX - box.left, cy: evt.clientY - box.top };
  };
  hit.addEventListener('pointermove', (e) => { const n = nearest(e); show(n.px, x(n.px) * (svg.getBoundingClientRect().width / W), n.cy); });
  hit.addEventListener('pointerleave', () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); });
  let focusIdx = 2;
  hit.addEventListener('focus', () => show(xs[focusIdx], x(xs[focusIdx]), H / 3));
  hit.addEventListener('blur', () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); focusIdx = Math.max(0, Math.min(2, focusIdx + (e.key === 'ArrowRight' ? 1 : -1))); show(xs[focusIdx], x(xs[focusIdx]), H / 3); }
  });
}

// The model scatters (cost, speed, confidence) share one drawing: hairline grid, likely-range whiskers,
// greedy direct labels, and a tooltip on the nearest point (hover, or focus and arrow keys).
const FOUND_Y = { y: [0.35, 0.95], yTicks: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9] };
// On the frontier: no other model is at least as accurate and lower on k, or more accurate and no higher.
const onFrontier = (m, k) => !models.some((o) => o !== m && ((o.found >= m.found && k(o) < k(m)) || (o.found > m.found && k(o) <= k(m))));
const listText = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function scatter(host, o) {
  host.replaceChildren();
  const W = Math.max(300, host.clientWidth);
  const M = { l: 40, r: 16, t: 14, b: 44 };
  // A square plot keeps the confidence diagonal at 45°; the others stretch to the card.
  const side = o.square ? Math.min(W - M.l - M.r, 320) : 0;
  const H = side ? side + M.t + M.b : 300, R = side ? M.l + side : W - M.r;
  const x = (v) => M.l + o.x(v) * (R - M.l);
  const y = (v) => M.t + (1 - (v - o.y[0]) / (o.y[1] - o.y[0])) * (H - M.t - M.b);
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.aria });
  const grid = s('g', { class: 'grid' });
  for (const t of o.yTicks) {
    grid.append(s('line', { x1: M.l, x2: R, y1: y(t), y2: y(t) }));
    svg.append(s('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick-label' }, `${Math.round(t * 100)}%`));
  }
  for (const [t, label] of o.xTicks) {
    grid.append(s('line', { x1: x(t), x2: x(t), y1: M.t, y2: H - M.b }));
    svg.append(s('text', { x: x(t), y: H - M.b + 18, 'text-anchor': 'middle', class: 'tick-label' }, label));
  }
  svg.append(grid);
  svg.append(s('line', { x1: M.l, x2: R, y1: H - M.b, y2: H - M.b, stroke: '#cfcfcf' }));
  svg.append(s('text', { x: (M.l + R) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' }, o.xTitle));
  const pts = o.pts.map((p) => ({ ...p, cx: x(p.xv), cy: y(p.yv) }));
  // Labels keep clear of points and of the corner notes ("↖ cheaper and better" top left, "↘" notes bottom right).
  const placed = pts.map((p) => ({ x0: p.cx - 6, y0: p.cy - 6, x1: p.cx + 6, y1: p.cy + 6 }));
  for (const [text, corner] of o.notes) {
    const w = text.length * 7.1, end = corner === 'br', bx = end ? R - 8 - w : M.l + 8, by = end ? H - M.b - 20 : M.t;
    svg.append(s('text', { x: end ? R - 8 : M.l + 8, y: by + 12, 'text-anchor': end ? 'end' : null, class: 'axis-title' }, text));
    placed.push({ x0: bx, y0: by, x1: bx + w, y1: by + 14 });
  }
  if (o.decorate) o.decorate(svg, x, y);
  if (o.frontier) {
    const edge = pts.filter((p) => p.front).sort((a, b) => a.cx - b.cx);
    svg.append(s('polyline', { points: edge.map((p) => `${p.cx},${p.cy}`).join(' '), fill: 'none', stroke: '#9a9a9a', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  }
  for (const p of pts) svg.append(s('line', { x1: p.cx, x2: p.cx, y1: y(p.m.found_ci95[0]), y2: y(p.m.found_ci95[1]), stroke: p.m.rank === 1 ? 'rgba(42,120,214,0.35)' : '#dcdcdc', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  for (const p of pts) {
    const fill = p.m.rank === 1 ? COLORS.lead : p.front ? COLORS.ink : '#b8b8b8';
    svg.append(s('circle', { cx: p.cx, cy: p.cy, r: p.m.rank === 1 ? 5.5 : 4.5, fill: p.hollow ? '#fff' : fill, stroke: p.hollow ? fill : '#fff', 'stroke-width': p.hollow ? 1.75 : 2 }));
  }
  // Direct labels: try right, left, above, below; skip a spot that collides with a placed label or a point.
  const clash = (b) => placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0) || b.x0 < M.l || b.x1 > W - M.r + 4 || b.y0 < M.t;
  for (const p of [...pts].sort((a, b) => a.m.rank - b.m.rank)) {
    const strong = p.m.rank === 1;
    const text = p.m.short;
    const w = measure(text, 12, strong ? 650 : 400), ht = 14;
    const options = [[p.cx + 9, p.cy - ht / 2], [p.cx - 9 - w, p.cy - ht / 2], [p.cx - w / 2, p.cy - 10 - ht], [p.cx - w / 2, p.cy + 9],
      [p.cx + 9, p.cy - ht - 2], [p.cx + 9, p.cy + 2], [p.cx - 9 - w, p.cy - ht - 2], [p.cx - 9 - w, p.cy + 2]];
    const spot = options.map(([bx, by]) => ({ x0: bx, y0: by, x1: bx + w, y1: by + ht })).find((b) => !clash(b));
    if (!spot) continue;
    placed.push(spot);
    svg.append(s('text', { x: spot.x0, y: spot.y0 + 11, class: strong ? 'label strong' : p.front ? 'label' : 'label dim' }, text));
  }
  host.append(svg);
  const tip = chartTip(host);
  const showFor = (p, px, py) => tip.show(px, py, p.m.name, o.tip(p));
  const near = (e) => {
    const box = svg.getBoundingClientRect();
    const k = W / box.width;
    const mx = (e.clientX - box.left) * k, my = (e.clientY - box.top) * k;
    let best = null, dist = 28;
    for (const p of pts) { const d = Math.hypot(p.cx - mx, p.cy - my); if (d < dist) { dist = d; best = p; } }
    if (best) showFor(best, best.cx / k, best.cy / k); else tip.hide();
  };
  svg.addEventListener('pointermove', near);
  svg.addEventListener('pointerdown', near);
  svg.addEventListener('pointerleave', () => tip.hide());
  svg.setAttribute('tabindex', '0');
  const order = [...pts].sort((a, b) => a.cx - b.cx);
  let fi = -1;
  const step = (d) => {
    fi = (fi + d + order.length) % order.length;
    const k = W / svg.getBoundingClientRect().width;
    showFor(order[fi], order[fi].cx / k, order[fi].cy / k);
  };
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
  });
  svg.addEventListener('focus', () => { if (svg.matches(':focus-visible')) { fi = -1; step(1); } });
  svg.addEventListener('blur', () => tip.hide());
}

function drawFrontier() {
  const lo = Math.log10(0.001), hi = Math.log10(0.04);
  scatter($('#frontier'), {
    ...FOUND_Y, aria: 'Found rate against cost per scene', frontier: true,
    x: (v) => (Math.log10(v) - lo) / (hi - lo),
    xTicks: [0.001, 0.002, 0.005, 0.01, 0.02].map((t) => [t, `$${t}`]),
    xTitle: '$ per scene · log', notes: [['↖ cheaper and better', 'tl']],
    pts: models.map((m) => ({ m, xv: perScene(m), yv: m.found_rate, front: onFrontier(m, perScene) })),
    tip: ({ m }) => [
      { label: 'Found', value: `${pct(m.found_rate)} (${m.found}/${m.searches})` },
      { label: 'Likely range', value: rangeText(m.found_ci95) },
      { label: 'Cost per scene', value: money(perScene(m)) },
      { label: 'Typical search', value: sec(m.p50_search_s) }],
  });
}

function drawSpeed() {
  const slowest = Math.max(...models.map((m) => m.p50_search_s));
  const step = [0.5, 1, 2, 5, 10, 20, 30, 60].find((st) => slowest / st <= 6) || 60;
  const top = Math.ceil(slowest / step) * step;
  scatter($('#speed'), {
    ...FOUND_Y, aria: 'Found rate against typical search time', frontier: true,
    x: (v) => v / top,
    xTicks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => [i * step, `${Number((i * step).toFixed(1))} s`]),
    xTitle: 'Typical search · seconds', notes: [['↖ faster and better', 'tl']],
    pts: models.map((m) => ({ m, xv: m.p50_search_s, yv: m.found_rate, front: onFrontier(m, shownTime) })),
    tip: ({ m }) => [
      { label: 'Found', value: `${pct(m.found_rate)} (${m.found}/${m.searches})` },
      { label: 'Likely range', value: rangeText(m.found_ci95) },
      { label: 'Typical search', value: sec(m.p50_search_s) },
      { label: 'Cost per scene', value: money(perScene(m)) }],
  });
}

// Average confidence in the chosen tile, overall and split by whether that tile held Waldo.
// Jev 1.14's figure is its Choice vote share on the tile, not a yes/no probability.
function calibration() {
  const avg = (ps) => (ps.length ? ps.reduce((a, p) => a + p.confidence, 0) / ps.length : null);
  return models.map((m) => {
    const ps = scenes.map((sc) => sc.picks[m.model]).filter((p) => p.confidence != null);
    return { m, vote: m.method === 'one-call', conf: avg(ps), right: avg(ps.filter((p) => p.found)), wrong: avg(ps.filter((p) => !p.found)) };
  });
}

function drawCalibration() {
  const quarters = [0, 0.25, 0.5, 0.75, 1];
  scatter($('#calibration'), {
    aria: 'Found rate against average confidence for each model', square: true,
    x: (v) => v, y: [0, 1], yTicks: quarters, xTicks: quarters.map((t) => [t, pct(t)]),
    xTitle: 'Average confidence in its pick', notes: [['↖ underconfident', 'tl'], ['overconfident ↘', 'br']],
    pts: calibration().filter((c) => c.conf != null).map((c) => ({ m: c.m, c, xv: c.conf, yv: c.m.found_rate, front: true, hollow: c.vote })),
    decorate: (svg, x, y) => {
      svg.append(s('line', { x1: x(0), y1: y(0), x2: x(1), y2: y(1), stroke: '#bdbdbd', 'stroke-width': 1 }));
      const px = x(0.08), py = y(0.08), angle = (Math.atan2(y(1) - y(0), x(1) - x(0)) * 180) / Math.PI;
      svg.append(s('text', { x: px, y: py - 5, transform: `rotate(${angle} ${px} ${py})`, class: 'tick-label' }, 'perfectly calibrated'));
    },
    tip: ({ m, c }) => {
      const what = c.vote ? 'Vote share' : 'Confidence';
      return [
        { label: `Average ${what.toLowerCase()}`, value: pct(c.conf) },
        { label: 'Found', value: `${pct(m.found_rate)} (${m.found}/${m.searches})` },
        { label: `${what} when right`, value: c.right == null ? '–' : pct(c.right) },
        { label: `${what} when wrong`, value: c.wrong == null ? '–' : pct(c.wrong) }];
    },
  });
}

// One sentence from the data, yes/no models only. "Further off than luck" = the likely range excludes the diagonal.
function calibrationSummary() {
  const yn = calibration().filter((c) => !c.vote && c.conf != null);
  const gap = (c) => c.conf - c.m.found_rate;
  const word = (n) => ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  const is = (xs) => (xs.length === 1 ? 'is' : 'are');
  const over = yn.filter((c) => gap(c) > 0);
  const clearOver = over.filter((c) => c.m.found_ci95[1] < c.conf), clearUnder = yn.filter((c) => c.m.found_ci95[0] > c.conf);
  let text = over.length
    ? `${cap(word(over.length))} of the ${word(yn.length)} yes/no models ${is(over)} overconfident, on average ${Math.round((100 * over.reduce((a, c) => a + gap(c), 0)) / over.length)} points surer than ${over.length === 1 ? 'its' : 'their'} found rate`
    : `None of the ${word(yn.length)} yes/no models is overconfident`;
  if (clearOver.length) text += `; ${listText(clearOver.map((c) => `${c.m.short} (+${Math.round(100 * gap(c))})`))} ${is(clearOver)} further off than luck explains`;
  if (clearUnder.length) text += `, and ${listText(clearUnder.map((c) => c.m.short))} ${is(clearUnder)} clearly underconfident`;
  return `${text}.`;
}

const drawCharts = () => { drawCurve(); drawFrontier(); drawSpeed(); drawCalibration(); };

function buildCharts() {
  drawCharts();
  const curveCard = $('#curve').parentElement, frontierCard = $('#frontier').parentElement;
  const speedCard = $('#speed').parentElement, calibrationCard = $('#calibration').parentElement;
  curveCard.append(h('div', { class: 'legend' },
    h('span', {}, h('i', { style: { color: COLORS.lead, height: '2.5px' } }), models[0].name),
    h('span', {}, h('i', { style: { color: COLORS.other } }), 'Other models'),
    h('span', {}, h('i', { style: { color: COLORS.random } }), 'Random tile'),
    h('span', {}, h('i', { class: 'dot', style: { border: '1.5px solid #9a9a9a', background: '#fff', width: '7px', height: '7px' } }), 'One-call method')));
  curveCard.append(h('div', { class: 'chart-foot' }, h('span', { class: 'note', text: 'Hover or focus the chart for every model at that size.' })));
  frontierCard.append(h('div', { class: 'chart-foot' }, h('span', { class: 'note', text: 'The line joins the best trade-offs: no other model is both cheaper and at least as accurate. Grey models are beaten on both. Vertical lines show each likely range.' })));
  speedCard.append(h('div', { class: 'chart-foot' }, h('span', { class: 'note', text: 'The line joins the best trade-offs: no other model is both quicker and at least as accurate. Grey models are beaten by one that is. Vertical lines show each likely range.' })));
  calibrationCard.append(h('p', { class: 'takeaway', text: calibrationSummary() }),
    h('div', { class: 'chart-foot' }, h('span', { class: 'note', text: 'Below the diagonal, a model is surer of its pick than its found rate justifies. Hollow dot: Jev 1.14 gives no yes/no probability; its figure is the share of its one Choice vote on the chosen tile, spread over every tile, so it sits far left by design and is left out of the sentence above. Vertical lines show each likely range.' })));
  let timer;
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => { drawCharts(); renderViews(); }, 120); });
}

/* ---------- Fooled ---------- */
function modelTags(aliases, cls) {
  return h('div', { class: 'tags' }, aliases.map((a) => h('span', { class: `tag ${cls}`, text: byAlias[a].short })));
}
function buildDecoys() {
  const decoyCopy = copy.decoys || {};
  $('#decoys').append(...bench.decoys.map((d) => {
    const c = decoyCopy[d.id] || {};
    const sc = sceneById[d.scene];
    return h('article', { class: 'card' },
      h('div', { class: 'pair', role: 'button', tabindex: 0, style: { cursor: 'pointer' }, title: `Open scene ${sc.number}`,
        onclick: (e) => openScene(d.scene, null, bench.decoys.map((x) => x.scene), e.currentTarget), onkeydown: (e) => { if (e.key === 'Enter') openScene(d.scene, null, bench.decoys.map((x) => x.scene), e.currentTarget); } },
        h('figure', {}, h('img', { src: d.crop, alt: `Where ${d.fooled} models looked in scene ${sc.number}`, loading: 'lazy' }), h('figcaption', { text: 'Their pick' })),
        h('figure', { class: 'real' }, h('img', { src: sc.waldoCrop, alt: `Waldo in scene ${sc.number}`, loading: 'lazy' }), h('figcaption', { text: 'Waldo' }))),
      h('h3', { text: c.who || `Scene ${sc.number}` }),
      c.caption ? h('p', { text: c.caption }) : null,
      h('div', { class: 'count', style: { margin: '6px 0' }, text: `Fooled ${d.fooled} of ${models.length} · scene ${sc.number}` }),
      modelTags(d.models, 'miss'),
      d.foundBy.length ? h('div', { style: { marginTop: '4px' } }, modelTags(d.foundBy, 'found')) : null);
  }));
  const hardest = scenes.filter((sc) => sc.foundBy <= 2).sort((a, b) => a.foundBy - b.foundBy || a.number - b.number);
  const hardCopy = copy.hardest || {};
  $('#hardest').append(...hardest.map((sc) => {
    const found = Object.entries(sc.picks).filter(([, p]) => p.found).map(([a]) => a);
    return h('article', { class: 'card' },
      h('div', { class: 'solo', role: 'button', tabindex: 0, style: { cursor: 'pointer' }, onclick: (e) => openScene(sc.id, null, hardest.map((x) => x.id), e.currentTarget), onkeydown: (e) => { if (e.key === 'Enter') openScene(sc.id, null, hardest.map((x) => x.id), e.currentTarget); } },
        h('img', { src: sc.waldoCrop, alt: `Waldo in scene ${sc.number}`, loading: 'lazy' })),
      h('h3', { text: `Scene ${sc.number}` }),
      hardCopy[sc.id] ? h('p', { text: hardCopy[sc.id] }) : null,
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
  const v = { kind, el, st: { open: kind === 'browser', mode: 'scene', model: null, filter: 'missed', list: scenes.map((x) => x.id), idx: 0, heatOn: true, opener: null,
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
      h('div', { class: 'insp-strip-wrap' }, h('div', { class: 'note', text: 'Scenes in this list · ← → to move, Esc to close' }), e.strip)));
  document.body.append(e.panel);
  document.addEventListener('keydown', (ev) => {
    if (!side.st.open || ev.target.closest('input, textarea, select, [contenteditable]')) return;
    if (ev.key === 'Escape') closeSide();
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepView(side, -1); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepView(side, 1); }
  });

  browser = makeView('browser');
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
    h('div', { class: 'browser-head' }, h('div', {}, b.kicker, b.title), h('div', { class: 'insp-nav' }, b.race, b.clock, b.prev, b.pos, b.next)),
    h('p', { class: 'race-note note', text: 'Race the models replays the recorded timings: each tile answer appears when it really came back. Every model was timed on its own, with 16 tile questions at a time in a shuffled order (Jev 1.14: one request for the whole scene).' }),
    h('div', { class: 'browser-body' }, h('div', { class: 'browser-picture' }, b.stage, b.legend),
      h('div', { class: 'browser-side' }, b.compare, b.verdict, b.list)));
  $('#browser').append(b.strip, b.view);
  renderView(browser);
}

function modelList(st) {
  return scenes.filter((sc) => st.filter === 'all' || (st.filter === 'missed') === !sc.picks[st.model].found).map((sc) => sc.id);
}
function openModel(alias, sceneId, opener) {
  // Start on the list that holds the given scene: its finds for a find, otherwise its misses.
  const st = side.st;
  const found = sceneId && sceneById[sceneId].picks[alias].found;
  Object.assign(st, { mode: 'model', model: alias, filter: found ? 'found' : byAlias[alias].missesPass1.length ? 'missed' : 'all' });
  st.list = modelList(st);
  st.idx = Math.max(0, sceneId ? st.list.indexOf(sceneId) : 0);
  showSide(opener);
}
function openScene(sceneId, alias, list, opener) {
  Object.assign(side.st, { mode: 'scene', model: alias, list: list || scenes.map((x) => x.id) });
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
  st.open = true;
  side.el.panel.classList.add('open'); side.el.panel.inert = false; side.el.panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('inspecting');
  side.el.scroll.scrollTop = 0;
  renderView(side);
  side.el.title.focus({ preventScroll: true });
}
function closeSide() {
  side.st.open = false;
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

// Confidence of a model's chosen tile, in words.
function shareText(c) { return c >= 0.995 ? '>99%' : c < 0.01 ? '<1%' : pct(c); }
function sureLabel(m, c) {
  if (c == null) return '';
  return m.method === 'one-call' ? `${shareText(c)} of its vote` : `${shareText(c)} sure`;
}

// Plain-language reading of one model's pick on one scene.
function explain(sc, alias) {
  const m = byAlias[alias], p = sc.picks[alias];
  const c = p.confidence;
  const share = c == null ? '' : c >= 0.995 ? 'over 99%' : c < 0.01 ? 'under 1%' : pct(c);
  const tiles = heat ? heat[sc.id].tiles.length : null;
  const sure = c == null ? '' : m.method === 'one-call'
    ? `It gave that tile ${share} of its vote${tiles ? `, spread over ${tiles} tiles` : ''}.`
    : `It was ${share} sure Waldo was in that tile.`;
  if (p.found) return { ok: true, head: 'Found Waldo', body: `${m.short}’s chosen tile contains him. ${sure}` };
  const d = bench.decoys.find((x) => x.scene === sc.id && x.models.includes(alias));
  const who = d && (copy.decoys || {})[d.id] && copy.decoys[d.id].who;
  const [a, b] = [p.box, sc.truth];
  const tilesAway = Math.max(1, Math.round(Math.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2) / 128));
  return { ok: false, head: who ? `Missed: fell for ${who === 'Wenda' ? 'Wenda' : who.toLowerCase()}` : 'Missed Waldo',
    body: `${m.short} chose a tile about ${tilesAway} tile${tilesAway === 1 ? '' : 's'} away from him. ${sure}` };
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
  if (st.mode === 'model') {
    el.kicker.textContent = `${focus.name} · found ${focus.found} of ${focus.searches}`;
    el.title.textContent = `Scene ${sc.number}`;
  } else {
    el.kicker.textContent = `Scene ${sc.number} of ${scenes.length}`;
    el.title.textContent = sc.foundBy ? `${sc.foundBy} of ${models.length} models found Waldo` : `None of the ${models.length} models found Waldo`;
  }

  // Verdict: what happened, in words, before the picture.
  const finished = models.filter((m) => done(m.model)).sort((a, b) => sc.picks[a.model].seconds - sc.picks[b.model].seconds);
  const firstFinder = finished.find((m) => sc.picks[m.model].found);
  if (t != null && !(focus && done(focus.model))) {
    const arrived = focus && heat ? heat[sc.id].times[focus.model].filter((x) => x <= t).length : 0;
    const lead = firstFinder ? `First to find Waldo: ${firstFinder.short}, at ${sec(sc.picks[firstFinder.model].seconds)}.` : t >= length ? 'Nobody found Waldo.' : 'Nobody has found Waldo yet.';
    const status = t >= length ? `Finished. ${sc.foundBy} of ${models.length} found him.` : `Racing: ${finished.length} of ${models.length} finished.`;
    el.verdict.replaceChildren(h('div', { class: 'insp-status race-status' }, status), h('p', { text: focus
      ? `${focus.short} is searching: ${arrived} of ${heat[sc.id].tiles.length} tile answers in. ${lead}` : lead }));
  } else if (focus) {
    const x = explain(sc, focus.model);
    el.verdict.replaceChildren(h('div', { class: `insp-status ${x.ok ? 'ok' : 'bad'}` }, h('span', { class: 'icon', text: x.ok ? '✓' : '✗' }), x.head), h('p', { text: x.body }));
  } else {
    const where = (copy.hardest || {})[sc.id];
    el.verdict.replaceChildren(h('p', { text: (where ? `Where Waldo is: ${where} ` : '') + 'Select a model below to see its pick up close.' }));
  }

  // Picture: the striped box is always Waldo; the solid boxes are the tiles models chose.
  if (el.img.getAttribute('src') !== sc.image) { el.img.src = sc.image; el.img.width = sc.width; el.img.height = sc.height; }
  el.img.alt = `Scene ${sc.number}`;
  el.overlay.setAttribute('viewBox', `0 0 ${sc.width} ${sc.height}`);
  el.overlay.replaceChildren(); el.chips.replaceChildren();
  const ns = { 'vector-effect': 'non-scaling-stroke', fill: 'none' };
  const groups = new Map();
  for (const m of models) {
    const p = sc.picks[m.model];
    if (!p.box || !p.complete || (st.mode === 'model' && m.model !== st.model) || !done(m.model)) continue;
    const key = p.box.join(',');
    if (!groups.has(key)) groups.set(key, { box: p.box, aliases: [], found: p.found });
    groups.get(key).aliases.push(m.model);
  }
  // Tags start at the box's left edge, or end at its right edge near the picture's right side so they are never cut off.
  // Click a tag to pick out its box: it comes to the front and everything else fades. Click again to clear.
  const tag = (box, cls, text, edge, key = box.join(',')) => el.chips.append(h('span', {
    class: `chip ${cls}`, text, 'data-key': key, title: 'Click to pick out this box; click again to clear',
    onclick: (e) => { e.stopPropagation(); st.front = st.front === key ? null : key; pickOut(v); },
    style: { ...(box[2] / sc.width > 0.8 ? { right: `${(1 - box[2] / sc.width) * 100}%` } : { left: `${(box[0] / sc.width) * 100}%` }),
      top: `${(box[edge] / sc.height) * 100}%` } }));
  for (const g of groups.values()) {
    const [x0, y0, x1, y1] = g.box;
    const mine = focus && g.aliases.includes(focus.model);
    const faded = focus && !mine;
    const attrs = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, opacity: faded ? 0.3 : 1 };
    el.overlay.append(s('rect', { ...attrs, ...ns, stroke: '#fff', 'stroke-width': mine ? 6 : 3.5, 'data-key': g.box.join(',') }));
    el.overlay.append(s('rect', { ...attrs, ...ns, stroke: mine ? COLORS.lead : COLORS.ink, 'stroke-width': mine ? 3 : 1.5, 'data-key': g.box.join(',') }));
    if (faded) continue;
    // One tag per chosen tile: "Jev 1.14: 0.43" (the model's confidence in that tile), or, when several models chose it,
    // each of them on its own line with its search time, fastest first. Near the bottom edge the tag sits above the box.
    const who = mine ? focus.model : g.aliases.length === 1 ? g.aliases[0] : null;
    const conf = who && sc.picks[who].confidence;
    const text = who ? `${byAlias[who].short}: ${conf == null ? '–' : conf.toFixed(2)}`
      : [...g.aliases].sort((a, b) => sc.picks[a].seconds - sc.picks[b].seconds).map((a) => `${byAlias[a].short} · ${sec(sc.picks[a].seconds)}`).join('\n');
    const above = g.box[3] / sc.height > 0.72;
    tag(g.box, `under${above ? ' above' : ''}${who ? '' : ' stack'}${g.found ? ' found' : ''}${mine ? ' mine' : ''}`, text, above ? 1 : 3);
  }
  const pad = 4, [t0, t1, t2, t3] = sc.truth;
  const truth = { x: t0 - pad, y: t1 - pad, width: t2 - t0 + 2 * pad, height: t3 - t1 + 2 * pad, ...ns, 'data-key': 'waldo' };
  el.overlay.append(s('rect', { ...truth, stroke: '#fff', 'stroke-width': 3.5 }), s('rect', { ...truth, stroke: COLORS.random, 'stroke-width': 2 }),
    s('rect', { ...truth, stroke: '#fff', 'stroke-width': 2, 'stroke-dasharray': '4 4' }));
  tag([t0 - pad, t1 - pad, t2 + pad, t3 + pad], 'waldo', 'Waldo', 1, 'waldo');
  pickOut(v);
  drawHeat(el.canvas, sc, focus && st.heatOn ? focus.model : null, t);
  // While the focused model is still searching, follow its best guess so far.
  if (focus && t != null && !done(focus.model) && heat) {
    const data = heat[sc.id], values = data.heat[focus.model], times = data.times[focus.model];
    let best = -1;
    values.forEach((val, i) => { if (val != null && times[i] <= t && (best < 0 || val > values[best])) best = i; });
    if (best >= 0) {
      const [x0, y0, x1, y1] = data.tiles[best];
      el.overlay.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, ...ns, stroke: COLORS.lead, 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
      tag(data.tiles[best], 'under mine', `${focus.short}: best so far ${values[best].toFixed(2)}`, 3);
    }
  }

  // Legend: every mark on the picture, named.
  const swatch = (cls) => h('i', { class: `sw ${cls}` });
  el.legend.replaceChildren(...[
    h('span', {}, swatch('waldo'), 'Waldo (the answer)'),
    focus ? h('span', {}, swatch('pick'), `${focus.short}’s chosen tile`) : h('span', {}, swatch('any'), 'A model’s chosen tile'),
    focus ? h('label', { class: 'toggle' }, el.heatToggle, 'Dim where it didn’t look') : null].filter(Boolean));

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
    el.switcher.append(h('button', { class: 'linkbtn', type: 'button', onclick: () => openScene(sc.id, st.model, st.list) },
      `${sc.foundBy} of ${models.length} models found Waldo here · compare all of them →`));
  } else {
    const choose = (alias) => { st.model = alias; renderView(v); };
    el.list.append(h('li', { 'aria-pressed': String(!focus), tabindex: 0, onclick: () => choose(null), onkeydown: (e) => { if (e.key === 'Enter') choose(null); } },
      h('span', { class: 'who', text: 'All models' }), h('span', { class: 'muted', text: `${sc.foundBy} found` })),
    ...models.map((m) => {
      const p = sc.picks[m.model];
      if (!done(m.model)) {
        const pickIt = () => choose(st.model === m.model ? null : m.model);
        return h('li', { 'aria-pressed': String(st.model === m.model), tabindex: 0, onclick: pickIt, onkeydown: (e) => { if (e.key === 'Enter') pickIt(); } },
          h('span', { class: 'who' }, h('span', { class: 'tag plain', text: '…', title: 'searching' }), v.kind === 'browser' ? m.short : m.name),
          h('span', { class: 'race-bar' }, h('i', { style: { width: `${Math.min(100, (100 * t) / p.seconds)}%` } })));
      }
      const state = p.found ? ['✓ Found', 'found'] : ['✗ Missed', 'miss'];
      const pickIt = () => choose(st.model === m.model ? null : m.model);
      return h('li', { 'aria-pressed': String(st.model === m.model), tabindex: 0, onclick: pickIt, onkeydown: (e) => { if (e.key === 'Enter') pickIt(); } },
        h('span', { class: 'who' }, h('span', { class: `tag ${state[1]}`, text: v.kind === 'browser' ? state[0].slice(0, 1) : state[0], title: state[0].slice(2) }), v.kind === 'browser' ? m.short : m.name),
        h('span', { class: 'muted num', style: { fontSize: '12px' }, text: t != null ? sec(p.seconds) : p.confidence != null ? p.confidence.toFixed(2) : '' }));
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

// Highlight the picked-out box and its tag; fade the rest (Waldo's own box always stays visible).
function pickOut(v) {
  const { el, st } = v;
  const on = Boolean(st.front && el.chips.querySelector(`[data-key="${CSS.escape(st.front)}"]`));
  el.stage.classList.toggle('picking', on);
  el.chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('front', on && c.dataset.key === st.front));
  el.overlay.querySelectorAll('rect').forEach((r) => r.classList.toggle('sel', on && r.dataset.key === st.front));
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
  setAttrs(grid, { role: 'group', 'aria-label': `Found or missed: ${models.length} models by ${order.length} scenes. Arrow keys move between squares.`,
    style: { gridTemplateColumns: `max-content repeat(${order.length}, var(--cell)) max-content`, gridTemplateRows: `repeat(${models.length}, var(--cell)) auto` } });
  const cells = models.map((m, r) => {
    const row = order.map((sc, c) => {
      const p = sc.picks[m.model];
      const tip = `${m.short} · Scene ${sc.number}: ${p.found ? 'found' : 'missed'}${p.confidence == null ? '' : `, ${sureLabel(m, p.confidence)}`}`;
      return h('button', { type: 'button', class: p.found ? 'm-cell on' : 'm-cell', tabindex: r || c ? -1 : 0, 'data-r': r, 'data-c': c,
        'data-tip': tip, 'aria-label': tip, onclick: () => browseScene(sc.id, m.model) });
    });
    grid.append(h('div', { class: m.rank === 1 ? 'm-label strong' : 'm-label', text: m.short }), ...row,
      h('div', { class: 'm-total num', 'data-tip': `${m.short} found Waldo in ${m.found} of ${m.searches} scenes`, text: m.found }));
    return row;
  });
  grid.append(h('div', { class: 'm-label m-foot', text: 'Found by' }),
    ...order.map((sc) => h('div', { class: 'm-count m-foot num', 'data-tip': `Scene ${sc.number}: found by ${sc.foundBy} of ${models.length}`, text: sc.foundBy })), h('div'));
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
  card.append(h('div', { class: 'chart-foot' },
    h('span', { class: 'm-key note' }, h('span', {}, h('i', { class: 'on' }), 'Found Waldo'), h('span', {}, h('i'), 'Missed'))));
}

/* ---------- Method ---------- */
function buildMethod() {
  const dl = $('#method-list');
  const item = (term, ...body) => { dl.append(h('dt', { text: term }), h('dd', {}, ...body)); };
  const p = (text) => h('p', { text });
  const pre = (text) => h('pre', { class: 'prompt', text });
  const d = bench.dataset;
  item('The task',
    p(`${d.pictures} scenes from the IVSN Waldo set (${d.sceneGroups} distinct source illustrations). Each scene is cut into overlapping ${d.tilePx}-pixel tiles every ${d.stridePx} pixels, ${d.tilesPerPicture[0]}–${d.tilesPerPicture[1]} tiles per scene, ${d.tiles.toLocaleString()} in all. Tiles are enlarged to ${d.sentPx} px before sending. A model finds Waldo when the tile it is surest about overlaps the labelled Waldo box.`),
    p('Every labelled Waldo fits inside a single tile, so a perfect searcher can always score.'));
  item('What each model saw',
    h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } },
      h('img', { src: 'assets/reference.jpg', alt: 'The reference picture of Waldo', style: { width: '96px', borderRadius: '4px' } }),
      h('div', { style: { flex: '1', minWidth: '240px' } },
        p('Every model gets the same tiles, the same reference picture of Waldo and the same description of him. Eight of the nine are asked about one tile at a time: two images per request, this reference picture then the tile, with one typed yes/no question (a Noul, which returns P(yes)) through the OpenRouter Decisions API. The tile it is surest about is its answer.'),
        pre(bench.prompts.noul),
        pre(`yes: ${bench.prompts.criteria.true}\nno:  ${bench.prompts.criteria.false}`))),
    h('h3', { class: 'method-sub', text: 'Why Jev 1.14 is asked differently' }),
    p('We call each model the way its maker documents. TypeSafe’s guide for searching a large image is one Choice request whose options are every tile of the scene, with the whole scene in state and the reference picture in the instructions; the tile it picks is its answer. Jev is also the only model here that reads images inside the question and its options, and that takes all of a scene’s tiles (about 211) in one request; the Clef models, for example, accept at most 4 images per request. The tiles, reference picture and wording are the same as everyone else’s; only the packaging differs.'),
    pre(`${bench.prompts.choiceLead} [reference picture] ${bench.prompts.choiceDetail}`));
  item('Scoring',
    p('Found = the chosen tile overlaps the labelled Waldo by any amount. Ties between equally sure tiles are broken by a fixed hash, the same for every model. A search that hit a provider error, or stalled (took more than 3 times its model’s median time), was run again in full, so every model finished all 66 scenes. The rule looks only at time, never at the answer.'),
    p('Typical search is the median time to search one whole scene. Jev 1.14’s time comes from an earlier pass the same day, run close in time to the other models; during its scored pass TypeSafe answered about 1.2 s slower.'),
    p(`Random tile: ${pct(bench.baselines.random['128'], 1)} (the average share of tiles that touch Waldo). Always picking the middle tile: ${pct(bench.baselines.middle, 1)}.`));
  item('Uncertainty',
    p(`95% intervals resample the ${d.sceneGroups} source illustrations 4,000 times. Leader gaps are paired: the same resampled scenes for both models.`),
    h('table', { class: 'table-view' }, h('thead', {}, h('tr', {}, h('th', { text: `${models[0].short} minus` }), h('th', { text: 'Gap' }), h('th', { text: '95% interval' }))),
      h('tbody', {}, bench.paired.map((g) => h('tr', {}, h('td', { text: byAlias[g.model].name }), h('td', { text: `+${Math.round(g.gap * 100)} pts` }),
        h('td', { text: `${Math.round(g.ci95[0] * 100)} to ${Math.round(g.ci95[1] * 100)}` }))))));
  item('Cost',
    p('Cost is the usage.cost OpenRouter billed for every search request, averaged per whole-scene search. It includes retries and the billed part of searches that failed and were run again.'),
    h('table', { class: 'table-view' }, h('thead', {}, h('tr', {}, ['Model', 'Per scene', `All ${scenes.length} scenes`].map((t) => h('th', { text: t })))),
      h('tbody', {}, models.map((m) => {
        const billed = perScene(m) * m.searches;
        return h('tr', {}, h('td', { text: m.name }), h('td', { text: money(perScene(m)) }), h('td', { text: `$${billed.toFixed(3)}` }));
      }))));
  item('Models',
    h('table', { class: 'table-view' }, h('thead', {}, h('tr', {}, ['Model', 'OpenRouter id', 'Provider'].map((t) => h('th', { text: t })))),
      h('tbody', {}, models.map((m) => h('tr', {}, h('td', { text: m.name }), h('td', { text: m.model_id, class: 'mono' }), h('td', { text: m.provider }))))));
  item('Reproduce',
    h('p', {}, 'The code is at ', h('a', { href: 'https://github.com/musubipapi/waldo-bench', target: '_blank', rel: 'noopener', text: 'github.com/musubipapi/waldo-bench' }), '. Get Part 1 of the IVSN datasets from the ', h('a', { href: bench.attribution.repository, target: '_blank', rel: 'noopener', text: 'Kreiman lab repository' }), ', then:'),
    pre(['uv run python -m waldobench extract <archive.tar.gz>', 'uv run python -m waldobench prepare --tile 128',
      'uv run python -m waldobench run-tiles    # the eight per-tile models',
      'uv run python -m waldobench run-jev      # Jev 1.14',
      'uv run python -m waldobench results --runs my-runs.json --output results/mine',
      'uv run python -m waldobench site --runs my-runs.json --results results/mine'].join('\n')));
}
