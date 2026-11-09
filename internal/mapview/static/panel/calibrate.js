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
import { esc, plural, humanize, failure } from '../util.js';
import { icon } from '../icons.js';
import { upgradeSelects } from '../picker.js';
import { stateHTML, warningHTML } from '../states.js';
import { runName, nodeDisplay, controllerName, humanText } from '../names.js';

const BASE = '/api/v1/calibration';
const BETWEEN = 'Between runs'; // the progress group for links and gaps
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
  const C = { st: null, error: '', details: [], next: true, lost: false, failed: null };
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
        // stays until the next action. A reply with no message of ours, like
        // {} or a proxy's page, is never shown as it came.
        if (fail(path, body, failure(DOING[path], { status: r.status, message: j?.error, unreadable: !j?.error }), j?.errors || [])) return;
      } else {
        if (polling && text === last && !C.lost) return;
        last = text; C.st = j;
        if (!polling || C.lost) { C.error = ''; C.details = []; C.lost = false; C.failed = null; }
      }
    } catch (e) {
      if (polling && my !== seq) return;
      if (fail(path, body, failure(DOING[path], { network: true }), [])) return;
    }
    onState(C);
  }

  // fail records a failure for Retry. It says true when a poll only repeats
  // the failure already on screen, which isn't redrawn under a tap on Retry.
  function fail(path, body, error, details) {
    const polling = body === undefined, same = polling && C.lost && C.error === error;
    C.error = error; C.details = details; C.lost = polling || C.lost; C.failed = { path, body };
    return same;
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
    // retry repeats what failed, going back to a clean screen meanwhile.
    retry() {
      const f = C.failed || { path: '' };
      C.error = ''; C.details = []; C.failed = null;
      onState(C);
      return call(f.path, f.body);
    },
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

// calLabel is the screen's header: the mode's name, and the doing word only
// while a session is actually running.
export const calLabel = (st) => (st?.active ? 'Calibrating' : 'Calibration');

// loadState is the screen's state before the first reading: loading, or
// the failure with Retry. null once there is a session state to draw.
export function loadState(C) {
  if (C.st) return null;
  if (C.error) return { kind: 'error', title: 'Could not load calibration', detail: C.error, retry: true };
  return { kind: 'loading', title: 'Loading calibration…' };
}

// calCount is the one count on the calibration screen: the steps in the
// progress list. It holds links and
// gaps as well as the points the Setup tab counts, which the title says.
export function calCount(st) {
  const items = st.progress || [];
  if (!items.length) return null;
  const others = items.length - (st.anchors || 0);
  return {
    text: `${items.filter((i) => i.done).length} of ${plural(items.length, 'step')} done`,
    title: `${st.measured || 0} of ${plural(st.anchors || 0, 'point')} measured` + (others ? `, plus ${plural(others, 'join between runs', 'joins between runs')}` : ''),
  };
}

// stepPlace says whether the current step is done. The one number on this
// screen is the count of steps done: steps can be done in any order, so a
// step's own number beside it reads as a mistake.
export function stepPlace(item) {
  if (item.done) return 'Done';
  return ['anchor', 'end'].includes(item.target?.kind) ? "This point isn't measured yet" : "This step isn't done yet";
}

// MOVE_HOW is the instruction, the same at the intro and on each step: the
// real pixel moves, and the map is the fixed reference.
export const MOVE_HOW = 'Use −/+ to move the lit pixel along the real strip until it matches the circled point on the map.';

// sourceWords says where a point's position came from.
const SOURCE_WORDS = { measured: 'Measured', estimated: 'Estimated from the layout', partial: 'Partly measured', end: 'End of the run' };
export const sourceWords = (source) => SOURCE_WORDS[source] || humanize(String(source || '')) || '—';

// stepScroll is where the panel's one scroll settles when the step changes:
// the top, or as far down as it takes to show the step's row in Progress,
// never so far that the step's own heading scrolls away. Positions are from
// the top of the content; row is null when the step has no row.
export function stepScroll(row, view, headTop) {
  if (!row) return 0;
  return Math.max(0, Math.min(row.bottom + 12 - view, headTop));
}

// returnTab is the tab to go back to when the mode closes, '' to stay.
export const returnTab = (from, tab) => (from && from !== tab ? from : '');

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

// NO_CURSOR_HOW says what to do on a step with no test pixel to move.
const NO_CURSOR_HOW = {
  bands: 'The lights show 100-pixel blocks, orange then blue, with every 10th pixel white. Check along the strip that no block is missing or out of place.',
  gap: 'Measure the real gap between the two ends, then type its length below.',
  dead: 'The marked pixels stay dark. Confirm to save them.',
};

// dockReason says why the dock's controls are off on this step, in the
// dock, where the disabled buttons are. '' when they work.
export function dockReason(target, cursor) {
  if (target?.kind === 'bands') return 'Nudge and Confirm are off while the test bands show. Leave test bands to keep measuring.';
  if (target?.kind === 'gap') return 'This step has no pixel to move. Type the length above and use Confirm length.';
  if (cursor?.fixed) return "This side is fixed, so it can't be nudged.";
  if (cursor && cursor.index < 0) return 'This run has no pixel here to move.';
  return '';
}

// OWN_RELOAD marks a page load Glowstack caused itself.
export const OWN_RELOAD = 'glowstack.ownReload';

// sheetShift is how far to raise the phone's calibration sheet so no row
// is cut at the scroller's resting edge: the smallest move, up or down, that
// leaves the edge between rows. rows are {top, bottom} from the top of the
// content, edge the scroller's height. Anything too tall to fit is left out.
export function sheetShift(rows, edge, max = 64) {
  const short = rows.filter((r) => r.bottom - r.top < 120);
  const cuts = (e) => short.some((r) => r.top < e && r.bottom > e);
  if (!cuts(edge)) return 0;
  const moves = short.flatMap((r) => [Math.ceil(r.bottom + 4 - edge), Math.floor(r.top - 4 - edge)]);
  return moves.filter((m) => Math.abs(m) <= max && !cuts(edge + m)).sort((a, b) => Math.abs(a) - Math.abs(b))[0] ?? 0;
}

// createCalibrate is the mode's screen in root.
export function createCalibrate(S, root) {
  const g = S.geo;
  const nodeLabel = (id) => nodeDisplay(g, id);
  const runLabel = (id) => runName(g, id);
  let open = false, run = '', tapped = -1, wake = null, hold = null, framed = '', wasActive = false, shownStep = '';
  const session = createSession({ fetch: (...a) => fetch(...a), storage: sessionStorage, onState: render });
  const C = session.C;
  // Set when the mode was left with a session still running: it doesn't
  // reopen by itself, including after a reload, until Resume.
  const remember = (v) => { try { sessionStorage.setItem('calLeft', String(v)); } catch (_) { /* no storage */ } };
  let left = false;
  try { left = sessionStorage.getItem('calLeft') === 'true'; } catch (_) { /* no storage */ }
  // The tab the mode was opened from, kept across the reload Confirm causes.
  let from = '';
  try { from = sessionStorage.getItem('calFrom') || ''; } catch (_) { /* no storage */ }
  const rememberFrom = (tab) => {
    from = tab;
    try { if (tab) sessionStorage.setItem('calFrom', tab); else sessionStorage.removeItem('calFrom'); } catch (_) { /* no storage */ }
  };
  // Run groups opened by hand stay open as the session moves on.
  const openGroups = new Set();
  // Where Leave test bands goes back to, kept across a reload.
  let beforeBands = null;
  try { beforeBands = JSON.parse(sessionStorage.getItem('calBeforeBands')); } catch (_) { /* none yet */ }
  const rememberBands = (t) => {
    beforeBands = t;
    try { sessionStorage.setItem('calBeforeBands', JSON.stringify(t)); } catch (_) { /* no storage */ }
  };
  const showBands = (t) => {
    if (C.st?.target && C.st.target.kind !== 'bands') rememberBands(C.st.target);
    return session.target(t);
  };
  const leaveBands = () => {
    const to = beforeBands || C.st?.progress?.[0]?.target;
    rememberBands(null);
    return to ? session.target(to) : session.next();
  };

  root.innerHTML = `
    <div class="cal-top"><span class="what"><b id="caLabel">Calibration</b><small id="caCount"></small></span>
      <button type="button" id="caStop" class="danger icon-btn" title="End calibration and return the lights to normal">${icon('stop')}Stop</button><button type="button" id="caClose" title="Back to the map">Close</button></div>
    <div class="cal-toasts" id="caToasts" aria-live="polite"></div>
    <div class="cal-body" id="caBody"></div>
    <div class="cal-dock" id="caDock" hidden>
      <p class="cal-why" id="caWhy" hidden></p>
      <p class="cal-nudge-how" id="caHow">Use −/+ until it matches the circled point: + moves it away from the strip's start, − back toward it.</p>
      <div class="nudges">${[-10, -1, 1, 10].map((n) => `<button type="button" data-by="${n}">${n > 0 ? '+' : '−'}${Math.abs(n)}</button>`).join('')}</div>
      <div class="cal-confirm"><button type="button" class="go icon-btn" id="caConfirm" title="Save this pixel as the measured position">${icon('check')}Confirm</button>
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
    S.moveToasts?.();
    S.subscribe?.();
    if (on) hold = S.view.hold();
    else { framed = ''; tapped = -1; shownStep = ''; }
    S.refreshLegend?.();
    S.resize();
    if (!on && hold) { S.view.release(hold); hold = null; }
    keepAwake();
    S.inspect(S.pinned);
    S.markDirty();
  }
  // close leaves the mode for the tab it was opened from.
  function close() {
    show(false);
    const to = returnTab(from, S.panel?.tab?.());
    rememberFrom('');
    if (to) S.panel.openTab(to);
    // Back to the top of the panel, its heading in view, not a stale scroll.
    S.panel?.toTop?.();
  }

  // leave exits the mode because the page moved on. A session that is
  // still running keeps driving the lights, so say where to find it.
  function leave() {
    if (!open) return;
    show(false);
    rememberFrom('');
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
    if (running && !open && !left) {
      show(true);
      // Glowstack's own reload, after a confirm changed the model, is no news.
      if (!globalThis.sessionStorage?.getItem(OWN_RELOAD)) S.toast?.('A calibration is still running on the lights. Stop returns them to normal.', { warn: true, ms: 9000 });
    }
    globalThis.sessionStorage?.removeItem?.(OWN_RELOAD);
    if (running !== wasActive) { wasActive = running; S.subscribe?.(); S.emit('calibration', running); }
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
    $$('#caLabel').textContent = calLabel(st);
    const count = st ? calCount(st) : null;
    $$('#caCount').textContent = count ? count.text : '';
    $$('#caCount').title = count ? count.title : '';

    const loading = loadState(C);
    if (loading) parts.push(stateHTML(loading));
    else if (!active) {
      const r = run && g.runs.find((x) => x.id === run);
      const first = r && r.anchors.find((a) => a.source === 'estimated');
      parts.push(`<h1 class="title">Line up the map with the lights</h1><p class="muted">Each step lights one point. ${MOVE_HOW} Then confirm.</p>${warningHTML('This changes the real lights until you stop.')}`);
      parts.push(`<div class="row">${btn(`${icon('target')}${r ? `Start on ${esc(runLabel(r.id))}` : 'Start calibrating'}`, () => session.start(r ? (first ? { kind: 'anchor', run: r.id, node: g.nodes[first.node].id } : { kind: 'bands', run: r.id }) : null), 'go grow icon-btn')}</div>`);
      parts.push('<details class="more"><summary>Details</summary><div class="muted small">Measurements are saved on the Glowstack server and survive restarts.</div></details>');
    } else {
      if (st.warning) parts.push(warningHTML(humanText(g, st.warning)));
      // Previous and Next come first: below the instructions they fell
      // under the nudge bar's edge on a phone.
      const nav = () => `<div class="cal-nav">${btn(`${icon('chevronLeft')}Previous`, () => session.next(true), 'icon-btn')}${btn(`Next${icon('chevronRight')}`, () => session.next(), 'icon-btn')}</div>`;
      const cs = st.cursors || [];
      if (cs.length > 1) parts.push(`<div class="cal-sides">${cs.map((c, i) => btn(esc(nodeLabel(c.label)) + (c.fixed ? ' (fixed)' : ''), () => session.side(i), i === st.side ? 'on' : '')).join('')}</div>`);
      const c = cs[st.side];
      // Every step keeps its heading, with a cursor to move or without.
      const step = stepTitle(st, nodeLabel, runLabel);
      const i = (st.progress || []).findIndex((it) => JSON.stringify(it.target) === JSON.stringify(st.target));
      parts.push(`<div class="cal-step">${i >= 0 ? `<small>${esc(stepPlace(st.progress[i]))}</small>` : ''}<h2>${esc(step.title)}</h2>${step.on ? `<p>${esc(step.on)}</p>` : ''}</div>`);
      if (c) {
        const moved = c.index - c.estimate;
        const isGap = st.target?.kind === 'gap'; // its ends are fixed: only a length to type
        if (!isGap) parts.push(`<div class="cal-read"><span class="idx">${c.index < 0 ? 'No pixel on this run' : moved ? `Moved ${moved > 0 ? '+' : ''}${moved} from where the layout puts it` : 'Not moved yet: still where the layout puts it'}</span></div>`);
        parts.push(nav());
        if (isGap) parts.push(`<p class="cal-how">${NO_CURSOR_HOW.gap}</p>`); // a pixel's −/+ is explained at its buttons
        const was = $$('#caBody details.tech'), wasIds = $$('#caBody details.ids');
        parts.push(`<details class="tech"${was && was.open ? ' open' : ''}><summary>Details</summary><p class="muted small">Red marks every 10th pixel toward the start, green toward the end. The picture on the map stays fixed.</p><table class="kv">
          <tr><th>Test pixel</th><td>${c.index < 0 ? '—' : `Pixel ${c.index} on ${esc(controllerName(g, c.controller))}`}</td></tr>
          <tr><th>The layout puts it at</th><td>Pixel ${c.estimate}</td></tr><tr><th>Position</th><td>${esc(sourceWords(c.source))}</td></tr></table>
          <details class="ids"${wasIds && wasIds.open ? ' open' : ''}><summary>Technical names</summary><p class="muted small">${esc(st.label || '—')}${c.index < 0 ? '' : ` · ${esc(c.controller)}:${c.index}`}</p></details>
          ${!c.fixed && c.index >= 0 ? `<form class="row" data-form="set"><input type="number" inputmode="numeric" name="i" placeholder="Pixel number" min="${c.min}" max="${c.max}" class="cal-pixel"><button type="submit">Go to pixel</button></form>` : ''}</details>`);
      }
      if (st.target && st.target.kind === 'gap') {
        parts.push(`<form class="row" data-form="gap"><label>Length <input name="len" value="${st.length != null ? st.length.toFixed(3) + ' m' : ''}" size="9" placeholder="2.5 m"></label><button type="submit">Confirm length</button></form>`);
      }
      const tr = st.target && (st.target.run || (c && c.run));
      if (!c) {
        if (NO_CURSOR_HOW[st.target?.kind]) parts.push(`<p class="cal-how">${esc(NO_CURSOR_HOW[st.target.kind])}</p>`);
        parts.push(nav());
      }
      const bands = st.target?.kind === 'bands';
      const item = i >= 0 ? st.progress[i] : null;
      const forgettable = item?.done || item?.source === 'partial' || !!(c && c.index !== c.estimate);
      const utilities = [bands ? btn('Leave test bands', leaveBands, 'on', false, 'Back to the step you were on') : tr ? btn('Show test bands', () => showBands({ kind: 'bands', run: tr }), '', false, 'Light numbered bands along this run to check the whole strip') : '', st.target && st.target.kind !== 'bands' ? btn(`${icon('trash')}Clear measurement`, () => session.forget(), 'quiet icon-btn', !forgettable, forgettable ? 'Forget what was measured for this point' : 'Nothing to forget: this point has not been measured or moved') : ''].join('');
      if (utilities) parts.push(`<div class="cal-nav cal-util">${utilities}</div>`);
      if (st.message && st.message !== 'calibrating ' + st.label) parts.push(`<div class="muted">${esc(humanText(g, st.message))}</div>`);
      for (const w of st.checks || []) parts.push(warningHTML(humanText(g, w)));
      const nudgeOff = !c || c.fixed || c.index < 0;
      for (const b of root.querySelectorAll('[data-by]')) b.disabled = nudgeOff;
      $$('#caHow').hidden = nudgeOff;
      const confirmable = st.target && st.target.kind !== 'bands' && st.target.kind !== 'gap';
      $$('#caConfirm').disabled = !confirmable;
      const why = dockReason(st.target, c);
      $$('#caWhy').textContent = why;
      $$('#caWhy').hidden = !why;
      $$('#caNext').checked = C.next;
    }
    // At the top, where a failure is seen from the nudge dock too.
    if (C.error && !loading) parts.unshift(stateHTML({ kind: 'error', title: C.error, detail: C.details.join(' '), retry: true }));

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
        if (active) tb.push(btn('Bands', () => showBands({ kind: 'bands', run: r.id })));
      }
      if (active) tb.push(btn('Mark as dead', () => session.target({ kind: 'dead', controller: ctl.id, indices: [px.index[p]] })));
      parts.push(`<div class="cal-tap"><div>Tapped <b>pixel ${px.index[p]}</b>${r ? ' on ' + esc(runLabel(r.id)) : ' on ' + esc(controllerName(g, ctl.id))}</div><div class="row">${tb.join('')}${btn(icon('close'), () => { tapped = -1; render(); }, 'quiet icon-btn', false, 'Dismiss')}</div></div>`);
    }

    // Progress, grouped by run. Tap one to calibrate it.
    if (st && st.progress && st.progress.length) {
      const cur = st.target ? JSON.stringify(st.target) : '';
      const hereGroup = st.target ? st.target.run || BETWEEN : '';
      const groups = new Map();
      for (const it of st.progress) {
        const k = (it.target && it.target.run) || BETWEEN;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
      parts.push(`<h3>Progress</h3><div class="cal-prog">${[...groups].map(([k, items]) => `<details class="group" data-group="${esc(k)}"${k === hereGroup || openGroups.has(k) ? ' open' : ''}><summary>${esc(k === BETWEEN ? k : runLabel(k))} <small class="muted">${items.filter((i) => i.done).length}/${items.length}</small></summary><ul>${items.map((it) => {
        const row = progressRow(it, nodeLabel, runLabel);
        const raw = it.target?.node ? g.nodes.find((n) => n.id === it.target.node)?.label : '';
        if (raw) row.title += ` (${raw})`;
        const isHere = JSON.stringify(it.target) === cur, here = isHere ? ' here' : '';
        const go = () => (active ? session.target(it.target) : session.start(it.target));
        acts.push(go);
        return `<li class="nv ${it.done ? 'done' : ''}${here}"${isHere ? ' aria-current="step"' : ''} data-a="${acts.length - 1}" title="${esc(row.title)}"><span class="name">${it.done ? icon('check') : '<svg class="icon" width="12" height="12" aria-hidden="true"></svg>'}<span>${esc(row.name)}</span></span><span class="value muted">${isHere ? '<span class="here-tag">Now</span>' : ''}${esc(row.value)}</span></li>`;
      }).join('')}</ul></details>`).join('')}</div>`);
    }

    // Other targets: run ends, bands over a controller, dead ranges.
    if (active) {
      const runs = g.runs.map((r) => `<option value="${esc(r.id)}">${esc(r.name || humanize(r.id))}</option>`).join('');
      const ctls = g.controllers.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join('');
      const was = $$('#caBody details.more');
      parts.push(`<details class="more"${was && was.open ? ' open' : ''}><summary>More places to measure</summary>
        <p class="muted small">Find either end of a run, or light its test bands to check the whole strip.</p>
        <div class="row"><select name="run" aria-label="Run">${runs}</select>
          ${btn('First end', () => session.target({ kind: 'end', run: $$('[name=run]').value, end: 'first' }))}
          ${btn('Last end', () => session.target({ kind: 'end', run: $$('[name=run]').value, end: 'last' }))}
          ${btn('Bands', () => showBands({ kind: 'bands', run: $$('[name=run]').value }))}</div>
        <p class="muted small">Light test bands across a whole controller, or mark pixels that don't light on it, by number.</p>
        <div class="row"><select name="ctl" aria-label="Controller">${ctls}</select>${btn('Bands on controller', () => showBands({ kind: 'bands', controller: $$('[name=ctl]').value }))}</div>
        <form class="row" data-form="dead"><input type="number" name="a" placeholder="First" style="width:6em"><input type="number" name="b" placeholder="Last" style="width:6em"><button type="submit">Mark as dead</button></form>
      </details>`);
    }

    const body = $$('#caBody');
    const top = body.scrollTop, fields = readFields(body);
    body.innerHTML = parts.join('');
    upgradeSelects(body);
    restoreFields(body, fields);
    if (!active && S.offline) for (const b of body.querySelectorAll('button.go')) b.disabled = true;
    // A new step comes into view however far down it was picked from, with
    // its own row when there's room. Only then: a poll mustn't take the
    // panel away from a thumb.
    const stepKey = active && st.target ? JSON.stringify(st.target) : '';
    body.scrollTop = top;
    if (stepKey && stepKey !== shownStep && body.getBoundingClientRect) {
      const at = body.getBoundingClientRect().top - body.scrollTop;
      const here = body.querySelector('li.here')?.getBoundingClientRect(), head = body.querySelector('.cal-step')?.getBoundingClientRect();
      body.scrollTop = stepScroll(here ? { bottom: here.bottom - at } : null, body.clientHeight, head ? head.top - at : 0);
    }
    shownStep = stepKey;
    for (const el of body.querySelectorAll('[data-a]')) el.onclick = (e) => { e.preventDefault(); acts[+el.dataset.a](); };
    for (const b of body.querySelectorAll('[data-retry]')) b.onclick = () => session.retry();
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
    fitSheet();
    frameCursor();
    keepAwake();
    S.markDirty();
  }

  // fitSheet settles the phone's sheet so its edge doesn't cut a row in
  // half, the way a half-height bottom sheet settles on a whole card.
  let shift = 0;
  function fitSheet() {
    const body = $$('#caBody');
    let next = 0;
    if (S.panel?.layout?.() === 'sheet') {
      root.style.removeProperty('top');
      const at = body.getBoundingClientRect().top - body.scrollTop;
      const rows = [...body.children].map((el) => { const r = el.getBoundingClientRect(); return { top: r.top - at, bottom: r.bottom - at }; });
      next = sheetShift(rows, body.clientHeight);
    }
    root.style.top = next ? `calc(var(--cal-map) - ${next}px)` : '';
    document.body.style?.setProperty('--cal-shift', next + 'px');
    if (next !== shift) { shift = next; S.resize(); }
  }

  // A disclosure opened by hand comes into view above the dock.
  let opening = null;
  $$('#caBody').addEventListener('click', (e) => { opening = e.target.closest?.('summary')?.parentElement || null; }, true);
  $$('#caBody').addEventListener('toggle', (e) => {
    if (e.target === opening && e.target.matches('details.group')) {
      if (e.target.open) openGroups.add(e.target.dataset.group); else openGroups.delete(e.target.dataset.group);
    }
    if (e.target === opening && e.target.open) e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    opening = null;
  }, true);

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
      rememberFrom(S.panel?.tab?.() || '');
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
