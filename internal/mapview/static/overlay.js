// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The live map's overlays: the diagnostic colorings (flow position,
// stretch, areas, controller outputs) with their legends, and the items
// drawn over the map in screen space on the 2-D canvas: controllers,
// nodes, links, anchors, labels, flow arrows, output starts, the calibration cursors
// and the hovered and pinned pixels. Pixels themselves are the view's
// (scene.js or plan.js).
import { api, load, save, esc, outputName, count, fmt, ramp, spacingColor, SPACING_FULL, nthColor, PALETTE, humanize } from './util.js';
import { controllerName, controllerLabel, nodeDisplay } from './names.js';

const CTRL = '#facc15', CTRL_OFF = '#9ca3af';
const OVERLAY_VERSION = 2;

export const MODES = [
  ['live', 'Live colors', 'What the map or the lights are showing'],
  ['flow', 'Direction', 'Which way effects travel along the lights'],
  ['stretch', 'Spacing', 'Where lights are packed tighter or looser than drawn; a run Status flags is in full color'],
  ['areas', 'Areas', 'The areas that make up a zone'],
  ['outputs', 'Wiring', 'Which controller output drives each light'],
];

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
export function createOverlay(S) {
  const g = S.geo, px = g.pixels, n = px.count;
  const st = { mode: 'live', mapping: '', zone: '', nodes: false, labels: false, controllers: false, evenSpacing: false, legend: '' };
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
  // While calibrating, the map shows the anchors over the live colors
  // whatever the saved overlays say. The mode reads through this and never
  // writes to st, so it leaves nothing behind to restore or to save.
  const shown = () => (S.calibrating ? { ...st, mode: 'live', nodes: true } : st);
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
          <div class="row"><span>tighter</span><span>as drawn</span><span>looser</span></div>`;
      }
      return { rgb: out, legend };
    }
    out.fill(40);
    if (st.mode === 'areas') {
      // The zone's segments; bigger areas first so smaller ones stay
      // visible where they overlap.
      const z = g.zones.find((z) => z.id === st.zone);
      const parts = z ? z.segments.map((s, i) => ({ name: humanize(s.area), area: g.areas.find((a) => a.id === s.area) })) : [];
      const order = parts.map((_, i) => i).filter((i) => parts[i].area).sort((a, b) => parts[b].area.count - parts[a].area.count);
      for (const i of order) {
        const c = PALETTE[i % PALETTE.length];
        for (const [a, b] of parts[i].area.ranges) for (let p = a; p <= b; p++) out.set(c, 3 * p);
      }
      legend = z ? `<div>Parts of <b>${esc(z.name || humanize(z.id))}</b></div>` +
        parts.map((pt, i) => `<div><span class="sw" style="background:rgb(${PALETTE[i % PALETTE.length]})"></span>${esc(pt.name)}</div>`).join('')
        : '<div class="muted">No zones.</div>';
      return { rgb: out, legend };
    }
    // outputs
    let html = '<div class="muted">Rings mark where each output starts</div>', ctrl = '';
    for (const o of outputs()) {
      if (S.visibility && !S.visibility.pixels.subarray(o.first, o.last + 1).some(Boolean)) continue;
      for (let p = o.first; p <= o.last; p++) out.set(o.color, 3 * p);
      if (o.controller !== ctrl) { ctrl = o.controller; html += `<div><b>${esc(controllerName(g, ctrl))}</b></div>`; }
      html += `<div><span class="sw" style="background:rgb(${o.color})"></span>${esc(outputName(o))}: ${count(o.count)} lights</div>`;
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
      legend += `<div class="key"><span><i class="sw" style="background:#5ddc8a"></i>measured point</span><span><i class="sw" style="background:#ffb347"></i>estimated</span><span><i class="sw" style="background:#f472b6"></i>shared corner</span></div>`;
    }
    if (o.controllers && (g.controller_locations || []).some((c) => c.plan === S.plan)) {
      legend += `<div class="key"><span><i class="sw" style="background:${CTRL}"></i>controller</span><span><i class="sw" style="background:${CTRL_OFF}"></i>not in config</span></div>`;
    }
    st.legend = legend;
    return legend;
  }

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
  let queued = [], lastPlaced = [];
  const label = (text, x, y, color, rank = 1) => { queued.push({ text, x, y, color, rank }); };
  const hit = (a, b, gap = 0) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
  function flushLabels() {
    ctx.textBaseline = 'alphabetic';
    const placed = [], avoid = S.labelAvoid ? S.labelAvoid() : [];
    const { w: width, h: height } = S.view.size ? S.view.size() : { w: Infinity, h: Infinity };
    queued.sort((a, b) => b.rank - a.rank);
    const receding = queued.some((l) => l.rank === TARGET);
    let targetBox = null;
    for (const l of queued) {
      const target = l.rank === TARGET;
      const H = target ? 19 : 15; // the plate's height
      ctx.font = `${target ? '600 14px' : '12px'} system-ui, sans-serif`;
      const w = ctx.measureText ? ctx.measureText(l.text).width : l.text.length * 6;
      for (const [dx, dy] of [[0, 0], [0, H], [0, -H], [-w - 20, 0], [-w - 20, H], [-w - 20, -H], [0, 2 * H], [0, -2 * H]]) {
        // A label near the right edge slides in rather than being cut off.
        const x = Math.max(4, Math.min(l.x + dx, width - w - 4)), y = l.y + dy;
        const box = { x0: x - 3, x1: x + w + 3, y0: y - H + 3, y1: y + 3 };
        if (box.y1 > height || (S.view.size && box.y0 < 0)) continue;
        if (avoid.some((a) => hit(box, a, 2)) || placed.some((b) => hit(box, b, 1))) continue;
        if (!target && targetBox && hit(box, targetBox, 40)) continue;
        placed.push({ ...box, text: l.text });
        if (target) targetBox = box;
        ctx.globalAlpha = receding && !target ? 0.6 : 1;
        ctx.fillStyle = 'rgba(13, 14, 16, 0.82)';
        ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
        if (target) { ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1; ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0); }
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, x, y);
        break;
      }
    }
    ctx.globalAlpha = 1;
    lastPlaced = placed;
    queued = [];
  }
  function ring(q, r, color, width = 2, dash = null) {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, 2 * Math.PI); ctx.stroke();
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

  function arrows(m) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    for (const pixels of edgePixels().values()) {
      const ps = pixels.filter((p) => m.u[p] !== null).sort((a, b) => m.u[a] - m.u[b]);
      if (ps.length < 4) continue;
      const i = Math.floor(ps.length / 2);
      const a = pixelAt(ps[i - 1]), b = pixelAt(ps[i + 1]), c = pixelAt(ps[i]);
      if (!a || !b || !c) continue;
      ctx.save();
      ctx.translate(c[0], c[1]); ctx.rotate(Math.atan2(b[1] - a[1], b[0] - a[0]));
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -6); ctx.lineTo(-3, 0); ctx.lineTo(-6, 6); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (m.flow) {
      const q = nodeAt(m.flow.origin);
      if (q) { ring(q, 7, '#fff'); label(`origin ${nodeDisplay(g, g.nodes[m.flow.origin].id)}`, q[0] + 10, q[1] + 18, '#fff', MAJOR); }
    }
  }

  // spacingLabels says how far each stretch is from its drawing. flowLabels
  // is the Direction mode's: where a flow stretches or compresses a pattern.
  function spacingLabels(m) {
    for (const pixels of edgePixels().values()) {
      const mid = pixels[Math.floor(pixels.length / 2)], s = m.spacing[mid];
      if (s === null || pixels.length < 2) continue;
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
      ring(q, 8, `rgb(${o.color})`);
      label(`${controllerName(g, o.controller)} ${outputName(o)}`, q[0] + 10, q[1] - 8, `rgb(${o.color})`, MAJOR);
    }
  }

  // controllers: a square where the scene model puts each board, gray
  // for one controllers.yaml doesn't list. In Outputs mode a dashed line
  // runs to each output's input ring; it isn't the cable's route.
  function controllers() {
    for (const c of g.controller_locations || []) {
      if (c.plan !== S.plan) continue;
      const q = at(c.x, c.y, c.z);
      if (!q) continue;
      const cfg = c.controller >= 0 ? g.controllers[c.controller] : null;
      if (cfg && st.mode === 'outputs') {
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
      const display = controllerName(g, c.id); // a board the config doesn't list has only an id
      const name = st.labels ? controllerLabel(display, c.label) : display;
      label(name, q[0] + 10, q[1] + 4, cfg ? CTRL : CTRL_OFF, MAJOR);
    }
  }

  // nodes: sync points, links and gaps, anchors (measured solid green,
  // estimated dashed amber).
  function nodes() {
    ctx.lineWidth = 1.5;
    for (const e of g.edges) {
      if (e.kind === 'strip') continue;
      const a = nodeAt(e.from), b = nodeAt(e.to);
      if (!a || !b) continue;
      ctx.setLineDash(e.kind === 'link' ? [6, 4] : [2, 3]);
      ctx.strokeStyle = e.kind === 'link' ? '#c4b5fd' : '#7dd3fc';
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (st.labels) label(e.kind === 'link' ? 'link' : `gap ${e.length.toFixed(2)} m`, (a[0] + b[0]) / 2 - 20, (a[1] + b[1]) / 2 + 16, ctx.strokeStyle, MINOR);
    }
    ctx.setLineDash([]);
    for (const r of g.runs) {
      for (const an of r.anchors) {
        if (an.source === 'end') continue;
        const q = pixelAt(an.pixel);
        if (!q) continue;
        const measured = an.source === 'measured';
        ring(q, 8, measured ? '#5ddc8a' : '#ffb347', 2, measured ? null : [3, 3]);
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
        ctx.fillStyle = sync ? '#f472b6' : '#e5e7eb';
        ctx.beginPath();
        if (sync) { ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); } else ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
        ctx.fill();
        const display = nd.name || nd.id;
        const name = shared && p.runs.length ? `${display} · ${p.runs.map((id) => g.runs.find((r) => r.id === id)?.name || id).join(' / ')}` : display;
        if (st.labels) label(name, x + 8, y - 6, sync ? '#f9a8d4' : '#e5e7eb');
      }
    });
  }

  // calCursors rings the physical target, not the moving test pixel.
  // The white pixel follows nudges; the target stays on the model corner.
  function calCursors() {
    const cal = S.cal;
    if (!S.calibrating || !cal || !cal.active || !cal.cursors) return;
    cal.cursors.forEach((c, i) => {
      if (c.index < 0) return;
      const ci = g.controllers.findIndex((x) => x.id === c.controller);
      if (ci < 0) return;
      const ni = c.node ? g.nodes.findIndex((n) => n.id === c.node) : -1;
      const occurrence = ni >= 0 ? g.nodes[ni].locations?.find((p) => p.run === c.run && p.plan === S.plan) : null;
      const q = occurrence ? at(occurrence.x, occurrence.y, occurrence.z) : ni >= 0 ? nodeAt(ni)
        : pixelAt(g.controllers[ci].base + (cal.target?.kind === 'end' ? c.estimate : c.index));
      if (!q) return;
      const on = i === cal.side;
      if (on) ring(q, 14, 'rgba(13, 14, 16, 0.8)', 6);
      ring(q, on ? 13 : 10, on ? '#22d3ee' : 'rgba(34,211,238,.5)', on ? 3 : 2);
      if (on) label(ni >= 0 ? g.nodes[ni].name || humanize(c.node) : c.label ? humanize(c.label) : `${controllerName(g, c.controller)}:${c.index}`, q[0] + 18, q[1] - 12, '#a5f3fc', TARGET);
    });
  }

  // draw paints the overlay items for the view's current projection.
  function draw(c) {
    ctx = c;
    const m = mappings.get(st.mapping), o = shown();
    if (o.mode === 'flow' && m) { arrows(m); flowLabels(m); }
    if (o.mode === 'stretch' && m) spacingLabels(m);
    if (o.mode === 'outputs') outputStarts();
    // Measuring one point: every other point steps back.
    ctx.globalAlpha = S.calibrating && S.cal?.active && S.cal.target ? 0.4 : 1;
    if (o.nodes) nodes();
    if (o.controllers) controllers();
    ctx.globalAlpha = 1;
    calCursors();
    for (const [p, color] of [[S.hover, '#fff'], [S.pinned, '#ffb347']]) {
      if (p < 0) continue;
      const q = pixelAt(p);
      if (q) ring(q, 9, color);
    }
    flushLabels();
  }

  return { st, apply, draw, outputs, outputOf, mapping, flows, remember, placed: () => lastPlaced, live: () => shown().mode === 'live' };
}
