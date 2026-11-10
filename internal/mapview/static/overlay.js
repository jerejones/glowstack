// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The live map's overlays: the diagnostic colorings (flow position,
// stretch, areas, controller outputs) with their legends, and the items
// drawn over the map in screen space on the 2-D canvas: controllers,
// nodes, links, anchors, labels, flow arrows, output starts, the calibration cursors
// and the hovered and pinned pixels. Pixels themselves are the view's
// (scene.js or plan.js).
import { api, load, save, esc, outputName, count, fmt, ramp, spacingColor, SPACING_FULL, nthColor, PALETTE, humanize, inRanges, readableLabel } from './util.js';
import { controllerName, controllerLabel, nodeDisplay, runName } from './names.js';
import { RUN_LINE, runLit, unlitRuns } from './map-control.js';
import { clusterPoints, runPoints, CLUSTER, MARKER, TARGET as TARGET_RING, OTHERS } from './cal-points.js';

const CTRL = '#facc15', CTRL_OFF = '#9ca3af';
const OVERLAY_VERSION = 2;

export const MODES = [
  ['live', 'Live', 'What the map or the lights are showing'],
  ['flow', 'Direction', 'Which way effects travel along the lights'],
  ['stretch', 'Spacing', 'Where lights are packed tighter or looser than drawn; a run Status flags is in full color'],
  ['areas', 'Areas', 'The areas that make up a zone'],
  ['outputs', 'Wiring', 'Which controller output drives each light'],
];

// overlayShown is what the map draws of the overlay state st. The color
// mode and the map options belong to Setup: other tabs show the plain map,
// and st keeps the choice for coming back. While calibrating, the map shows
// the anchors over the live colors whatever the saved overlays say; this
// reads st and never writes to it, so nothing is left to restore or save.
export function overlayShown(st, { calibrating = false, tab = 'setup' } = {}) {
  if (calibrating) return { ...st, mode: 'live', nodes: true };
  return tab === 'setup' ? st : { ...st, mode: 'live', nodes: false, labels: false, controllers: false };
}

// namesDraw is what the Names option names for an overlay state (B149):
// 'points' with Points on (each point, gap and link, as before), 'runs'
// without (every drawn run, once), '' when Names is off. Names alone used to
// name nothing in any view, because only the Points and Controllers drawings
// asked for labels. It is the same in every "Color the map by" view.
export const namesDraw = (o) => (!o.labels ? '' : o.nodes ? 'points' : 'runs');

// CHROME is what floats over the map: the header chip and brand, the
// Preview/Lights toggle, the tap hint, the breadcrumb's buttons, the key,
// the inspect card and the calibration panel. Each is an occupied rectangle
// for the label placer at every viewport (B144): a label that would touch
// one moves or is hidden and counted. The bars that hold the chips and the
// crumbs are as wide as the map; their children are what is drawn.
export const CHROME = ['#chips > *', '#mapControls', '#mapHint', '#crumbs > *', '#crumbMenu', '#legend', '#inspectCard', '#calibrate'];
export const CHROME_GAP = 4; // px of clear space a label keeps from any of them

// occupiedRects measures CHROME in doc, in px from the stage's corner (stage
// is its bounding rect), each grown by gap. sheetTop, when given, is where a
// phone's sheet will rest: the sheet is occupied from there down, wherever
// its animation has got to.
export function occupiedRects(doc, stage, { sheetTop = null, gap = CHROME_GAP } = {}) {
  const out = [];
  for (const el of CHROME.flatMap((sel) => [...doc.querySelectorAll(sel)])) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue; // display: none
    out.push({ x0: r.left - stage.left - gap, x1: r.right - stage.left + gap, y0: r.top - stage.top - gap, y1: r.bottom - stage.top + gap });
  }
  if (sheetTop != null) out.push({ x0: 0, x1: stage.width, y0: sheetTop - gap, y1: stage.height });
  return out;
}

const hit = (a, b, gap = 0) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
// Nearest first; the far ones get a leader line back to their point.
const NEAR_SPOTS = 8;
const SPOTS = (w, H) => [[0, 0], [0, H], [0, -H], [-w - 20, 0], [-w - 20, H], [-w - 20, -H], [0, 2 * H], [0, -2 * H],
  ...[3, 4, 6, 8].flatMap((r) => [[0, r * H], [0, -r * H], [-w - 20, r * H], [-w - 20, -r * H], [40, r * H], [40, -r * H]])];
const NAME_ROOM = 10;     // px of clear space around a name label
const NAME_AREA = 16000;  // px² of free map each name label may have
const LABEL_GAP = 3;      // px between any two labels
const NAME_LENGTH = 26;   // longer names are cut short; hovering shows them whole
const FOCUS_LENGTH = 40;  // the name of what's being pointed at, cut less
const PHONE_LENGTH = 18;  // any name on a phone's narrow map
const PHONE_WIDTH = 480;  // px of map narrower than that

// shortLabel fits text in max characters on a word boundary: it never ends
// mid-word or on punctuation.
export function shortLabel(text, max = NAME_LENGTH) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max - 1);
  return `${(cut > 0 ? text.slice(0, cut) : text.slice(0, max - 1)).replace(/[\s,;:·/-]+$/, '')}…`;
}

// inZones says a screen point falls inside one of the boxes that outrank it.
export const inZones = ([x, y], zones) => zones.some((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);

// runCrowded says a run's points are too close on screen for each to carry
// a name: zoomed out, the run gets one label instead. points are in order.
export function runCrowded(points, room = 90) {
  if (points.length < 2) return false;
  const gaps = points.slice(1).map((q, i) => Math.hypot(q[0] - points[i][0], q[1] - points[i][1])).sort((a, b) => a - b);
  return gaps[gaps.length >> 1] < room;
}

// ARROW_GAP is the least room, on screen, between two direction arrows:
// closer than that they touch and the run reads as a smear.
export const ARROW_GAP = 24;

// thinArrows keeps, of the candidate arrows, those at least gap px from
// every other kept one, the longest edges' arrows first. Each candidate is
// { x, y, len }; the order of the result is the order they were kept in.
export function thinArrows(cands, gap = ARROW_GAP) {
  const kept = [];
  for (const c of [...cands].sort((a, b) => b.len - a.len)) {
    if (kept.every((k) => Math.hypot(k.x - c.x, k.y - c.y) >= gap)) kept.push(c);
  }
  return kept;
}

// plate draws a label's rounded dark plate: the same behind every label,
// colored or gray, so each reads against the wireframe.
export function plate(ctx, b, radius = 4) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  ctx.fillStyle = 'rgba(13, 14, 16, 0.94)';
  if (!ctx.roundRect) { ctx.fillRect(b.x0, b.y0, w, h); return; } // an old canvas: square corners
  ctx.beginPath(); ctx.roundRect(b.x0, b.y0, w, h, radius); ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'; ctx.lineWidth = 1; ctx.stroke();
}

// The labels that show whatever the room: below it, only these are readable.
const FOCUS = 2.5;
// The least map height, between the top chips and the sheet, worth labeling.
const MIN_MAP_ROOM = 150;

// placeLabels picks where each label goes, or leaves it out: highest rank
// first, the first free spot near where it asked to be. A budget label (a
// name, a percentage) needs room around it too, and is placed only while
// the free map has space for it: the rest show on hover or tap. measure(l) is the text's width. It returns the placed labels with
// their boxes and text positions, and on the array, hidden: how many on the
// visible map were left out. marks are the map's points: a label goes clear
// of them when it can, and on top of one only if nothing else is free.
// solid(box) says a box lies across the model's lights. No label goes there,
// except the point being measured or pointed at, and only if nothing else is free.
// A clear label is never placed on a mark: without room it is hidden and counted.
export function placeLabels(queued, { avoid = [], marks = [], width = Infinity, height = Infinity, measure, clipTop = true, solid = () => false }) {
  const placed = [];
  // What a full-width sheet along the bottom leaves of the map.
  const free = Math.min(height, ...avoid.filter((a) => a.x0 <= 0 && a.x1 >= width && a.y1 >= height).map((a) => a.y0));
  const budget = Number.isFinite(width * height) ? Math.floor(width * free / NAME_AREA) : Infinity;
  const inView = (l) => l.x >= 0 && l.x <= width && l.y >= 0 && l.y <= free;
  const top = Math.max(0, ...avoid.filter((a) => a.y0 < 16 && a.y1 < free).map((a) => a.y1));
  const cramped = Number.isFinite(free) && free - top < MIN_MAP_ROOM;
  let spent = 0, targetBox = null, hidden = 0;
  // The same kind of label, shortest first: it fits where a long one won't.
  const order = [...queued].sort((a, b) => b.rank - a.rank || (a.budget && b.budget ? a.text.length - b.text.length : 0));
  for (const raw of order) {
    if ((cramped && raw.rank < FOCUS) || (raw.budget && spent >= budget)) { if (inView(raw)) hidden++; continue; }
    const target = raw.rank === 3, H = target ? 19 : 15; // the plate's height
    const most = width < PHONE_WIDTH ? PHONE_LENGTH : raw.rank >= FOCUS ? FOCUS_LENGTH : NAME_LENGTH;
    const l = !target && raw.text.length > most ? { ...raw, text: shortLabel(raw.text, most) } : raw;
    const w = measure(l);
    const passes = [...(marks.length ? [[true, true]] : []), ...(raw.clear && marks.length ? [] : [[false, true]]), ...(raw.rank >= FOCUS ? [[false, false]] : [])];
    let done = false;
    // Only a label the model blocks moves far: neighbors don't push one away.
    let blocked = false;
    for (const [clearMarks, clearModel] of passes) {
      for (const [i, [dx, dy]] of SPOTS(w, H).entries()) {
        if (i >= NEAR_SPOTS && !blocked) break;
        // A label near the right edge slides in rather than being cut off.
        const x = Math.max(4, Math.min(l.x + dx, width - w - 4)), y = l.y + dy;
        const box = { x0: x - 3, x1: x + w + 3, y0: y - H + 3, y1: y + 3 };
        if (box.y1 > height || (clipTop && box.y0 < 0)) continue;
        if (avoid.some((a) => hit(box, a, 2)) || placed.some((b) => hit(box, b, l.budget ? NAME_ROOM : LABEL_GAP))) continue;
        if (clearMarks && marks.some((m) => hit(box, m))) continue;
        if (clearModel && solid(box)) { blocked = true; continue; }
        if (!target && targetBox && hit(box, targetBox, 40)) continue;
        placed.push({ ...box, text: l.text, tx: x, ty: y, color: l.color, rank: l.rank, alpha: l.alpha ?? 1, leader: i >= NEAR_SPOTS ? [l.x, l.y] : null });
        if (target) targetBox = box;
        if (l.budget) spent++;
        done = true;
        break;
      }
      if (done) break;
    }
    // The point being measured always has its name: with no free spot it
    // goes beside the point, held inside the free map, over whatever is there.
    if (!done && target) {
      const x = Math.max(4, Math.min(l.x, width - w - 4)), y = Math.max(top + H + 4, Math.min(l.y, free - 8));
      const box = { x0: x - 3, x1: x + w + 3, y0: y - H + 3, y1: y + 3 };
      placed.push({ ...box, text: l.text, tx: x, ty: y, color: l.color, rank: l.rank, alpha: 1, leader: null });
      targetBox = box;
      done = true;
    }
    if (!done && inView(raw)) hidden++;
  }
  placed.hidden = hidden;
  return placed;
}

// Deduplicate coincident occurrences in world space, not screen space: two
// elevations may overlap from one camera angle and separate from another.
export function nodeLocations(g, i, plan) {
  const nd = g.nodes[i];
  if (!nd) return [];
  const out = [];
  for (const p of nd.locations?.length ? nd.locations : [nd]) {
    if (p.plan !== plan || p.x == null) continue;
    const same = out.find((q) => Math.hypot(q.x-p.x, q.y-p.y, q.z-p.z) < 1e-5);
    if (same) { if (p.run) same.runs.push(p.run); }
    else out.push({ ...p, runs: p.run ? [p.run] : [] });
  }
  return out;
}

// createOverlay keeps the overlay state. S is the app state: geo, view,
// plan, hover, pinned, cal (the calibration session, or null).
// areaPaint is the order a zone's parts are painted in, bigger areas first so
// smaller ones stay visible over them, and which parts still show afterward:
// a part every pixel of which is painted over has no color on the map, so it
// has no place in the key.
export function areaPaint(parts) {
  const order = parts.map((_, i) => i).filter((i) => parts[i].area).sort((a, b) => parts[b].area.count - parts[a].area.count);
  const last = new Map();
  for (const i of order) for (const [a, b] of parts[i].area.ranges) for (let p = a; p <= b; p++) last.set(p, i);
  return { order, seen: new Set(last.values()) };
}

export function createOverlay(S) {
  const g = S.geo, px = g.pixels, n = px.count;
  const st = { mode: 'live', mapping: '', zone: '', nodes: false, labels: false, controllers: false, evenSpacing: false, legend: '' };
  // focus is the controller the Wiring key points at: the others' runs and
  // labels dim while it does. Never remembered.
  st.focus = '';
  const flows = g.mappings.filter((m) => m.kind === 'flow');
  st.mapping = (flows.find((m) => m.id === g.default_mapping) || flows[0] || g.mappings[0] || {}).id || '';
  st.zone = (g.zones[0] || {}).id || '';
  const prefs = load('glowstack.overlays', {}) || {};
  // Builds before v2 could save the Points overlay calibration had forced
  // on. A saved state from one of them gives up its Points setting, once.
  if (prefs.v !== OVERLAY_VERSION) delete prefs.nodes;
  if (MODES.some(([mode]) => mode === prefs.mode)) st.mode = prefs.mode;
  if (g.mappings.some((m) => m.id === prefs.mapping)) st.mapping = prefs.mapping;
  if (g.zones.some((z) => z.id === prefs.zone)) st.zone = prefs.zone;
  for (const key of ['nodes', 'labels', 'controllers', 'evenSpacing']) {
    if (typeof prefs[key] === 'boolean') st[key] = prefs[key];
  }
  const remember = () => save('glowstack.overlays', Object.fromEntries([['v', OVERLAY_VERSION],
    ...['mode', 'mapping', 'zone', 'nodes', 'labels', 'controllers', 'evenSpacing'].map((key) => [key, st[key]])]));
  const shown = () => overlayShown(st, { calibrating: S.calibrating, tab: S.panel?.tab() });
  const mappings = new Map();
  let outs = null, edgeCache = null;

  const mapping = async (id) => {
    if (!mappings.has(id)) mappings.set(id, await api('/api/map/mappings/' + encodeURIComponent(id)));
    return mappings.get(id);
  };

  // outputs lists every controller output: its global pixel range and a
  // color.
  function outputs() {
    if (outs) return outs;
    outs = [];
    for (const c of g.controllers) {
      for (const o of c.outputs) {
        const i = outs.length;
        outs.push({ controller: c.id, output: o.output, gpio: o.gpio, start: o.start, input: c.base + o.start + (o.reversed ? o.count - 1 : 0), first: c.base + o.start, last: c.base + o.start + o.count - 1, count: o.count, max_ma: o.max_ma, color: nthColor(i) });
      }
    }
    return outs;
  }
  const outputOf = (p) => outputs().find((o) => p >= o.first && p <= o.last) || null;

  // colors computes the view's colors for the mode and its legend, as
  // { rgb, legend }.
  async function colors() {
    const out = new Uint8Array(n * 3);
    let legend = '';
    if (st.mode === 'flow' || st.mode === 'stretch') {
      const m = await mapping(st.mapping);
      for (let p = 0; p < n; p++) {
        const c = m.u[p] === null ? [70, 70, 70]
          : st.mode === 'flow' ? ramp((m.u[p] - m.min) / ((m.max - m.min) || 1)) : spacingColor(m.spacing[p]);
        out.set(c, 3 * p);
      }
      if (st.mode === 'flow') {
        const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `rgb(${ramp(t)})`).join(',');
        const unit = m.kind === 'index' ? '' : ' m';
        legend = `<div>Distance along <b>${esc(humanize(m.id))}</b>; arrows show the direction</div>
          <div class="ramp" style="background:linear-gradient(90deg,${stops})"></div>
          <div class="row"><span>${fmt(m.min, 2)}${unit}</span><span>${fmt(m.max, 2)}${unit}</span></div>`;
      } else {
        const stops = [1 / SPACING_FULL, 1 / 1.1, 1, 1.1, SPACING_FULL].map((s) => `rgb(${spacingColor(s)})`).join(',');
        legend = `<div>Spacing against the drawing; full color is what Status flags</div>
          <div class="ramp" style="background:linear-gradient(90deg,${stops})"></div>
          <div class="row"><span>tighter</span><span>as drawn</span><span>looser</span></div>
          <div class="muted">${S.coarse ? 'Tap' : 'Hover over'} a run for its percentage</div>`;
      }
      return { rgb: out, legend };
    }
    out.fill(40);
    if (st.mode === 'areas') {
      // The zone's segments; bigger areas first so smaller ones stay
      // visible where they overlap.
      const z = g.zones.find((z) => z.id === st.zone);
      const parts = z ? z.segments.map((s, i) => ({ name: humanize(s.area), area: g.areas.find((a) => a.id === s.area) })) : [];
      const { order, seen } = areaPaint(parts);
      for (const i of order) {
        const c = PALETTE[i % PALETTE.length];
        for (const [a, b] of parts[i].area.ranges) for (let p = a; p <= b; p++) out.set(c, 3 * p);
      }
      legend = z ? `<div>Parts of <b>${esc(z.name || humanize(z.id))}</b></div>` +
        parts.map((pt, i) => (seen.has(i) ? `<div><span class="sw" style="background:rgb(${PALETTE[i % PALETTE.length]})"></span>${esc(pt.name)}</div>` : '')).join('')
        : '<div class="muted">No zones.</div>';
      return { rgb: out, legend };
    }
    // outputs: one line per controller, a numbered swatch per output.
    const byController = new Map();
    for (const o of outputs()) {
      if (S.visibility && !S.visibility.pixels.subarray(o.first, o.last + 1).some(Boolean)) continue;
      const color = dimmed(o.controller) ? o.color.map((v) => Math.round(v * DIM)) : o.color;
      for (let p = o.first; p <= o.last; p++) out.set(color, 3 * p);
      byController.set(o.controller, [...(byController.get(o.controller) || []), o]);
    }
    // The GPIO lives here and in each swatch's title, not on the map's labels.
    let html = `<div class="muted">Rings mark where each output starts. ${S.coarse ? 'Tap' : 'Point at'} a controller to pick it out.</div>`;
    for (const [id, list] of byController) {
      const name = controllerName(g, id);
      html += `<div class="key-row" data-controller="${esc(id)}"><b>${esc(name)}</b>${list.map((o) => `<span title="${esc(`${name} ${outputName(o)}: ${count(o.count)} lights`)}"><i class="sw" style="background:rgb(${o.color})"></i>${o.output}${o.gpio != null ? `<span class="muted"> GPIO ${o.gpio}</span>` : ''}</span>`).join('')}</div>`;
    }
    return { rgb: out, legend: html };
  }

  // apply puts the mode's colors on the view and returns the legend.
  async function apply() {
    const o = shown();
    // Built up here and only then stored: two applies in flight (a mode
    // change during a run filter change) mustn't write the keys twice.
    const made = o.mode === 'live' ? { rgb: null, legend: '' } : await colors();
    S.view.setColors(made.rgb);
    let legend = made.legend;
    if (o.nodes) {
      legend += `<div class="key"><span><i class="sw ring" style="color:#5ddc8a"></i>measured</span><span><i class="sw ring dash" style="color:#ffb347"></i>estimated</span><span><i class="sw dot" style="background:#e5e7eb"></i>point</span><span><i class="sw diamond" style="background:#f472b6"></i>shared corner</span></div>`;
    }
    if (o.controllers && (g.controller_locations || []).some((c) => c.plan === S.plan)) {
      legend += `<div class="key"><span><i class="sw" style="background:${CTRL}"></i>controller</span><span><i class="sw" style="background:${CTRL_OFF}"></i>not in config</span></div>`;
    }
    st.legend = legend;
    return legend;
  }

  // focus picks controller id out in Wiring: the others' runs recolor
  // dimmer and their rings and labels fade. '' clears it.
  async function focus(id) {
    const next = id || '';
    if (next === st.focus) return;
    st.focus = next;
    if (shown().mode === 'outputs') S.view.setColors((await colors()).rgb);
    S.markDirty();
  }
  // DIM is how much of its color a run keeps while another controller is picked out.
  const DIM = 0.3, FADE = 0.35;
  const dimmed = (controller) => !!st.focus && controller !== st.focus;

  // ----- drawing -----
  let ctx = null;
  const at = (x, y, z) => S.view.toScreen(x, y, z);
  const pixelAt = (p) => ((!S.visibility || S.visibility.pixels[p]) && px.plan[p] === S.plan && px.x[p] !== null ? at(px.x[p], px.y[p], px.z[p]) : null);
  const nodeAt = (i) => { const nd = g.nodes[i]; return (!S.visibility || S.visibility.nodes.has(i)) && nd && nd.plan === S.plan && nd.x !== null ? at(nd.x, nd.y, nd.z) : null; };

  // label queues text at (x, y). Labels are set after everything else is
  // drawn: each takes the first free spot near where it asked to be, on a
  // dark plate so it reads over the wireframe, and one with nowhere free is
  // dropped rather than drawn over another. rank orders them when there
  // isn't room: TARGET, the point being calibrated, goes first, stands out
  // and clears its neighbors.
  const TARGET = 3, MAJOR = 2, MINOR = 0;
  let queued = [], lastPlaced = [], marks = [], hiddenShown = -1;
  // mark notes a point drawn on the map, for the labels to keep clear of.
  const mark = (q, r) => { marks.push({ x0: q[0] - r, x1: q[0] + r, y0: q[1] - r, y1: q[1] + r }); };
  let labelAlpha = 1; // what the next labels are drawn at: a dimmed controller's fade
  const label = (text, x, y, color, rank = 1, budget = false, clear = false) => { queued.push({ text, x, y, color, rank, budget, clear, alpha: labelAlpha }); };
  // modelCells is which cells of a coarse screen grid the visible lights
  // cross, redone only when the view moves. Far-apart pixels are joined, so
  // a zoomed-in strip stays solid between its samples.
  const CELL = 6, MAX_SAMPLES = 4000;
  let cells = null, cellsKey = '', cellsFor = null;
  function modelCells(width, height) {
    const stride = Math.max(1, Math.floor(n / MAX_SAMPLES));
    const key = [S.plan, width, height, pixelAt(0), pixelAt(n >> 1), pixelAt(n - 1)].join();
    if (cells && key === cellsKey && cellsFor === S.visibility) return cells;
    const cols = Math.ceil(width / CELL) + 1, rows = Math.ceil(height / CELL) + 1;
    const grid = new Uint8Array(cols * rows);
    const fill = (x, y) => { if (x >= 0 && y >= 0 && x <= width && y <= height) grid[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1; };
    let last = null, lastRun = -2;
    for (let p = 0; p < n; p += stride) {
      const q = pixelAt(p);
      if (!q) { last = null; continue; }
      fill(q[0], q[1]);
      if (last && px.run[p] === lastRun) {
        const steps = Math.min(200, Math.ceil(Math.hypot(q[0] - last[0], q[1] - last[1]) / CELL));
        for (let i = 1; i < steps; i++) fill(last[0] + (q[0] - last[0]) * i / steps, last[1] + (q[1] - last[1]) * i / steps);
      }
      last = q; lastRun = px.run[p];
    }
    cells = { grid, cols, rows };
    cellsKey = key; cellsFor = S.visibility;
    return cells;
  }
  function flushLabels() {
    ctx.textBaseline = 'alphabetic';
    const avoid = S.labelAvoid ? S.labelAvoid() : [];
    const { w: width, h: height } = S.view.size ? S.view.size() : { w: Infinity, h: Infinity };
    const receding = queued.some((l) => l.rank === TARGET);
    const model = queued.length && n && px.plan && Number.isFinite(width * height) ? modelCells(width, height) : null;
    const solid = model ? (b) => {
      for (let y = Math.max(0, Math.floor(b.y0 / CELL)); y <= Math.min(model.rows - 1, Math.floor(b.y1 / CELL)); y++) {
        for (let x = Math.max(0, Math.floor(b.x0 / CELL)); x <= Math.min(model.cols - 1, Math.floor(b.x1 / CELL)); x++) if (model.grid[y * model.cols + x]) return true;
      }
      return false;
    } : undefined;
    const placed = placeLabels(queued, {
      avoid, marks, width, height, clipTop: !!S.view.size, solid,
      measure: (l) => { ctx.font = `${l.rank === TARGET ? '600 14px' : '12px'} system-ui, sans-serif`; return ctx.measureText ? ctx.measureText(l.text).width : l.text.length * 6; },
    });
    for (const p of placed) {
      const target = p.rank === TARGET;
      ctx.font = `${target ? '600 14px' : '12px'} system-ui, sans-serif`;
      ctx.globalAlpha = (receding && !target ? 0.6 : 1) * (p.alpha ?? 1);
      if (p.leader) {
        ctx.strokeStyle = 'rgba(203, 213, 225, 0.55)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.leader[0], p.leader[1]); ctx.lineTo(Math.max(p.x0, Math.min(p.leader[0], p.x1)), p.leader[1] < p.y0 ? p.y0 : p.y1); ctx.stroke();
      }
      plate(ctx, p);
      if (target) { ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1; ctx.strokeRect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0); }
      ctx.fillStyle = readableLabel(p.color);
      ctx.fillText(p.text, p.tx, p.ty);
    }
    ctx.globalAlpha = 1;
    lastPlaced = placed;
    queued = [];
    marks = [];
    if (placed.hidden !== hiddenShown) { hiddenShown = placed.hidden; S.refreshLabelNote?.(); }
  }
  function ring(q, r, color, width = 2, dash = null, disc = null) {
    mark(q, r * 0.7);
    ctx.strokeStyle = color; ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, 2 * Math.PI); if (disc) { ctx.fillStyle = disc; ctx.fill(); } ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  function edgePixels() {
    if (edgeCache && edgeCache.plan === S.plan) return edgeCache.map;
    const map = new Map();
    for (let p = 0; p < n; p++) {
      const e = px.edge[p];
      if (e < 0 || px.plan[p] !== S.plan || px.x[p] === null) continue;
      if (!map.has(e)) map.set(e, []);
      map.get(e).push(p);
    }
    edgeCache = { plan: S.plan, map };
    return map;
  }

  // arrows: one per edge at its middle, thinned so that none is within
  // ARROW_GAP of another on screen; a far run keeps its longest edges' arrows.
  let lastArrows = [];
  function arrows(m) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    const cands = [];
    for (const pixels of edgePixels().values()) {
      const ps = pixels.filter((p) => m.u[p] !== null).sort((a, b) => m.u[a] - m.u[b]);
      if (ps.length < 4) continue;
      const i = Math.floor(ps.length / 2);
      const a = pixelAt(ps[i - 1]), b = pixelAt(ps[i + 1]), c = pixelAt(ps[i]);
      const s = pixelAt(ps[0]), e = pixelAt(ps[ps.length - 1]);
      if (!a || !b || !c || !s || !e) continue;
      cands.push({ x: c[0], y: c[1], angle: Math.atan2(b[1] - a[1], b[0] - a[0]), len: Math.hypot(e[0] - s[0], e[1] - s[1]) });
    }
    lastArrows = thinArrows(cands);
    lastArrows.offered = cands.length; // for a measurement: how many there were before thinning
    for (const c of lastArrows) {
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(c.angle);
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -6); ctx.lineTo(-3, 0); ctx.lineTo(-6, 6); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (m.flow) {
      const q = nodeAt(m.flow.origin);
      if (q) { ring(q, 7, '#fff'); label(`origin ${nodeDisplay(g, g.nodes[m.flow.origin].id)}`, q[0] + 10, q[1] + 18, '#fff', MAJOR); }
    }
  }

  // inFocus says pixel p is the one hovered or pinned, or in the selection.
  const inFocus = (p) => p === S.hover || p === S.pinned || (!!S.sel && inRanges(S.sel.node.ranges, p));

  // spacingLabels says how far each stretch is from its drawing. flowLabels
  // is the Direction mode's: where a flow stretches or compresses a pattern.
  function spacingLabels(m) {
    for (const pixels of edgePixels().values()) {
      const mid = pixels[Math.floor(pixels.length / 2)], s = m.spacing[mid];
      if (s === null || pixels.length < 2) continue;
      if (!pixels.some(inFocus)) continue; // the map is the view; the number is a detail
      const pct = Math.round(Math.abs(s - 1) * 100);
      if (!pct && !st.evenSpacing) continue; // as drawn: nothing to say
      const q = pixelAt(mid);
      if (q) label(pct ? `${pct}% ${s < 1 ? 'tighter' : 'looser'}` : 'as drawn', q[0] + 6, q[1] + 14, '#eee', MINOR);
    }
  }
  function flowLabels(m) {
    if (!m.flow) return;
    for (const [e, pixels] of edgePixels()) {
      const s = m.flow.edge_stretch[e];
      if (s === null || pixels.length < 2 || s.toFixed(2) === '1.00') continue;
      const q = pixelAt(pixels[Math.floor(pixels.length / 2)]);
      if (q) label('×' + s.toFixed(2), q[0] + 6, q[1] + 14, '#eee', MINOR);
    }
  }

  function outputStarts() {
    for (const o of outputs()) {
      const q = pixelAt(o.input);
      if (!q) continue;
      const fade = dimmed(o.controller);
      ctx.globalAlpha = fade ? FADE : 1;
      ring(q, 11, `rgb(${o.color})`, 2, null, 'rgba(0,0,0,.8)');
      // Colors can repeat on a big site: the number inside says which output.
      ctx.fillStyle = '#fff'; ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(o.output), q[0], q[1]);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
      // The phone's map strip is short: the panel's legend has the rest.
      // In a tight cluster a name is hidden, and counted, rather than crowded in.
      // The output's GPIO is in the key and the inspect card, never here: a
      // label that has to be cut short says less than one without it.
      labelAlpha = fade ? FADE : 1;
      if (S.panel?.layout() === 'sheet') label(`${controllerName(g, o.controller)} ${o.output}`, q[0] + 10, q[1] - 8, `rgb(${o.color})`, MAJOR, true, true);
      else label(`${controllerName(g, o.controller)} output ${o.output}`, q[0] + 10, q[1] - 8, `rgb(${o.color})`, MAJOR, true, true);
      labelAlpha = 1;
    }
  }

  // controllers: a square where the scene model puts each board, gray
  // for one controllers.yaml doesn't list. In Outputs mode a dashed line
  // runs to each output's input ring; it isn't the cable's route.
  function controllers() {
    const o = shown();
    for (const c of g.controller_locations || []) {
      if (c.plan !== S.plan) continue;
      const q = at(c.x, c.y, c.z);
      if (!q || inZones(q, targetZones)) continue;
      const cfg = c.controller >= 0 ? g.controllers[c.controller] : null;
      const inStep = S.calibrating && !!S.cal?.active && !!S.cal.target; // a step shows only its own run's names
      const fade = o.mode === 'outputs' && dimmed(cfg ? cfg.id : c.id);
      const was = ctx.globalAlpha;
      ctx.globalAlpha = was * (fade ? FADE : 1);
      if (cfg && o.mode === 'outputs') {
        ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        for (const o of outputs()) {
          if (o.controller !== cfg.id) continue;
          const r = pixelAt(o.input);
          if (!r) continue;
          ctx.strokeStyle = `rgb(${o.color})`;
          ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(r[0], r[1]); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      ctx.fillStyle = cfg ? CTRL : CTRL_OFF; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(q[0] - 6, q[1] - 6, 12, 12); ctx.fill(); ctx.stroke();
      mark(q, 6);
      const display = controllerName(g, c.id); // a board the config doesn't list has only an id
      const name = o.labels ? controllerLabel(display, c.label) : display;
      // On the small map these are names like any other: only those with room.
      labelAlpha = fade ? FADE : 1;
      if (!inStep) label(name, q[0] + 10, q[1] + 4, cfg ? CTRL : CTRL_OFF, MAJOR, S.panel?.layout?.() === 'sheet');
      labelAlpha = 1;
      ctx.globalAlpha = was;
    }
  }

  // nodes: sync points, links and gaps, anchors (measured solid green,
  // estimated dashed amber).
  function nodes() {
    const o = shown();
    // The phone's overview before starting: small enough not to run together.
    const k = S.calibrating && !S.cal?.active && S.panel?.layout() === 'sheet' ? 0.6 : 1;
    // In a step only the run being measured keeps its names: the others' hide.
    const step = S.calibrating && S.cal?.active ? S.cal.target : null;
    const stepRun = step ? step.run || S.cal.cursors?.[S.cal.side]?.run || '' : null;
    const named = (runs) => stepRun === null || !runs.length || runs.includes(stepRun);
    ctx.lineWidth = 1.5;
    for (const e of g.edges) {
      if (e.kind === 'strip') continue;
      const a = nodeAt(e.from), b = nodeAt(e.to);
      if (!a || !b) continue;
      ctx.setLineDash(e.kind === 'link' ? [6, 4] : [2, 3]);
      ctx.strokeStyle = e.kind === 'link' ? '#c4b5fd' : '#7dd3fc';
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (o.labels && stepRun === null) label(e.kind === 'link' ? 'link' : `gap ${e.length.toFixed(2)} m`, (a[0] + b[0]) / 2 - 20, (a[1] + b[1]) / 2 + 16, ctx.strokeStyle, MINOR, true);
    }
    ctx.setLineDash([]);
    // What a name is for right now: the point under the pointer, or the selected run.
    const near = S.pinned >= 0 ? pixelAt(S.pinned) : S.hover >= 0 ? pixelAt(S.hover) : null;
    const pointed = S.pinned >= 0 ? S.pinned : S.hover;
    const under = (r) => { const ps = r.anchors.map((an) => an.pixel); return pointed >= Math.min(...ps) && pointed <= Math.max(...ps); };
    const chosen = new Set(g.runs.filter((r) => (S.sel && r.anchors.some((an) => inRanges(S.sel.node.ranges, an.pixel))) || (pointed >= 0 && under(r))).map((r) => r.id));
    // Zoomed out, a run's points would be a pile of names: it gets one.
    const crowded = new Set();
    if (o.labels) for (const r of g.runs) {
      const pts = r.anchors.map((an) => pixelAt(an.pixel)).filter(Boolean);
      if (chosen.has(r.id) || !runCrowded(pts)) continue;
      crowded.add(r.id);
      const q = pts[pts.length >> 1];
      if (named([r.id]) && !inZones(q, targetZones) && !inZones(q, nameZones)) label(runName(g, r.id), q[0] + 8, q[1] - 6, '#e5e7eb', 1.1, true);
    }
    calClusters = [];
    if (S.calibrating) calMarkers(step);
    else for (const r of g.runs) {
      for (const an of r.anchors) {
        if (an.source === 'end') continue;
        const q = pixelAt(an.pixel);
        if (!q) continue;
        const measured = an.source === 'measured';
        ring(q, MARKER.radius * k, measured ? '#5ddc8a' : '#ffb347', MARKER.width, measured ? null : [3, 3]);
      }
    }
    g.nodes.forEach((nd, i) => {
      const locations = nodeLocations(g, i, S.plan).filter((p) => !S.visibility || p.runs.some((id) => S.visibility.runs[g.runs.findIndex((r) => r.id === id)]) || (!p.runs.length && S.visibility.nodes.has(i)));
      const shared = (nd.locations?.length || 0) > 1;
      const sync = nd.sync || locations.length > 1;
      const projected = locations.map((p) => ({ ...p, q: at(p.x, p.y, p.z) })).filter((p) => p.q);
      if (projected.length > 1) {
        const a = projected[0].q;
        ctx.strokeStyle = '#f472b6'; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]);
        for (const p of projected.slice(1)) {
          ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...p.q); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      for (const p of projected) {
        const [x, y] = p.q;
        if (inZones(p.q, targetZones) || inZones(p.q, nameZones)) continue;
        if (calClusters.some((c) => c.points.length > 1 && Math.hypot(c.x - x, c.y - y) < CLUSTER_R + 2)) continue; // under a cluster's marker
        ctx.fillStyle = sync ? '#f472b6' : '#e5e7eb';
        ctx.beginPath();
        const d = 6 * k;
        if (sync) { ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath(); } else ctx.arc(x, y, 3.5 * k, 0, 2 * Math.PI);
        ctx.fill();
        mark(p.q, 5);
        if (!o.labels || !named(p.runs)) continue;
        const display = nodeDisplay(g, nd.id);
        const whole = shared && p.runs.length ? `${display} · ${p.runs.map((id) => runName(g, id)).join(' / ')}` : display;
        const focused = (near && Math.hypot(near[0] - x, near[1] - y) < 40) || p.runs.some((id) => chosen.has(id));
        if (!focused && p.runs.length && p.runs.every((id) => crowded.has(id))) continue;
        // Which run a shared corner is on is the first thing to give up.
        const name = focused || whole.length <= NAME_LENGTH ? whole : display;
        // A corner several runs meet at matters most, then the rest by room.
        label(name, x + 8, y - 6, sync ? '#f9a8d4' : '#e5e7eb', focused ? FOCUS : sync ? 1.2 : 1, !focused);
      }
    });
  }

  // runNames names every drawn run once, at its middle, when Names is on
  // without Points: a name like any other, placed only where there is room
  // and counted in the key when there is not.
  function runNames() {
    g.runs.forEach((r, ri) => {
      const sets = S.tree?.runSets?.[ri];
      if (!sets || !sets.length) return;
      const [a, b] = sets.reduce((best, x) => (x[1] - x[0] > best[1] - best[0] ? x : best));
      const q = pixelAt((a + b) >> 1);
      if (q) label(runName(g, r.id), q[0] + 8, q[1] - 6, '#e5e7eb', 1.1, true);
    });
  }

  // ----- run lines: the state language (map-control.js) -----
  // Every drawn run that is not lit has a thin neutral line along it; the run
  // under the pointer brightens; a run whose Status warning is pointed at
  // gets an amber outline. A lit run shows its look and no line. Paths are
  // screen polylines, rebuilt only when the view or the runs shown change.
  let pathsKey = '', paths = [], lineStates = { installed: false, hovered: false, warned: false }, statesKey = '';
  const seenLit = [];
  function runPaths() {
    const key = [S.plan, S.view.version, S.view.size?.().w, S.view.size?.().h, pixelAt(0), pixelAt(n - 1)].join();
    if (key === pathsKey && paths.for === S.visibility) return paths;
    paths = g.runs.map((r, ri) => {
      if (r.plan !== S.plan || !S.tree) return null;
      const parts = [];
      for (const [a, b] of S.tree.runSets[ri]) {
        const stride = Math.max(1, Math.floor((b - a) / 300));
        let part = [];
        for (let p = a; ; p = Math.min(b, p + stride)) {
          const q = pixelAt(p);
          if (q) part.push(q); else if (part.length) { parts.push(part); part = []; }
          if (p >= b) break;
        }
        if (part.length) parts.push(part);
      }
      return parts.length ? parts : null;
    });
    paths.for = S.visibility; pathsKey = key;
    return paths;
  }
  function strokeRun(parts, style) {
    ctx.strokeStyle = style.color; ctx.lineWidth = style.width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const part of parts) {
      ctx.moveTo(part[0][0], part[0][1]);
      // One pixel on screen still draws: a dot of the line's width.
      if (part.length === 1) ctx.lineTo(part[0][0] + 0.01, part[0][1]);
      for (let i = 1; i < part.length; i++) ctx.lineTo(part[i][0], part[i][1]);
    }
    ctx.stroke();
  }
  function runLines(o) {
    const next = { installed: false, hovered: false, warned: false };
    // Only over the live colors: a diagnostic coloring or a calibration step
    // paints every pixel, and their own marks lead.
    if (o.mode === 'live' && S.rgb && S.tree && !(S.calibrating && S.cal?.active)) {
      const all = runPaths();
      const lit = g.runs.map((r, ri) => !all[ri] || runLit(S.rgb, S.tree.runSets[ri]));
      const unlit = new Set(unlitRuns(lit, seenLit, performance.now()).filter((ri) => all[ri]));
      const hovered = S.hover >= 0 ? px.run[S.hover] : -1;
      for (const ri of unlit) if (ri !== hovered) { strokeRun(all[ri], RUN_LINE.installed); next.installed = true; }
      if (unlit.has(hovered)) { strokeRun(all[hovered], RUN_LINE.hovered); next.hovered = true; }
      const warned = S.warnedRun ?? -1;
      if (all[warned]) { strokeRun(all[warned], RUN_LINE.warned); next.warned = true; }
    }
    lineStates = next;
    const key = JSON.stringify(next);
    if (key !== statesKey) { statesKey = key; S.refreshStateKey?.(); }
  }

  // calCursors rings the physical target, not the moving test pixel.
  // The white pixel follows nudges; the target stays on the model corner.
  function cursorPoints() {
    const cal = S.cal;
    if (!S.calibrating || !cal || !cal.active || !cal.cursors) return [];
    return cal.cursors.flatMap((c, i) => {
      if (c.index < 0) return [];
      const ci = g.controllers.findIndex((x) => x.id === c.controller);
      if (ci < 0) return [];
      const ni = c.node ? g.nodes.findIndex((n) => n.id === c.node) : -1;
      const occurrence = ni >= 0 ? g.nodes[ni].locations?.find((p) => p.run === c.run && p.plan === S.plan) : null;
      const q = occurrence ? at(occurrence.x, occurrence.y, occurrence.z) : ni >= 0 ? nodeAt(ni)
        : pixelAt(g.controllers[ci].base + (cal.target?.kind === 'end' ? c.estimate : c.index));
      if (!q) return [];
      const name = ni >= 0 ? g.nodes[ni].name || humanize(c.node) : c.label ? humanize(c.label) : `${controllerName(g, c.controller)}:${c.index}`;
      return [{ q, on: i === cal.side, name }];
    });
  }

  // The current target is the one cyan ring: half again the radius of any
  // other marker and more than 2 px thicker, on a dark halo so it reads over
  // the lights, with its name always shown. Every other marker has stepped
  // back to OTHERS of its opacity (draw()).
  function calCursors(cursors) {
    for (const { q, on, name } of cursors) {
      if (on) ring(q, TARGET_RING.radius + 1, TARGET_RING.halo, TARGET_RING.width + 4);
      ring(q, on ? TARGET_RING.radius : 10, on ? TARGET_RING.color : 'rgba(34,211,238,.5)', on ? TARGET_RING.width : 2);
      if (on) label(name, q[0] + TARGET_RING.radius + 8, q[1] - 12, '#a5f3fc', TARGET);
    }
  }

  // calMarkers draws calibration's points while the mode is open. Markers
  // closer than a finger (or a pointer) can tell apart draw as one, with how
  // many it stands for; a tap on it lists them (calibrate.js). The point
  // being measured is never in a cluster: it has its own ring.
  const CLUSTER_R = 11;
  let calClusters = [], clustered = [], clustersKey = '';
  function calMarkers(step) {
    const pts = [];
    g.runs.forEach((r) => {
      for (const rp of runPoints(r, g.nodes)) {
        if (step && step.kind === 'anchor' && step.run === rp.run && step.node === rp.node) continue;
        const q = pixelAt(rp.pixel);
        if (q) pts.push({ x: q[0], y: q[1], ...rp });
      }
    });
    // Worked out again only when the view or the points change.
    const key = JSON.stringify([S.view.version, step && [step.run, step.node], pts.length, pts[0], pts.map((p) => p.measured).join('')]);
    if (key !== clustersKey) { clustersKey = key; clustered = clusterPoints(pts, S.coarse ? CLUSTER.coarse : CLUSTER.fine); }
    // Nothing overlaps the point being measured: a marker that would sit
    // under its ring is left out for that step (its row in Progress still
    // reaches it).
    const at = cursorPoints().filter((c) => c.on).map((c) => c.q);
    calClusters = clustered.filter((c) => !at.some((q) => Math.hypot(c.x - q[0], c.y - q[1]) < TARGET_RING.radius + TARGET_RING.width + CLUSTER_R + 2));
    for (const c of calClusters) {
      const all = c.points.every((p) => p.measured), q = [c.x, c.y];
      const color = all ? '#5ddc8a' : '#ffb347';
      if (c.points.length === 1) { ring(q, MARKER.radius, color, MARKER.width, all ? null : [3, 3]); continue; }
      ring(q, CLUSTER_R, color, MARKER.width, all ? null : [3, 3], 'rgba(13, 14, 16, 0.92)');
      ctx.fillStyle = '#fff'; ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(c.points.length), q[0], q[1] + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }

  // While a point is measured the map keeps an order: its ring and name,
  // then the controllers' names, then every other mark. Each gives way to
  // what outranks it instead of being drawn on top.
  let targetZones = [], nameZones = [];
  function reserveZones(cursors, showControllers) {
    targetZones = cursors.filter((c) => c.on).flatMap(({ q, name }) => [
      { x0: q[0] - 26, x1: q[0] + 26, y0: q[1] - 26, y1: q[1] + 26 },
      { x0: q[0] + 12, x1: q[0] + 24 + name.length * 8, y0: q[1] - 30, y1: q[1] + 2 },
    ]);
    nameZones = [];
    if (!targetZones.length || !showControllers) return;
    for (const c of g.controller_locations || []) {
      if (c.plan !== S.plan) continue;
      const q = at(c.x, c.y, c.z);
      if (!q || inZones(q, targetZones)) continue;
      nameZones.push({ x0: q[0] - 14, x1: q[0] + 14 + controllerName(g, c.id).length * 7, y0: q[1] - 14, y1: q[1] + 14 });
    }
  }

  // draw paints the overlay items for the view's current projection.
  function draw(c) {
    ctx = c;
    const m = mappings.get(st.mapping), o = shown();
    runLines(o);
    if (o.mode === 'flow' && m) { arrows(m); flowLabels(m); }
    if (o.mode === 'stretch' && m) spacingLabels(m);
    if (o.mode === 'outputs') outputStarts();
    const cursors = cursorPoints();
    reserveZones(cursors, o.controllers);
    // Measuring one point: every other point steps back.
    ctx.globalAlpha = S.calibrating && S.cal?.active && S.cal.target ? OTHERS : 1;
    if (o.nodes) nodes();
    else if (namesDraw(o) === 'runs') runNames();
    if (o.controllers) controllers();
    ctx.globalAlpha = 1;
    calCursors(cursors);
    for (const [p, color] of [[S.hover, '#fff'], [S.pinned, '#ffb347']]) {
      if (p < 0) continue;
      const q = pixelAt(p);
      if (q) ring(q, 9, color);
    }
    flushLabels();
  }

  return { st, apply, draw, outputs, outputOf, mapping, flows, remember, shown, focus, placed: () => lastPlaced, arrows: () => lastArrows, hiddenLabels: () => lastPlaced.hidden || 0, lineStates: () => lineStates, runPaths, calClusters: () => calClusters, live: () => shown().mode === 'live' };
}
