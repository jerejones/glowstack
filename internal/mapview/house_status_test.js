// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const load = () => import('./static/house-status.js');

test('empty is reported only after a successful read; failure and recovery notify the UI', async () => {
  const { createHousePoll, houseStatusMessage } = await load();
  let reply, fail = true, events = 0;
  const S = { house: [], houseStatus: 'loading', emit() { events++; } };
  const poll = createHousePoll(S, async () => { if (fail) throw Error('offline'); return reply; });
  assert.equal(houseStatusMessage(S.houseStatus, 0), 'Loading light status…');
  await poll();
  assert.equal(houseStatusMessage(S.houseStatus, 0), 'Light status unavailable.');
  fail = false; reply = { layers: [] };
  await poll();
  assert.equal(houseStatusMessage(S.houseStatus, 0), 'Nothing on the lights.');
  reply = { layers: [{ id: 'sample', preset: 'evening' }] };
  await poll();
  fail = true;
  await poll();
  assert.equal(S.house.length, 1);
  assert.match(houseStatusMessage(S.houseStatus, 1), /last known/);
  fail = false;
  await poll();
  assert.equal(houseStatusMessage(S.houseStatus, 1), '');
  assert.equal(events, 5);
  reply = null;
  await poll();
  assert.equal(S.houseStatus, 'unavailable');
  assert.equal(S.house.length, 1);
});

test('an older response cannot overwrite a newer refresh', async () => {
  const { createHousePoll } = await load();
  const pending = [];
  const S = { house: [], houseStatus: 'loading', emit() {} };
  const poll = createHousePoll(S, () => new Promise(resolve => pending.push(resolve)));
  const older = poll(), newer = poll();
  pending[1]({ layers: [{ id: 'current' }] });
  await newer;
  pending[0]({ layers: [] });
  await older;
  assert.equal(S.house[0].id, 'current');
});

test('I70: zones at 0% draw dim in the preview, once per frame', async () => {
  const { zeroRanges, dimSent, PREVIEW_DIM } = await import('./static/house-status.js');
  const geo = { areas: [{ id: 'a', ranges: [[0, 1]] }, { id: 'b', ranges: [[2, 3]] }], zones: [{ id: 'one', area: 'a' }, { id: 'two', area: 'b' }] };
  assert.deepEqual(zeroRanges(geo, { zones: { one: 0, two: 1 } }), [[0, 1]]);
  assert.deepEqual(zeroRanges(geo, null), []);
  const rgb = new Uint8Array([200, 100, 0, 200, 100, 0, 200, 100, 0, 200, 100, 0]);
  dimSent(rgb, [[1, 3]], [[0, 1]]); // pixel 0 wasn't in this frame: untouched, or it would keep darkening
  assert.deepEqual([...rgb.slice(0, 3)], [200, 100, 0]);
  assert.deepEqual([...rgb.slice(3, 6)], [Math.trunc(200 * PREVIEW_DIM), Math.trunc(100 * PREVIEW_DIM), 0], 'same hue, about 35%');
  assert.deepEqual([...rgb.slice(6, 9)], [200, 100, 0], 'a lit zone stays full');
  const { mapStatus } = await import('./static/map-status.js');
  const m = (dimZones) => mapStatus({ connected: true, show: '', preview: { previewing: true }, dimZones });
  assert.equal(m(4).text + m(4).detail, 'Showing your preview · 4 zones at 0% shown dim');
  assert.equal(m(1).detail, ' · 1 zone at 0% shown dim');
  assert.equal(m(0).detail, '');
});
