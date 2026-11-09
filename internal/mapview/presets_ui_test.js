// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
test('new preset IDs are readable, valid and avoid existing IDs', async () => {
 const { presetSlug } = await import('./static/panel/presets.js');
 assert.equal(presetSlug(' Café lights! ', []), 'cafe-lights');
 assert.equal(presetSlug('Night', [{id:'night'},{id:'night-2'}]), 'night-3');
 assert.equal(presetSlug('✨', []), 'preset');
});
