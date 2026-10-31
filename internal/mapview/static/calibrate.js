// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The live map's calibration panel: big buttons for a phone, standing
// outside. It drives /api/v1/calibration (the session lives on the server,
// so a phone and a laptop share it) and reads the map's geometry (S.geo)
// for tapped pixels. Loaded after map.js, whose globals it uses.
'use strict';

(() => {
  const BASE = '/api/v1/calibration';
  const C = { st: null, tapped: -1, error: '', details: [], next: true };
  const box = $('cal');

  // call sends one request and shows the state it returns, or the error.
  // A poll (path '') that a button press overtook is dropped, and an
  // unchanged state isn't redrawn, so a finger mid-tap keeps its button.
  let seq = 0, last = '';
  async function call(path, body) {
    const my = ++seq, polling = body === undefined;
    try {
      const r = await fetch(BASE + path, polling ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const text = await r.text();
      if (polling && my !== seq) return;
      const j = JSON.parse(text);
      if (!r.ok) {
        C.error = j.error || r.statusText; C.details = j.errors || [];
      } else {
        if (polling && text === last && !C.lost) return;
        last = text; C.st = j;
        if (!polling || C.lost) { C.error = ''; C.details = []; C.lost = false; }
      }
    } catch (e) {
      if (polling && my !== seq) return;
      C.error = String(e.message || e); C.details = []; C.lost = polling;
    }
    render();
  }

  const target = (t) => call('/target', t);
  const button = (label, cls, fn, disabled) => ({ label, cls, fn, disabled });

  function render() {
    const st = C.st;
    if (!st) { box.innerHTML = '<div class="muted">Loading…</div>'; return; }
    const parts = [];
    const actions = [];
    const act = (b) => { actions.push(b); return actions.length - 1; };
    const btn = (b) => `<button class="${b.cls || ''}" data-a="${act(b)}"${b.disabled ? ' disabled' : ''}>${b.label}</button>`;

    if (!st.active) {
      parts.push(`<p class="muted">Lights the first unmeasured anchor on the house: nudge the white pixel to the real corner, then confirm. Measurements go to <code>anchors.yaml</code> in the data folder.</p>`);
      parts.push(`<div class="calrow">${btn(button('Start calibrating', 'big go', () => call('/start', {})))}</div>`);
    } else {
      parts.push(`<div class="calhead"><b>${esc(st.label || 'nothing picked yet')}</b>${btn(button('Stop', 'stop', () => call('/end', {})))}</div>`);
      if (st.warning) parts.push(`<div class="calwarn">${esc(st.warning)}</div>`);
      const cs = st.cursors || [];
      if (cs.length > 1) {
        parts.push(`<div class="calrow sides">${cs.map((c, i) => btn(button(esc(c.label) + (c.fixed ? ' (fixed)' : ''), i === st.side ? 'on' : '', () => call('/side', { side: i })))).join('')}</div>`);
      }
      const c = cs[st.side];
      if (c) {
        const moved = c.index - c.estimate;
        parts.push(`<div class="calread"><span class="idx">${c.index < 0 ? 'no pixel' : esc(c.controller) + ':' + c.index}</span>
          <span class="muted">layout ${c.estimate} · ${esc(c.source)}${moved ? ` · <b>${moved > 0 ? '+' : ''}${moved}</b>` : ''}</span></div>`);
        const fixed = c.fixed || c.index < 0;
        parts.push(`<div class="calrow nudge">${[-10, -1, 1, 10].map((n) => btn(button((n > 0 ? '+' : '−') + Math.abs(n), 'big', () => call('/nudge', { by: n }), fixed))).join('')}</div>`);
        if (!fixed) {
          parts.push(`<form class="calrow" data-form="set"><input id="calSet" type="number" inputmode="numeric" placeholder="index" min="${c.min}" max="${c.max}">${btn(button('Go to index', '', null))}</form>`);
        }
        parts.push(`<div class="muted small">+ moves towards the run's end. White is the cursor; red marks every 10th pixel towards the start, green towards the end.</div>`);
      }
      if (st.target && st.target.kind === 'gap') {
        parts.push(`<form class="calrow" data-form="gap"><label>Length <input id="calLen" value="${st.length != null ? st.length.toFixed(3) + ' m' : ''}" size="9"></label>${btn(button('Confirm length', 'big go', null))}</form>`);
      } else if (st.target && st.target.kind !== 'bands') {
        parts.push(`<div class="calrow">${btn(button('Confirm', 'big go wide', () => call('/confirm', { next: C.next })))}</div>
          <label class="check"><input type="checkbox" id="calNext"${C.next ? ' checked' : ''}> then go to the next unmeasured anchor</label>`);
      }
      const run = st.target && (st.target.run || (cs[st.side] && cs[st.side].run));
      parts.push(`<div class="calrow">${btn(button('◀ Prev', '', () => call('/next', { back: true })))}${btn(button('Next ▶', '', () => call('/next', {})))}${run ? btn(button('Bands on run', '', () => target({ kind: 'bands', run }))) : ''}${st.target && st.target.kind !== 'bands' ? btn(button('Forget', 'quiet', () => call('/forget', {}))) : ''}</div>`);
      if (st.message && st.message !== 'calibrating ' + st.label) parts.push(`<div class="muted calmsg">${esc(st.message)}</div>`);
    }
    if (C.error) parts.push(`<div class="error">${esc(C.error)}${C.details.map((d) => `<div class="small">${esc(d)}</div>`).join('')}</div>`);

    // A tapped pixel: calibrate there.
    const g = S.geo;
    if (g && C.tapped >= 0 && C.tapped < S.n) {
      const p = C.tapped, px = g.pixels;
      const ctl = g.controllers[px.controller[p]], ri = px.run[p], run = ri >= 0 ? g.runs[ri] : null;
      const c = st.active && st.cursors ? st.cursors[st.side] : null;
      const tb = [];
      if (c && !c.fixed && c.controller === ctl.id && px.index[p] >= c.min && px.index[p] <= c.max) {
        tb.push(btn(button('Move cursor here', 'on', () => call('/set', { index: px.index[p] }))));
      }
      if (run) {
        const near = nearestAnchor(run, px.index[p]);
        if (near) tb.push(btn(button(`Calibrate ${esc(g.nodes[near.node].id)}`, '', () => target({ kind: 'anchor', run: run.id, node: g.nodes[near.node].id }))));
        const end = Math.abs(px.index[p] - run.first) <= Math.abs(px.index[p] - run.last) ? 'first' : 'last';
        tb.push(btn(button(`${end} end`, '', () => target({ kind: 'end', run: run.id, end }))));
        tb.push(btn(button('Bands', '', () => target({ kind: 'bands', run: run.id }))));
      }
      tb.push(btn(button('Mark dead', '', () => target({ kind: 'dead', controller: ctl.id, indices: [px.index[p]] }))));
      parts.push(`<div class="caltap"><div>Tapped <b>${esc(ctl.id)}:${px.index[p]}</b>${run ? ' on ' + esc(run.id) : ''}</div><div class="calrow">${tb.join('')}</div></div>`);
    }

    // Progress: anchors, links, gaps. Tap one to calibrate it.
    if (st.progress && st.progress.length) {
      const cur = st.target ? JSON.stringify(st.target) : '';
      parts.push(`<h3>Progress <small class="muted">${st.measured} of ${st.anchors} anchors measured</small></h3><ul class="calprog">${st.progress.map((it) => {
        const val = it.index != null ? it.index : it.length != null ? it.length.toFixed(2) + ' m' : '';
        const here = JSON.stringify(it.target) === cur ? ' here' : '';
        return `<li class="${it.done ? 'done' : ''}${here}" data-a="${act(button('', '', () => target(it.target)))}"><span>${it.done ? '✓' : '·'} ${esc(it.label)}</span><span class="muted">${val} ${esc(it.source)}</span></li>`;
      }).join('')}</ul>`);
    }

    // Other targets: run ends, bands over a controller, dead ranges.
    if (g) {
      const runs = g.runs.map((r) => `<option>${esc(r.id)}</option>`).join('');
      const ctls = g.controllers.map((c) => `<option>${esc(c.id)}</option>`).join('');
      parts.push(`<details class="calmore"><summary>More: run ends, bands, dead pixels</summary>
        <div class="calrow"><select id="calRun">${runs}</select>
          ${btn(button('First end', '', () => target({ kind: 'end', run: $('calRun').value, end: 'first' })))}
          ${btn(button('Last end', '', () => target({ kind: 'end', run: $('calRun').value, end: 'last' })))}
          ${btn(button('Bands', '', () => target({ kind: 'bands', run: $('calRun').value })))}</div>
        <div class="calrow"><select id="calCtl">${ctls}</select>
          ${btn(button('Bands on controller', '', () => target({ kind: 'bands', controller: $('calCtl').value })))}</div>
        <form class="calrow" data-form="dead"><input id="calDeadA" type="number" placeholder="first" size="5"><input id="calDeadB" type="number" placeholder="last" size="5">${btn(button('Dead pixels', '', null))}</form>
      </details>`);
    }

    const open = box.querySelector('details.calmore') && box.querySelector('details.calmore').open;
    box.innerHTML = parts.join('');
    if (open) box.querySelector('details.calmore').open = true;
    for (const b of box.querySelectorAll('[data-a]')) {
      const a = actions[+b.dataset.a];
      if (a.fn) b.onclick = (e) => { e.preventDefault(); a.fn(); };
    }
    const nx = $('calNext');
    if (nx) nx.onchange = () => { C.next = nx.checked; };
    for (const f of box.querySelectorAll('form[data-form]')) {
      f.onsubmit = (e) => {
        e.preventDefault();
        if (f.dataset.form === 'set' && $('calSet').value !== '') call('/set', { index: +$('calSet').value });
        if (f.dataset.form === 'gap') call('/confirm', { length: $('calLen').value });
        if (f.dataset.form === 'dead' && $('calDeadA').value !== '') {
          const a = +$('calDeadA').value, b = $('calDeadB').value === '' ? a : +$('calDeadB').value;
          target({ kind: 'dead', controller: $('calCtl').value, indices: [a, b] });
        }
      };
    }
  }

  function nearestAnchor(run, index) {
    let best = null;
    for (const a of run.anchors) {
      if (a.source === 'end') continue;
      if (!best || Math.abs(a.index - index) < Math.abs(best.index - index)) best = a;
    }
    return best;
  }

  document.addEventListener('glowstack:tap', (e) => { C.tapped = e.detail; if (C.st) render(); });
  $('calToggle').onclick = () => {
    document.body.classList.remove('nopanel');
    resize(); markDirty();
    $('calSec').scrollIntoView({ behavior: 'smooth' });
  };

  async function poll() {
    if (document.body.classList.contains('nopanel') && C.st && !C.st.active) return;
    const f = document.activeElement;
    if (f && box.contains(f) && (f.tagName === 'INPUT' || f.tagName === 'SELECT')) return; // don't wipe what's being typed
    const was = C.st && C.st.active;
    await call('');
    // A session already running (say, from the phone before a reload):
    // open the panel on it.
    if (!was && C.st && C.st.active && document.body.classList.contains('nopanel')) {
      document.body.classList.remove('nopanel');
      resize(); markDirty();
    }
  }
  poll();
  setInterval(poll, 1500);
})();
