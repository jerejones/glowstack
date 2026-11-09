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

test('B142: the Status tiles are one component with one color rule', async () => {
  const { tileFacts, tileHTML, fitFigure } = await import('./static/panel/status.js');
  const ok = { up: 8, n: 8, cls: 'ok', text: 'Controllers: all 8 reachable' }, fps = { measured: 40, target: 40 };
  const power = { overall: '1.08 A', limiting: 'None needed', partial: false, anyKnown: true };
  const cls = (o) => tileFacts({ health: ok, fps, power, late: 0, ...o }).map((f) => f.cls);
  // The four states the rule is written for: a count is neutral, color is state.
  assert.deepEqual(cls({ lit: 0, total: 0 }), ['', 'ok', '', ''], 'nothing lit, no looks: 0 lights and 0 late frames are both neutral');
  assert.deepEqual(cls({ lit: 500, total: 500 }), ['ok', 'ok', '', ''], 'lit: every covered light shows');
  assert.deepEqual(cls({ lit: 500, total: 500, health: { up: 7, n: 8, cls: 'bad', text: '' } }), ['ok', 'bad', '', ''], 'one controller unreachable');
  assert.deepEqual(cls({ lit: 500, total: 500, late: 7 }), ['ok', 'ok', 'warn', ''], 'late frames');
  assert.deepEqual(cls({ lit: 0, total: 500 }), ['warn', 'ok', '', ''], 'covered but dark needs attention');
  assert.deepEqual(cls({ lit: 500, total: 500, power: { ...power, limiting: 'Dimmed to 80.0%' } }), ['ok', 'ok', '', 'warn']);
  assert.deepEqual(cls({ lit: 0, total: 0, health: { up: 0, n: 8, cls: '', text: '' } }), ['', '', '', ''], 'no report yet is neutral');
  // One-line labels, the same at both viewports; "8 of 8" is the figure.
  const facts = tileFacts({ lit: 0, total: 0, health: ok, late: 0, fps, power: { overall: 'Unknown', limiting: 'Unknown', partial: false, anyKnown: false } });
  assert.deepEqual(facts.map((f) => [f.v, f.label]), [['0', 'lights lit'], ['8 of 8', 'controllers'], ['0', 'late frames'], ['Not set', 'power estimate']]);
  // One markup for all four; only the tag differs, and the power tile is the link.
  const shape = (h) => h.replace(/^<(button|div)[^>]*>/, '<T>').replace(/<\/(button|div)>$/, '</T>').replace(/<b>[^<]*<\/b><span>[^<]*<\/span>/, '<b></b><span></span>');
  assert.equal(new Set(facts.map((f) => shape(tileHTML(f)))).size, 1);
  assert.match(tileHTML(facts[3]), /^<button type="button" id="stPowerTile" class="stat" title="[^"]*Opens the Power note\."><b>Not set<\/b><span>power estimate<\/span><\/button>$/);
  assert.match(tileHTML(facts[1]), /^<div class="stat ok"/);
  // The figure shrinks only while it does not fit, never grows, and stops at the floor.
  const el = (fits) => ({ style: { fontSize: 'x' }, clientWidth: 100, get scrollWidth() { return fits(parseFloat(this.style.fontSize) || 22) ? 100 : 140; } });
  const a = el(() => true); fitFigure(a); assert.equal(a.style.fontSize, '', 'a figure that fits keeps the one size');
  const b = el((px) => px <= 17); fitFigure(b); assert.equal(b.style.fontSize, '17px');
  const c = el(() => false); fitFigure(c); assert.equal(c.style.fontSize, '13px');
  // One spec in the stylesheet: a fixed one-line figure box (equal bottoms), tabular numerals, one-line labels, equal heights.
  assert.match(css, /\.tiles \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); grid-auto-rows: 1fr;/);
  assert.match(css, /\.tiles \.stat \{ display: flex; flex-direction: column; justify-content: flex-start;/);
  assert.match(css, /\.tiles \.stat b \{ height: 26px; line-height: 26px; white-space: nowrap; overflow: hidden; color: var\(--fg\); \}/);
  assert.match(css, /\.tiles \.stat span \{ white-space: nowrap;/);
  assert.match(css, /\.stat b \{[^}]*font-variant-numeric: tabular-nums;/);
  assert.match(design, /\*\*Status tiles\.\*\*[\s\S]*a count is neutral, and color is for state only/);
});
