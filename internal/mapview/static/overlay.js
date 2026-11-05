// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The live map's overlays: the diagnostic colorings (flow position,
// stretch, areas, controller outputs) with their legends, and the items
// drawn over the map in screen space on the 2-D canvas: nodes, links,
// anchors, labels, flow arrows, output starts, the calibration cursors
// and the hovered and pinned pixels. Pixels themselves are the view's
// (scene.js or plan.js).
import { api, esc, outputName, fmt, ramp, stretchColor, nthColor, PALETTE } from './util.js';

export const MODES = [
  ['live', 'Colors'], ['flow', 'Flow'], ['stretch', 'Stretch'], ['areas', 'Areas'], ['outputs', 'Outputs'],
];

// createOverlay keeps the overlay state. S is the app state: geo, view,
// plan, hover, pinned, cal (the calibration session, or null).
export function createOverlay(S) {
  const g = S.geo, px = g.pixels, n = px.count;
  const st = { mode: 'live', mapping: '', zone: '', nodes: false, labels: false, legend: '' };
  const flows = g.mappings.filter((m) => m.kind === 'flow');
  st.mapping = (flows.find((m) => m.id === g.default_mapping) || flows[0] || g.mappings[0] || {}).id || '';
  st.zone = (g.zones[0] || {}).id || '';
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
        outs.push({ controller: c.id, output: o.output, gpio: o.gpio, start: o.start, first: c.base + o.start, last: c.base + o.start + o.count - 1, count: o.count, max_ma: o.max_ma, color: nthColor(i) });
      }
    }
    return outs;
  }
  const outputOf = (p) => outputs().find((o) => p >= o.first && p <= o.last) || null;

  // colors computes the view's colors for the mode, and the legend.
  async function colors() {
    const out = new Uint8Array(n * 3);
    if (st.mode === 'flow' || st.mode === 'stretch') {
      const m = await mapping(st.mapping);
      for (let p = 0; p < n; p++) {
        const c = m.u[p] === null ? [70, 70, 70]
          : st.mode === 'flow' ? ramp((m.u[p] - m.min) / ((m.max - m.min) || 1)) : stretchColor(m.stretch[p]);
        out.set(c, 3 * p);
      }
      if (st.mode === 'flow') {
        const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `rgb(${ramp(t)})`).join(',');
        const unit = m.kind === 'index' ? '' : ' m';
        st.legend = `<div>u in <b>${esc(m.id)}</b> (${esc(m.kind)}); arrows point the way u grows</div>
          <div class="ramp" style="background:linear-gradient(90deg,${stops})"></div>
          <div class="row"><span>${fmt(m.min, 2)}${unit}</span><span>${fmt(m.max, 2)}${unit}</span></div>`;
      } else {
        const stops = [1 / 1.5, 1 / 1.2, 1, 1.2, 1.5].map((s) => `rgb(${stretchColor(s)})`).join(',');
        st.legend = `<div>stretch in <b>${esc(m.id)}</b>${m.flow ? '' : ' (not a flow: 1 everywhere)'}</div>
          <div class="ramp" style="background:linear-gradient(90deg,${stops})"></div>
          <div class="row"><span>compressed ≤×0.67</span><span>1</span><span>stretched ≥×1.5</span></div>`;
      }
      return out;
    }
    out.fill(40);
    if (st.mode === 'areas') {
      // The zone's segments; bigger areas first so smaller ones stay
      // visible where they overlap.
      const z = g.zones.find((z) => z.id === st.zone);
      const parts = z ? z.segments.map((s, i) => ({ name: `${i}: ${s.area}`, area: g.areas.find((a) => a.id === s.area) })) : [];
      const order = parts.map((_, i) => i).filter((i) => parts[i].area).sort((a, b) => parts[b].area.count - parts[a].area.count);
      for (const i of order) {
        const c = PALETTE[i % PALETTE.length];
        for (const [a, b] of parts[i].area.ranges) for (let p = a; p <= b; p++) out.set(c, 3 * p);
      }
      st.legend = z ? `<div>segments of zone <b>${esc(z.name || z.id)}</b></div>` +
        parts.map((pt, i) => `<div><span class="sw" style="background:rgb(${PALETTE[i % PALETTE.length]})"></span>${esc(pt.name)}</div>`).join('')
        : '<div class="muted">No zones.</div>';
      return out;
    }
    // outputs
    let html = '<div class="muted">rings mark where data enters each output</div>', ctrl = '';
    for (const o of outputs()) {
      for (let p = o.first; p <= o.last; p++) out.set(o.color, 3 * p);
      if (o.controller !== ctrl) { ctrl = o.controller; html += `<div><b>${esc(ctrl)}</b></div>`; }
      html += `<div><span class="sw" style="background:rgb(${o.color})"></span>${esc(outputName(o))}: ${o.count} px (${o.start}–${o.start + o.count - 1})</div>`;
    }
    st.legend = html;
    return out;
  }

  // apply puts the mode's colors on the view and returns the legend.
  async function apply() {
    st.legend = '';
    S.view.setColors(st.mode === 'live' ? null : await colors());
    if (st.nodes) {
      st.legend += `<div><span class="sw" style="background:#5ddc8a"></span>measured anchor
        <span class="sw" style="background:#ffb347"></span>estimated
        <span class="sw" style="background:#f472b6"></span>sync node</div>`;
    }
    return st.legend;
  }

  // ----- drawing -----
  let ctx = null;
  const at = (x, y, z) => S.view.toScreen(x, y, z);
  const pixelAt = (p) => (px.plan[p] === S.plan && px.x[p] !== null ? at(px.x[p], px.y[p], px.z[p]) : null);
  const nodeAt = (i) => { const nd = g.nodes[i]; return nd && nd.plan === S.plan && nd.x !== null ? at(nd.x, nd.y, nd.z) : null; };

  function label(text, x, y, color) {
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
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
      if (q) { ring(q, 7, '#fff'); label(`origin ${g.nodes[m.flow.origin].id}`, q[0] + 10, q[1] + 18, '#fff'); }
    }
  }

  function stretchLabels(m) {
    if (!m.flow) return;
    for (const [e, pixels] of edgePixels()) {
      const s = m.flow.edge_stretch[e];
      if (s === null || pixels.length < 2) continue;
      const q = pixelAt(pixels[Math.floor(pixels.length / 2)]);
      if (q) label('×' + s.toFixed(2), q[0] + 6, q[1] + 14, '#eee');
    }
  }

  function outputStarts() {
    for (const o of outputs()) {
      const q = pixelAt(o.first);
      if (!q) continue;
      ring(q, 8, `rgb(${o.color})`);
      label(`${o.controller} ${outputName(o)}`, q[0] + 10, q[1] - 8, `rgb(${o.color})`);
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
      if (st.labels) label(e.kind === 'link' ? 'link' : `gap ${e.length.toFixed(2)} m`, (a[0] + b[0]) / 2 - 20, (a[1] + b[1]) / 2 + 16, ctx.strokeStyle);
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
      const q = nodeAt(i);
      if (!q) return;
      const [x, y] = q;
      ctx.fillStyle = nd.sync ? '#f472b6' : '#e5e7eb';
      ctx.beginPath();
      if (nd.sync) { ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); } else ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
      ctx.fill();
      if (st.labels) label(nd.id, x + 8, y - 6, nd.sync ? '#f9a8d4' : '#e5e7eb');
    });
  }

  // calCursors rings the physical target, not the moving test pixel.
  // The white pixel follows nudges; the target stays on the model corner.
  function calCursors() {
    const cal = S.cal;
    if (!cal || !cal.active || !cal.cursors) return;
    cal.cursors.forEach((c, i) => {
      if (c.index < 0) return;
      const ci = g.controllers.findIndex((x) => x.id === c.controller);
      if (ci < 0) return;
      const ni = c.node ? g.nodes.findIndex((n) => n.id === c.node) : -1;
      const q = ni >= 0 ? nodeAt(ni)
        : pixelAt(g.controllers[ci].base + (cal.target?.kind === 'end' ? c.estimate : c.index));
      if (!q) return;
      const on = i === cal.side;
      ring(q, on ? 13 : 10, on ? '#22d3ee' : 'rgba(34,211,238,.5)', on ? 3 : 2);
      if (on) label(c.node || c.label || `${c.controller}:${c.index}`, q[0] + 14, q[1] - 10, '#a5f3fc');
    });
  }

  // draw paints the overlay items for the view's current projection.
  function draw(c) {
    ctx = c;
    const m = mappings.get(st.mapping);
    if (st.mode === 'flow' && m) arrows(m);
    if (st.mode === 'stretch' && m) stretchLabels(m);
    if (st.mode === 'outputs') outputStarts();
    if (st.nodes) nodes();
    calCursors();
    for (const [p, color] of [[S.hover, '#fff'], [S.pinned, '#ffb347']]) {
      if (p < 0) continue;
      const q = pixelAt(p);
      if (q) ring(q, 9, color);
    }
  }

  return { st, apply, draw, outputs, outputOf, mapping, flows };
}
