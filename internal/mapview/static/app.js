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
import { createOverlay, occupiedRects } from './overlay.js';
import { buildTree, nodeName, nodeKinds, targetName, targetRanges } from './select.js';
import { openPlan } from './plan.js';
import { createPresets } from './panel/presets.js';
import { createLooks } from './panel/looks.js';
import { cardCorner, createAim, rectGap, labelSpot } from './card-place.js';
import { tapHint, showTapHint, hintSeen, markHintSeen, runAt, runTitle } from './map-control.js';
import { inspectSentences, inspectTechnical } from './inspect.js';
import { createSetup } from './panel/setup.js';
import { createStatus } from './panel/status.js';
import { createCalibrate, OWN_RELOAD } from './panel/calibrate.js';
import { runVisibility } from './run-visibility.js';
import { createHousePoll, lightOutcome, zeroRanges, dimSent } from './house-status.js';
import { createLibrary } from './library.js';
import { mapStatus, badgeHTML, showButton } from './map-status.js';
import { icon, fillIcons } from './icons.js';
import { stateHTML, showState, bootFailure, skeletonHTML } from './states.js';
import { frameInsets, framePad, toastBottom, toastHome, sheetToastTop } from './map-frame.js';
import { foldable, merged } from './toast-merge.js';
import { createTiles } from './tiles.js';
import { runName, controllerName, areaName, zoneName } from './names.js';
import { showingLabel, layerName } from './form.js';

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
  connecting: true,    // no socket result yet: neither connected nor lost
  stream: null,        // the last "subscribed" message
  fps: load(RATE, 0),  // stream rate asked for; 0 is the server's cap
  preview: null,       // /api/map/preview
  previewStatus: 'loading',
  house: [],           // /api/v1/layers
  houseStatus: 'loading',
  houseRead: false,    // the lights have been read at least once
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
// sheetUp says a phone's sheet is showing its contents: messages go in it.
const sheetUp = () => !!S.panel && S.panel.layout() === 'sheet' && !S.panel.collapsed();
function toast(msg, opts = {}) {
  const box = $(toastHome(S.calibrating, !!$('caToasts'), sheetUp()));
  const err = msg instanceof Error;
  const el = document.createElement('div');
  el.className = 'toast' + (err || opts.error ? ' error' : opts.warn ? ' warn' : opts.neutral ? ' neutral' : '');
  // Messages arriving together fold into this one: see toast-merge.js.
  const showing = [...box.children].map((t) => ({ el: t, ...t.note }));
  const folded = foldable(showing, { error: err || opts.error, action: opts.action || opts.actions?.[0] }, S.panel ? S.panel.layout() : 'wide', Date.now());
  for (const t of folded) t.el.remove();
  const { text, details } = merged(err ? msg.message : msg, err ? msg.details || [] : opts.details || [], folded);
  el.note = { at: Date.now(), error: err || opts.error, action: opts.action || opts.actions?.[0], text, details };
  el.innerHTML = `<span class="msg">${esc(text)}${details.map((d) => `<div>${esc(d)}</div>`).join('')}</span><button type="button" aria-label="Dismiss" title="Dismiss">${icon('close')}</button>`;
  el.querySelector('button').onclick = () => el.remove();
  // Buttons that do the toast's fix, then clear it: the one action, and
  // after an apply Undo beside it (opts.actions).
  const actions = [opts.action, ...(opts.actions || [])].filter(Boolean);
  if (actions.length) el.classList.add('has-action');
  let after = el.querySelector('.msg');
  for (const a of actions) {
    const act = Object.assign(document.createElement('button'), { type: 'button', className: 'act' + (a.quiet ? ' quiet' : ''), textContent: a.label });
    if (a.id) act.dataset.act = a.id;
    act.onclick = () => { el.remove(); a.run(); };
    after.after(act);
    after = act;
  }
  placeToasts();
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), opts.ms || (err || opts.error ? 8000 : 3500));
  return el;
}
S.toast = toast;
function placeToasts() {
  if (!S.panel) return;
  const stage = $('stage').getBoundingClientRect();
  $('toasts').style.bottom = toastBottom({ floats: floatsBottom(stage) }) + 'px';
  // In the sheet they end just above its sticky bar, when it has one showing.
  const bar = [...document.querySelectorAll('#content .look-bar, #content .editor-actions')].find((b) => b.offsetParent);
  $('panelToasts').style.top = sheetToastTop({ visible: S.panel.covered(), bar: bar ? bar.offsetHeight : 0, safe: parseFloat(getComputedStyle($('panel')).paddingBottom) || 0 }) + 'px';
}
S.placeToasts = placeToasts;
// moveToasts carries messages already showing to where they belong now.
S.moveToasts = () => {
  const home = $(toastHome(S.calibrating, !!$('caToasts'), sheetUp()));
  for (const id of ['toasts', 'caToasts', 'panelToasts']) { const other = $(id); if (other && other !== home) home.append(...other.children); }
  placeToasts();
};
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
  syncTabsInset();
  placeToasts();
  markDirty();
}

// syncTabsInset keeps scrolling into view a tab bar's height clear of the
// content's top edge, whatever the bar's height at this width.
function syncTabsInset() {
  $('content').style.setProperty('--tabs-h', document.querySelector('.tabs').offsetHeight + 'px');
}

// setInsets keeps framing to the map the chip bar and sheet leave free.
function setInsets() {
  if (!S.view) return;
  const stage = $('stage').getBoundingClientRect();
  const below = (id) => $(id).getBoundingClientRect().bottom - stage.top;
  const { top, bottom } = frameInsets({
    height: stage.height,
    chips: below('chips'),
    // The tap hint sits where the breadcrumb will be: the lights frame clear of either.
    crumbs: !$('crumbs').hidden ? below('crumbs') : !$('mapHint').hidden ? below('mapHint') : null,
    controls: below('mapControls'),
    layout: S.panel.layout(),
    covered: S.panel.covered(),
    calibrating: S.calibrating,
    calTop: $('calibrate').getBoundingClientRect().top - stage.top,
    floats: floatsBottom(stage),
  });
  // Markers on the lights (calibration's points, Wiring's rings) are framed with them.
  const shown = S.overlay?.shown();
  S.view.setInsets(top, bottom, framePad({ width: stage.width, height: stage.height - top - bottom, markers: !!shown && (shown.nodes || shown.mode === 'outputs') }));
}
S.setInsets = setInsets;

// floatsBottom is how much of the map's bottom edge the side-layout toggle
// and legend take up.
function floatsBottom(stage) {
  // Height 0 is a legend ui.css hides. The toggle at the top of a phone's
  // map doesn't count; the key above its sheet does.
  const low = (r) => r.top - stage.top > stage.height / 2;
  const sheet = S.panel.layout() === 'sheet' && !S.calibrating;
  // A folded key on a calibrating phone's strip is a corner chip: the target can use that row.
  // So is the key while it lists only the runs' states: one line, a chip's size.
  const foldedCorner = (S.calibrating && S.panel.layout() === 'sheet' && $('legend').classList.contains('folded')) || $('legend').classList.contains('states-only');
  const tops = [[$('mapControls'), low], [$('legend'), () => !foldedCorner]].map(([el, keep]) => [el.getBoundingClientRect(), keep]).filter(([r, keep]) => r.height && keep(r)).map(([r]) => r.top);
  return Math.max(sheet ? S.panel.covered() : 0, stage.bottom - Math.min(stage.bottom, ...tops));
}
S.resize = resize;

// ---------- the view ----------

async function openView(i) {
  const plan = S.geo.plans[i];
  S.plan = i;
  const runs = S.geo.runs.map((r, ri) => (r.plan === i ? { ranges: S.tree.runSets[ri] } : null));
  S.pickRuns = runs;
  const common = { px: S.geo.pixels, rgb: S.rgb, onChange: markDirty, onCamera: cameraChanged };
  const blank = () => openPlan(canvas, { url: '', view_box: [0, 0, 10, 10], scale: 1 }, -1, common);
  try {
    if (plan && plan.kind === 'scene') {
      $('gl').hidden = false;
      const scene = await import('./scene.js');
      S.view = await scene.open($('gl'), canvas, { ...common, url: plan.url, layers: plan.layers || [], map: S.geo.map || {}, plan: i });
    } else S.view = plan ? openPlan(canvas, plan, i, common) : blank();
  } catch (e) {
    // The drawing failed, not the page: every tab goes on without it.
    console.error(e);
    $('gl').hidden = true;
    showMapError('draw the map', e);
    S.view = blank();
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
  if (node) markHintSeen(); // the first selection: the tap has been found
  renderCrumbs();
  renderHint();
  applySelection();
  S.emit('select', S.sel);
  if (S.panel.detent() === 'full') frameFull();
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
  $('crumbs').style.top = $('mapHint').style.top = ($('chips').getBoundingClientRect().bottom - stage.top + 6) + 'px';
}

// renderHint shows the one line that teaches the tap, as a quiet caption
// where the breadcrumb will be, on the Looks tab, until this device's first
// selection. It is the only place the line is said.
function renderHint() {
  const box = $('mapHint');
  box.hidden = !showTapHint({ seen: hintSeen(), selected: !!S.sel, tab: S.panel.tab(), calibrating: S.calibrating, failed: !!S.mapFailed || !S.view });
  box.textContent = box.hidden ? '' : tapHint(S.coarse ? 'Tap' : 'Click'); // in the page only while it shows
  setInsets(); // the caption takes, or gives back, a line of the map's top
}
S.renderHint = renderHint;

// ---------- the panel points at the map ----------

// pointAt draws the pointing halo along ranges, or clears it with null: the
// pixels a hovered card would go on, a controller's runs, one run. What is
// selected already has its halo, so pointing at the same pixels adds none.
let pointed = null;
const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
function pointAt(ranges) {
  pointed = ranges && ranges.length ? ranges : null;
  applyPoint();
}
S.pointAt = pointAt;
// applyPoint shows what is pointed at. With nothing selected and nothing
// pointed at there is no halo, at any detent: a halo is for an explicit
// selection, a hover or focus from the panel, or a tapped controller row.
function applyPoint() {
  if (!S.view || !S.view.setHighlight) return;
  let show = pointed;
  if (show && S.sel && JSON.stringify(show) === JSON.stringify(S.sel.node.ranges)) show = null;
  S.view.setHighlight(show, !reducedMotion.matches);
}
S.applyPoint = applyPoint;

// warnRun outlines a run in amber while its Status warning is pointed at
// ('' clears it).
S.warnedRun = -1;
S.warnRun = (id) => {
  const ri = id ? S.geo.runs.findIndex((r) => r.id === id) : -1;
  if (ri === S.warnedRun) return;
  S.warnedRun = ri;
  markDirty();
};
// runStates is which of the map's run states are on screen now, for the key.
S.runStates = () => ({
  ...(S.overlay ? S.overlay.lineStates() : {}),
  selected: !!S.sel && !S.calibrating,
  previewed: !S.calibrating && S.show !== 'house' && !!S.preview?.layers?.length,
  target: S.calibrating && !!S.cal?.active && !!S.cal.cursors?.length,
});

// applySelection draws the halo along the selected pixels.
function applySelection() {
  if (!S.view) return;
  S.view.setSelection(S.sel ? S.sel.node.ranges : null);
}

const previewRanges = () => (S.preview?.layers || []).flatMap((l) => targetRanges(S.geo, S.tree, l.target) || []);
const rangeIds = (ranges) => {
  const ids = [];
  for (const [a, b] of ranges) for (let p = a; p <= b; p++) ids.push(p);
  return ids;
};

// frameFull points the camera for a full sheet's short band of map: at what's
// selected, else at the runs the preview lights. With neither it goes back to
// the device's camera, and holds that for when the sheet comes down.
function frameFull() {
  if (S.sel) S.view.frameIds(rangeIds(S.sel.node.ranges));
  else if (previewRanges().length) S.view.frameTight(rangeIds(previewRanges()));
  else if (fullHold) { S.view.release(fullHold); fullHold = S.view.hold(); }
  framedPreview = JSON.stringify(previewRanges());
}

// ---------- input on the map ----------

function tapAt(x, y) {
  const radius = S.coarse ? 24 : 12;
  if (S.calibrating) {
    const p = S.view.pickPixel(x, y, radius);
    S.calib.tapAt(x, y, p);
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
      // A double tap fits. While calibrating that is the mode's own framing:
      // it is not remembered as this device's camera.
      if (S.calibrating && S.view.fitAll) S.view.fitAll(); else S.view.setView('fit');
      return;
    }
    lastTap = { x: t.x, y: t.y, t: now };
    tapAt(t.x, t.y);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // Moving onto the card isn't leaving: it is what the card is there for.
  canvas.addEventListener('pointerleave', (e) => { if (!$('inspectCard').contains(e.relatedTarget)) endHover(); });
  const card = $('inspectCard');
  card.addEventListener('pointerenter', () => {
    clearTimeout(hoverTimer);
    armedFor = undefined;
    if (inspected && S.pinned < 0) { S.hover = inspected.id; markDirty(); }
  });
  card.addEventListener('pointerleave', (e) => { if (e.relatedTarget !== canvas) endHover(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

let hoverTimer = 0, armedFor;
const aim = createAim();
// hoverRun tells the panel which run the pointer is on ('' for none), so a
// row for it that is on screen can show it: the map points at the panel too.
let hoveredRun = -1;
function hoverRun(p) {
  const ri = p >= 0 ? S.geo.pixels.run[p] : -1;
  if (ri === hoveredRun) return;
  hoveredRun = ri;
  S.hoveredRun = ri >= 0 && S.geo.runs[ri] ? S.geo.runs[ri].id : '';
  S.emit('hoverRun', S.hoveredRun);
}
function endHover() {
  clearTimeout(hoverTimer);
  armedFor = undefined;
  aim.reset();
  S.hover = -1;
  hoverRun(-1);
  $('hoverLabel').hidden = true;
  if (S.pinned < 0 && inspected) inspect(-1);
  markDirty();
}
// hoverLabel names the run under the pointer, and its zone, in a small label
// beside the pointer: at once, from the geometry, for any drawn run, lit or
// not. It is placed where it covers none of that run's pixels.
function hoverLabel(p, x, y) {
  const box = $('hoverLabel');
  const at = p >= 0 && !S.calibrating ? runAt(S.geo, S.tree, p) : null;
  box.hidden = !at;
  if (!at) return;
  const html = `<b>${esc(at.run)}</b>${at.zone && at.zone !== at.run ? `<span>${esc(at.zone)}</span>` : ''}`;
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  const { w, h } = S.view.size();
  const points = [];
  for (const [a, b] of S.tree.runSets[at.index]) for (let q = a; q <= b; q += Math.max(1, Math.floor((b - a) / 300))) { const s = S.view.screenOf(q); if (s) points.push(s); }
  const [left, top] = labelSpot({ x, y, w: box.offsetWidth, h: box.offsetHeight, W: w, H: h, points });
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}
// aiming says the pointer is on its way to the open card, so what it
// crosses on the way doesn't replace what the card shows.
function aiming(x, y) {
  const card = $('inspectCard');
  if (S.pinned >= 0 || card.hidden || !inspected) { aim.reset(); return false; }
  const r = card.getBoundingClientRect(), at = canvas.getBoundingClientRect();
  return aim.step(rectGap({ left: r.left - at.left, top: r.top - at.top, right: r.right - at.left, bottom: r.bottom - at.top }, x, y), performance.now());
}
function hoverAt(x, y) {
  const p = S.view.pickPixel(x, y, 12);
  if (p !== S.hover) { S.hover = p; markDirty(); }
  hoverRun(p);
  hoverLabel(p, x, y);
  if (S.pinned >= 0) return;
  if (aiming(x, y)) { clearTimeout(hoverTimer); armedFor = undefined; return; }
  if (p === (inspected ? inspected.id : -1) || p === armedFor) return;
  clearTimeout(hoverTimer);
  armedFor = p;
  hoverTimer = setTimeout(() => { armedFor = undefined; inspect(p); }, 60);
}

// ---------- inspect ----------

let inspectSeq = 0, inspected = null, inspectMore = false, inspectTech = false, inspectShown = '', cardAt = null;
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
  if (card.hidden) cardAt = null;
  row.hidden = !d || !sheet || !pinned || S.calibrating;
  if (!d) return;
  const r = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const el = sheet ? row : card;
  const o = S.overlay.outputOf(d.id);
  const sh = d.showing;
  const layer = sh ? esc(showingLabel(S, sh, sh.target === 'all' ? 'everything' : sh.target ? targetName(S.geo, sh.target) : '')) : '<span class="muted">Nothing</span>';
  const pinButton = pinned
    ? `<button type="button" class="quiet icon-btn" data-unpin aria-label="Unpin this light" title="Stop keeping this card open">${icon('pinFilled')}Pinned</button>`
    : `<button type="button" class="quiet icon-btn" data-pin title="Keep this card open">${icon('pin')}Pin</button>`;
  const sentences = inspectSentences(d, {
    run: d.run ? runName(S.geo, d.run) : '',
    output: o && { led: d.id - o.first + 1, count: o.count, name: `${controllerName(S.geo, o.controller)} ${outputName(o)}` },
    areas: d.areas.map((id) => areaName(S.geo, id)),
    zones: d.zones.map((id) => zoneName(S.geo, id)),
  });
  // The run and its zone are the card's first line; the pixel's number follows.
  const where = d.run ? runTitle({ run: runName(S.geo, d.run), zone: d.zones.length ? zoneName(S.geo, d.zones[0]) : '' }) : '';
  const html = `<div class="head"><b>${where ? `${esc(where)}<small>Pixel ${d.id}${d.dead ? ' (dead)' : ''}</small>` : `Pixel ${d.id}${d.dead ? ' (dead)' : ''}`}</b>${pinButton}</div>
    <table>
    ${r('Color', `<span class="chip-color" data-color-chip></span><span data-color-text></span>`)}
    ${r('Showing', layer)}
    ${r('Run', d.run ? `<span title="${esc(d.run)}">${esc(runName(S.geo, d.run))}</span>` : '<span class="muted">None</span>')}
    ${r('Output', o ? `${esc(controllerName(S.geo, o.controller))} ${esc(outputName(o))}` : '<span class="muted">None</span>')}
    </table>
    <details class="more"${inspectMore ? ' open' : ''}><summary>Details</summary>
    ${sentences.map((t) => `<p>${esc(t)}</p>`).join('')}
    <details class="tech"${inspectTech ? ' open' : ''}><summary>Technical details</summary><table>
    ${inspectTechnical(d, { is3d: S.view.kind === '3d', fmt }).map(([k, v]) => r(esc(k), esc(v))).join('')}
    </table></details></details>`;
  inspectColor = '';
  // The second-by-second refresh of a pinned card leaves its buttons alone
  // unless something changed, so a press isn't lost to a redraw.
  if (html === inspectShown && el.innerHTML) { refreshInspectColor(); placeCard(); return; }
  inspectShown = html;
  el.innerHTML = html;
  el.querySelector('details.more').ontoggle = (e) => { inspectMore = e.target.open; placeCard(); };
  el.querySelector('details.tech').ontoggle = (e) => { inspectTech = e.target.open; placeCard(); };
  const b = el.querySelector('[data-unpin]');
  if (b) b.onclick = unpin;
  const p = el.querySelector('[data-pin]');
  if (p) p.onclick = () => pin(d.id);
  refreshInspectColor();
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
  const [x, y] = cardAt = cardCorner({ w, h, cw: card.offsetWidth, ch: card.offsetHeight, top: Math.max(under('chips'), under('crumbs')), pixel: q, prev: cardAt });
  card.style.left = x + 'px';
  card.style.top = y + 'px';
}

// ---------- the stream ----------

let ws = null, ranges = [];
let dimFor, dimPixels = []; // zones at 0%, worked out when their brightness changes
let geometrySignature = '';
const geometryKey = ({ gen, presets, ...rest }) => JSON.stringify(rest);
// setOffline follows a lost connection, not the wait for a first one, so
// startup doesn't flash it.
function setOffline(off) {
  if (S.offline === off) return;
  S.offline = off;
  document.getElementById('offlineBanner').hidden = !off;
  for (const id of ['tab-looks', 'tab-presets']) document.getElementById(id).inert = off;
  S.emit('offline');
}
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/map/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { S.connected = true; S.connecting = false; setOffline(false); subscribe(); };
  ws.onclose = () => { S.connected = false; S.connecting = false; badge(); setOffline(true); setTimeout(connect, 1000); };
  ws.onmessage = async (e) => {
    const t0 = performance.now();
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'subscribed') {
        // The config was reloaded: the pixel table may have changed.
        if (m.gen !== S.geo.gen) {
          try {
            const geo = await api('/api/map/geometry');
            if (geometryKey(geo) !== geometrySignature) { sessionStorage.setItem(OWN_RELOAD, '1'); location.reload(); return; }
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
    // A zone at 0% draws dim in the preview, so the look can be judged there
    // while the map still shows it won't be seen as drawn. Lights frames are the truth.
    if (S.frame.preview) {
      const b = S.statusData?.brightness;
      if (b !== dimFor) { dimFor = b; dimPixels = zeroRanges(S.geo, b); }
      if (dimPixels.length) dimSent(S.rgb, ranges, dimPixels);
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
  // A running calibration is on the real lights, whatever is in preview.
  ws.send(JSON.stringify({ fps: streamRate(), show: S.calibrating && S.cal?.active ? 'house' : S.show }));
}
S.subscribe = subscribe;
S.setRate = (fps) => { S.fps = fps; save(RATE, fps); subscribe(); };
S.streamRate = streamRate;

// What the labels keep clear of: the chrome over the map, and a phone's sheet
// where it ends up, not where its animation has got to.
S.labelAvoid = () => occupiedRects(document, $('stage').getBoundingClientRect(), { sheetTop: S.panel.layout() === 'sheet' && !S.calibrating ? $('stage').getBoundingClientRect().height - S.panel.covered() : null });
// litNow says whether what's on the lights can be seen, for the chip.
const litNow = () => lightOutcome(S.geo, S.statusData?.brightness, S.house.filter((l) => !l.ephemeral).map((l) => targetRanges(S.geo, S.tree, l.target)), S.houseStatus === 'available');
S.refreshBadge = badge;
let badgeShown = false;
// badge shows what the map is showing, on the chip and on the toggle.
function badge() {
  badgeShown = true;
  const step = S.calibrating && S.cal?.active ? S.cal.target?.kind || '' : '';
  const target = ['anchor', 'end'].includes(step);
  const m = mapStatus({ connected: S.connected, connecting: S.connecting, show: S.show, preview: S.preview, target, measuring: target ? '' : step, calActive: !!S.cal?.active, mode: S.overlay?.shown().mode, lit: S.geo?.mapless ? null : litNow(), mapless: !!S.mapFailed, fresh: S.houseStatus === 'available' && !S.statusFailed, reading: S.houseStatus === 'loading' && !S.statusFailed, dimZones: S.dimZones || 0, looks: S.house.filter((l) => !l.ephemeral).map((l) => layerName(S, l)), levels: S.statusData?.brightness && S.geo?.zones ? S.geo.zones.map((z) => S.statusData.brightness.zones?.[z.id] ?? 1) : null });
  const b = $('badge');
  b.innerHTML = badgeHTML(m, S.panel.layout() === 'sheet');
  b.className = 'badge ' + m.cls;
  b.title = m.title;
  // A calibration step is neither choice, and the chip says which it is.
  $('showSeg').hidden = m.showing === 'target' || m.showing === 'calibration';
  for (const t of $('showSeg').querySelectorAll('button')) {
    press(t, (t.dataset.show === '' ? 'preview' : 'lights') === m.showing);
    const state = showButton(t.dataset.show, { ready: !!S.view, failed: !!S.mapFailed, canPreview: m.canPreview, word: S.coarse ? 'Tap' : 'Click' });
    t.disabled = state.disabled;
    t.title = state.title;
    if (t.dataset.show === '') t.setAttribute('aria-disabled', state.ariaDisabled ? 'true' : 'false');
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
    S.previewStatus = 'ready';
    S.emit('preview', st);
    badge();
  } catch (e) {
    // Offline, the badge says so. Before a first reading the lane does too.
    if (!S.preview) { S.previewStatus = 'failed'; S.emit('preview', null); }
  }
}
const pollHouse = createHousePoll(S, api);
// refresh reloads the stacks now, after a change.
S.refresh = async () => { await Promise.all([pollPreview(), pollHouse()]); };

// ---------- chrome ----------

function bindChrome() {
  for (const b of $('showSeg').querySelectorAll('button')) b.onclick = () => (b.getAttribute('aria-disabled') === 'true' ? toast(b.title) : setShow(b.dataset.show));
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
    if (t && t.closest?.('dialog')) return; // Escape there is the dialog's
    if (S.calibrating) return; // calibration has its own keys: Escape asks to stop
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'Escape') {
      if (S.presetLibrary.closeEditor()) return;
      if (S.pinned >= 0) unpin();
      else if (S.sel) select(null);
      else if (S.panel.detent() && S.panel.detent() !== 'peek') S.panel.setDetent('peek');
    }
  });
}

function onLayout() {
  resize();
  if (!S.view) return;
  renderInspect();
  S.emit('layout', S.panel.layout());
}

let fullHold = null, framedPreview = '';
function onDetent(d) {
  if (!S.view) return; // still loading
  placeCrumbs(); // setInsets reads where the crumbs are
  if (d === 'full' && !fullHold) {
    fullHold = S.view.hold();
    setInsets();
    frameFull();
  } else if (d !== 'full' && fullHold) {
    const h = fullHold;
    fullHold = null;
    setInsets();
    S.view.release(h);
  } else {
    setInsets();
    if (d === 'full') frameFull(); // the band changed height
  }
  markDirty();
  S.emit('detent', d);
}
// While full, a change in what's previewed moves the camera with it.
function refitPreview() {
  if (!S.view || S.panel?.detent() !== 'full' || S.sel) return;
  if (!fullHold) { onDetent('full'); return; } // opened full: this is the first it can frame
  if (JSON.stringify(previewRanges()) !== framedPreview) frameFull();
}

// ---------- boot ----------

// showMapError puts a map failure in the map's pane, with Retry.
function showMapError(step, e, serverUp = false) {
  S.mapFailed = true;
  const box = $('mapError');
  box.innerHTML = stateHTML({ ...bootFailure(step, e, serverUp), retry: true });
  box.hidden = false;
  box.querySelector('[data-retry]').onclick = () => location.reload();
}

// NEEDS_MAP are the tabs that can't draw without the geometry.
const NEEDS_MAP = [['looks', 'Looks'], ['setup', 'Set up the map']];

// startWithoutMap keeps the page usable when the geometry can't be read:
// the navigation, the preset library and Status, which don't need it.
async function startWithoutMap(e) {
  console.error(e);
  $('bootLoading').remove();
  // An error answer is still an answer: only no answer at all is offline.
  const serverUp = await api('/api/v1/status').then(() => true, (err) => !err.network);
  showMapError('load the map', e, serverUp);
  S.connected = serverUp;
  S.connecting = false;
  $('mapControls').hidden = true;
  addEventListener('resize', () => { S.panel.refresh(); resize(); badge(); });
  const controllers = await api('/api/v1/controllers').then((r) => r.controllers || [], () => []);
  // The API counts a controller's outputs; the geometry lists them.
  S.geo = { mapless: true, mappings: [], controllers: controllers.map((c) => ({ ...c, outputs: Array(c.outputs || 0).fill({}) })), zones: [], areas: [], runs: [], nodes: [], plans: [] };
  // No stream to lose here: Status's own reads say whether the server is there.
  S.setServerUp = (up) => { if (S.connected === up) return; S.connected = up; setOffline(!up); badge(); };
  badge();
  S.status = createStatus(S, $('tab-status'));
  const loadLibrary = createLibrary(S, api);
  await loadLibrary();
  S.retryLibrary = async () => { await loadLibrary(); S.emit('presets'); };
  S.refresh = async () => {};
  S.looks = { push: () => toast('Previewing needs the map. Use Retry on the map.', { warn: true }), inPreview: () => false };
  S.tiles = createTiles(S);
  S.presetLibrary = createPresets(S, $('tab-presets'));
  for (const [id, name] of NEEDS_MAP) {
    $('tab-' + id).innerHTML = `<h1 class="title">${name}</h1>`;
    $('tab-' + id).append(Object.assign(document.createElement('div'), { innerHTML: stateHTML({ kind: 'empty', title: 'This needs the map', detail: 'It comes back when the map loads. Use Retry on the map.' }) }));
  }
}

// showLoadingTabs says each tab is on its way, until its own code draws it.
// showLoadingTabs puts each tab's skeleton in place (Looks already has its
// own from index.html) until the catalog arrives.
function showLoadingTabs() {
  for (const id of ['looks', 'presets', 'setup', 'status']) $('tab-' + id).innerHTML = skeletonHTML(id);
}

let bootStep = 'load the map';
async function main() {
  fillIcons(document);
  const q = new URLSearchParams(location.search);
  if (q.get('pointer') === 'coarse') document.documentElement.classList.add('coarse');
  S.coarse = matchMedia('(pointer: coarse)').matches || q.get('pointer') === 'coarse';
  S.panel = createPanel({ onLayout, onDetent, onTab: (name) => { S.emit('tab', name); resize(); } });
  showLoadingTabs();
  try { S.geo = await api('/api/map/geometry'); } catch (e) { await startWithoutMap(e); return; }
  geometrySignature = geometryKey(S.geo);
  S.visibility = runVisibility(S.geo, S.allRuns);
  S.rgb = new Uint8Array(S.geo.pixels.count * 3);
  S.tree = buildTree(S.geo);
  const loadLibrary = createLibrary(S, api);
  await loadLibrary();
  // A failed load stays recorded; each panel shows it with Retry.
  S.retryLibrary = async () => { await loadLibrary(); S.emit('presets'); };
  bootStep = 'set up the page';
  S.overlay = createOverlay(S);
  S.tiles = createTiles(S); // the library's tiles share one clock
  S.looks = createLooks(S, $('tab-looks'));
  S.presetLibrary = createPresets(S, $('tab-presets'));
  S.setup = createSetup(S, $('tab-setup'));
  S.status = createStatus(S, $('tab-status'));
  S.on('preview', refitPreview);
  for (const ev of ['preview', 'select', 'tab', 'detent', 'layout', 'view', 'runVisibility']) S.on(ev, applyPoint);
  S.on('tab', renderHint); // the caption is the Looks tab's
  for (const ev of ['preview', 'select', 'show', 'tab', 'calprogress']) S.on(ev, () => S.refreshStateKey?.());
  for (const ev of ['tab', 'detent', 'layout', 'preview']) S.on(ev, () => S.moveToasts());
  bindChrome();
  bindMap();
  bootStep = 'draw the map';
  let plan = +load(PLAN, 0);
  if (!(plan >= 0 && plan < S.geo.plans.length)) plan = 0;
  await openView(plan);
  $('bootLoading').remove();
  renderHint();
  // An active session reopens immediately after Confirm reloads the map.
  // Its camera hold/frame operations require the asynchronous 3-D view.
  S.calib = createCalibrate(S, $('calibrate'));
  S.setup.calibrateReady();
  setShow(S.show);
  connect();
  S.on('status', badge);
  S.on('house', badge);
  S.on('tab', badge);
  S.on('detent', badge);
  S.on('layout', badge);
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
