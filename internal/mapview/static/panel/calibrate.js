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
import { esc, plural, NOT_RESPONDING } from '../util.js';

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
        C.error = j?.error || text || r.statusText; C.details = j?.errors || [];
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

// createCalibrate is the mode's screen in root.
export function createCalibrate(S, root) {
  const g = S.geo;
  let open = false, run = '', tapped = -1, wake = null, hold = null, framed = '', wasActive = false;
  const session = createSession({ fetch: (...a) => fetch(...a), storage: sessionStorage, onState: render });
  const C = session.C;
  // Set when the mode was left with a session still running: it doesn't
  // reopen by itself, including after a reload, until Resume.
  const remember = (v) => { try { sessionStorage.setItem('calLeft', String(v)); } catch (_) { /* no storage */ } };
  let left = false;
  try { left = sessionStorage.getItem('calLeft') === 'true'; } catch (_) { /* no storage */ }

  root.innerHTML = `
    <div class="cal-top"><span class="what"><b id="caLabel">Calibration</b><small id="caCount"></small></span>
      <button type="button" id="caStop" class="danger">Stop</button><button type="button" id="caClose" title="Back to the map">Close</button></div>
    <div class="cal-body" id="caBody"></div>
    <div class="cal-dock" id="caDock" hidden>
      <div class="nudges">${[-10, -1, 1, 10].map((n) => `<button type="button" data-by="${n}">${n > 0 ? '+' : '−'}${Math.abs(n)}</button>`).join('')}</div>
      <div class="cal-confirm"><button type="button" class="go" id="caConfirm">Confirm</button>
        <label class="check small"><input type="checkbox" id="caNext"> then next</label></div>
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
    else { framed = ''; tapped = -1; }
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
      S.toast('Calibration is still running on the lights. Resume or stop it from Setup.');
    }
  }
  S.on('tab', leave);

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
  const btn = (label, fn, cls = '', disabled = false) => {
    acts.push(fn);
    return `<button type="button" class="${cls}" data-a="${acts.length - 1}"${disabled ? ' disabled' : ''}>${label}</button>`;
  };

  function render() {
    S.cal = C.st;
    const running = !!(C.st && C.st.active);
    if (!running && left) { left = false; remember(false); }
    if (running && !open && !left) show(true);
    if (running !== wasActive) { wasActive = running; S.emit('calibration', running); }
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
    $$('#caLabel').textContent = active ? (st.label || 'nothing picked yet') : 'Calibration';
    $$('#caCount').textContent = st && st.anchors ? `${st.measured} of ${st.anchors} anchors measured` : '';

    if (!st) parts.push('<p class="muted">Loading…</p>');
    else if (!active) {
      const r = run && g.runs.find((x) => x.id === run);
      const first = r && r.anchors.find((a) => a.source === 'estimated');
      parts.push(`<p class="muted">Lights the next unmeasured anchor on the house: nudge the white pixel onto the real corner, then confirm. This drives the real lights. Measurements go to <code>anchors.yaml</code> in the data folder.</p>`);
      parts.push(`<div class="row">${btn(r ? `Start on ${esc(r.id)}` : 'Start calibrating', () => session.start(r ? (first ? { kind: 'anchor', run: r.id, node: g.nodes[first.node].id } : { kind: 'bands', run: r.id }) : null), 'on grow')}</div>`);
    } else {
      if (st.warning) parts.push(`<div class="cal-warn">${esc(st.warning)}</div>`);
      const cs = st.cursors || [];
      if (cs.length > 1) parts.push(`<div class="cal-sides">${cs.map((c, i) => btn(esc(c.label) + (c.fixed ? ' (fixed)' : ''), () => session.side(i), i === st.side ? 'on' : '')).join('')}</div>`);
      const c = cs[st.side];
      if (c) {
        const moved = c.index - c.estimate;
        parts.push(`<div class="cal-read"><span class="idx">${c.index < 0 ? 'no pixel' : esc(c.controller) + ':' + c.index}</span>
          <span class="muted">layout ${c.estimate} · ${esc(c.source)}${moved ? ` · <b>${moved > 0 ? '+' : ''}${moved}</b>` : ''}</span></div>`);
        parts.push('<div class="muted small">+ moves toward the run\'s end. Target pattern: this picture stays fixed. Use the offset buttons until the real white pixel matches the circled corner. Red marks every 10th pixel toward the start, green toward the end.</div>');
        if (!c.fixed && c.index >= 0) parts.push(`<form class="row" data-form="set"><input type="number" inputmode="numeric" name="i" placeholder="index" min="${c.min}" max="${c.max}" style="width:8em"><button type="submit">Go to index</button></form>`);
      }
      if (st.target && st.target.kind === 'gap') {
        parts.push(`<form class="row" data-form="gap"><label>Length <input name="len" value="${st.length != null ? st.length.toFixed(3) + ' m' : ''}" size="9"></label><button type="submit">Confirm length</button></form>`);
      }
      const tr = st.target && (st.target.run || (c && c.run));
      parts.push(`<div class="cal-nav">${btn('◀ Prev', () => session.next(true))}${btn('Next ▶', () => session.next())}${tr ? btn('Bands on run', () => session.target({ kind: 'bands', run: tr })) : ''}${st.target && st.target.kind !== 'bands' ? btn('Forget', () => session.forget(), 'quiet') : ''}</div>`);
      if (st.message && st.message !== 'calibrating ' + st.label) parts.push(`<div class="muted">${esc(st.message)}</div>`);
      for (const w of st.checks || []) parts.push(`<div class="cal-warn">${esc(w)}</div>`);
      const nudgeOff = !c || c.fixed || c.index < 0;
      for (const b of root.querySelectorAll('[data-by]')) b.disabled = nudgeOff;
      const confirmable = st.target && st.target.kind !== 'bands' && st.target.kind !== 'gap';
      $$('#caConfirm').disabled = !confirmable;
      $$('#caNext').checked = C.next;
    }
    if (C.error) parts.push(`<div class="error">${esc(C.error)}${C.details.map((d) => `<div class="small">${esc(d)}</div>`).join('')}</div>`);

    // A tapped pixel: calibrate there.
    if (tapped >= 0) {
      const p = tapped, px = g.pixels;
      const ctl = g.controllers[px.controller[p]], ri = px.run[p], r = ri >= 0 ? g.runs[ri] : null;
      const c = active && st.cursors ? st.cursors[st.side] : null;
      const tb = [];
      if (c && !c.fixed && c.controller === ctl.id && px.index[p] >= c.min && px.index[p] <= c.max) tb.push(btn('Move cursor here', () => session.set(px.index[p]), 'on'));
      if (r) {
        const near = nearestAnchor(r, px.index[p]);
        if (near) tb.push(btn(`Calibrate ${esc(g.nodes[near.node].id)}`, () => (active ? session.target : (t) => session.start(t))({ kind: 'anchor', run: r.id, node: g.nodes[near.node].id })));
        const end = Math.abs(px.index[p] - r.first) <= Math.abs(px.index[p] - r.last) ? 'first' : 'last';
        if (active) tb.push(btn(`${end} end`, () => session.target({ kind: 'end', run: r.id, end })));
        if (active) tb.push(btn('Bands', () => session.target({ kind: 'bands', run: r.id })));
      }
      if (active) tb.push(btn('Mark dead', () => session.target({ kind: 'dead', controller: ctl.id, indices: [px.index[p]] })));
      parts.push(`<div class="cal-tap"><div>Tapped <b>${esc(ctl.id)}:${px.index[p]}</b>${r ? ' on ' + esc(r.id) : ''}</div><div class="row">${tb.join('')}${btn('✕', () => { tapped = -1; render(); }, 'quiet')}</div></div>`);
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
      parts.push(`<h3>Progress</h3><div class="cal-prog">${[...groups].map(([k, items]) => `<div class="group"><div>${esc(k)} <small class="muted">${items.filter((i) => i.done).length}/${items.length}</small></div><ul>${items.map((it) => {
        const val = it.index != null ? it.index : it.length != null ? it.length.toFixed(2) + ' m' : '';
        const here = JSON.stringify(it.target) === cur ? ' here' : '';
        const go = () => (active ? session.target(it.target) : session.start(it.target));
        acts.push(go);
        return `<li class="${it.done ? 'done' : ''}${here}" data-a="${acts.length - 1}"><span>${it.done ? '✓' : '·'} ${esc(it.label)}</span><span class="muted">${val} ${esc(it.source || '')}</span></li>`;
      }).join('')}</ul></div>`).join('')}</div>`);
    }

    // Other targets: run ends, bands over a controller, dead ranges.
    if (active) {
      const runs = g.runs.map((r) => `<option>${esc(r.id)}</option>`).join('');
      const ctls = g.controllers.map((c) => `<option>${esc(c.id)}</option>`).join('');
      const was = $$('#caBody details.more');
      parts.push(`<details class="more"${was && was.open ? ' open' : ''}><summary>More: run ends, bands, dead pixels</summary>
        <div class="row"><select name="run">${runs}</select>
          ${btn('First end', () => session.target({ kind: 'end', run: $$('[name=run]').value, end: 'first' }))}
          ${btn('Last end', () => session.target({ kind: 'end', run: $$('[name=run]').value, end: 'last' }))}
          ${btn('Bands', () => session.target({ kind: 'bands', run: $$('[name=run]').value }))}</div>
        <div class="row"><select name="ctl">${ctls}</select>${btn('Bands on controller', () => session.target({ kind: 'bands', controller: $$('[name=ctl]').value }))}</div>
        <form class="row" data-form="dead"><input type="number" name="a" placeholder="first" style="width:6em"><input type="number" name="b" placeholder="last" style="width:6em"><button type="submit">Dead pixels</button></form>
      </details>`);
    }

    const body = $$('#caBody');
    const top = body.scrollTop;
    body.innerHTML = parts.join('');
    body.scrollTop = top;
    for (const el of body.querySelectorAll('[data-a]')) el.onclick = (e) => { e.preventDefault(); acts[+el.dataset.a](); };
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
