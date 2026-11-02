// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Status tab: the frame loop's numbers, each controller with its
// health, the runs (a drawn length far from the measured one stands
// out, with a link to calibrate the run), the power estimate and any
// warnings from solving the layout. Controller health comes from
// /api/v1/status: health.controllers[id] when the server reports it,
// else the older map keyed by controller id. A controller known to be
// unreachable is drawn gray while the map shows the lights.
import { api, esc, fmt } from '../util.js';

// healthOf normalizes a controller's health report; null if there is
// none.
export function healthOf(health, id) {
  if (!health) return null;
  const h = health.controllers ? health.controllers[id] : health[id];
  if (!h || typeof h !== 'object') return null;
  return {
    reachable: typeof h.reachable === 'boolean' ? h.reachable : null,
    lastSeen: h.last_seen || (h.reachable === true ? h.checked : null) || null,
    errors: h.send_errors || 0,
    error: h.last_error || h.error || h.last_send_error || '',
    sending: typeof h.sending === 'boolean' ? h.sending : null,
    version: h.version || '',
    reboots: h.reboots || 0,
  };
}

const ago = (t) => {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 90) return Math.max(0, Math.round(s)) + ' s ago';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  return Math.round(s / 3600) + ' h ago';
};

export function createStatus(S, root) {
  const g = S.geo;
  root.innerHTML = `
    <div class="stats" id="stStats"></div>
    <h2>Controllers</h2><ul class="list-rows" id="stCtl"></ul>
    <h2>Runs <small>drawn vs measured length</small></h2><ul class="list-rows" id="stRuns"></ul>
    <h2>Power <small id="stPowerHint">estimate before limiting</small></h2><div id="stPower" class="muted">No frame yet.</div>
    <div id="stWarn"></div>`;
  const $$ = (s) => root.querySelector(s);
  let last = null;

  const visible = () => S.panel.tab() === 'status' && !S.panel.collapsed();

  async function poll() {
    let st;
    try { st = await api('/api/v1/status'); } catch (e) { return; }
    last = st;
    S.statusData = st;
    gray();
    if (visible()) { render(st); power(); }
  }

  // gray grays the pixels of unreachable controllers on the Lights view.
  function gray() {
    const set = new Set();
    if (last && S.show === 'house') {
      g.controllers.forEach((c, i) => { const h = healthOf(last.health, c.id); if (h && h.reachable === false) set.add(i); });
    }
    const key = [...set].join();
    if (key !== S.grayKey) { S.grayKey = key; S.gray = set; if (S.view) S.view.setGray(set); }
  }

  function render(st) {
    const perf = S.perf();
    const stat = (v, label, title) => `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><b>${v}</b><span>${label}</span></div>`;
    $$('#stStats').innerHTML = [
      stat(`${fmt(st.measured_fps, 1)}`, `fps of ${st.fps}`),
      stat(`${fmt(st.frame_ms, 2)} ms`, `frame (max ${fmt(st.max_frame_ms, 1)})`),
      stat(st.late_frames, 'late frames'),
      stat(st.layers, 'layers on the lights'),
      stat(st.preview_layers, 'preview layers'),
      stat(esc(st.uptime), 'uptime'),
      stat(st.solve.pixels, 'pixels'),
      // The median: the first draws compile shaders and would swamp a mean.
      stat(`${fmt(perf.draw.p50, 2)} ms`, 'map draw', `this device; median of the last ${perf.draw.n} draws, p95 ${fmt(perf.draw.p95, 2)} ms`),
    ].join('');

    $$('#stCtl').innerHTML = g.controllers.map((c) => {
      const h = healthOf(st.health, c.id);
      let dot = 'idle', line = 'no health report';
      if (h) {
        dot = h.reachable === true ? 'ok' : h.reachable === false ? 'bad' : 'idle';
        const bits = [];
        bits.push(h.reachable === true ? 'reachable' : h.reachable === false ? 'unreachable' : 'not checked');
        if (h.sending === false) bits.push('output off');
        else if (h.sending === true) bits.push('sending');
        if (h.lastSeen) bits.push('seen ' + ago(h.lastSeen));
        if (h.version) bits.push(esc(h.version));
        if (h.errors) bits.push(`${h.errors} send error${h.errors === 1 ? '' : 's'}`);
        if (h.reboots) bits.push(`${h.reboots} reboot${h.reboots === 1 ? '' : 's'}`);
        line = bits.join(' · ');
        if (h.error) line += `<br><span class="error">${esc(h.error)}</span>`;
      }
      return `<li><span class="dotc ${dot}"></span><span class="what"><b>${esc(c.id)}</b><small>${c.pixels} px · ${c.outputs.length} outputs · ${line}</small></span></li>`;
    }).join('');

    const runs = new Map(st.solve.runs.map((r) => [r.id, r]));
    $$('#stRuns').innerHTML = g.runs.map((r) => {
      const s = runs.get(r.id) || {};
      const mis = s.mismatch || r.length_mismatch || 0;
      const warn = mis >= 0.05;
      const a = s.anchors || { measured: 0, estimated: 0 };
      const drawn = s.drawn_m || r.drawn_m;
      return `<li class="${warn ? 'warn' : ''}"><span class="what"><b>${esc(r.id)}</b><small>${r.count} px · ${fmt(s.length_m ?? r.length, 2)} m${drawn ? ` · drawn ${fmt(drawn, 2)} m` : ''}${mis ? ` · <b>${(mis * 100).toFixed(1)}% off</b>` : ''} · ${a.measured}/${a.measured + a.estimated} anchors</small></span>
        <button type="button" data-run="${esc(r.id)}" title="Calibrate this run">Calibrate</button></li>`;
    }).join('');
    for (const b of $$('#stRuns').querySelectorAll('[data-run]')) b.onclick = () => S.calib.open({ run: b.dataset.run });

    const w = st.solve.warnings || [];
    $$('#stWarn').innerHTML = w.length ? `<h2>Warnings</h2><ul class="list-rows">${w.map((x) => `<li><span class="what">${esc(x)}</span></li>`).join('')}</ul>` : '';
  }

  async function power() {
    let pw;
    try { pw = await api('/api/map/power' + (S.show ? '?show=' + S.show : '')); } catch (e) { return; }
    const box = $$('#stPower');
    if (!pw.frame) { box.className = 'muted'; box.textContent = 'No frame yet.'; return; }
    box.className = '';
    const amps = (ma) => (ma / 1000).toFixed(2) + ' A';
    const rows = pw.estimate.map((o) => {
      if (!o.known) return `<div class="pw"><div class="row"><span>${esc(o.controller)} pin ${o.pin}</span><span class="muted">no led_ma</span></div></div>`;
      const pct = o.max_ma ? Math.min(100, 100 * o.ma / o.max_ma) : 0;
      return `<div class="pw"><div class="row"><span>${esc(o.controller)} pin ${o.pin} · ${o.count} px</span>
        <span>${amps(o.ma)}${o.max_ma ? ' / ' + (o.max_ma / 1000).toFixed(1) + ' A' : ''}</span></div>
        ${o.max_ma ? `<div class="bar"><span class="${o.ma > o.max_ma ? 'hot' : ''}" style="width:${pct}%"></span></div>` : ''}</div>`;
    }).join('');
    const totals = pw.controllers.map((c) => `${esc(c.controller)} ${amps(c.ma)}${c.max_ma ? ' / ' + (c.max_ma / 1000).toFixed(1) + ' A' : ''}`).join(' · ');
    const stg = pw.stage;
    const scale = stg ? stg.scale.toFixed(3) + (stg.group ? ` (group ${esc(stg.group)})` : '') : 'n/a (output stage not reporting)';
    const stageRow = (o) => `<div class="row" style="justify-content:space-between"><span>${esc(o.controller)}${o.pin ? ' pin ' + o.pin : ' total'}</span>
      <span>${amps(o.ma)}${o.requested_ma > o.ma + 0.5 ? ` <span class="muted">(asked ${amps(o.requested_ma)})</span>` : ''}${o.max_ma ? ' / ' + (o.max_ma / 1000).toFixed(1) + ' A' : ''}${o.need < 0.9995 ? ` · <b>×${o.need.toFixed(3)}</b>` : ''}</span></div>`;
    const stage = stg ? `<details><summary>Output stage (after limiting)</summary>${(stg.outputs || []).map(stageRow).join('')}${(stg.controllers || []).map(stageRow).join('')}</details>` : '';
    box.innerHTML = `${rows}<div class="muted small">totals: ${totals}</div><div>limit scale: <b>${scale}</b></div>${stage}`;
  }

  S.on('tab', (t) => { if (t === 'status') { if (last) render(last); poll(); } });
  S.on('show', gray);
  S.on('layout', () => { if (visible() && last) render(last); });
  poll();
  setInterval(() => { if (!document.hidden && (visible() || Date.now() - (S.lastHealth || 0) > 5000)) { S.lastHealth = Date.now(); poll(); } }, 2000);
  return { poll };
}
