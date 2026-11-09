// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Calibration mode: measuring where anchors really are, standing outside
// with a phone. On a phone it takes the screen below a strip of map
// (the cursor framed in it): what is being measured and Stop at the top,
// the cursor's index large, nudges and Confirm in the thumb zone, the
// progress grouped by run. Wider screens show it in place of the panel.
// The session lives on the server (/api/v1/calibration), so a phone and
// a laptop share it; a session already running opens this mode. The
// screen is kept awake while a session runs. createSession is the
// session logic without the page, for tests.
import { esc, plural, humanize, NOT_RESPONDING } from '../util.js';
import { icon } from '../icons.js';
import { upgradeSelects } from '../picker.js';
import { stateHTML } from '../states.js';
import { runName, nodeDisplay, controllerName, humanText } from '../names.js';

const BASE = '/api/v1/calibration';
// What each action is called when it fails on the network.
const DOING = {
  '': 'read the calibration state', '/start': 'start calibrating', '/end': 'stop calibrating',
  '/target': 'pick that point', '/next': 'move to the next point', '/nudge': 'move the test pixel',
  '/set': 'go to that pixel', '/side': 'switch sides', '/confirm': 'save the measurement', '/forget': 'forget the measurement',
};

// createSession talks to the calibration API. Actions run in tap order
// (confirming waits for earlier nudges); a poll waits until no action is
// pending, is dropped if an action overtook it, and an unchanged state
// isn't redrawn, so a finger mid-tap keeps its button. onState is called
// when the state or error changed. storage keeps the confirm-and-next
// choice across the reload that confirming causes.
export function createSession({ fetch, storage, onState }) {
  const C = { st: null, error: '', details: [], next: true, lost: false };
  try { C.next = storage.getItem('calNext') !== 'false'; } catch (_) { /* no storage */ }
  let actions = Promise.resolve(), pending = 0, seq = 0, last = '';

  function call(path, body) {
    if (body === undefined) return pending ? Promise.resolve() : send(path, body);
    pending++;
    const action = actions.then(() => send(path, body)).finally(() => { pending--; });
    actions = action.catch(() => {});
    return action;
  }

  async function send(path, body) {
    const my = ++seq, polling = body === undefined;
    try {
      const r = await fetch(BASE + path, polling ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const text = await r.text();
      if (polling && my !== seq) return;
      let j = null;
      try { j = JSON.parse(text); } catch (_) { /* reported below */ }
      if (!r.ok || j === null) {
        // A poll's own error clears with the next good poll; an action's
        // stays until the next action.
        C.error = j?.error || text || r.statusText; C.details = j?.errors || []; C.lost = C.lost || polling;
      } else {
        if (polling && text === last && !C.lost) return;
        last = text; C.st = j;
        if (!polling || C.lost) { C.error = ''; C.details = []; C.lost = false; }
      }
    } catch (e) {
      if (polling && my !== seq) return;
      C.error = `Could not ${DOING[path]}. ${NOT_RESPONDING}`; C.details = []; C.lost = polling;
    }
    onState(C);
  }

  return {
    C,
    poll: () => call(''),
    start: (target) => call('/start', target ? { target } : {}),
    end: () => call('/end', {}),
    target: (t) => call('/target', t),
    next: (back) => call('/next', back ? { back: true } : {}),
    nudge: (by) => call('/nudge', { by }),
    set: (index) => call('/set', { index }),
    side: (side) => call('/side', { side }),
    confirm: (opts) => call('/confirm', opts || { next: C.next }),
    forget: () => call('/forget', {}),
    setNext(v) {
      C.next = v;
      try { storage.setItem('calNext', String(v)); } catch (_) { /* no storage */ }
    },
    pending: () => pending > 0,
  };
}

// The map is a target pattern during anchor/end calibration. Nudging changes
// the real LEDs, not this reference; the live stream remains untouched.
export function referenceColors(g, cal) {
  if (!cal?.active || !['anchor', 'end'].includes(cal.target?.kind)) return null;
  const c = cal.cursors?.[cal.side];
  const ctl = c && g.controllers.find((x) => x.id === c.controller);
  if (!ctl || c.estimate < 0) return null;
  const run = g.runs?.find((r) => r.id === c.run);
  const direction = run && run.first > run.last ? -1 : 1;
  const out = new Uint8Array(g.pixels.count * 3);
  for (let i = c.min; i <= c.max; i++) {
    const d = (i - c.estimate) * direction;
    let color = [64, 64, 64];
    if (d === 0) color = [255, 255, 255];
    else if (Math.abs(d) <= 100 && d % 10 === 0) color = d < 0 ? [255, 0, 0] : [0, 255, 0];
    else if (d === -1) color = [96, 0, 0];
    else if (d === 1) color = [0, 96, 0];
    out.set(color, (ctl.base + i) * 3);
  }
  return out;
}

// KEPT names the fields a redraw must not reset: what's been chosen or
// typed there is the person's until they change it.
const KEPT = ['run', 'ctl', 'a', 'b', 'i'];
export function readFields(body) {
  const out = {};
  for (const name of KEPT) {
    const el = body.querySelector(`[name=${name}]`);
    if (el && el.value !== '') out[name] = el.value;
  }
  return out;
}
export function restoreFields(body, saved) {
  for (const [name, value] of Object.entries(saved)) {
    const el = body.querySelector(`[name=${name}]`);
    if (el) el.value = value;
  }
}

// loadState is the screen's state before the first reading: loading, or
// the failure with Retry. null once there is a session state to draw.
export function loadState(C) {
  if (C.st) return null;
  if (C.error) return { kind: 'error', title: 'Could not load calibration', detail: C.error, retry: true };
  return { kind: 'loading', title: 'Loading calibration…' };
}

// calCount is the one count on the calibration screen: the steps in the
// progress list, which is what "Step 3 of 9" counts. It holds links and
// gaps as well as the points the Setup tab counts, which the title says.
export function calCount(st) {
  const items = st.progress || [];
  if (!items.length) return null;
  const others = items.length - (st.anchors || 0);
  return {
    text: `${items.filter((i) => i.done).length} of ${plural(items.length, 'step')} done`,
    title: `${st.measured || 0} of ${plural(st.anchors || 0, 'point')} measured` + (others ? `, plus ${plural(others, 'link or gap', 'links and gaps')}` : ''),
  };
}

// stepPlace says where the current step sits in the list, against the same
// total as the count of steps done, and the list marks the same step.
export function stepPlace(index, item, total) {
  return `Step ${index + 1} of ${total} · ${item.done ? 'done' : 'not done yet'}`;
}

// progCenter is the list's scroll position that puts a row in its middle.
export function progCenter(rowTop, rowHeight, viewHeight) {
  return Math.max(0, rowTop - (viewHeight - rowHeight) / 2);
}

// partName is an anchor's name within its run: the run's name is on the
// group already, so the part that tells two rows apart comes first.
export function partName(run, node, label) {
  if (label) return label;
  const r = String(run).toLowerCase().split(/[-_.\s]+/).filter(Boolean);
  const n = String(node).split(/[-_.\s]+/).filter(Boolean);
  let i = 0;
  while (i < r.length && i < n.length - 1 && r[i].startsWith(n[i].toLowerCase())) i++;
  const rest = n.slice(i).join(' ');
  return i && /^\d+$/.test(rest) ? `Point ${rest}` : humanize(rest);
}

// progressRow is one progress row in words: name, value and the full
// label for hover. nodeLabel gives a node id's display name.
export function progressRow(it, nodeLabel = humanize, runLabel = humanize) {
  const t = it.target || {};
  const between = t.from ? `${nodeLabel(t.from)} to ${nodeLabel(t.to)}` : '';
  if (t.kind === 'link') return { name: `Link ${between}`, value: it.done ? 'Done' : it.source === 'partial' ? 'Partly done' : 'Not yet', title: `Link from ${between}` };
  if (t.kind === 'gap') return { name: `Gap ${between}`, value: it.length != null ? `${it.length.toFixed(2)} m${it.done ? '' : ' planned'}` : '', title: `Gap from ${between}` };
  const node = t.node ? nodeLabel(t.node) : it.label;
  const name = t.node ? partName(t.run, t.node, nodeLabel === humanize || node === humanize(t.node) ? '' : node) : humanize(it.label);
  return { name, value: it.index == null ? '' : `${it.done ? 'Pixel' : 'About pixel'} ${it.index}`, title: t.run ? `${runLabel(t.run)}: ${node}` : node };
}

// stepTitle says what a target asks of the person, in words. nodeLabel
// gives a node id's display name.
export function stepTitle(st, nodeLabel = humanize, runLabel = humanize) {
  const t = st.target || {};
  const between = t.from ? `between ${nodeLabel(t.from)} and ${nodeLabel(t.to)}` : '';
  const on = t.run ? `on ${runLabel(t.run)}` : t.controller ? `on ${runLabel(t.controller)}` : between;
  switch (t.kind) {
    case 'anchor': return { title: `Line up ${nodeLabel(t.node)}`, on };
    case 'end': return { title: `Find the ${t.end} end`, on };
    case 'link': return { title: 'Line up both sides of the link', on };
    case 'gap': return { title: 'Measure the gap', on };
    case 'bands': return { title: 'Check the test bands', on };
    case 'dead': return { title: 'Mark dead pixels', on };
  }
  return { title: st.label ? humanize(st.label) : 'Pick a point to measure', on: '' };
}

// createCalibrate is the mode's screen in root.
export function createCalibrate(S, root) {
  const g = S.geo;
  const nodeLabel = (id) => nodeDisplay(g, id);
  const runLabel = (id) => runName(g, id);
  let open = false, run = '', tapped = -1, wake = null, hold = null, framed = '', wasActive = false, shownHere = '';
  const session = createSession({ fetch: (...a) => fetch(...a), storage: sessionStorage, onState: render });
  const C = session.C;
  // Set when the mode was left with a session still running: it doesn't
  // reopen by itself, including after a reload, until Resume.
  const remember = (v) => { try { sessionStorage.setItem('calLeft', String(v)); } catch (_) { /* no storage */ } };
  let left = false;
  try { left = sessionStorage.getItem('calLeft') === 'true'; } catch (_) { /* no storage */ }

  root.innerHTML = `
    <div class="cal-top"><span class="what"><b id="caLabel">Calibration</b><small id="caCount"></small></span>
      <button type="button" id="caStop" class="danger" title="End calibration and return the lights to normal">Stop</button><button type="button" id="caClose" title="Back to the map">Close</button></div>
    <div class="cal-body" id="caBody"></div>
    <div class="cal-dock" id="caDock" hidden>
      <div class="nudges">${[-10, -1, 1, 10].map((n) => `<button type="button" data-by="${n}">${n > 0 ? '+' : '−'}${Math.abs(n)}</button>`).join('')}</div>
      <div class="cal-confirm"><button type="button" class="go" id="caConfirm" title="Save this pixel as the measured position">Confirm</button>
        <label class="check small"><input type="checkbox" id="caNext"> Go to next after</label></div>
    </div>`;
  const $$ = (s) => root.querySelector(s);
  for (const b of root.querySelectorAll('[data-by]')) b.onclick = () => session.nudge(+b.dataset.by);
  // Stop ends the session and leaves the mode together: the overlays
  // only ever exist inside it.
  $$('#caStop').onclick = async () => {
    await session.end();
    if (!C.error) { close(); S.toast('Calibration stopped. The lights are back to normal.'); }
  };
  $$('#caClose').onclick = () => close();
  $$('#caConfirm').onclick = () => session.confirm();
  $$('#caNext').onchange = (e) => session.setNext(e.target.checked);

  // ---------- the mode ----------

  function show(on) {
    if (on === open) return;
    open = on;
    root.hidden = !on;
    document.body.classList.toggle('calibrating', on);
    S.calibrating = on;
    if (on) hold = S.view.hold();
    else { framed = ''; tapped = -1; shownHere = ''; }
    S.refreshLegend?.();
    S.resize();
    if (!on && hold) { S.view.release(hold); hold = null; }
    keepAwake();
    S.inspect(S.pinned);
    S.markDirty();
  }
  function close() { show(false); }

  // leave exits the mode because the page moved on. A session that is
  // still running keeps driving the lights, so say where to find it.
  function leave() {
    if (!open) return;
    show(false);
    if (C.st && C.st.active) {
      left = true;
      remember(true);
      S.toast('Calibration is still running on the lights. Resume or stop it from Setup.', { warn: true });
    }
  }
  S.on('tab', leave);
  S.on('offline', () => render());

  // keepAwake holds a screen wake lock while a session runs in this
  // mode; the browser drops it when the page is hidden.
  async function keepAwake() {
    const want = open && C.st && C.st.active && 'wakeLock' in navigator && !document.hidden;
    if (want && !wake) {
      try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch (_) { wake = null; }
    } else if (!want && wake) { wake.release().catch(() => {}); wake = null; }
  }
  document.addEventListener('visibilitychange', keepAwake);

  // frameCursor frames the cursor's neighborhood in the map strip when
  // the target changes.
  function frameCursor() {
    const st = C.st;
    if (!open || !st || !st.active) return;
    const c = (st.cursors || [])[st.side];
    if (!c || c.index < 0) return;
    const key = st.label + '|' + st.side;
    if (key === framed) return;
    framed = key;
    const ctl = g.controllers.find((x) => x.id === c.controller);
    if (!ctl) return;
    const ids = [];
    const center = c.node ? c.estimate : c.index;
    for (let i = Math.max(c.min, center - 40); i <= Math.min(c.max, center + 40); i++) ids.push(ctl.base + i);
    S.view.frameIds(ids);
  }

  // ---------- rendering ----------

  function nearestAnchor(r, index) {
    let best = null;
    for (const a of r.anchors) {
      if (a.source === 'end') continue;
      if (!best || Math.abs(a.index - index) < Math.abs(best.index - index)) best = a;
    }
    return best;
  }

  const acts = [];
  const btn = (label, fn, cls = '', disabled = false, title = '') => {
    acts.push(fn);
    return `<button type="button" class="${cls}" data-a="${acts.length - 1}"${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  };

  function render() {
    S.cal = C.st;
    const running = !!(C.st && C.st.active);
    if (!running && left) { left = false; remember(false); }
    if (running && !open && !left) show(true);
    if (running !== wasActive) { wasActive = running; S.emit('calibration', running); }
    S.emit('calprogress', C.st);
    if (!open) { S.markDirty(); return; }
    const st = C.st;
    acts.length = 0;
    const parts = [];
    const active = st && st.active;
    const reference = referenceColors(g, st);
    if (reference) S.view.setColors(reference);
    else S.overlay.apply();
    S.refreshBadge?.();
    $$('#caStop').hidden = !active;
    $$('#caClose').hidden = !!active;
    $$('#caDock').hidden = !active;
    $$('#caLabel').textContent = 'Calibrating';
    const count = st ? calCount(st) : null;
    $$('#caCount').textContent = count ? count.text : '';
    $$('#caCount').title = count ? count.title : '';

    const loading = loadState(C);
    if (loading) parts.push(stateHTML(loading));
    else if (!active) {
      const r = run && g.runs.find((x) => x.id === run);
      const first = r && r.anchors.find((a) => a.source === 'estimated');
      parts.push(`<h1 class="title">Line up the map with the lights</h1><p class="muted">Each step lights one point on the house. Move the white pixel onto the real corner, then confirm. This changes the real lights until you stop.</p>`);
      parts.push(`<div class="row">${btn(r ? `Start on ${esc(runLabel(r.id))}` : 'Start calibrating', () => session.start(r ? (first ? { kind: 'anchor', run: r.id, node: g.nodes[first.node].id } : { kind: 'bands', run: r.id }) : null), 'go grow')}</div>`);
      parts.push('<details class="more"><summary>Details</summary><div class="muted small">Measurements are saved on the Glowstack server and survive restarts.</div></details>');
    } else {
      if (st.warning) parts.push(`<div class="cal-warn">${esc(humanText(g, st.warning))}</div>`);
      // Previous and Next come first: below the instructions they fell
      // under the nudge bar's edge on a phone.
      const nav = () => `<div class="cal-nav">${btn(`${icon('chevronLeft')}Previous`, () => session.next(true), 'icon-btn')}${btn(`Next${icon('chevronRight')}`, () => session.next(), 'icon-btn')}</div>`;
      const cs = st.cursors || [];
      if (cs.length > 1) parts.push(`<div class="cal-sides">${cs.map((c, i) => btn(esc(nodeLabel(c.label)) + (c.fixed ? ' (fixed)' : ''), () => session.side(i), i === st.side ? 'on' : '')).join('')}</div>`);
      const c = cs[st.side];
      if (c) {
        const moved = c.index - c.estimate;
        const step = stepTitle(st, nodeLabel, runLabel);
        const i = (st.progress || []).findIndex((it) => JSON.stringify(it.target) === JSON.stringify(st.target));
        parts.push(`<div class="cal-step">${i >= 0 ? `<small>${esc(stepPlace(i, st.progress[i], st.progress.length))}</small>` : ''}<h2>${esc(step.title)}</h2>${step.on ? `<p>${esc(step.on)}</p>` : ''}</div>`);
        parts.push(`<div class="cal-read"><span class="idx">${c.index < 0 ? 'No pixel on this run' : moved ? `Moved ${moved > 0 ? '+' : ''}${moved} from where the layout expects it` : 'Where the layout expects it'}</span></div>`);
        parts.push(nav());
        parts.push('<p class="cal-how">Move the real white pixel onto the circled corner. The + buttons move it away from where the strip starts, the − buttons back toward it.</p>');
        const was = $$('#caBody details.tech');
        parts.push(`<details class="tech"${was && was.open ? ' open' : ''}><summary>Details</summary><p class="muted small">Red marks every 10th pixel toward the start, green toward the end. The picture on the map stays fixed.</p><table class="kv">
          <tr><th>Pixel</th><td>${c.index < 0 ? '—' : esc(c.controller) + ':' + c.index}</td></tr>
          <tr><th>Target</th><td>${esc(st.label || '—')}</td></tr>
          <tr><th>Layout position</th><td>${c.estimate}</td></tr><tr><th>Source</th><td>${esc(c.source)}</td></tr></table>
          ${!c.fixed && c.index >= 0 ? `<form class="row" data-form="set"><input type="number" inputmode="numeric" name="i" placeholder="Pixel number" min="${c.min}" max="${c.max}" style="width:8em"><button type="submit">Go to pixel</button></form>` : ''}</details>`);
      }
      if (st.target && st.target.kind === 'gap') {
        parts.push(`<form class="row" data-form="gap"><label>Length <input name="len" value="${st.length != null ? st.length.toFixed(3) + ' m' : ''}" size="9" placeholder="2.5 m"></label><button type="submit">Confirm length</button></form>`);
      }
      const tr = st.target && (st.target.run || (c && c.run));
      if (!c) parts.push(nav());
      const utilities = [tr ? btn('Show test bands', () => session.target({ kind: 'bands', run: tr }), '', false, 'Light numbered bands along this run to check the whole strip') : '', st.target && st.target.kind !== 'bands' ? btn('Clear measurement', () => session.forget(), 'quiet', false, 'Forget what was measured for this point') : ''].join('');
      if (utilities) parts.push(`<div class="cal-nav cal-util">${utilities}</div>`);
      if (st.message && st.message !== 'calibrating ' + st.label) parts.push(`<div class="muted">${esc(humanText(g, st.message))}</div>`);
      for (const w of st.checks || []) parts.push(`<div class="cal-warn">${esc(humanText(g, w))}</div>`);
      const nudgeOff = !c || c.fixed || c.index < 0;
      for (const b of root.querySelectorAll('[data-by]')) b.disabled = nudgeOff;
      const confirmable = st.target && st.target.kind !== 'bands' && st.target.kind !== 'gap';
      $$('#caConfirm').disabled = !confirmable;
      $$('#caNext').checked = C.next;
    }
    if (C.error && !loading) parts.push(`<div class="error">${esc(C.error)}${C.details.map((d) => `<div class="small">${esc(d)}</div>`).join('')}</div>`);

    // A tapped pixel: calibrate there.
    if (tapped >= 0) {
      const p = tapped, px = g.pixels;
      const ctl = g.controllers[px.controller[p]], ri = px.run[p], r = ri >= 0 ? g.runs[ri] : null;
      const c = active && st.cursors ? st.cursors[st.side] : null;
      const tb = [];
      if (c && !c.fixed && c.controller === ctl.id && px.index[p] >= c.min && px.index[p] <= c.max) tb.push(btn('Move cursor here', () => session.set(px.index[p]), 'on'));
      if (r) {
        const near = nearestAnchor(r, px.index[p]);
        if (near) tb.push(btn(`Line up ${esc(nodeLabel(g.nodes[near.node].id))}`, () => (active ? session.target : (t) => session.start(t))({ kind: 'anchor', run: r.id, node: g.nodes[near.node].id })));
        const end = Math.abs(px.index[p] - r.first) <= Math.abs(px.index[p] - r.last) ? 'first' : 'last';
        if (active) tb.push(btn(`${end === 'first' ? 'First' : 'Last'} end`, () => session.target({ kind: 'end', run: r.id, end })));
        if (active) tb.push(btn('Bands', () => session.target({ kind: 'bands', run: r.id })));
      }
      if (active) tb.push(btn('Mark as dead', () => session.target({ kind: 'dead', controller: ctl.id, indices: [px.index[p]] })));
      parts.push(`<div class="cal-tap"><div>Tapped <b>pixel ${px.index[p]}</b>${r ? ' on ' + esc(runLabel(r.id)) : ' on ' + esc(controllerName(g, ctl.id))}</div><div class="row">${tb.join('')}${btn(icon('close'), () => { tapped = -1; render(); }, 'quiet icon-btn', false, 'Dismiss')}</div></div>`);
    }

    // Progress, grouped by run. Tap one to calibrate it.
    if (st && st.progress && st.progress.length) {
      const cur = st.target ? JSON.stringify(st.target) : '';
      const groups = new Map();
      for (const it of st.progress) {
        const k = (it.target && it.target.run) || 'Links and gaps';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
      parts.push(`<h3>Progress</h3><div class="cal-prog">${[...groups].map(([k, items]) => `<div class="group"><div>${esc(k === 'Links and gaps' ? k : runLabel(k))} <small class="muted">${items.filter((i) => i.done).length}/${items.length}</small></div><ul>${items.map((it) => {
        const row = progressRow(it, nodeLabel, runLabel);
        const raw = it.target?.node ? g.nodes.find((n) => n.id === it.target.node)?.label : '';
        if (raw) row.title += ` (${raw})`;
        const isHere = JSON.stringify(it.target) === cur, here = isHere ? ' here' : '';
        const go = () => (active ? session.target(it.target) : session.start(it.target));
        acts.push(go);
        return `<li class="nv ${it.done ? 'done' : ''}${here}"${isHere ? ' aria-current="step"' : ''} data-a="${acts.length - 1}" title="${esc(row.title)}"><span class="name">${it.done ? icon('check') : '<svg class="icon" width="12" height="12" aria-hidden="true"></svg>'}<span>${esc(row.name)}</span></span><span class="value muted">${isHere ? `<span class="here-tag">Step ${st.progress.indexOf(it) + 1}</span>` : ''}${esc(row.value)}</span></li>`;
      }).join('')}</ul></div>`).join('')}</div>`);
    }

    // Other targets: run ends, bands over a controller, dead ranges.
    if (active) {
      const runs = g.runs.map((r) => `<option value="${esc(r.id)}">${esc(r.name || humanize(r.id))}</option>`).join('');
      const ctls = g.controllers.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join('');
      const was = $$('#caBody details.more');
      parts.push(`<details class="more"${was && was.open ? ' open' : ''}><summary>More places to measure</summary>
        <div class="row"><select name="run" aria-label="Run">${runs}</select>
          ${btn('First end', () => session.target({ kind: 'end', run: $$('[name=run]').value, end: 'first' }))}
          ${btn('Last end', () => session.target({ kind: 'end', run: $$('[name=run]').value, end: 'last' }))}
          ${btn('Bands', () => session.target({ kind: 'bands', run: $$('[name=run]').value }))}</div>
        <div class="row"><select name="ctl" aria-label="Controller">${ctls}</select>${btn('Bands on controller', () => session.target({ kind: 'bands', controller: $$('[name=ctl]').value }))}</div>
        <form class="row" data-form="dead"><input type="number" name="a" placeholder="First" style="width:6em"><input type="number" name="b" placeholder="Last" style="width:6em"><button type="submit">Mark as dead</button></form>
      </details>`);
    }

    const body = $$('#caBody');
    const top = body.scrollTop, listTop = body.querySelector('.cal-prog')?.scrollTop || 0, fields = readFields(body);
    body.innerHTML = parts.join('');
    upgradeSelects(body);
    restoreFields(body, fields);
    if (!active && S.offline) for (const b of body.querySelectorAll('button.go')) b.disabled = true;
    body.scrollTop = top;
    const list = body.querySelector('.cal-prog');
    if (list) {
      list.scrollTop = listTop;
      // Only when the step changes: a poll mustn't take the list away from a thumb.
      const here = list.querySelector('li.here'), key = here ? JSON.stringify(st.target) : '';
      if (here && key !== shownHere) list.scrollTop = progCenter(here.offsetTop, here.offsetHeight, list.clientHeight);
      shownHere = key;
    }
    for (const el of body.querySelectorAll('[data-a]')) el.onclick = (e) => { e.preventDefault(); acts[+el.dataset.a](); };
    for (const b of body.querySelectorAll('[data-retry]')) b.onclick = () => { C.error = ''; render(); session.poll(); };
    for (const f of body.querySelectorAll('form[data-form]')) {
      f.onsubmit = (e) => {
        e.preventDefault();
        const v = (n) => f.elements[n].value;
        if (f.dataset.form === 'set' && v('i') !== '') session.set(+v('i'));
        if (f.dataset.form === 'gap') session.confirm({ length: v('len') });
        if (f.dataset.form === 'dead' && v('a') !== '') {
          const a = +v('a'), b = v('b') === '' ? a : +v('b');
          session.target({ kind: 'dead', controller: $$('[name=ctl]').value, indices: [a, b] });
        }
      };
    }
    frameCursor();
    keepAwake();
    S.markDirty();
  }

  // Poll faster while the mode is open; otherwise only to notice a
  // session started elsewhere. Don't redraw over what's being typed.
  let lastPoll = 0;
  setInterval(() => {
    if (document.hidden) return;
    const f = document.activeElement;
    if (open && f && root.contains(f) && (f.tagName === 'INPUT' || f.tagName === 'SELECT')) return;
    if (open && root.querySelector('.picker.open')) return;
    const now = Date.now();
    if (!open && now - lastPoll < 4000) return;
    lastPoll = now;
    session.poll();
  }, 1500);
  session.poll();

  return {
    // open shows the mode, optionally ready to start on a run.
    open(opts = {}) {
      run = opts.run || '';
      left = false;
      remember(false);
      show(true);
      if (run && C.st && C.st.active) {
        const r = g.runs.find((x) => x.id === run);
        const first = r && r.anchors.find((a) => a.source === 'estimated');
        session.target(first ? { kind: 'anchor', run: r.id, node: g.nodes[first.node].id } : { kind: 'bands', run });
      }
      render();
    },
    tapped(p) { tapped = p; render(); },
    session,
  };
}
