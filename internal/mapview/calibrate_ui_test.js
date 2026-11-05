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
    geo: { pixels: { count: 20 }, mappings: [], zones: [],
      controllers: [{ id: 'shed', base: 0 }],
      nodes: [{ id: 'corner', plan: 0, x: 3, y: 4, z: 2 }] },
    plan: 0, hover: -1, pinned: -1,
    cal: { active: true, side: 0, target: { kind: 'anchor' }, cursors: [cursor] },
    view: { toScreen: (x, y, z) => [x * 10, (y + z) * 10] },
  };
  const rings = [], labels = [];
  const ctx = { beginPath() {}, arc(x, y) { rings.push([x, y]); }, stroke() {},
    strokeText() {}, fillText(t) { labels.push(t); } };
  const overlay = createOverlay(S);
  overlay.draw(ctx);
  cursor.index = 15;
  overlay.draw(ctx);
  assert.deepEqual(rings, [[30, 60], [30, 60]]);
  assert.deepEqual(labels, ['corner', 'corner']);
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
