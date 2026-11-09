// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for the calibration session logic in static/panel/calibrate.js,
// against a controlled server. Run with:
// node --test internal/mapview/calibrate_ui_test.js
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const load = () => import(pathToFileURL(path.join(__dirname, 'static/panel/calibrate.js')).href);

function storage(saved = new Map()) {
  return { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
}

function state() {
  return {
    active: true, label: 'anchor corner on eave', side: 0,
    target: { kind: 'anchor', run: 'eave', node: 'corner' },
    cursors: [{ controller: 'shed', index: 5, estimate: 5, min: 0, max: 20, source: 'estimated' }],
    progress: [],
  };
}

const reply = (st) => ({ ok: true, text: async () => JSON.stringify(st) });

test('confirm waits for an earlier nudge to finish', async () => {
  const { createSession } = await load();
  const st = state();
  let releaseNudge, confirmedIndex;
  const s = createSession({
    storage: storage(),
    onState() {},
    fetch: async (url, opts) => {
      if (url.endsWith('/nudge')) {
        await new Promise((resolve) => { releaseNudge = resolve; });
        st.cursors[0].index += JSON.parse(opts.body).by;
      }
      if (url.endsWith('/confirm')) confirmedIndex = st.cursors[0].index;
      return reply(st);
    },
  });
  s.nudge(1);
  await flush();
  s.confirm();
  await flush();
  const confirmedBeforeNudge = confirmedIndex !== undefined;
  releaseNudge();
  await flush();
  await flush();
  assert.equal(confirmedBeforeNudge, false, 'confirm overtook the pending nudge');
  assert.equal(confirmedIndex, 6);
});

test('a poll overtaken by an action is dropped', async () => {
  const { createSession } = await load();
  const st = state();
  let releasePoll;
  const shown = [];
  const s = createSession({
    storage: storage(),
    onState: (C) => shown.push(C.st.cursors[0].index),
    fetch: async (url, opts) => {
      if (!opts.method) {
        const old = JSON.stringify(st);
        await new Promise((resolve) => { releasePoll = resolve; });
        return { ok: true, text: async () => old };
      }
      st.cursors[0].index += JSON.parse(opts.body).by;
      return reply(st);
    },
  });
  s.poll();
  await flush();
  await s.nudge(10);
  releasePoll();
  await flush();
  assert.deepEqual(shown, [15], 'the stale poll was drawn over the nudge');
});

test('confirm-and-next preference survives the reload caused by confirming', async () => {
  const { createSession } = await load();
  const saved = new Map();
  let confirmed;
  const fetch = async (url, opts) => {
    if (url.endsWith('/confirm')) confirmed = JSON.parse(opts.body);
    return reply(state());
  };
  const first = createSession({ fetch, storage: storage(saved), onState() {} });
  first.setNext(false);
  await first.confirm();
  assert.deepEqual(confirmed, { next: false });
  const reloaded = createSession({ fetch, storage: storage(saved), onState() {} });
  assert.equal(reloaded.C.next, false);
});


test('calibration target ring stays on the model node while the pixel is nudged', async () => {
  const { createOverlay } = await import(pathToFileURL(path.join(__dirname, 'static/overlay.js')).href);
  const cursor = { node: 'corner', controller: 'shed', index: 5, estimate: 5 };
  const S = {
    geo: { pixels: { count: 20 }, mappings: [], zones: [], edges: [], runs: [],
      controllers: [{ id: 'shed', base: 0 }],
      nodes: [{ id: 'corner', plan: 0, x: 3, y: 4, z: 2 }] },
    plan: 0, hover: -1, pinned: -1, calibrating: true,
    cal: { active: true, side: 0, target: { kind: 'anchor' }, cursors: [cursor] },
    view: { toScreen: (x, y, z) => [x * 10, (y + z) * 10] },
  };
  const rings = [], labels = [];
  const ctx = { beginPath() {}, arc(x, y, r) { if (r === 14) rings.push([x, y]); }, stroke() {}, fill() {}, setLineDash() {},
    fillRect() {}, strokeRect() {}, strokeText() {}, fillText(t) { labels.push(t); } };
  const overlay = createOverlay(S);
  overlay.draw(ctx);
  cursor.index = 15;
  overlay.draw(ctx);
  assert.deepEqual(rings, [[30, 60], [30, 60]]);
  assert.deepEqual(labels, ['Corner', 'Corner']);
});


test('target pattern stays fixed while nudges change the real cursor index', async () => {
  const { referenceColors } = await load();
  const g = { pixels: { count: 30 }, controllers: [{ id: 'shed', base: 5 }] };
  const cal = state();
  const first = referenceColors(g, cal);
  assert.deepEqual([...first.slice(30, 33)], [255, 255, 255]);
  cal.cursors[0].index += 10;
  assert.deepEqual(referenceColors(g, cal), first);
  cal.cursors[0].estimate = 10;
  assert.notDeepEqual(referenceColors(g, cal), first, 'next target must update reference');
  cal.active = false;
  assert.equal(referenceColors(g, cal), null);
  cal.active = true; cal.target.kind = 'bands';
  assert.equal(referenceColors(g, cal), null, 'bands retain the live display');
});


test('reversed runs keep reference ruler colors in physical run order', async () => {
  const { referenceColors } = await load();
  const g = { pixels: { count: 25 }, controllers: [{ id: 'shed', base: 0 }],
    runs: [{ id: 'eave', first: 20, last: 0 }] };
  const cal = state();
  Object.assign(cal.cursors[0], { run: 'eave', estimate: 10, index: 11 });
  const colors = referenceColors(g, cal);
  assert.deepEqual([...colors.slice(0, 3)], [0, 255, 0]);
  assert.deepEqual([...colors.slice(60, 63)], [255, 0, 0]);
  cal.cursors[0].index = 9;
  assert.deepEqual(referenceColors(g, cal), colors);
});


test('controller markers: config boards lead to their output inputs, others are gray', async () => {
  const { createOverlay } = await import(pathToFileURL(path.join(__dirname, 'static/overlay.js')).href);
  const g = { pixels: { count: 20, plan: Array(20).fill(0), x: Array.from({length:20}, (_,i)=>i), y:Array(20).fill(0), z:Array(20).fill(0) },
    mappings: [], zones: [], controllers: [{ id: 'shed', base: 5, outputs: [
      { output: 1, start: 0, count: 4 }, { output: 2, start: 4, count: 6, reversed: true } ] }],
    controller_locations: [
      { id: 'shed', controller: 0, plan: 0, x: 2, y: 7, z: 0 },
      { id: 'spare', controller: -1, plan: 0, x: 30, y: 7, z: 0 },
      { id: 'other-plan', controller: -1, plan: 1, x: 40, y: 7, z: 0 }] };
  const S = { geo:g, plan:0, hover:-1, pinned:-1, view:{toScreen:(x,y)=>[x,y]} };
  const overlay = createOverlay(S);
  const draw = () => {
    const out = { rects: [], lines: [], fills: [] };
    let from = null, fill = '';
    overlay.draw({ fillRect(){}, beginPath(){}, arc(){}, stroke(){}, strokeText(){}, fillText(){}, setLineDash(){},
      set fillStyle(v) { fill = v; }, get fillStyle() { return fill; },
      rect(x,y){ out.rects.push([x+6,y+6]); out.fills.push(fill); }, fill(){},
      moveTo(x,y){ from=[x,y]; }, lineTo(x,y){ out.lines.push([from,[x,y]]); } });
    return out;
  };
  assert.equal(overlay.st.controllers, false);
  assert.deepEqual(draw().rects, []);
  overlay.st.controllers = true;
  let d = draw();
  assert.deepEqual(d.rects, [[2,7],[30,7]]);
  assert.notEqual(d.fills[0], d.fills[1]);
  assert.deepEqual(d.lines, []);
  overlay.st.mode = 'outputs';
  d = draw();
  assert.deepEqual(d.lines, [[[2,7],[5,0]], [[2,7],[14,0]]]);
  overlay.st.controllers = false;
  assert.deepEqual(draw().rects, []);
});

test('output input marker honors WLED reversal without changing output ranges', async () => {
  const { createOverlay } = await import(pathToFileURL(path.join(__dirname, 'static/overlay.js')).href);
  const g = { pixels: { count: 20, plan: Array(20).fill(0), x: Array.from({length:20}, (_,i)=>i), y:Array(20).fill(0), z:Array(20).fill(0) },
    mappings: [], zones: [], controllers: [{ id: 'shed', base: 5, outputs: [
      { output: 1, start: 0, count: 4 }, { output: 2, start: 4, count: 6, reversed: true } ] }] };
  const rings = [];
  const S = { geo:g, plan:0, hover:-1, pinned:-1, view:{toScreen:(x,y)=>[x,y]} };
  const overlay = createOverlay(S); overlay.st.mode = 'outputs';
  overlay.draw({ fillRect(){}, beginPath(){}, arc(x,y){rings.push([x,y]);}, fill(){}, stroke(){}, strokeText(){}, fillText(){} });
  assert.deepEqual(rings, [[5,0],[14,0]]);
  assert.deepEqual(overlay.outputs().map(o=>[o.first,o.last]), [[5,8],[9,14]]);
  assert.equal(overlay.outputOf(9).output, 2);
});


test('shared sync nodes show distinct run locations and a dotted connector', async () => {
  const { createOverlay, nodeLocations } = await import(pathToFileURL(path.join(__dirname, 'static/overlay.js')).href);
  const g = { pixels:{count:0}, controllers:[], mappings:[], zones:[], edges:[], runs:[],
    nodes:[{id:'junction',sync:true,plan:0,x:1,y:2,z:3,locations:[
      {run:'eave',plan:0,x:1,y:2,z:3}, {run:'rail',plan:0,x:1,y:2,z:1},
      {run:'return',plan:0,x:1,y:2,z:1}, {run:'other-plan',plan:1,x:1,y:2,z:5}]}] };
  assert.equal(nodeLocations(g,0,0).length,2);
  assert.deepEqual(nodeLocations(g,0,0)[1].runs,['rail','return']);
  const lines=[],labels=[]; let dash=[],from;
  const ctx={fillRect(){},beginPath(){},moveTo(x,y){from=[x,y];},lineTo(x,y){if(dash.length) lines.push([from,[x,y],dash]);},
    setLineDash(v){dash=v;},stroke(){},closePath(){},fill(){},strokeText(){},fillText(t){labels.push(t);} };
  const S={geo:g,plan:0,hover:-1,pinned:-1,view:{toScreen:(x,y,z)=>[x,y+z]}};
  const overlay=createOverlay(S);overlay.st.nodes=true;overlay.st.labels=true;overlay.draw(ctx);
  assert.deepEqual(lines,[[[1,5],[1,3],[2,4]]]);
  assert.deepEqual(labels,['Junction · Eave','Junction · Rail / Return']);
});


test('run visibility defaults to operating strips and restores all runs', async () => {
  const { runVisibility } = await import(pathToFileURL(path.join(__dirname, 'static/run-visibility.js')).href);
  const g = { runs:[{status:'working',path:[0,1]},{status:'inop',path:[1,2]},
    {status:'replace',path:[3,4]},{path:[5,6]}], pixels:{count:5,run:[0,1,2,3,-1]} };
  const filtered = runVisibility(g);
  assert.deepEqual(filtered.runs,[true,false,false,true]);
  assert.deepEqual([...filtered.pixels],[1,0,0,1,0]);
  assert.deepEqual([...filtered.nodes],[0,1,5,6]);
  const all = runVisibility(g,true);
  assert.ok(all.runs.every(Boolean));
  assert.deepEqual([...all.pixels],[1,1,1,1,1]);
  assert.deepEqual(runVisibility(g),filtered, 'toggle is reversible without changing geometry');
});


// mountCalibrate runs the mode's screen against a stub page and server.
function mountCalibrate(serverState, overlayStub) {
  const stub = () => ({ hidden: true, disabled: false, checked: false, textContent: '', innerHTML: '', scrollTop: 0, open: false, querySelector: () => null, querySelectorAll: () => [], classList: { toggle() {} }, style: {}, addEventListener() {} });
  const els = new Map();
  const root = { hidden: true, innerHTML: '', style: { removeProperty() {} }, querySelector: (s) => { if (!els.has(s)) els.set(s, stub()); return els.get(s); }, querySelectorAll: () => [], contains: () => false };
  const saved = new Map();
  Object.assign(globalThis, {
    document: { body: { classList: { toggle() {} } }, addEventListener() {}, activeElement: null, hidden: false },
    sessionStorage: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) },
    setInterval: () => 0,
    fetch: async (url, opts) => {
      if (url.endsWith('/end')) serverState.active = false;
      if (url.endsWith('/start')) serverState.active = true;
      return reply(serverState);
    },
  });
  const handlers = {}, toasts = [];
  const S = { geo: { runs: [], controllers: [], nodes: [], pixels: { count: 0 } }, pinned: -1, overlay: overlayStub || { st: {}, apply() {} },
    view: { hold: () => ({}), release() {}, setColors() {} },
    resize() {}, inspect() {}, markDirty() {}, refreshBadge() {}, refreshLegend() {}, toast: (m) => toasts.push(m),
    on: (t, fn) => { (handlers[t] ||= []).push(fn); }, emit: (t, d) => (handlers[t] || []).forEach((fn) => fn(d)) };
  return { S, root, els, saved, toasts };
}

test('changing route leaves calibration and it does not reopen by itself', async () => {
  const { createCalibrate } = await load();
  const st = { ...state(), measured: 0, anchors: 1 };
  const { S, root, toasts } = mountCalibrate(st);
  const cal = createCalibrate(S, root);
  await flush();
  assert.equal(S.calibrating, true, 'a running session opens the mode');
  S.emit('tab', 'looks');
  assert.equal(S.calibrating, false);
  assert.match(toasts[0], /still running/);
  await cal.session.poll();
  st.label = 'changed';
  await cal.session.poll();
  await flush();
  assert.equal(S.calibrating, false, 'a poll reopened the mode after leaving it');
  cal.open();
  assert.equal(S.calibrating, true, 'Resume reopens it');
});

test('leaving a running session survives a reload without reopening', async () => {
  const { createCalibrate } = await load();
  const st = { ...state(), measured: 0, anchors: 1 };
  const first = mountCalibrate(st);
  createCalibrate(first.S, first.root);
  await flush();
  first.S.emit('tab', 'presets');
  const saved = first.saved;
  const again = mountCalibrate(st);
  for (const [k, v] of saved) globalThis.sessionStorage.setItem(k, v);
  createCalibrate(again.S, again.root);
  await flush();
  assert.equal(again.S.calibrating, undefined);
});

test('Stop ends the session and leaves the mode', async () => {
  const { createCalibrate } = await load();
  const st = { ...state(), measured: 0, anchors: 1 };
  const { S, root, els } = mountCalibrate(st);
  createCalibrate(S, root);
  await flush();
  await els.get('#caStop').onclick();
  assert.equal(st.active, false);
  assert.equal(S.calibrating, false);
});

test('calibration shows the anchors without changing or saving the overlay settings', async () => {
  const { createOverlay } = await import(pathToFileURL(path.join(__dirname, 'static/overlay.js')).href);
  const written = [];
  globalThis.localStorage = { getItem: () => null, setItem: (k, v) => written.push(v), removeItem() {} };
  const g = { pixels: { count: 1, plan: [0], x: [0], y: [0], z: [0] }, controllers: [], nodes: [{ id: 'n', plan: 0, x: 1, y: 1, z: 0 }], edges: [], runs: [], mappings: [], zones: [] };
  const S = { geo: g, plan: 0, hover: -1, pinned: -1, view: { toScreen: (x, y) => [x, y], setColors() {} } };
  const overlay = createOverlay(S);
  overlay.st.mode = 'flow';
  overlay.remember();
  const before = { ...overlay.st };
  const seen = [];
  const ctx = { beginPath() {}, arc(x, y) { seen.push([x, y]); }, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, setLineDash() {} };
  overlay.draw(ctx);
  assert.equal(seen.length, 0, 'nodes are hidden outside the mode');
  S.calibrating = true;
  assert.equal(overlay.live(), true, 'the mode shows live colors');
  overlay.draw(ctx);
  assert.equal(seen.length, 1, 'the mode shows the nodes');
  overlay.remember();
  assert.deepEqual(overlay.st, before);
  assert.equal(JSON.parse(written[written.length - 1]).nodes, false, 'the mode saved its overlay');
  S.calibrating = false;
  seen.length = 0;
  overlay.draw(ctx);
  assert.equal(seen.length, 0, 'nodes left behind after the mode');
});

test('the calibration cursor ring is only drawn inside the mode', async () => {
  const { createOverlay } = await import(pathToFileURL(path.join(__dirname, 'static/overlay.js')).href);
  const S = { geo: { pixels: { count: 20 }, mappings: [], zones: [], controllers: [{ id: 'shed', base: 0 }], nodes: [{ id: 'corner', plan: 0, x: 3, y: 4, z: 2 }] }, plan: 0, hover: -1, pinned: -1,
    cal: { active: true, side: 0, target: { kind: 'anchor' }, cursors: [{ node: 'corner', controller: 'shed', index: 5, estimate: 5 }] },
    view: { toScreen: (x, y, z) => [x, y + z] } };
  const rings = [];
  createOverlay(S).draw({ fillRect() {}, beginPath() {}, arc(x, y) { rings.push([x, y]); }, fill() {}, stroke() {}, strokeText() {}, fillText() {} });
  assert.deepEqual(rings, []);
});

test('a failed first load is a failure with Retry, not a spinner beside an error', async () => {
  const { loadState } = await load();
  assert.equal(loadState({ st: null, error: '' }).kind, 'loading');
  const failed = loadState({ st: null, error: "Glowstack isn't responding." });
  assert.equal(failed.kind, 'error');
  assert.equal(failed.retry, true);
  assert.equal(loadState({ st: state(), error: 'x' }), null);
});

test('an error from a poll clears when polling recovers', async () => {
  const { createSession } = await load();
  const st = state();
  let fail = false;
  const s = createSession({
    storage: storage(), onState() {},
    fetch: async () => (fail ? { ok: false, statusText: 'Bad Gateway', text: async () => 'upstream down' } : reply(st)),
  });
  await s.poll();
  fail = true;
  await s.poll();
  assert.match(s.C.error, /^Could not read the calibration state\./);
  fail = false;
  await s.poll();
  assert.equal(s.C.error, '', 'the same state as before must still clear the error');
});

test('the screen counts one thing: steps, the same as "Step n of m"', async () => {
  const { calCount } = await load();
  const anchor = (done) => ({ done, target: { kind: 'anchor' } });
  const c = calCount({ measured: 1, anchors: 2, progress: [anchor(true), anchor(false), { done: true, target: { kind: 'gap' } }] });
  assert.equal(c.text, '2 of 3 steps done');
  assert.equal(c.title, '1 of 2 points measured, plus 1 join between runs');
  assert.equal(calCount({ measured: 0, anchors: 1, progress: [anchor(false)] }).title, '0 of 1 point measured');
  assert.equal(calCount({ progress: [] }), null);
});
