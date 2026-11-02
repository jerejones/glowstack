// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Glowstack live map: it boots the page and owns what the tabs
// share. That is the geometry and the live frame (the websocket), the
// map view (scene.js for a model, plan.js for an SVG plan) and the draw
// loop, the chip bar, input on the map (tap, long press, hover,
// double-tap), the selection with its breadcrumb and ribbons, the
// inspect card, toasts and the keyboard. Plain JS modules, no build
// step.
import { $, api, esc, fmt, load, save, press, accentFor, inRanges, laneCenter, LANE } from './util.js';
import { createPanel } from './sheet.js';
import { createOverlay } from './overlay.js';
import { buildTree, nodeName, nodeKinds, targetRanges, lanes } from './select.js';
import { openPlan } from './plan.js';
import { createLooks } from './panel/looks.js';
import { createSetup } from './panel/setup.js';
import { createStatus } from './panel/status.js';
import { createCalibrate } from './panel/calibrate.js';

const SHOW = 'glowstack.show';   // '' preview, 'house' lights
const PLAN = 'glowstack.plan';
const RATE = 'glowstack.fps';
const RIBBONS = 'glowstack.ribbons';
const LONG_PRESS = 450; // ms
const TAP_SLOP = 6;     // px a tap may move

const canvas = $('map');
const ctx = canvas.getContext('2d');
const bus = new EventTarget();

// S is the state the tabs share.
const S = {
  geo: null, tree: null, view: null, plan: 0, overlay: null, panel: null,
  rgb: null,
  show: load(SHOW, '') === 'house' ? 'house' : '',
  frame: { seq: 0, t: 0, preview: false, paused: false },
  connected: false,
  stream: null,        // the last "subscribed" message
  fps: load(RATE, 0),  // stream rate asked for; 0 is the server's cap
  preview: null,       // /api/map/preview
  house: [],           // /api/v1/layers
  catalog: null,       // /api/v1/effects
  presets: [],
  sel: null,           // { node, chain }
  hover: -1,
  pinned: -1,
  focus: '',           // layer id whose card a ribbon tap picked
  ribbons: load(RIBBONS, true),
  ribbonList: [],
  cal: null,           // calibration session state
  calibrating: false,
  gray: new Set(),     // controller indices shown gray (unreachable)
  coarse: false,
  on(type, fn) { bus.addEventListener(type, (e) => fn(e.detail)); },
  emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); },
};

// ---------- toasts ----------

// toast shows a message in the one toast area. An Error shows its
// server message and file:line details.
function toast(msg, opts = {}) {
  const box = $('toasts');
  const err = msg instanceof Error;
  const el = document.createElement('div');
  el.className = 'toast' + (err || opts.error ? ' error' : '');
  const details = err ? msg.details || [] : opts.details || [];
  el.innerHTML = `<span class="msg">${esc(err ? msg.message : msg)}${details.map((d) => `<div>${esc(d)}</div>`).join('')}</span><button type="button" aria-label="Dismiss">✕</button>`;
  el.querySelector('button').onclick = () => el.remove();
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), opts.ms || (err || opts.error ? 8000 : 3500));
}
S.toast = toast;

// ---------- drawing ----------

const perf = { draw: [], ws: [] };
const note = (list, ms) => { list.push(ms); if (list.length > 600) list.shift(); };
let dirty = false, raf = 0;
function markDirty() {
  dirty = true;
  if (!raf) raf = requestAnimationFrame(frame);
}
S.markDirty = markDirty;

function frame() {
  raf = 0;
  if (document.hidden || !S.view) return;
  const moving = S.view.tick();
  if (dirty) draw();
  if (moving && !raf) raf = requestAnimationFrame(frame);
}

function draw() {
  dirty = false;
  const t0 = performance.now();
  const dpr = devicePixelRatio || 1;
  if (S.view.kind === '3d') {
    S.view.render();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    S.view.render(ctx);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S.overlay.draw(ctx);
  placeCard();
  note(perf.draw, performance.now() - t0);
}

function resize() {
  const r = $('stage').getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  if (!S.view) return;
  S.view.resize(r.width, r.height, dpr);
  placeCrumbs();
  setInsets();
  markDirty();
}

// setInsets keeps framing to the map the chip bar and sheet leave free.
function setInsets() {
  if (!S.view) return;
  const stage = $('stage').getBoundingClientRect();
  const full = S.panel.detent() === 'full';
  let top = full ? 0 : $('chips').getBoundingClientRect().bottom - stage.top;
  if (full && !$('crumbs').hidden) top = $('crumbs').getBoundingClientRect().bottom - stage.top;
  let bottom = S.panel.covered();
  if (S.calibrating && S.panel.layout() === 'sheet') bottom = stage.height * 0.65;
  // Leave the framing some room, whatever covers the map.
  top = Math.max(0, Math.min(top, stage.height - bottom - 52));
  S.view.setInsets(top + 6, bottom + 6);
}
S.setInsets = setInsets;
S.resize = resize;

// ---------- the view ----------

async function openView(i) {
  const plan = S.geo.plans[i];
  S.plan = i;
  const runs = S.geo.runs.map((r, ri) => (r.plan === i ? { ranges: S.tree.runSets[ri] } : null));
  S.pickRuns = runs;
  const common = { px: S.geo.pixels, rgb: S.rgb, onChange: markDirty, onCamera: cameraChanged };
  if (plan && plan.kind === 'scene') {
    $('gl').hidden = false;
    const scene = await import('./scene.js');
    S.view = await scene.open($('gl'), canvas, { ...common, url: plan.url, layers: plan.layers || [], map: S.geo.map || {}, plan: i });
    $('viewChips').hidden = false;
  } else if (plan) {
    S.view = openPlan(canvas, plan, i, common);
  } else {
    S.view = openPlan(canvas, { url: '', view_box: [0, 0, 10, 10], scale: 1 }, -1, common);
  }
  resize();
  S.view.restore();
  applyRibbons();
  S.emit('view');
}

function cameraChanged(st) {
  for (const b of $('viewChips').querySelectorAll('button')) {
    press(b, b.dataset.view === st.mode);
    if (b.dataset.view === 'free') b.disabled = !st.hasFree && st.mode !== 'free';
  }
  press($('fitBtn'), st.mode === 'fit');
  S.emit('camera', st);
}

// ---------- selection and ribbons ----------

// select makes a tree node the selection; chain is the breadcrumb (top
// first), by default the node's ancestors.
function select(node, chain) {
  if (!node) { S.sel = null; } else S.sel = { node, chain: chain || S.tree.chain(node) };
  S.focus = '';
  renderCrumbs();
  applyRibbons();
  S.emit('select', S.sel);
  if (S.panel.detent() === 'full') frameSelection();
}
S.select = select;

function renderCrumbs() {
  const box = $('crumbs');
  const sel = S.sel;
  box.hidden = !sel;
  if (!sel) { setInsets(); return; }
  box.innerHTML = sel.chain.map((nd, i) => `${i ? '<span class="sep">›</span>' : ''}<button type="button" data-i="${i}" class="${nd === sel.node ? 'on' : ''}" title="${esc(nodeKinds(nd))} · ${nd.count} px">${esc(nodeName(nd))}</button>`).join('') +
    '<button type="button" class="x" aria-label="Clear the selection">✕</button>';
  box.querySelectorAll('button[data-i]').forEach((b) => { b.onclick = () => select(sel.chain[+b.dataset.i], sel.chain); });
  box.querySelector('.x').onclick = () => select(null);
  // On a phone the crumbs are one row that scrolls: show the selected one.
  const on = box.querySelector('.on');
  const past = on.offsetLeft + on.offsetWidth + 8 - (box.scrollLeft + box.clientWidth);
  if (past > 0) box.scrollLeft += past;
  else if (on.offsetLeft < box.scrollLeft) box.scrollLeft = on.offsetLeft - 8;
  placeCrumbs();
}

function placeCrumbs() {
  const stage = $('stage').getBoundingClientRect();
  const full = S.panel && S.panel.detent() === 'full';
  $('crumbs').style.top = (full ? 6 : $('chips').getBoundingClientRect().bottom - stage.top + 6) + 'px';
}

// layersShown are the layers the map shows: the preview stack over the
// lights' stack, or just the lights' stack.
S.layersShown = () => {
  const house = S.house.filter((l) => !l.ephemeral).map((l) => ({ ...l, lane: 'house' }));
  if (S.show === 'house') return house;
  return [...(S.preview ? S.preview.layers : []).map((l) => ({ ...l, lane: 'preview' })), ...house];
};

function applyRibbons() {
  if (!S.view) return;
  let list = [];
  if (S.ribbons) {
    const ls = S.layersShown().map((l) => ({ key: l.id, lane: l.lane, ranges: targetRanges(S.geo, S.tree, l.target) }));
    const ln = lanes(ls);
    list = ls.filter((l) => l.ranges).map((l) => ({ key: l.key, ranges: l.ranges, color: accentFor(l.key), lane: ln[ls.indexOf(l)] }));
  }
  S.ribbonList = list;
  S.view.setRibbons(list, S.sel ? S.sel.node.ranges : null);
}
S.applyRibbons = applyRibbons;

function frameSelection() {
  if (!S.sel) return;
  const ids = [];
  for (const [a, b] of S.sel.node.ranges) for (let p = a; p <= b; p++) ids.push(p);
  S.view.frameIds(ids);
}

// ---------- input on the map ----------

// pickRibbon finds the layer ribbon under (x, y): ribbons run beside
// the pixels, lane by lane, so only a tap past the pixel's own dot
// counts.
function pickRibbon(x, y) {
  if (!S.ribbonList.length) return '';
  const px = S.geo.pixels;
  const p = S.view.pickPixel(x, y, 40);
  if (p < 0) return '';
  const q = S.view.screenOf(p);
  const nb = (d) => (px.run[p + d] === px.run[p] ? S.view.screenOf(p + d) : null);
  const a = nb(-1) || q, b = nb(1) || q;
  if (!q) return '';
  let dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!len) return '';
  dx /= len; dy /= len;
  const off = (x - q[0]) * dy - (y - q[1]) * dx;
  const radius = S.view.pixelRadius(p);
  if (off < radius + LANE.gap) return '';
  let best = '', bd = LANE.step / 2 + (S.coarse ? 3 : 1);
  for (const r of S.ribbonList) {
    if (!inRanges(r.ranges, p)) continue;
    const d = Math.abs(off - laneCenter(radius, r.lane));
    if (d <= bd) { bd = d; best = r.key; }
  }
  return best;
}

function tapAt(x, y) {
  const radius = S.coarse ? 24 : 12;
  if (S.calibrating) {
    const p = S.view.pickPixel(x, y, radius);
    S.calib.tapped(p);
    return;
  }
  const ri = S.view.pickRun(x, y, radius, S.pickRuns);
  if (ri < 0) {
    if (S.pinned >= 0) unpin();
    else if (S.sel) select(null);
    return;
  }
  const lay = pickRibbon(x, y);
  const nd = S.tree.climb(ri, S.sel && S.sel.node);
  const chain = S.tree.chain(S.tree.runNode(ri));
  select(nd, chain.includes(nd) ? chain : null);
  // A tap on a layer's ribbon also picks the layer's card; a collapsed
  // panel stays collapsed, so taps meant for the run aren't hijacked.
  if (lay) {
    S.focus = lay;
    if (!S.panel.collapsed()) S.panel.openTab('looks');
    S.emit('focus', lay);
  }
}

function pin(p) {
  S.pinned = p;
  S.hover = -1;
  if (p >= 0 && S.panel.layout() === 'sheet' && S.panel.detent() === 'peek') S.panel.setDetent('half');
  inspect(p);
  markDirty();
}
function unpin() {
  S.pinned = -1;
  inspect(S.hover);
  markDirty();
}

function bindMap() {
  const pointers = new Map();
  let tap = null, lastTap = null, timer = 0;
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, at(e));
    clearTimeout(timer);
    if (pointers.size > 1) { tap = null; return; }
    const [x, y] = at(e);
    tap = { x, y, long: false, type: e.pointerType };
    timer = setTimeout(() => {
      if (!tap) return;
      tap.long = true;
      const p = S.view.pickPixel(tap.x, tap.y, S.coarse ? 28 : 14);
      if (p >= 0) { if (navigator.vibrate) navigator.vibrate(12); pin(p); }
    }, LONG_PRESS);
  });
  canvas.addEventListener('pointermove', (e) => {
    const q = at(e);
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') hoverAt(q[0], q[1]);
      return;
    }
    pointers.set(e.pointerId, q);
    if (tap && Math.hypot(q[0] - tap.x, q[1] - tap.y) > TAP_SLOP) { tap = null; clearTimeout(timer); }
  });
  const end = (e) => {
    const had = pointers.delete(e.pointerId);
    clearTimeout(timer);
    if (!had || !tap || e.type === 'pointercancel') { if (pointers.size === 0) tap = null; return; }
    const t = tap;
    tap = null;
    if (t.long) return;
    const now = e.timeStamp;
    if (lastTap && now - lastTap.t < 320 && Math.hypot(t.x - lastTap.x, t.y - lastTap.y) < 24) {
      lastTap = null;
      S.view.setView('fit');
      return;
    }
    lastTap = { x: t.x, y: t.y, t: now };
    tapAt(t.x, t.y);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (S.hover >= 0) { S.hover = -1; if (S.pinned < 0) inspect(-1); markDirty(); } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

let hoverTimer = 0;
function hoverAt(x, y) {
  const p = S.view.pickPixel(x, y, 12);
  if (p === S.hover) return;
  S.hover = p;
  markDirty();
  if (S.pinned >= 0) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => inspect(p), 60);
}

// ---------- inspect ----------

let inspectSeq = 0, inspected = null;
const showQ = () => (S.show ? '?show=' + S.show : '');

async function inspect(p) {
  const seq = ++inspectSeq;
  if (p < 0) { inspected = null; renderInspect(); return; }
  let d;
  try { d = await api('/api/map/pixels/' + p + showQ()); } catch (e) { return; }
  if (seq !== inspectSeq) return;
  inspected = d;
  renderInspect();
}
S.inspect = inspect;

function renderInspect() {
  const d = inspected;
  const card = $('inspectCard'), row = $('inspectRow');
  const sheet = S.panel.layout() === 'sheet';
  const pinned = S.pinned >= 0;
  card.hidden = !d || sheet || S.calibrating;
  row.hidden = !d || !sheet || !pinned || S.calibrating;
  if (!d) return;
  const r = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const o = S.overlay.outputOf(d.id);
  const sh = d.showing;
  const layer = sh ? `${esc(sh.layer)}${sh.preview ? ' (preview)' : ''}${sh.effect ? ' · ' + esc(sh.effect) : ''}${sh.preset ? ' · preset ' + esc(sh.preset) : ''}${sh.target ? ' on ' + esc(sh.target) : ''}` : '<span class="muted">none</span>';
  const maps = d.mappings.map((m) => r(esc(m.id), `u ${fmt(m.u)}${m.kind === 'index' ? '' : ' m'}${m.stretch !== null && Math.abs(m.stretch - 1) > 1e-4 ? ` · ×${fmt(m.stretch)}` : ''}`)).join('');
  const html = `<div class="head"><b>#${d.id} · ${esc(d.controller)}:${d.index}${d.dead ? ' (dead)' : ''}</b>${pinned ? '<button type="button" class="quiet" data-unpin aria-label="Unpin">✕</button>' : ''}</div>
    <table>
    ${r('color', d.rgb ? `<span class="chip-color" style="background:${d.rgb}"></span>${d.rgb}` : '—')}
    ${r('showing', layer)}
    ${r('run', d.run ? `${esc(d.run)} · pixel ${d.run_pixel}` : '<span class="muted">none</span>')}
    ${r('output', o ? `${esc(o.controller)} pin ${o.pin} · ${d.id - o.first + 1} of ${o.count}` : '<span class="muted">none</span>')}
    ${r('areas', esc(d.areas.join(', ') || '—'))}
    ${r('zones', esc(d.zones.join(', ') || '—'))}
    ${r('edge', d.edge ? `${esc(d.edge)} · ${fmt(d.dist, 2)} m` : '—')}
    ${r('size', d.dl === null ? '—' : fmt(d.dl * 1000, 1) + ' mm')}
    ${S.view.kind === '3d' ? r('position', d.x === null ? '—' : `${fmt(d.x, 2)}, ${fmt(d.y, 2)}, ${fmt(d.z, 2)} m`) : r('plan x, y', d.x === null ? '—' : `${fmt(d.x, 2)}, ${fmt(d.y, 2)} m`)}
    ${maps}
    </table>`;
  const el = sheet ? row : card;
  el.innerHTML = html;
  const b = el.querySelector('[data-unpin]');
  if (b) b.onclick = unpin;
  if (sheet && pinned && !row.hidden) row.scrollIntoView({ block: 'nearest' });
  placeCard();
}

// placeCard keeps the floating card beside its pixel, inside the map.
function placeCard() {
  const card = $('inspectCard');
  if (card.hidden || !inspected) return;
  const q = S.view.screenOf(inspected.id);
  const { w, h } = S.view.size();
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x = q ? q[0] + 18 : w - cw - 10, y = q ? q[1] + 18 : 70;
  if (x + cw > w - 8) x = q ? q[0] - 18 - cw : w - cw - 8;
  if (y + ch > h - 8) y = Math.max(8, (q ? q[1] - 18 : h) - ch);
  card.style.left = Math.max(8, x) + 'px';
  card.style.top = Math.max(8, y) + 'px';
}

// ---------- the stream ----------

let ws = null, ranges = [];
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/map/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { S.connected = true; subscribe(); };
  ws.onclose = () => { S.connected = false; badge(); setTimeout(connect, 1000); };
  ws.onmessage = (e) => {
    const t0 = performance.now();
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'subscribed') {
        // The config was reloaded: the pixel table may have changed.
        if (m.gen !== S.geo.gen) { location.reload(); return; }
        ranges = m.ranges;
        S.stream = m;
        S.rgb.fill(0);
        S.emit('stream', m);
      }
      return;
    }
    const dv = new DataView(e.data);
    if (dv.getUint8(0) !== 1) return;
    const flags = dv.getUint8(1);
    const was = S.frame;
    S.frame = { seq: dv.getUint32(4, true), t: dv.getFloat64(8, true), preview: !!(flags & 1), paused: !!(flags & 2) };
    const data = new Uint8Array(e.data, 16);
    let o = 0;
    for (const [a, b] of ranges) {
      const len = (b - a + 1) * 3;
      S.rgb.set(data.subarray(o, o + len), a * 3);
      o += len;
    }
    if (was.preview !== S.frame.preview || was.paused !== S.frame.paused || !badgeShown) badge();
    S.view.frameArrived();
    if (S.overlay.st.mode === 'live') markDirty();
    note(perf.ws, performance.now() - t0);
  };
}

// streamRate is the rate to ask for: lower when the page is hidden or
// the device runs on battery.
let onBattery = false;
function streamRate() {
  const want = +S.fps || 0;
  if (document.hidden || onBattery) return want && want < 10 ? want : 10;
  return want;
}
function subscribe() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ fps: streamRate(), show: S.show }));
}
S.subscribe = subscribe;
S.setRate = (fps) => { S.fps = fps; save(RATE, fps); subscribe(); };
S.streamRate = streamRate;

let badgeShown = false;
function badge() {
  badgeShown = true;
  const b = $('badge');
  if (!S.connected) { b.textContent = 'offline'; b.className = 'badge off'; return; }
  const f = S.frame;
  const hidden = S.show === 'house' && S.preview && S.preview.previewing;
  b.textContent = f.preview ? (f.paused ? 'preview · paused' : 'preview') : hidden ? 'lights · preview hidden' : 'lights';
  b.className = 'badge ' + (f.preview ? 'preview' : 'house');
  b.title = f.preview ? 'The map shows your preview, not the lights' : 'The map shows what the lights show';
}

// setShow picks what the map shows: '' the preview (the lights' frames
// when nothing is being previewed), 'house' what the lights show.
function setShow(v) {
  S.show = v;
  save(SHOW, v);
  for (const b of $('showSeg').querySelectorAll('button')) press(b, b.dataset.show === v);
  subscribe();
  badge();
  applyRibbons();
  if (S.pinned >= 0) inspect(S.pinned);
  S.emit('show', v);
}
S.setShow = setShow;

// ---------- server state ----------

async function pollPreview() {
  try {
    const st = await api('/api/map/preview');
    const changed = !S.preview || JSON.stringify(st.layers) !== JSON.stringify(S.preview.layers);
    S.preview = st;
    if (changed) applyRibbons();
    S.emit('preview', st);
    badge();
  } catch (e) { /* offline: the badge says so */ }
}
async function pollHouse() {
  try {
    const { layers } = await api('/api/v1/layers');
    const changed = JSON.stringify(layers) !== JSON.stringify(S.house);
    S.house = layers;
    if (changed) { applyRibbons(); S.emit('house', layers); }
  } catch (e) { /* offline */ }
}
// refresh reloads the stacks now, after a change.
S.refresh = async () => { await Promise.all([pollPreview(), pollHouse()]); };

// ---------- chrome ----------

function bindChrome() {
  for (const b of $('showSeg').querySelectorAll('button')) b.onclick = () => setShow(b.dataset.show);
  for (const b of $('viewChips').querySelectorAll('button')) b.onclick = () => S.view.setView(b.dataset.view);
  $('fitBtn').onclick = () => S.view.setView('fit');
  addEventListener('resize', () => { S.panel.refresh(); resize(); });
  document.addEventListener('visibilitychange', () => {
    subscribe();
    if (!document.hidden) markDirty();
  });
  if (navigator.getBattery) {
    navigator.getBattery().then((bat) => {
      const update = () => { onBattery = !bat.charging; subscribe(); };
      bat.addEventListener('chargingchange', update);
      update();
    }).catch(() => {});
  }
  addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'Escape') {
      if (S.pinned >= 0) unpin();
      else if (S.sel) select(null);
      else if (S.panel.detent() && S.panel.detent() !== 'peek') S.panel.setDetent('peek');
    } else if (e.key === ' ' && !e.repeat && t.tagName !== 'BUTTON') {
      e.preventDefault();
      S.looks.togglePause();
    }
  });
}

function onLayout() {
  resize();
  renderInspect();
  S.emit('layout', S.panel.layout());
}

let fullHold = null;
function onDetent(d) {
  placeCrumbs(); // setInsets reads where the crumbs are
  if (d === 'full' && !fullHold) {
    fullHold = S.view.hold();
    setInsets();
    frameSelection();
  } else if (d !== 'full' && fullHold) {
    const h = fullHold;
    fullHold = null;
    setInsets();
    S.view.release(h);
  } else setInsets();
  markDirty();
}

// ---------- boot ----------

async function main() {
  const q = new URLSearchParams(location.search);
  if (q.get('pointer') === 'coarse') document.documentElement.classList.add('coarse');
  S.coarse = matchMedia('(pointer: coarse)').matches || q.get('pointer') === 'coarse';
  S.geo = await api('/api/map/geometry');
  S.rgb = new Uint8Array(S.geo.pixels.count * 3);
  S.tree = buildTree(S.geo);
  [S.catalog, S.presets] = await Promise.all([
    api('/api/v1/effects').catch(() => ({ common: [], effects: [] })),
    api('/api/v1/presets').then((r) => r.presets).catch(() => []),
  ]);
  S.panel = createPanel({ onLayout, onDetent, onTab: (name) => S.emit('tab', name) });
  S.overlay = createOverlay(S);
  S.looks = createLooks(S, $('tab-looks'));
  S.setup = createSetup(S, $('tab-setup'));
  S.status = createStatus(S, $('tab-status'));
  S.calib = createCalibrate(S, $('calibrate'));
  bindChrome();
  bindMap();
  let plan = +load(PLAN, 0);
  if (!(plan >= 0 && plan < S.geo.plans.length)) plan = 0;
  await openView(plan);
  setShow(S.show);
  connect();
  await S.refresh();
  setInterval(pollPreview, 1000);
  setInterval(pollHouse, 2000);
  setInterval(() => { if (S.pinned >= 0) inspect(S.pinned); }, 1000);
  S.emit('ready');
}

S.setPlan = (i) => { save(PLAN, i); location.reload(); };
S.perf = () => {
  const stat = (l) => {
    const s = [...l].sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
    const at = (q) => +(s[Math.floor(s.length * q)] || 0).toFixed(3);
    return { n: s.length, mean: +mean.toFixed(3), p50: at(0.5), p95: at(0.95), max: +(s[s.length - 1] || 0).toFixed(3) };
  };
  return { draw: stat(perf.draw), ws: stat(perf.ws) };
};
S.perfReset = () => { perf.draw.length = 0; perf.ws.length = 0; };
window.glowstack = S;

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<pre class="error" style="position:fixed;z-index:9;inset:auto 8px 8px 8px;white-space:pre-wrap">${esc(e.stack || e)}</pre>`);
});
