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
import { api, esc, fmt, plural, count, humanize, covers, normRanges } from '../util.js';
import { showState, stateHTML } from '../states.js';
import { darkZones, darkMessage, joined, BRIGHTNESS_RULE } from '../house-status.js';
import { targetRanges } from '../select.js';
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
  if (bad) return { cls: 'bad', text: `Controllers: ${bad} ${bad === 1 ? "isn't" : "aren't"} reachable` };
  if (!known) return { cls: '', text: 'Controllers: no report yet' };
  if (known < ids.length) return { cls: '', text: `Controllers: ${known} reachable, ${ids.length - known} not checked` };
  return { cls: 'ok', text: ids.length === 1 ? 'Controller: reachable' : `Controllers: all ${ids.length} reachable` };
}

// controllerFact is the one thing to read on a controller's row: whether
// it is taking frames. h is healthOf's report, or null. With nothing lit,
// Sending is still true but isn't good news.
export function controllerFact(h, nothingLit = false) {
  if (!h) return { text: 'No report', cls: '' };
  if (h.reachable === false) return { text: 'Unreachable', cls: 'bad' };
  if (h.sending === false) return { text: 'Output off', cls: '' };
  if (h.sending === true) return { text: 'Sending', cls: nothingLit ? '' : 'ok' };
  return h.reachable === true ? { text: 'Reachable', cls: 'ok' } : { text: 'Not checked', cls: '' };
}

// sharedFact is what every controller's row would say, when that's good or
// neutral news: said once on the heading, not on each row.
export function sharedFact(facts) {
  return facts.length > 1 && facts.every((f) => f.text === facts[0].text) && facts[0].cls !== 'bad' ? facts[0].text : '';
}

// LENGTH_WARN is how far a run's total length may be from its drawing
// before Status flags it.
export const LENGTH_WARN = 0.05;

// runOff is the percentage a run row calls out: only a run Status flags,
// so the real outliers are the ones that stand out.
export function runOff(mis, unassigned) {
  return mis >= LENGTH_WARN && !unassigned ? `${(mis * 100).toFixed(1)}% off` : '';
}

// runsFine sums up the runs list when no run's length is off: it says what
// it measured, so it can't be read against a spacing warning above it.
export function runsFine(spacing) {
  const lengths = `Run lengths: every run is within ${LENGTH_WARN * 100}% of its drawing.`;
  return spacing ? `${lengths} ${plural(spacing, 'stretch', 'stretches')} inside a run ${spacing === 1 ? 'is' : 'are'} spaced differently, as warned above.` : lengths;
}

// lightsVerdict answers the first question on this tab: is anything lit?
// st is the status reading; layers is each lights layer's pixel ranges, or
// null when the layers haven't been read. A layer whose every pixel is in a
// zone at 0 brightness shows nothing, however healthy the controllers are.
export function lightsVerdict(g, st, layers) {
  const b = st.brightness || {};
  if (b.master === 0) return { cls: 'warn', text: 'Nothing is lit: brightness is at 0%' };
  if (!st.layers) return { cls: '', text: 'Nothing is lit: no looks are on the lights' };
  const zones = g.zones.filter((z) => b.zones?.[z.id] === 0);
  const dark = normRanges(zones.flatMap((z) => g.areas.find((a) => a.id === z.area)?.ranges || []));
  const look = plural(st.layers, 'look');
  if (!zones.length) return { cls: 'ok', text: `Lit: ${look} on the lights` };
  if (!layers) return zones.length === g.zones.length ? { cls: 'warn', text: 'Nothing is lit: every zone is at 0%' } : { cls: 'warn', text: `Partly lit: ${joined(zones.map((z) => z.name || z.id))} at 0%` };
  const shown = layers.filter((r) => !r || !covers(dark, normRanges(r)));
  if (!shown.length) return { cls: 'warn', text: 'Nothing is lit: the zones in use are at 0%' };
  const hit = darkZones(g, b, layers.flatMap((r) => r || []));
  return hit.length ? { cls: 'warn', text: `Partly lit: ${joined(hit)} at 0%` } : { cls: 'ok', text: `Lit: ${look} on the lights` };
}

// maplessVerdict is the verdict without the map: which zones the looks are
// in is the map's to say, so it reports what's known and no more.
export function maplessVerdict(st) {
  if (st.brightness?.master === 0) return { cls: 'warn', text: 'Nothing is lit: brightness is at 0%' };
  return st.layers ? { cls: '', text: `${plural(st.layers, 'look')} on the lights` } : { cls: '', text: 'Nothing is lit: no looks are on the lights' };
}

// powerSummary is the power estimate in words: name(id) reads a
// controller. An output with no LED current is unknown, never zero, and
// that carries through the totals and the limiting line.
export function powerSummary(pw, name = (id) => id) {
  const unknown = pw.estimate.filter((o) => !o.known);
  const anyKnown = pw.estimate.some((o) => o.known);
  const byCtl = new Map();
  for (const o of unknown) byCtl.set(o.controller, [...(byCtl.get(o.controller) || []), o.output]);
  const groups = [...byCtl].map(([c, outs]) => `${name(c)} ${outs.length === 1 ? 'output' : 'outputs'} ${joined(outs.map(String))}`);
  const stg = pw.stage;
  const dimmed = stg && stg.scale < 0.9995;
  const limiting = !stg ? 'Not reporting'
    : dimmed ? `Dimmed to ${(stg.scale * 100).toFixed(1)}%${stg.group ? ` (group ${stg.group})` : ''}`
    : !anyKnown ? 'Unknown'
    : unknown.length ? 'None needed on the outputs with a current set'
    : 'None needed';
  const knownMA = pw.controllers.filter((c) => c.known !== false).reduce((sum, c) => sum + c.ma, 0);
  const amps = (ma) => (ma / 1000).toFixed(2) + ' A';
  return {
    limiting,
    overall: !anyKnown ? 'Unknown' : unknown.length ? `At least ${amps(knownMA)}` : amps(knownMA),
    partial: anyKnown && unknown.length > 0,
    notSet: !anyKnown && unknown.length ? "No LED current is set for any output, so the draw and any power limiting can't be estimated." : groups.length ? `No LED current is set for ${joined(groups)}, so ${unknown.length === 1 ? 'its' : 'their'} draw and any power limiting can't be estimated.` : '',
  };
}

// groupIssues is the warnings as cards: exact repeats dropped, and several
// spacing warnings folded into one card that lists them, so one kind of
// problem doesn't read as a wall of amber.
export function groupIssues(items) {
  const seen = new Set();
  const out = items.filter((it) => !seen.has(it.summary) && seen.add(it.summary));
  const spacing = out.filter((it) => it.kind === 'spacing' && it.fix);
  if (spacing.length < 2) return out;
  const at = out.indexOf(spacing[0]);
  const rest = out.filter((it) => !spacing.includes(it));
  rest.splice(at, 0, { summary: `The lights are spaced differently than drawn in ${spacing.length} places.`, group: spacing });
  return rest;
}

// loadFailure is the failure state for a status read that never worked.
// Whatever the server's error text was, the person gets words and Retry.
export function loadFailure(e) {
  return {
    kind: 'error', title: 'Could not load the status',
    detail: e && e.network ? "Glowstack isn't responding. Check that it is running, then try again." : 'Glowstack could not read its status. Try again; if it keeps happening, check the Glowstack log.',
  };
}

// readableDuration is the server's "3h5m12s" as someone would say it.
export function readableDuration(text) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(text || '');
  if (!m || !text) return text;
  const total = Math.floor(+(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0));
  const days = Math.floor(total / 86400), hours = Math.floor(total / 3600) % 24, mins = Math.floor(total / 60) % 60;
  if (days) return `${plural(days, 'day')}${hours ? ` ${hours} h` : ''}`;
  if (hours) return `${hours} h${mins ? ` ${mins} min` : ''}`;
  return total < 60 ? `${total} s` : `${mins} min`;
}

// nb keeps a value and its unit on one line.
const nb = (s) => `<span class="nb">${s}</span>`;

// runLabel is how a run reads: its name in words. A run named unassigned-*
// isn't wired into a zone yet, which is a state, not a fault.
export function runLabel(id) {
  const m = /^unassigned[-_.](.+)$/.exec(id);
  return m ? { name: humanize(m[1]), unassigned: true } : { name: humanize(id), unassigned: false };
}

// asOf ties a reassuring line to when it was read, while refreshing fails.
export const asOf = (text, time) => (time && text ? `${text} at ${time}` : text);

// mark is a health state as a shape: a check, an alert, or a plain dot.
export function mark(state) {
  if (state === 'ok') return `<span class="mark ok" title="Healthy">${icon('check')}</span>`;
  if (state === 'bad') return `<span class="mark bad" title="Not reachable">${icon('alert')}</span>`;
  return '<span class="dotc idle"></span>';
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
    <h1 class="title">Status</h1>
    <div id="stVerdict" class="verdict" role="status">${stateHTML({ kind: 'loading', title: 'Loading status…' })}</div>
    <div id="stStale" class="stale-note" role="status" hidden></div>
    <div id="stHealth" class="health" hidden></div>
    <div id="stIssues"></div>
    <div id="stBody" hidden>
    <h2>Controllers <small id="stCtlShared"></small></h2><p class="muted small" id="stCtlNote" hidden>Sending means the frames are going out. Nothing is lit, so those frames are dark.</p><ul class="list-rows" id="stCtl"></ul>
    <div id="stRunsBox"><h2>Runs <small>drawn vs measured length</small></h2>
    <p class="muted" id="stRunsFine" hidden></p>
    <ul class="list-rows run-rows" id="stRuns"></ul>
    <details id="stRunsMore"><summary></summary><ul class="list-rows run-rows" id="stRunsRest"></ul></details></div>
    <h2>Power <small id="stPowerHint">estimate before limiting</small></h2><div id="stPower"></div>
    <p class="meta-line" id="stStats"></p>
    <details id="stDiag"><summary>Diagnostics</summary><div class="stats" id="stDiagStats"></div></details>
    </div>`;
  const $$ = (s) => root.querySelector(s);
  let last = null, lastAt = 0, shownFailure = false, staleSince = false;

  const markOffline = () => { for (const b of root.querySelectorAll('[data-run], [data-fix]')) b.disabled = !!S.offline; };
  const visible = () => S.panel.tab() === 'status' && !S.panel.collapsed();

  async function poll() {
    let st;
    try { st = await api('/api/v1/status'); S.setServerUp?.(true); } catch (e) {
      if (e?.network) S.setServerUp?.(false);
      if (!last) {
        // A poll mustn't redraw the card out from under a tap on Retry.
        if (shownFailure) return;
        shownFailure = true;
        showState($$('#stVerdict'), { ...loadFailure(e), retry: () => { shownFailure = false; return poll(); } });
      } else {
        // Its own line: the other polls redraw the verdict from the last reading.
        $$('#stStale').textContent = `Couldn't refresh. Showing the reading from ${new Date(lastAt).toLocaleTimeString()}.`;
        $$('#stStale').hidden = false;
        staleSince = true;
        if (visible()) render(last);
      }
      return;
    }
    lastAt = Date.now();
    staleSince = false;
    $$('#stStale').hidden = true;
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
  function renderIssues(list, dark) {
    const key = dark + list.join('\n');
    if (key === shownIssues) return;
    shownIssues = key;
    // Most urgent first: nothing lit before a run that's a little off.
    const items = groupIssues([...(dark ? [{ summary: dark, detail: '', fix: null }] : []), ...list.map((w) => warningSummary(g, w))]);
    const row = (it, i) => it.group
      ? `<li class="issue"><div class="issue-text">${icon('alert')}<span>${esc(it.summary)}</span></div><ul class="issue-list">${it.group.map((one, j) => `<li><span>${esc(one.summary)}</span><button type="button" data-fix="${i}" data-one="${j}">${esc(one.fix.label)}</button></li>`).join('')}</ul></li>`
      : `<li class="issue"><div class="issue-text">${icon('alert')}<span>${esc(it.summary)}</span></div>${it.fix ? `<div class="issue-acts"><button type="button" data-fix="${i}">${esc(it.fix.label)}</button><details><summary>Details</summary><p class="plain" title="${esc(it.detail)}">${esc(it.plain)}</p></details></div>` : ''}</li>`;
    const box = $$('#stIssues');
    box.innerHTML = items.length ? `<ul class="issues">${items.map(row).join('')}</ul>` : '';
    for (const b of box.querySelectorAll('[data-fix]')) {
      const item = items[+b.dataset.fix];
      const { fix } = item.group ? item.group[+b.dataset.one] : item;
      b.onclick = () => (fix.retry ? location.reload() : fix.run ? S.calib.open({ run: fix.run }) : S.panel.openTab(fix.tab));
    }
  }

  function render(st) {
    const perf = S.perf();
    const health = verdict(g.controllers.map((c) => c.id), st.health);
    const lit = g.mapless ? maplessVerdict(st) : lightsVerdict(g, st, S.houseStatus === 'available' ? S.house.map((l) => targetRanges(g, S.tree, l.target)) : null);
    $$('#stBody').hidden = false;
    $$('#stRunsBox').hidden = !!g.mapless; // run lengths are the map's
    $$('#stVerdict').className = `verdict ${lit.cls}`;
    // The verdict says why and what to do: no second card for the same thing.
    const isDark = lit.cls === 'warn';
    // The effective result comes first; the controllers only say the wire works.
    const nothingLit = lit.text.startsWith('Nothing is lit');
    $$('#stCtlNote').hidden = !nothingLit;
    if (isDark) $$('#stVerdict').dataset.dark = ''; else delete $$('#stVerdict').dataset.dark;
    $$('#stVerdict').innerHTML = `<span>${esc(lit.text)}</span>${isDark ? `<small>Raise the brightness in Home Assistant. ${esc(BRIGHTNESS_RULE)}</small>` : ''}`;
    // Health is the second line, in plain text unless something is wrong.
    $$('#stHealth').hidden = false;
    $$('#stHealth').className = `health ${health.cls === 'bad' ? 'bad' : ''}`;
    $$('#stHealth').title = 'Whether Glowstack can reach each controller over the network';
    const readAt = staleSince ? new Date(lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    $$('#stHealth').innerHTML = `${mark(health.cls === 'ok' && !nothingLit && !readAt ? 'ok' : health.cls === 'bad' ? 'bad' : 'idle')}<span>${esc(asOf(health.text, readAt))}</span>`;
    const dark = darkMessage(darkZones(g, st.brightness, g.zones.flatMap((z) => (g.areas.find((a) => a.id === z.area) || { ranges: [] }).ranges)));
    // Facts about the installation, once: the verdict above answers the question.
    $$('#stStats').textContent = [`${count(st.solve.pixels)} lights`, `${plural(st.preview_layers, 'look')} in preview`, `Up ${readableDuration(st.uptime)}`].join(' · ');
    const stat = (v, label, title) => `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><b>${v}</b><span>${label}</span></div>`;
    // What the owner asks; how the renderer is doing is below, in Diagnostics.
    $$('#stDiagStats').innerHTML = [
      stat(`${fmt(st.measured_fps, 1)}`, `fps of ${st.fps}`),
      stat(`${fmt(st.frame_ms, 2)} ms`, `per frame, max ${fmt(st.max_frame_ms, 1)}`),
      stat(count(st.late_frames), 'frames late', 'Frames that took longer than the frame rate allows'),
      // The median: the first draws compile shaders and would swamp a mean.
      stat(`${fmt(perf.draw.p50, 2)} ms`, 'to draw the map', `this device; median of the last ${perf.draw.n} draws, p95 ${fmt(perf.draw.p95, 2)} ms`),
    ].join('');

    const shared = sharedFact(g.controllers.map((c) => controllerFact(healthOf(st.health, c.id), nothingLit)));
    $$('#stCtlShared').textContent = shared ? asOf(`all ${shared.toLowerCase()}`, readAt) : '';
    $$('#stCtl').innerHTML = g.controllers.map((c) => {
      const h = healthOf(st.health, c.id);
      let dot = 'idle', line = '';
      const fact = controllerFact(h, nothingLit);
      const kit = [nb(plural(c.pixels, 'light')), nb(plural(c.outputs.length, 'output'))];
      const titled = h?.version ? `${c.id} · version ${h.version}` : c.id;
      if (h) {
        dot = h.reachable === true && !nothingLit && !readAt ? 'ok' : h.reachable === false ? 'bad' : 'idle';
        // Only worth saying when it isn't simply working.
        if (h.lastSeen && !(h.reachable === true && h.sending === true)) line = nb('Last answered ' + ago(h.lastSeen));
        const faults = [];
        if (h.errors) faults.push(`${h.errors} send error${h.errors === 1 ? '' : 's'}`);
        if (h.reboots) faults.push(`${h.reboots} reboot${h.reboots === 1 ? '' : 's'}`);
        if (faults.length) line += `${line ? '<br>' : ''}${faults.join(' · ')}`;
        if (h.error) line += `${line ? '<br>' : ''}<span class="error">${esc(h.error)}</span>`;
      }
      return `<li>${mark(dot)}<span class="what"><b title="${esc(titled)}">${esc(controllerName(g, c.id))}</b><small>${line ? `${line}<br>` : ''}${kit.join(' · ')}</small></span>${shared ? '' : `<span class="fact ${readAt ? '' : fact.cls}">${asOf(fact.text, readAt)}</span>`}</li>`;
    }).join('');

    const runs = new Map(st.solve.runs.map((r) => [r.id, r]));
    const rows = g.runs.map((r) => {
      const s = runs.get(r.id) || {};
      // Signed: a run can be shorter than drawn as well as longer.
      const mis = Math.abs(s.mismatch || r.length_mismatch || 0);
      const label = { ...runLabel(r.id), name: r.name || runName(g, r.id) };
      const offText = runOff(mis, label.unassigned), warn = !!offText;
      const a = s.anchors || { measured: 0, estimated: 0 };
      const drawn = s.drawn_m || r.drawn_m;
      const off = offText ? `<strong class="dev">${nb(offText)}</strong> · ` : '';
      const points = a.measured + a.estimated;
      const detail = [label.unassigned ? 'Not in a zone yet' : '', nb(plural(r.count, 'light')), points ? `<span title="Points on this run that have been measured">${nb(`${a.measured} of ${plural(points, 'point')}`)}</span>` : ''].filter(Boolean).join(' · ');
      // Two columns: what the run is, and its length, each figure on one line.
      return { warn, html: `<li class="${warn ? 'warn' : ''}"><span class="what"><b title="${esc(r.id)}">${esc(label.name)}</b><small>${off}${detail}</small></span>
        <span class="len">${fmt(s.length_m ?? r.length, 2)} m${drawn ? `<small>drawn ${fmt(drawn, 2)} m</small>` : ''}</span>
        ${points ? `<button type="button" data-run="${esc(r.id)}" title="Calibrate this run">Calibrate</button>` : ''}</li>` };
    });
    // The runs with a problem, then the rest behind a disclosure.
    const problems = rows.filter((r) => r.warn), rest = rows.filter((r) => !r.warn);
    $$('#stRuns').innerHTML = problems.map((r) => r.html).join('');
    $$('#stRunsRest').innerHTML = rest.map((r) => r.html).join('');
    $$('#stRunsFine').hidden = problems.length > 0;
    // Counted as the warnings above are: a repeat is one stretch.
    $$('#stRunsFine').textContent = runsFine(new Set((st.solve.warnings || []).map((w) => warningSummary(g, w)).filter((w) => w.kind === 'spacing').map((w) => w.summary)).size);
    $$('#stRunsMore').hidden = !rest.length;
    $$('#stRunsMore summary').textContent = problems.length ? `${plural(rest.length, 'other run')}` : `All ${plural(rest.length, 'run')}`;
    for (const b of root.querySelectorAll('[data-run]')) b.onclick = () => S.calib.open({ run: b.dataset.run });
    markOffline();

    renderIssues(st.solve.warnings || [], isDark ? '' : dark);
    S.refreshBadge?.();
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
    const known = pw.estimate.filter((o) => o.known);
    if (!known.length && pw.controllers.every((c) => c.known === false)) {
      // Nothing known: a table of Unknown says less than the sentence.
      box.innerHTML = `<p class="muted">${esc(powerSummary(pw, (id) => controllerName(g, id)).notSet || "Glowstack can't estimate the power yet.")}</p>`;
      return;
    }
    const rows = known.map((o) => {
      const pct = o.max_ma ? Math.min(100, 100 * o.ma / o.max_ma) : 0;
      return `<tr><td>${esc(controllerName(g, o.controller))} output ${o.output}${o.max_ma ? `<div class="bar"><span class="${o.ma > o.max_ma ? 'hot' : ''}" style="width:${pct}%"></span></div>` : ''}</td><td>${amps(o.ma)}</td><td>${limit(o.max_ma)}</td></tr>`;
    }).join('');
    const sum = powerSummary(pw, (id) => controllerName(g, id));
    const ctlRow = (c) => `<tr class="total"><td>${esc(controllerName(g, c.controller))}</td><td>${c.known === false ? '<span class="muted">Unknown</span>' : amps(c.ma)}</td><td>${limit(c.max_ma)}</td></tr>`;
    const overall = pw.controllers.length > 1 ? `<tr class="total"><td>All controllers</td><td>${sum.overall}</td><td></td></tr>` : '';
    const stg = pw.stage;
    const stageRow = (o) => o.known === false ? '' : `<tr><td>${esc(controllerName(g, o.controller))}${o.output ? ' output ' + o.output : ' total'}</td><td>${amps(o.ma)}${o.requested_ma > o.ma + 0.5 ? ` <span class="muted">(asked ${amps(o.requested_ma)})</span>` : ''}</td><td>${limit(o.max_ma)}${o.need < 0.9995 ? ` · ×${o.need.toFixed(3)}` : ''}</td></tr>`;
    const stage = stg ? `<details><summary>After limiting</summary><table class="power"><tbody>${(stg.outputs || []).map(stageRow).join('')}${(stg.controllers || []).map(stageRow).join('')}</tbody></table></details>` : '';
    // Polling redraws this: an open disclosure stays open.
    const wasOpen = box.querySelector('details')?.open;
    box.innerHTML = `<div class="nv"><span class="name muted">Power limiting</span><span class="value">${esc(sum.limiting)}</span></div>
      <table class="power"><thead><tr><th>Output</th><th>Draw</th><th>Limit</th></tr></thead><tbody>${overall}${pw.controllers.map(ctlRow).join('')}${rows}</tbody></table>
      ${sum.notSet ? `<p class="muted small">${esc(sum.notSet)}</p>` : ''}${stage}`;
    if (wasOpen && box.querySelector('details')) box.querySelector('details').open = true;
  }

  S.on('tab', (t) => { if (t === 'status') { if (last) render(last); poll(); } });
  S.on('house', () => { if (visible() && last) render(last); });
  S.on('show', gray);
  S.on('offline', markOffline);
  S.on('layout', () => { if (visible() && last) render(last); });
  poll();
  setInterval(() => { if (!document.hidden && (visible() || Date.now() - (S.lastHealth || 0) > 5000)) { S.lastHealth = Date.now(); poll(); } }, 2000);
  return { poll };
}
