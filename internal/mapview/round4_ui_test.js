// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for series 2 round 4 of the UI review: its bugs (B144 to B146), the
// map as a control, refined (C2), calibration that leads and guides (F) and
// the refinements. Run with: node --test internal/mapview/round4_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (f) => fs.readFileSync(path.join(__dirname, 'static', f), 'utf8');
const css = read('ui.css');
const design = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'design.md'), 'utf8');

// fakeDoc answers querySelectorAll from a table of selector to elements, each
// { rect: [left, top, right, bottom], hidden }.
const fakeDoc = (table) => ({
  querySelectorAll: (sel) => (table[sel] || []).map((e) => ({
    hidden: !!e.hidden,
    getBoundingClientRect: () => ({ left: e.rect[0], top: e.rect[1], right: e.rect[2], bottom: e.rect[3], width: e.rect[2] - e.rect[0], height: e.rect[3] - e.rect[1] }),
  })),
});
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

test('B144: the label placer treats the chrome over the map as occupied', async () => {
  const { occupiedRects, placeLabels, CHROME, CHROME_GAP } = await import('./static/overlay.js');
  // The chip, the toggle, the hint, the breadcrumb, the key, the card and the calibration panel.
  for (const sel of ['#chips > *', '#mapControls', '#mapHint', '#crumbs > *', '#legend', '#calibrate']) assert.ok(CHROME.includes(sel), sel);
  // A phone: brand and chip at the left, the toggle at the right, the hint under them, the key above the sheet.
  const chrome = {
    '#chips > *': [{ rect: [8, 8, 52, 52] }, { rect: [58, 8, 186, 52] }],
    '#mapControls': [{ rect: [242, 8, 382, 52] }],
    '#mapHint': [{ rect: [10, 58, 380, 76] }],
    '#crumbs > *': [{ rect: [8, 58, 120, 102], hidden: true }],
    '#legend': [{ rect: [8, 230, 120, 290] }],
    '#inspectCard': [{ rect: [0, 0, 0, 0] }], // display: none measures as nothing
  };
  const stage = { left: 0, top: 0, width: 390, height: 844 };
  const rects = occupiedRects(fakeDoc(chrome), stage, { sheetTop: 304 });
  assert.equal(rects.length, 6, 'five visible elements and the sheet; hidden and undrawn ones are not occupied');
  assert.deepEqual(rects[1], { x0: 58 - CHROME_GAP, x1: 186 + CHROME_GAP, y0: 8 - CHROME_GAP, y1: 52 + CHROME_GAP }, 'the chip itself, not the bar that holds it');
  assert.deepEqual(rects[5], { x0: 0, x1: 390, y0: 304 - CHROME_GAP, y1: 844 }, 'the sheet where it will rest');
  // Labels asked for on top of each of them are moved clear or hidden, and the hidden ones are counted.
  const measure = (l) => l.text.length * 6;
  const asked = [[70, 40], [250, 44], [40, 72], [200, 70], [20, 260], [100, 330], [300, 150], [150, 180]].map(([x, y], i) => ({ text: `Run ${i}`, x, y, color: '#fff', rank: 1, budget: false }));
  const placed = placeLabels(asked, { avoid: rects, width: 390, height: 844, measure });
  assert.ok(placed.length >= 2, 'the labels with room are still drawn');
  for (const p of placed) for (const r of rects) assert.ok(!overlap(p, r), `"${p.text}" at ${p.x0},${p.y0} touches chrome at ${r.x0},${r.y0}`);
  // One of the eight is under the sheet: off the visible map, so not counted.
  assert.equal(placed.length + placed.hidden, asked.length - 1, 'every label on the visible map is either placed or counted as hidden');
  // The desktop: the calibration panel is beside the stage, the key and the toggle are at the bottom left.
  const desk = occupiedRects(fakeDoc({ '#chips > *': [{ rect: [8, 8, 130, 36] }, { rect: [138, 8, 400, 36] }], '#legend': [{ rect: [8, 714, 268, 854] }], '#mapControls': [{ rect: [8, 862, 140, 892] }], '#calibrate': [{ rect: [940, 0, 1440, 900] }] }), { left: 0, top: 0, width: 940, height: 900 });
  const wide = placeLabels([{ text: 'Under the chip', x: 150, y: 30, color: '#fff', rank: 1 }, { text: 'On the key', x: 40, y: 760, color: '#fff', rank: 1 }, { text: 'Free', x: 500, y: 400, color: '#fff', rank: 1 }], { avoid: desk, width: 940, height: 900, measure });
  for (const p of wide) for (const r of desk) assert.ok(!overlap(p, r), `"${p.text}" touches chrome`);
  assert.ok(wide.some((p) => p.text === 'Free'));
  // app.js hands the placer those rectangles, and the key still says how many are hidden.
  assert.match(read('app.js'), /S\.labelAvoid = \(\) => occupiedRects\(document, /);
  assert.match(read('panel/setup.js'), /plural\(n, 'label'\)\} hidden: no room\./);
});
