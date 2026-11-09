// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Glowstack live map: it boots the page and owns what the tabs
// share. That is the geometry and the live frame (the websocket), the
// map view (scene.js for a model, plan.js for an SVG plan) and the draw
// loop, the chip bar, input on the map (tap, long press, hover,
// double-tap), the selection with its breadcrumb and halo, the
// inspect card, toasts and the keyboard. Plain JS modules, no build
// step.
import { $, api, esc, outputName, fmt, load, save, press, failure } from './util.js';
import { createPanel } from './sheet.js';
import { createOverlay } from './overlay.js';
import { buildTree, nodeName, nodeKinds } from './select.js';
import { openPlan } from './plan.js';
import { createPresets } from './panel/presets.js';
import { createLooks } from './panel/looks.js';
import { cardCorner } from './card-place.js';
import { createSetup } from './panel/setup.js';
import { createStatus } from './panel/status.js';
import { createCalibrate } from './panel/calibrate.js';
import { runVisibility } from './run-visibility.js';
import { createHousePoll } from './house-status.js';
import { createLibrary } from './library.js';
import { mapStatus } from './map-status.js';
import { icon, fillIcons } from './icons.js';
import { stateHTML, bootFailure } from './states.js';

const SHOW = 'glowstack.show';   // '' preview, 'house' lights
const PLAN = 'glowstack.plan';
const RATE = 'glowstack.fps';
const RUNS = 'glowstack.allRuns';
const LONG_PRESS = 450; // ms
const TAP_SLOP = 6;     // px a tap may move

const canvas = $('map');
const ctx = canvas.getContext('2d');
const bus = new EventTarget();

// S is the state the tabs share.
const S = {
  geo: null, tree: null, view: null, plan: 0, overlay: null, panel: null,
  rgb: null,
  allRuns: load(RUNS, false) === true,
  visibility: null,
  show: load(SHOW, '') === 'house' ? 'house' : '',
  frame: { seq: 0, t: 0, preview: false, paused: false },
  connected: false,
  stream: null,        // the last "subscribed" message
  fps: load(RATE, 0),  // stream rate asked for; 0 is the server's cap
  preview: null,       // /api/map/preview
  house: [],           // /api/v1/layers
  houseStatus: 'loading',
  catalog: null,       // /api/v1/effects
  presets: [],
  sel: null,           // { node, chain }
  hover: -1,
  pinned: -1,
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
  el.innerHTML = `<span class="msg">${esc(err ? msg.message : msg)}${details.map((d) => `<div>${esc(d)}</div>`).join('')}</span><button type="button" aria-label="Dismiss" title="Dismiss">${icon('close')}</button>`;
  el.querySelector('button').onclick = () => el.remove();
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), opts.ms || (err || opts.error ? 8000 : 3500));
}
S.toast = toast;
// S.fail reports an action that failed, naming the action.
S.fail = (doing, e) => toast(failure(doing, e), { error: true, details: (e && e.details) || [] });

S.setAllRuns = (all) => {
  S.allRuns = !!all;
  save(RUNS, S.allRuns);
  S.visibility = runVisibility(S.geo, S.allRuns);
  S.view?.setPixelVisibility(S.visibility.pixels);
  if (S.pinned >= 0 && !S.visibility.pixels[S.pinned]) unpin();
  S.hover = -1;
  applySelection();
  S.refreshLegend?.();
  S.emit('runVisibility');
  markDirty();
};

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
  // At full the chip sits by the toggle, in the strip of map above the sheet.
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
  } else if (plan) {
    S.view = openPlan(canvas, plan, i, common);
  } else {
    S.view = openPlan(canvas, { url: '', view_box: [0, 0, 10, 10], scale: 1 }, -1, common);
  }
  S.view.setPixelVisibility(S.visibility.pixels);
  resize();
  S.view.restore();
  applySelection();
  S.emit('view');
}

function cameraChanged(st) {
  S.emit('camera', st);
}

// ---------- selection ----------

// select makes a tree node the selection; chain is the breadcrumb (top
// first), by default the node's ancestors.
function select(node, chain) {
  if (!node) { S.sel = null; } else S.sel = { node, chain: chain || S.tree.chain(node) };
  renderCrumbs();
  applySelection();
  S.emit('select', S.sel);
  if (S.panel.detent() === 'full') frameSelection();
}
S.select = select;

function renderCrumbs() {
  const box = $('crumbs');
  const sel = S.sel;
  box.hidden = !sel;
  if (!sel) { setInsets(); return; }
  box.innerHTML = sel.chain.map((nd, i) => `${i ? `<span class="sep">${icon('chevronRight')}</span>` : ''}<button type="button" data-i="${i}" class="${nd === sel.node ? 'on' : ''}" title="${esc(nodeKinds(nd))} · ${nd.count} px">${esc(nodeName(nd))}</button>`).join('') +
    `<button type="button" class="x" aria-label="Clear the selection" title="Clear the selection">${icon('close')}</button>`;
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

// applySelection draws the halo along the selected pixels.
function applySelection() {
  if (!S.view) return;
  S.view.setSelection(S.sel ? S.sel.node.ranges : null);
}

function frameSelection() {
  if (!S.sel) return;
  const ids = [];
  for (const [a, b] of S.sel.node.ranges) for (let p = a; p <= b; p++) ids.push(p);
  S.view.frameIds(ids);
}

// ---------- input on the map ----------

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
  const nd = S.tree.climb(ri, S.sel && S.sel.node);
  const chain = S.tree.chain(S.tree.runNode(ri));
  select(nd, chain.includes(nd) ? chain : null);
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

let inspectSeq = 0, inspected = null, inspectMore = false;
const showQ = () => (S.show ? '?show=' + S.show : '');

async function inspect(p) {
  const seq = ++inspectSeq;
  if (p < 0) { inspected = null; renderInspect(); return; }
  let d;
  try { d = await api('/api/map/pixels/' + p + showQ()); } catch (e) { return; } // the next hover or poll retries
  if (seq !== inspectSeq) return;
  inspected = d;
  renderInspect();
}
S.inspect = inspect;

// liveHex is pixel p's color in the live frame, as #rrggbb.
function liveHex(p) {
  const i = 3 * p;
  return '#' + [S.rgb[i], S.rgb[i + 1], S.rgb[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// refreshInspectColor keeps the card's color row on the live frame, so
// an inspected pixel shows its color changing.
let inspectColor = '';
function refreshInspectColor() {
  const d = inspected;
  if (!d) return;
  const hex = liveHex(d.id);
  if (hex === inspectColor) return;
  inspectColor = hex;
  const el = S.panel.layout() === 'sheet' ? $('inspectRow') : $('inspectCard');
  const chip = el.querySelector('[data-color-chip]'), text = el.querySelector('[data-color-text]');
  if (!chip) return;
  chip.style.background = hex;
  text.textContent = hex;
}

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
  const layer = sh ? `${esc(sh.layer)}${sh.preview ? ' (preview)' : ''}${sh.effect ? ' · ' + esc(sh.effect) : ''}${sh.preset ? ' · preset ' + esc(sh.preset) : ''}${sh.target ? ' on ' + esc(sh.target) : ''}` : '<span class="muted">Nothing</span>';
  const maps = d.mappings.map((m) => r(esc(m.id), `${fmt(m.u)}${m.kind === 'index' ? '' : ' m'}${m.stretch !== null && Math.abs(m.stretch - 1) > 1e-4 ? ` · ×${fmt(m.stretch)}` : ''}`)).join('');
  const html = `<div class="head"><b>Pixel ${d.id}${d.dead ? ' (dead)' : ''}</b>${pinned ? `<button type="button" class="quiet" data-unpin aria-label="Unpin" title="Unpin">${icon('close')}</button>` : ''}</div>
    <table>
    ${r('Color', `<span class="chip-color" data-color-chip style="background:${liveHex(d.id)}"></span><span data-color-text>${liveHex(d.id)}</span>`)}
    ${r('Showing', layer)}
    ${r('Run', d.run ? esc(d.run) : '<span class="muted">None</span>')}
    ${r('Output', o ? `${esc(o.controller)} ${esc(outputName(o))}` : '<span class="muted">None</span>')}
    </table>
    <details class="more"${inspectMore ? ' open' : ''}><summary>Details</summary><table>
    ${r('Controller pixel', `${esc(d.controller)}:${d.index}`)}
    ${d.run ? r('Pixel on run', d.run_pixel) : ''}
    ${o ? r('LED on output', `${d.id - o.first + 1} of ${o.count}`) : ''}
    ${r('Areas', esc(d.areas.join(', ') || '—'))}
    ${r('Zones', esc(d.zones.join(', ') || '—'))}
    ${r('Segment', d.edge ? `${esc(d.edge)} · ${fmt(d.dist, 2)} m` : '—')}
    ${r('Pixel size', d.dl === null ? '—' : fmt(d.dl * 1000, 1) + ' mm')}
    ${S.view.kind === '3d' ? r('Position', d.x === null ? '—' : `${fmt(d.x, 2)}, ${fmt(d.y, 2)}, ${fmt(d.z, 2)} m`) : r('Plan position', d.x === null ? '—' : `${fmt(d.x, 2)}, ${fmt(d.y, 2)} m`)}
    ${maps}
    </table></details>`;
  const el = sheet ? row : card;
  el.innerHTML = html;
  el.querySelector('details.more').ontoggle = (e) => { inspectMore = e.target.open; placeCard(); };
  const b = el.querySelector('[data-unpin]');
  if (b) b.onclick = unpin;
  inspectColor = '';
  if (sheet && pinned && !row.hidden) row.scrollIntoView({ block: 'nearest' });
  placeCard();
}

// placeCard docks the floating card in the corner of the map farthest
// from its pixel, so that it never hides what is being inspected.
function placeCard() {
  const card = $('inspectCard');
  if (card.hidden || !inspected) return;
  const q = S.view.screenOf(inspected.id);
  const { w, h } = S.view.size();
  const stage = $('stage').getBoundingClientRect();
  const under = (id) => { const el = $(id); return el.hidden ? 0 : el.getBoundingClientRect().bottom - stage.top; };
  const [x, y] = cardCorner({ w, h, cw: card.offsetWidth, ch: card.offsetHeight, top: Math.max(under('chips'), under('crumbs')), pixel: q });
  card.style.left = x + 'px';
  card.style.top = y + 'px';
}

// ---------- the stream ----------

let ws = null, ranges = [];
let geometrySignature = '';
const geometryKey = ({ gen, presets, ...rest }) => JSON.stringify(rest);
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/map/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { S.connected = true; subscribe(); };
  ws.onclose = () => { S.connected = false; badge(); setTimeout(connect, 1000); };
  ws.onmessage = async (e) => {
    const t0 = performance.now();
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'subscribed') {
        // The config was reloaded: the pixel table may have changed.
        if (m.gen !== S.geo.gen) {
          try {
            const geo = await api('/api/map/geometry');
            if (geometryKey(geo) !== geometrySignature) { location.reload(); return; }
            S.geo.gen = geo.gen;
            S.geo.presets = geo.presets;
            await S.refreshPresets();
          } catch (err) { S.toast('Could not refresh the preset library.'); }
        }
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
    refreshInspectColor();
    if (S.overlay.live()) markDirty();
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

S.refreshBadge = badge;
let badgeShown = false;
// badge shows what the map is showing, on the chip and on the toggle.
function badge() {
  badgeShown = true;
  const m = mapStatus({ connected: S.connected, show: S.show, preview: S.preview, target: S.calibrating && S.cal?.active && ['anchor', 'end'].includes(S.cal.target?.kind) });
  const b = $('badge');
  b.innerHTML = `${esc(m.text)}<span class="detail">${esc(m.detail)}</span>`;
  b.className = 'badge ' + m.cls;
  b.title = m.title;
  for (const t of $('showSeg').querySelectorAll('button')) {
    press(t, (t.dataset.show === '' ? 'preview' : 'lights') === m.showing);
    if (t.dataset.show === '') {
      t.disabled = !m.canPreview;
      t.title = m.canPreview ? 'Your preview layers, on the map only' : 'Nothing in preview. Tap a look to try one.';
    }
  }
}

// setShow picks what the map shows: '' the preview (the lights' frames
// when nothing is being previewed), 'house' what the lights show.
function setShow(v) {
  S.show = v;
  save(SHOW, v);
  subscribe();
  badge();
  if (S.pinned >= 0) inspect(S.pinned);
  S.emit('show', v);
}
S.setShow = setShow;

// ---------- server state ----------

async function pollPreview() {
  try {
    const st = await api('/api/map/preview');
    S.preview = st;
    S.emit('preview', st);
    badge();
  } catch (e) { /* offline: the badge says so */ }
}
const pollHouse = createHousePoll(S, api);
// refresh reloads the stacks now, after a change.
S.refresh = async () => { await Promise.all([pollPreview(), pollHouse()]); };

// ---------- chrome ----------

function bindChrome() {
  for (const b of $('showSeg').querySelectorAll('button')) b.onclick = () => setShow(b.dataset.show);
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

let bootStep = 'load the map';
async function main() {
  fillIcons(document);
  const q = new URLSearchParams(location.search);
  if (q.get('pointer') === 'coarse') document.documentElement.classList.add('coarse');
  S.coarse = matchMedia('(pointer: coarse)').matches || q.get('pointer') === 'coarse';
  S.geo = await api('/api/map/geometry');
  geometrySignature = geometryKey(S.geo);
  S.visibility = runVisibility(S.geo, S.allRuns);
  S.rgb = new Uint8Array(S.geo.pixels.count * 3);
  S.tree = buildTree(S.geo);
  const loadLibrary = createLibrary(S, api);
  await loadLibrary();
  // A failed load stays recorded; each panel shows it with Retry.
  S.retryLibrary = async () => { await loadLibrary(); S.emit('presets'); };
  bootStep = 'set up the page';
  S.panel = createPanel({ onLayout, onDetent, onTab: (name) => { S.emit('tab', name); resize(); } });
  S.overlay = createOverlay(S);
  S.looks = createLooks(S, $('tab-looks'));
  S.presetLibrary = createPresets(S, $('tab-presets'));
  S.setup = createSetup(S, $('tab-setup'));
  S.status = createStatus(S, $('tab-status'));
  $('bootLoading').remove();
  bindChrome();
  bindMap();
  bootStep = 'draw the map';
  let plan = +load(PLAN, 0);
  if (!(plan >= 0 && plan < S.geo.plans.length)) plan = 0;
  await openView(plan);
  // An active session reopens immediately after Confirm reloads the map.
  // Its camera hold/frame operations require the asynchronous 3-D view.
  S.calib = createCalibrate(S, $('calibrate'));
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
  $('bootLoading')?.remove();
  const box = $('bootError');
  box.innerHTML = stateHTML({ ...bootFailure(bootStep, e), retry: true });
  box.hidden = false;
  box.querySelector('[data-retry]').onclick = () => location.reload();
});
