// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for series 2 round 3 of the UI review: its bugs (B141 to B143), the
// swatch (B3), the map as a control (C), undo after apply (E) and the
// refinements. Run with: node --test internal/mapview/round3_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (f) => fs.readFileSync(path.join(__dirname, 'static', f), 'utf8');
const css = read('ui.css');
const design = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'design.md'), 'utf8');

test('B141: the camera fits the free rectangle, its width as well as its height', async () => {
  const { fitDepth, framePad, frameInsets } = await import('./static/map-frame.js');
  // A phone keeps 12 px clear at the sides and 8 px above and below (6 of
  // those are frameInsets'), with a pixel to spare; wider layouts keep theirs.
  assert.deepEqual(framePad('sheet'), { side: 13, edge: 3 });
  assert.deepEqual(framePad('wide'), { side: 0, edge: 0 });
  const ins = frameInsets({ height: 844, chips: 54, crumbs: null, controls: 54, layout: 'sheet', covered: 540, calibrating: false, calTop: 0, floats: 0 });
  assert.ok(ins.top - 54 + framePad('sheet').edge >= 8 && ins.bottom - 540 + framePad('sheet').edge >= 8);
  // A 390 px band 250 px tall: k px per unit of tangent. A point 10 m off
  // center with a 3 cm pitch, at the depth fitDepth gives, draws its dot's
  // edge inside the pad.
  const k = 250 / (2 * Math.tan(20 * Math.PI / 180)), half = 195, pad = 13;
  for (const [off, dl] of [[10, 0.03], [-10, 0.03], [3, 0.5], [0.2, 0.001], [25, 0]]) {
    const depth = fitDepth(off, dl, k, half, pad);
    const center = Math.abs(off) * k / depth, radius = Math.max(1.5, Math.min(10.5, 1.35 * dl * k / depth / 2));
    assert.ok(center + radius <= half - pad + 1e-6, `${off} m, pitch ${dl}: ${center + radius} px of ${half - pad}`);
  }
  // More pad is more depth: the house draws smaller, the sheet keeps its height.
  assert.ok(fitDepth(10, 0.03, k, half, 13) > fitDepth(10, 0.03, k, half, 0));
  // scene.js applies it on both axes of every fit, and app.js passes the pad.
  const scene = read('scene.js');
  assert.match(scene, /fitDepth\(x, pitch, k, W \/ 2, padSide\) - z, fitDepth\(y, pitch, k, hf \/ 2, padEdge\) - z/);
  assert.match(read('app.js'), /S\.view\.setInsets\(top, bottom, framePad\(/);
  assert.match(read('sheet.js'), /const HALF = 0\.64;/, 'the half sheet keeps its height');
  assert.match(design, /at least 12 px clear of the left and right edges/);
});
