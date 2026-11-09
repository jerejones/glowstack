// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for the page's chrome: the map status, styles and sheet. Run with:
// node --test internal/mapview/chrome_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const css = fs.readFileSync(path.join(__dirname, 'static/ui.css'), 'utf8');

test('map status never disagrees with its toggle', async () => {
  const { mapStatus } = await import('./static/map-status.js');
  const live = { connected: true, target: false };
  const none = mapStatus({ ...live, show: '', preview: { previewing: false } });
  assert.equal(none.showing, 'lights', 'Preview must not be pressed with nothing previewing');
  assert.equal(none.canPreview, false);
  assert.equal(none.text + none.detail, 'Showing the lights · nothing in preview');
  const on = mapStatus({ ...live, show: '', preview: { previewing: true } });
  assert.equal(on.showing, 'preview');
  assert.equal(on.text, 'Showing your preview');
  const hidden = mapStatus({ ...live, show: 'house', preview: { previewing: true } });
  assert.equal(hidden.showing, 'lights');
  assert.equal(hidden.detail, ' · preview hidden');
  assert.equal(mapStatus({ ...live, show: '', preview: null }).showing, 'lights');
  assert.equal(mapStatus({ connected: false, show: '', preview: null }).cls, 'off');
});

test('.err is styled wherever it appears', () => {
  assert.match(css, /(^|\n|, )\.err[ ,][^{]*\{[^}]*color:/);
  assert.doesNotMatch(css, /\.form \.err/);
});

test('search shares the input rule and placeholders are readable', () => {
  assert.match(css, /input\[type=search\],[^{]*\{[^}]*background/);
  assert.match(css, /::placeholder \{ color: var\(--muted\); opacity: 1; \}/);
});

test('counts are pluralized', async () => {
  const { plural } = await import('./static/util.js');
  assert.equal(plural(1, 'output'), '1 output');
  assert.equal(plural(2, 'output'), '2 outputs');
  assert.equal(plural(0, 'output'), '0 outputs');
  for (const f of ['panel/status.js', 'panel/setup.js', 'panel/calibrate.js']) {
    const src = fs.readFileSync(path.join(__dirname, 'static', f), 'utf8');
    assert.doesNotMatch(src, /\.length\} outputs|\$\{g\.runs\.length\} runs|\$\{st\.anchors\} anchors/, f);
  }
});

test('dragging the sheet cannot select text', async () => {
  const { guardSelection } = await import('./static/sheet.js');
  let handler, dragging = false, prevented = 0;
  guardSelection({ addEventListener: (type, fn) => { assert.equal(type, 'selectstart'); handler = fn; } }, () => dragging);
  handler({ preventDefault: () => prevented++ });
  assert.equal(prevented, 0, 'selection works normally away from a drag');
  dragging = true;
  handler({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.match(css, /\.handle, \.tabs \{ user-select: none/);
});
