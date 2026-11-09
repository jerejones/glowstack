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
