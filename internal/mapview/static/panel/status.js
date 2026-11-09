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
import { api, esc, fmt, plural, humanize } from '../util.js';
import { showState, stateHTML } from '../states.js';
import { darkZones, darkMessage } from '../house-status.js';
import { runName, controllerName, warningSummary } from '../names.js';
import { icon } from '../icons.js';

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

// verdict sums the controllers' health into one line.
export function verdict(ids, health) {
  let bad = 0, known = 0;
  for (const id of ids) {
    const h = healthOf(health, id);
    if (!h || h.reachable === null) continue;
    known++;
    if (h.reachable === false) bad++;
  }
  if (bad) return { cls: 'bad', text: `${bad} ${bad === 1 ? 'controller needs' : 'controllers need'} attention` };
  if (!known) return { cls: '', text: 'No controller health reported yet' };
  if (known < ids.length) return { cls: '', text: `${known} healthy, ${ids.length - known} not checked` };
  return { cls: 'ok', text: ids.length === 1 ? 'The controller is healthy' : `All ${ids.length} controllers healthy` };
}

// loadFailure is the failure state for a status read that never worked.
// Whatever the server's error text was, the person gets words and Retry.
export function loadFailure(e) {
  return {
    kind: 'error', title: 'Could not load the status',
    detail: e && e.network ? "Glowstack isn't responding. Check that it is running, then try again." : 'Glowstack could not read its status. Try again; if it keeps happening, check the Glowstack log.',
  };
}

// nb keeps a value and its unit on one line.
const nb = (s) => `<span class="nb">${s}</span>`;

// runLabel is how a run reads: its name in words. A run named unassigned-*
// isn't wired into a zone yet, which is a state, not a fault.
export function runLabel(id) {
  const m = /^unassigned[-_.](.+)$/.exec(id);
  return m ? { name: humanize(m[1]), unassigned: true } : { name: humanize(id), unassigned: false };
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
    <h2 class="title">Status</h2>
    <div id="stVerdict" class="verdict" role="status">${stateHTML({ kind: 'loading', title: 'Loading status…' })}</div>
    <div id="stDark" class="dark-note" hidden></div>
    <div id="stIssues"></div>
    <div id="stBody" hidden>
    <div class="stats" id="stStats"></div>
    <h2>Controllers</h2><ul class="list-rows" id="stCtl"></ul>
    <h2>Runs <small>drawn vs measured length</small></h2><ul class="list-rows" id="stRuns"></ul>
    <h2>Power <small id="stPowerHint">estimate before limiting</small></h2><div id="stPower"></div>
    </div>`;
  const $$ = (s) => root.querySelector(s);
  let last = null, shownFailure = false;

  const visible = () => S.panel.tab() === 'status' && !S.panel.collapsed();

  async function poll() {
    let st;
    try { st = await api('/api/v1/status'); } catch (e) {
      if (!last) {
        // A poll mustn't redraw the card out from under a tap on Retry.
        if (shownFailure) return;
        shownFailure = true;
        showState($$('#stVerdict'), { ...loadFailure(e), retry: () => { shownFailure = false; return poll(); } });
      } else {
        $$('#stVerdict').className = 'verdict';
        $$('#stVerdict').textContent = "Couldn't refresh. Showing the last reading.";
      }
      return;
    }
    const levels = JSON.stringify(st.brightness);
    const changed = levels !== JSON.stringify(last?.brightness);
    last = st;
    shownFailure = false;
    S.statusData = st;
    if (changed) S.emit('status', st);
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

  // renderIssues keeps layout warnings right under the verdict, in plain
  // words, each with its fix. It redraws only when they change, so an open
  // disclosure survives the poll.
  let shownIssues = '';
  function renderIssues(list) {
    const key = list.join('\n');
    if (key === shownIssues) return;
    shownIssues = key;
    const items = list.map((w) => warningSummary(g, w));
    const row = (it, i) => `<li class="issue"><div class="issue-text">${icon('alert')}<span>${esc(it.summary)}</span></div><div class="issue-acts"><button type="button" data-fix="${i}">${esc(it.fix.label)}</button><details><summary>Details</summary><code>${esc(it.detail)}</code></details></div></li>`;
    const box = $$('#stIssues');
    box.innerHTML = items.length ? `<ul class="issues">${items.map(row).join('')}</ul>` : '';
    for (const b of box.querySelectorAll('[data-fix]')) {
      const { fix } = items[+b.dataset.fix];
      b.onclick = () => (fix.run ? S.calib.open({ run: fix.run }) : S.panel.openTab(fix.tab));
    }
  }

  function render(st) {
    const perf = S.perf();
    const v = verdict(g.controllers.map((c) => c.id), st.health);
    $$('#stBody').hidden = false;
    $$('#stVerdict').className = `verdict ${v.cls}`;
    $$('#stVerdict').textContent = v.text;
    const dark = darkMessage(darkZones(g, st.brightness, g.zones.flatMap((z) => (g.areas.find((a) => a.id === z.area) || { ranges: [] }).ranges)));
    $$('#stDark').hidden = !dark;
    $$('#stDark').textContent = dark;
    const stat = (v, label, title) => `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><b>${v}</b><span>${label}</span></div>`;
    $$('#stStats').innerHTML = [
      stat(`${fmt(st.measured_fps, 1)}`, `fps of ${st.fps}`),
      stat(`${fmt(st.frame_ms, 2)} ms`, `frame, max ${fmt(st.max_frame_ms, 1)}`),
      stat(st.late_frames, st.late_frames === 1 ? 'late frame' : 'late frames'),
      stat(st.layers, 'on the lights', 'Layers on the lights'),
      stat(st.preview_layers, 'in preview', 'Layers in preview'),
      stat(esc(st.uptime), 'uptime'),
      stat(st.solve.pixels, 'pixels'),
      // The median: the first draws compile shaders and would swamp a mean.
      stat(`${fmt(perf.draw.p50, 2)} ms`, 'map draw', `this device; median of the last ${perf.draw.n} draws, p95 ${fmt(perf.draw.p95, 2)} ms`),
    ].join('');

    $$('#stCtl').innerHTML = g.controllers.map((c) => {
      const h = healthOf(st.health, c.id);
      let dot = 'idle', line = 'no health report';
      const kit = [nb(`${c.pixels} px`), nb(plural(c.outputs.length, 'output'))];
      if (h) {
        dot = h.reachable === true ? 'ok' : h.reachable === false ? 'bad' : 'idle';
        const state = [h.reachable === true ? 'reachable' : h.reachable === false ? 'unreachable' : 'not checked'];
        if (h.sending === false) state.push('output off');
        else if (h.sending === true) state.push('sending');
        if (h.lastSeen) state.push(nb('seen ' + ago(h.lastSeen)));
        line = state.join(' · ');
        if (h.version) kit.push(nb('version ' + esc(h.version)));
        const faults = [];
        if (h.errors) faults.push(`${h.errors} send error${h.errors === 1 ? '' : 's'}`);
        if (h.reboots) faults.push(`${h.reboots} reboot${h.reboots === 1 ? '' : 's'}`);
        if (faults.length) line += `<br>${faults.join(' · ')}`;
        if (h.error) line += `<br><span class="error">${esc(h.error)}</span>`;
      }
      return `<li><span class="dotc ${dot}"></span><span class="what"><b title="${esc(c.id)}">${esc(c.name || c.id)}</b><small>${line}<br>${kit.join(' · ')}</small></span></li>`;
    }).join('');

    const runs = new Map(st.solve.runs.map((r) => [r.id, r]));
    $$('#stRuns').innerHTML = g.runs.map((r) => {
      const s = runs.get(r.id) || {};
      // Signed: a run can be shorter than drawn as well as longer.
      const mis = Math.abs(s.mismatch || r.length_mismatch || 0);
      const label = { ...runLabel(r.id), name: r.name || runName(g, r.id) };
      const warn = mis >= 0.05 && !label.unassigned;
      const a = s.anchors || { measured: 0, estimated: 0 };
      const drawn = s.drawn_m || r.drawn_m;
      const off = mis && !label.unassigned ? `<strong class="dev">${nb(`${(mis * 100).toFixed(1)}% off`)}</strong> · ` : '';
      return `<li class="${warn ? 'warn' : ''}"><span class="what"><b title="${esc(r.id)}">${esc(label.name)}</b><small>${label.unassigned ? 'Not in a zone yet · ' : ''}${off}${nb(`${r.count} px`)} · ${nb(`${fmt(s.length_m ?? r.length, 2)} m`)}${drawn ? ` · ${nb(`drawn ${fmt(drawn, 2)} m`)}` : ''}</small></span>
        <span class="val" title="Points on this run that have been measured">${a.measured} of ${a.measured + a.estimated} points</span>
        <button type="button" data-run="${esc(r.id)}" title="Calibrate this run">Calibrate</button></li>`;
    }).join('');
    for (const b of $$('#stRuns').querySelectorAll('[data-run]')) b.onclick = () => S.calib.open({ run: b.dataset.run });

    renderIssues(st.solve.warnings || []);
  }

  let shownPower = false;
  async function power() {
    let pw;
    const box = $$('#stPower');
    try { pw = await api('/api/map/power' + (S.show ? '?show=' + S.show : '')); } catch (e) {
      if (!shownPower) showState(box, { kind: 'error', title: 'Could not read the power estimate', retry: power });
      return;
    }
    shownPower = true;
    if (!pw.frame) { showState(box, { kind: 'loading', title: 'Waiting for the first frame…' }); return; }
    const amps = (ma) => (ma / 1000).toFixed(2) + ' A';
    const limit = (ma) => (ma ? (ma / 1000).toFixed(1) + ' A' : '—');
    const rows = pw.estimate.map((o) => {
      if (!o.known) return `<tr><td>${esc(controllerName(g, o.controller))} output ${o.output}</td><td class="muted" title="Set led_ma for this output in controllers.yaml to estimate its current">Not set</td><td>${limit(o.max_ma)}</td></tr>`;
      const pct = o.max_ma ? Math.min(100, 100 * o.ma / o.max_ma) : 0;
      return `<tr><td>${esc(controllerName(g, o.controller))} output ${o.output}${o.max_ma ? `<div class="bar"><span class="${o.ma > o.max_ma ? 'hot' : ''}" style="width:${pct}%"></span></div>` : ''}</td><td>${amps(o.ma)}</td><td>${limit(o.max_ma)}</td></tr>`;
    }).join('');
    const totals = pw.controllers.map((c) => `<tr><td>${esc(controllerName(g, c.controller))} total</td><td>${amps(c.ma)}</td><td>${limit(c.max_ma)}</td></tr>`).join('');
    const unknown = pw.estimate.some((o) => !o.known);
    const stg = pw.stage;
    const scale = stg ? (stg.scale >= 0.9995 ? 'None needed' : `Dimmed to ${(stg.scale * 100).toFixed(1)}%${stg.group ? ` (group ${esc(stg.group)})` : ''}`) : 'Not reporting';
    const stageRow = (o) => `<tr><td>${esc(controllerName(g, o.controller))}${o.output ? ' output ' + o.output : ' total'}</td><td>${amps(o.ma)}${o.requested_ma > o.ma + 0.5 ? ` <span class="muted">(asked ${amps(o.requested_ma)})</span>` : ''}</td><td>${limit(o.max_ma)}${o.need < 0.9995 ? ` · ×${o.need.toFixed(3)}` : ''}</td></tr>`;
    const stage = stg ? `<details><summary>After limiting</summary><table class="power"><tbody>${(stg.outputs || []).map(stageRow).join('')}${(stg.controllers || []).map(stageRow).join('')}</tbody></table></details>` : '';
    box.innerHTML = `<table class="power"><thead><tr><th>Output</th><th>Draw</th><th>Limit</th></tr></thead><tbody>${rows}</tbody><tfoot>${totals}</tfoot></table>
      ${unknown ? '<p class="muted small">“Not set” means the output has no LED current in its settings, so its draw can\'t be estimated.</p>' : ''}
      <div class="nv"><span class="name muted">Power limiting</span><span class="value">${scale}</span></div>${stage}`;
  }

  S.on('tab', (t) => { if (t === 'status') { if (last) render(last); poll(); } });
  S.on('show', gray);
  S.on('layout', () => { if (visible() && last) render(last); });
  poll();
  setInterval(() => { if (!document.hidden && (visible() || Date.now() - (S.lastHealth || 0) > 5000)) { S.lastHealth = Date.now(); poll(); } }, 2000);
  return { poll };
}
