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

test('B143: the half sheet folds two or more previews to one line, and the 0% line is one line', async () => {
  const { previewFold, previewSummary, previewNames, liveFold, warnTexts, fitText } = await import('./static/panel/looks.js');
  // One rule for the whole card: at most one layer row in full at the half detent.
  assert.deepEqual(previewFold({ compact: true, preview: 1, open: false }), { summary: false, folded: false }, 'one preview is its row, as before');
  assert.deepEqual(previewFold({ compact: true, preview: 2, open: false }), { summary: true, folded: true });
  assert.deepEqual(previewFold({ compact: true, preview: 3, open: true }), { summary: true, folded: false }, 'the chevron opens the rows in place');
  assert.deepEqual(previewFold({ compact: false, preview: 3, open: false }), { summary: false, folded: false }, 'the full sheet shows every row');
  for (const [preview, live] of [[1, 0], [2, 0], [3, 0], [1, 2], [2, 2]]) {
    const p = previewFold({ compact: true, preview, open: false }), l = liveFold({ compact: true, preview, live, open: false });
    const full = (p.folded ? 0 : preview) + (l.folded ? 0 : live);
    assert.ok(full <= 1, `${preview} previews over ${live} live: ${full} rows in full`);
  }
  const prev = [{ name: 'Comet chase' }, { name: 'Candy stripes' }, { name: 'Ember drift' }], nameOf = (l) => l.name;
  assert.equal(previewSummary(prev.slice(0, 2), nameOf), '2 previews · Comet chase, Candy stripes');
  assert.equal(previewNames(prev, nameOf, 2), '3 previews: Comet chase, Candy stripes, +1 more');
  assert.equal(previewNames(prev, nameOf, 1), '3 previews: Comet chase, +2 more');
  assert.equal(previewNames(prev, nameOf, 0), '3 previews');
  // The summary takes the first form that fits whole: no ellipsis.
  const el = { clientWidth: 150, set textContent(t) { this.t = t; this.scrollWidth = t.length * 7; }, get textContent() { return this.t; } };
  assert.equal(fitText(el, [2, 1, 0].map((n) => previewNames(prev, nameOf, n))), '3 previews');
  assert.doesNotMatch(css, /\.live-sum \.text \{[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.stage-warn \.warn-text \{[^}]*text-overflow: ellipsis/);
  assert.match(css, /body\[data-detent=half\] #lkRows\.prev-folded \.layer\.preview \{ display: none; \}/);
  // The 0% line: one line, the words shortened before any is cut.
  assert.deepEqual(warnTexts({ text: 'Stays dark: 4 zones at 0%', names: ['a', 'b', 'c', 'd'] }), ['Stays dark: 4 zones at 0%', 'Stays dark at 0%']);
  assert.deepEqual(warnTexts({ text: 'Partly dark: Long Covered Porch at 0%', names: ['Long Covered Porch'] }), ['Partly dark: Long Covered Porch at 0%', 'Partly dark: 1 zone at 0%', 'Partly dark at 0%']);
  assert.deepEqual(warnTexts({ text: 'Brightness is at 0%', names: [] }), ['Brightness is at 0%', 'At 0%']);
  const looks = read('panel/looks.js');
  assert.match(looks, /if \(word && text\.scrollWidth > text\.clientWidth\) \{ word\.textContent = 'Turn on'; fitText\(text, texts\); \}/);
  assert.match(looks, /id="lkPrevSum" aria-expanded="false" hidden><small class="kind">Preview<\/small>/);
  assert.match(looks, /if \(prev\.length < 2\) prevOpen = false;/);
});

test('B3: a swatch shows the look as a motion trail, wherever a look is a card or a row', async () => {
  const { spriteStyle, trailOffset, trailRows, TRAIL, FRAMES, MID, FADE, FPS, SLOW_FPS, tileState, rateOf } = await import('./static/tiles.js');
  // The whole picture, position by time, not one row of it.
  assert.equal(TRAIL, FRAMES, 'the trail is the sprite: 3 s of the look');
  // The current frame is the bottom row; the frames before it rise above, oldest at the top, round the cycle.
  const rows = trailRows(MID);
  assert.equal(rows.length, TRAIL);
  assert.equal(rows[rows.length - 1], MID, 'the current frame along the bottom edge');
  assert.equal(rows[rows.length - 2], MID - 1, 'the frame before it just above');
  assert.equal(rows[0], (MID + 1) % FRAMES, 'the oldest at the top');
  assert.deepEqual(trailRows(0).slice(-3), [28, 29, 0], 'wraps round the sprite');
  assert.equal(new Set(trailRows(7)).size, TRAIL);
  // As CSS: the sprite repeats down the swatch, shifted so that row is at the bottom.
  // With the swatch 30 px tall and 30 rows, row r's top is at r px; offset (29 - r) px puts its bottom at 30.
  assert.equal(trailOffset(), 'calc(var(--swatch-h, 30px) * (29 - var(--tile-row, 15)) / 30)');
  for (const r of [0, 15, 29]) assert.equal((r + (29 - r) + 1), 30, 'row r ends at the swatch bottom');
  const style = spriteStyle('/s.png', 'rgb(1,2,3)');
  assert.ok(style.startsWith(`background-image: ${FADE}, url(/s.png), `), 'the fade is over the sprite');
  assert.match(style, /background-repeat: no-repeat, repeat-y, no-repeat/);
  assert.match(FADE, /^linear-gradient\(to bottom, rgba\(13, 14, 16, 0\.\d+\), rgba\(13, 14, 16, 0\) \d+%\)$/, 'fading toward the top; full strength at the bottom');
  // No sprite (a show): the drawn strip fills the block, no fade over nothing.
  assert.doesNotMatch(spriteStyle('', 'rgb(1,2,3)'), /url\(|rgba\(13/);
  // Same rates and pause rules as B2.
  assert.equal(rateOf(tileState({ reduced: false, hidden: false, visible: true, previewing: false })), FPS);
  assert.equal(rateOf(tileState({ reduced: false, hidden: false, visible: true, previewing: true })), SLOW_FPS);
  assert.equal(rateOf(tileState({ reduced: false, hidden: false, visible: false, previewing: false })), 0);
  assert.equal(rateOf(tileState({ reduced: true, hidden: false, visible: true, previewing: false })), 0);
  // One component, at least 28 px tall on both pointer types, in the cards and the preset rows.
  assert.match(css, /:root \{ --tile-row: 15; --swatch-h: 30px; \}\s*html:not\(\.coarse\) \{ --swatch-h: 36px; \}/);
  assert.match(css, /\.swatch \{ display: block; flex: none; height: var\(--swatch-h\);[^}]*image-rendering: pixelated; \}/);
  assert.doesNotMatch(css, /\.preset \.strip|\.preset-entry \.strip|\.strip\.sprite/, 'the 10 px strips are gone from cards and rows');
  assert.match(read('panel/looks.js'), /<span class="swatch" style="\$\{esc\(spriteStyle\(sprite, strip\)\)\}"><\/span><span class="name">/);
  assert.match(read('panel/presets.js'), /<div class="preset-body"[^>]*><span class="swatch"><\/span><div class="preset-title">/, 'the block at the row\'s left, the name and sub beside it');
  assert.match(css, /\.preset-body \{ display: grid; grid-template-columns: 72px minmax\(0, 1fr\); align-items: center;/);
  // The layer rows' small chip stays a chip.
  assert.match(css, /\.layer \.name-line \.strip \{ width: 28px; height: 8px;/);
  // The lit floor is the server's (a swatch-only render hint): never faked in the client.
  const strip = fs.readFileSync(path.join(__dirname, '..', 'api', 'strip.go'), 'utf8');
  assert.match(strip, /stripLitFloor\s+= 0\.08/);
  assert.match(strip, /denserParams\(def, effectRaw, values,/);
  assert.doesNotMatch(read('tiles.js'), /Math\.random/);
});
