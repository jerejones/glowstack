// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for failure states and the library load. Run with:
// node --test internal/mapview/library_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const util = () => import('./static/util.js');
const states = () => import('./static/states.js');
const library = () => import('./static/library.js');

test('startup failure names what failed in plain words, with Retry and no stack', async () => {
  const { bootFailure, stateHTML } = await states();
  const e = new Error('boom'); e.stack = 'Error: boom\n    at api (util.js:32:17)';
  const f = bootFailure('load the map', e);
  assert.equal(f.title, 'Glowstack could not load the map');
  const html = stateHTML({ ...f, retry: true });
  assert.doesNotMatch(html, /util\.js|boom|at api/);
  assert.match(html, /data-retry/);
  const net = Object.assign(new Error('x'), { network: true });
  assert.match(bootFailure('load the map', net).detail, /isn't responding/);
});

test('a failed load is told apart from an empty library, and Retry recovers', async () => {
  const { createLibrary } = await library();
  let down = true;
  const reply = { '/api/v1/effects': { common: [], effects: [] }, '/api/v1/presets': { presets: [] }, '/api/v1/palettes': { palettes: [] } };
  const S = {};
  const load = createLibrary(S, async (path) => { if (down) throw new Error('offline'); return reply[path]; });
  await load();
  assert.deepEqual(S.library, { catalog: 'failed', presets: 'failed', palettes: 'failed' });
  assert.deepEqual(S.presets, []);
  down = false;
  await load();
  assert.deepEqual(S.library, { catalog: 'ready', presets: 'ready', palettes: 'ready' });
  assert.deepEqual(S.presets, [], 'really empty is ready and empty');
});

test('a load that fails after one succeeded keeps what it had', async () => {
  const { createLibrary } = await library();
  let down = false;
  const S = {};
  const load = createLibrary(S, async (path) => {
    if (down) throw new Error('offline');
    return { '/api/v1/effects': { effects: [] }, '/api/v1/presets': { presets: [{ id: 'sample' }] }, '/api/v1/palettes': { palettes: [] } }[path];
  });
  await load();
  down = true;
  await load();
  assert.equal(S.library.presets, 'ready');
  assert.equal(S.presets[0].id, 'sample');
});

test('a malformed reply counts as a failed load', async () => {
  const { createLibrary } = await library();
  const S = {};
  await createLibrary(S, async () => ({}))();
  assert.equal(S.library.presets, 'failed');
});

test('network failures name the action; server messages are kept', async () => {
  const { api, failure } = await util();
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const e = await api('/x').catch((x) => x);
    assert.equal(e.network, true);
    assert.equal(failure('apply the look', e), "Could not apply the look. Glowstack isn't responding.");
    globalThis.fetch = async () => ({ ok: false, status: 400, statusText: 'Bad', text: async () => '{"error":"no such area"}' });
    const s = await api('/x').catch((x) => x);
    assert.equal(failure('apply the look', s), 'no such area');
    globalThis.fetch = async () => { throw new DOMException('gone', 'AbortError'); };
    await assert.rejects(api('/x'), { name: 'AbortError' });
  } finally { globalThis.fetch = real; }
});

test('calibration names the action when the network fails', async () => {
  const { createSession } = await import('./static/panel/calibrate.js');
  const s = createSession({ fetch: async () => { throw new TypeError('Failed to fetch'); }, storage: { getItem: () => null, setItem() {} }, onState() {} });
  await s.confirm();
  assert.equal(s.C.error, "Could not save the measurement. Glowstack isn't responding.");
});
