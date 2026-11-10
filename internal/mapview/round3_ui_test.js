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
  // (Round 4's B145 made the pad scale with the pane; a phone's band keeps these floors.)
  const ins = frameInsets({ height: 844, chips: 54, crumbs: null, controls: 54, layout: 'sheet', covered: 540, calibrating: false, calTop: 0, floats: 0 });
  const phonePad = framePad({ width: 390, height: 844 - ins.top - ins.bottom });
  assert.ok(phonePad.side >= 13 && phonePad.edge >= 3, JSON.stringify(phonePad));
  assert.ok(ins.top - 54 + phonePad.edge >= 8 && ins.bottom - 540 + phonePad.edge >= 8);
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
  assert.deepEqual(cls({ lit: 500, total: 500, late: 7, frames: 100 }), ['ok', 'ok', 'warn', ''], 'late frames over the threshold');
  assert.deepEqual(cls({ lit: 500, total: 500, late: 7, frames: 100000 }), ['ok', 'ok', '', ''], 'a few late frames in many are neutral (series 2 round 5)');
  assert.deepEqual(cls({ lit: 0, total: 500 }), ['warn', 'ok', '', ''], 'covered but dark needs attention');
  assert.deepEqual(cls({ lit: 500, total: 500, power: { ...power, limiting: 'Dimmed to 80.0%' } }), ['ok', 'ok', '', 'warn']);
  assert.deepEqual(cls({ lit: 0, total: 0, health: { up: 0, n: 8, cls: '', text: '' } }), ['', '', '', ''], 'no report yet is neutral');
  // One-line labels, the same at both viewports; "8 of 8" is the figure.
  const facts = tileFacts({ lit: 0, total: 0, health: ok, late: 0, fps, power: { overall: 'Unknown', limiting: 'Unknown', partial: false, anyKnown: false } });
  assert.deepEqual(facts.map((f) => [f.v, f.label]), [['0', 'lights lit'], ['8 of 8', 'controllers'], ['0', 'late since start'], ['Not configured', 'power estimate']]); // "Not set" until series 2 round 4
  // One markup for all four; only the tag differs, and the power tile is the link.
  const shape = (h) => h.replace(/^<(button|div)[^>]*>/, '<T>').replace(/<\/(button|div)>$/, '</T>').replace(/<b(?: class="words")?>[^<]*<\/b><span>[^<]*(<svg.*<\/svg>)?<\/span>/, '<b></b><span></span>'); // the link's label ends with a chevron (series 2 round 4)
  assert.equal(new Set(facts.map((f) => shape(tileHTML(f)))).size, 1);
  assert.match(tileHTML(facts[3]), /^<button type="button" id="stPowerTile" class="stat wordy link" title="[^"]*Go to the Power section\."><b class="words">power estimate<\/b><span>Not configured<svg[^]*<\/svg><\/span><\/button>$/); // the words under the label since series 2 round 5 (B148)
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

test('C: one target control, a button with a border and a chevron, labeled for what it changes', async () => {
  const { targetControl, placeControl } = await import('./static/panel/looks.js');
  // (Round 4's C2 put "next" in its accessible name and gave it the tooltip "Where the next look goes".)
  assert.deepEqual(targetControl('Everything', true), { label: 'Next look:', text: 'Everything', aria: 'Next look: Everything. Change where the next look goes', title: 'Where the next look goes', clear: false });
  const sel = targetControl('Porch rail', false);
  assert.equal(sel.text, 'Porch rail', 'a selection on the map is what the control shows');
  assert.equal(sel.clear, true, 'with a clear (x) back to Everything');
  // A preview row's own place: the same word and style, labeled for that layer.
  assert.deepEqual(placeControl('Everything'), { label: 'This look:', text: 'Everything', title: 'This look is on Everything. Move it somewhere else.' });
  const looks = read('panel/looks.js');
  // Exactly one control sets where the next preview goes.
  assert.equal(looks.match(/id="lkTarget"/g).length, 1);
  assert.doesNotMatch(looks, /New previews go on|Goes on</);
  assert.match(looks, /<button type="button" class="target-select" id="lkTarget"[^>]*aria-haspopup="dialog"><b id="lkTargetName"><\/b>\$\{icon\('chevronDown'\)\}<\/button>/);
  assert.match(looks, /id="lkTargetClear" aria-label="Next look: back to Everything"/);
  assert.match(css, /^button\.target-select \{[^}]*border: 1px solid var\(--control-line\);/m);
  // Selecting on the map changes its text in the same task: the select event is synchronous.
  assert.match(looks, /S\.on\('select', \(\) => \{ fillTargets\(\); renderStage\(\); \}\);/);
  assert.match(read('app.js'), /applySelection\(\);[\s\S]{0,260}?S\.emit\('select', S\.sel\);/); // the announcement sits between them since series 2 round 5
  assert.match(design, /\*\*Next look:\*\*/);
});

test('C: the tap is taught once per device, in one line', async () => {
  const { tapHint, showTapHint } = await import('./static/map-control.js');
  // (Round 4's C2 reworded it: tapping chooses a target, it lights nothing.)
  assert.equal(tapHint('Tap'), 'Tap a run on the map to choose where the next look goes.');
  assert.equal(tapHint('Click'), 'Click a run on the map to choose where the next look goes.');
  assert.equal(showTapHint({ seen: false, selected: false }), true, 'first load on this device');
  assert.equal(showTapHint({ seen: false, selected: true }), false, 'gone with the first selection');
  assert.equal(showTapHint({ seen: true, selected: false }), false, 'then never again');
  assert.equal(showTapHint({ seen: false, selected: false, calibrating: true }), false);
  assert.equal(showTapHint({ seen: false, selected: false, failed: true }), false);
  const app = read('app.js');
  assert.match(app, /if \(node\) markHintSeen\(\);/, 'the first selection is remembered');
  assert.match(read('map-control.js'), /const HINT_SEEN = 'glowstack\.hint\.tap';/, 'per device: localStorage');
  // Said once, on the map (round 4's C2 took it out of the menu and the empty state); no tour, no modal.
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /tapHint|lkTip/);
  assert.match(read('index.html'), /<p id="mapHint" class="map-hint" hidden><\/p>/);
  assert.doesNotMatch(app + looks, /tour|showModal\(\)[^;]*hint/i);
  assert.match(css, /\.map-hint \{[^}]*pointer-events: none;/, 'a caption: it never takes a tap from the map');
});

test('C: hovering a run names it and its zone, beside the pointer and never over the run', async () => {
  const { runAt, runTitle } = await import('./static/map-control.js');
  const { labelSpot } = await import('./static/card-place.js');
  const { buildTree } = await import('./static/select.js');
  const geo = {
    pixels: { count: 30, run: [...Array(10).fill(0), ...Array(10).fill(1), ...Array(10).fill(-1)] },
    runs: [{ id: 'porch-rail', name: 'Porch rail' }, { id: 'shed-eave' }],
    areas: [{ id: 'front', ranges: [[0, 19]] }], zones: [{ id: 'front', area: 'front', name: 'Front' }],
  };
  const tree = buildTree(geo);
  assert.deepEqual(runAt(geo, tree, 3), { index: 0, run: 'Porch rail', zone: 'Front' });
  assert.equal(runAt(geo, tree, 12).run, 'Shed eave', 'an id reads as words');
  assert.equal(runAt(geo, tree, 25), null, 'a pixel on no run has no name');
  assert.equal(runTitle(runAt(geo, tree, 3)), 'Porch rail · Front');
  assert.equal(runTitle({ run: 'Front', zone: 'Front' }), 'Front');
  // Three runs, three names.
  assert.equal(new Set([3, 12].map((p) => runAt(geo, tree, p).run)).size, 2);
  // Placement: the first corner that is clear of the run's pixels.
  const base = { x: 200, y: 200, w: 80, h: 30, W: 800, H: 600 };
  assert.deepEqual(labelSpot({ ...base, points: [] }), [214, 156], 'above and right of the pointer by default');
  const diag = Array.from({ length: 40 }, (_, i) => [200 + i * 4, 200 - i * 4]); // the run rises to the right, through the default spot
  const [l, t] = labelSpot({ ...base, points: diag });
  assert.ok(!diag.some(([px, py]) => px >= l && px <= l + 80 && py >= t && py <= t + 30), 'it moved off the run');
  // A loop around the pointer: no near corner is clear, a farther spot is.
  const loop = []; for (let a = 0; a < 360; a += 3) loop.push([200 + 60 * Math.cos(a * Math.PI / 180), 200 + 40 * Math.sin(a * Math.PI / 180)]);
  const [ll, lt] = labelSpot({ ...base, points: loop });
  assert.ok(!loop.some(([px, py]) => px >= ll && px <= ll + 80 && py >= lt && py <= lt + 30));
  // Never off the map, and never under the pointer.
  const [cl, ct] = labelSpot({ ...base, x: 795, y: 5, points: [] });
  assert.ok(cl >= 4 && cl + 80 <= 796 && ct >= 4);
  const app = read('app.js');
  assert.match(app, /hoverLabel\(p, x, y\);/, 'shown from pointermove itself: no request, no timer');
  assert.match(app, /<div class="head"><b>\$\{esc\(name\.title\)\}\$\{name\.sub \? `<small>\$\{esc\(name\.sub\)\}<\/small>` : ''\}<\/b>/, 'the inspect card leads with the run and its zone');
});

test('C: the panel points at the map with the soft halo', async () => {
  const control = await import('./static/map-control.js');
  const { controllerRanges } = control;
  const geo = { controllers: [{ id: 'shed', base: 0, pixels: 600 }, { id: 'yard', base: 600, pixels: 480 }, { id: 'spare' }] };
  assert.deepEqual(controllerRanges(geo, 'yard'), [[600, 1079]], 'that controller\'s pixels and no others');
  assert.deepEqual(controllerRanges(geo, 'spare'), []);
  assert.deepEqual(controllerRanges(geo, 'nope'), []);
  // Touch has no hover, and no resting halo either: round 4's C2 removed the one round 3 added.
  assert.equal(control.restPoint, undefined);
  // pointOn: one listener per list; hover and focus point, leaving clears.
  const { pointOn } = await import('./static/panel/looks.js');
  const calls = [], handlers = {};
  const row = { closest: () => row, contains: (el) => el === row, matches: () => true };
  const box = { addEventListener: (ev, fn) => { handlers[ev] = fn; }, contains: (el) => el === row };
  pointOn(box, 'li', () => [[1, 2]], { coarse: false, pointAt: (r) => calls.push(r) });
  handlers.pointerover({ target: row }); handlers.pointerout({ target: row, relatedTarget: null });
  handlers.focusin({ target: row }); handlers.focusout({ target: row, relatedTarget: null });
  assert.deepEqual(calls, [[[1, 2]], null, [[1, 2]], null]);
  handlers.pointerout({ target: row, relatedTarget: row }); // moving within the row is not leaving
  assert.equal(calls.length, 4);
  const touch = {}; pointOn({ addEventListener: (ev) => { touch[ev] = true; } }, 'li', () => null, { coarse: true });
  assert.ok(!touch.pointerover && touch.focusin, 'no hover listeners on touch');
  // Wiring: library cards, preset rows, Status controller and run rows.
  assert.match(read('panel/looks.js'), /pointOn\(\$\$\('#lkPresets'\), '\.preset', here, S\);/);
  assert.match(read('panel/presets.js'), /pointOn\(\$\('#prList'\), '\.preset-entry',/);
  const status = read('panel/status.js');
  assert.match(status, /pointOn\(\$\$\('#stCtl'\), 'li\[data-ctl\]', \(el\) => controllerRanges\(g, el\.dataset\.ctl\), S\);/);
  assert.match(status, /pointOn\(box, 'li\[data-run-row\]:not\(\.warn\)',/); // a warning's row outlines its run in amber instead (round 4)
  assert.match(status, /if \(S\.coarse\) \$\$\('#stCtl'\)\.addEventListener\('click'/, 'a tap on a phone');
  // The mark (a thin outline since B150; a halo before): a fade unless motion is reduced, cleared at once; never doubled over the selection.
  const app = read('app.js'), overlay = read('overlay.js');
  assert.match(app, /S\.pointing = show \? \{ ranges: show, key, since: performance\.now\(\), fade: !reducedMotion\.matches \} : null;/);
  assert.match(app, /if \(show && S\.sel && JSON\.stringify\(show\) === JSON\.stringify\(S\.sel\.node\.ranges\)\) show = null;/);
  assert.match(overlay, /const k = pt\.fade \? Math\.min\(1, \(performance\.now\(\) - pt\.since\) \/ OUTLINE\.fade\) : 1;/);
  assert.equal((await import('./static/map-control.js')).OUTLINE.fade, 120);
  // Owner decisions: no camera buttons, reset-view control or map toolbar came with it.
  assert.doesNotMatch(read('index.html') + app, /Reset view|Fit lights|map-toolbar|data-view="(street|overhead|free|fit)"/i);
});

test('E: undo after apply: ten seconds on the toast, five minutes on the card, one level', async () => {
  const { createUndo, mark, undoResult, TOAST_MS, LINK_MS } = await import('./static/undo.js');
  assert.equal(TOAST_MS, 10000);
  assert.equal(LINK_MS, 5 * 60 * 1000);
  let t = 1000;
  const undo = createUndo(() => t);
  assert.equal(undo.toast(), false); assert.equal(undo.link(), false); assert.equal(undo.point(), null);
  undo.set('a1', 'applied 2 looks');
  assert.deepEqual(undo.point(), { id: 'a1', at: 1000, what: 'applied 2 looks' });
  assert.equal(undo.toast(), true); assert.equal(undo.link(), true);
  t += 9999; assert.equal(undo.toast(), true, 'still on the toast just under ten seconds');
  t += 1; assert.equal(undo.toast(), false, 'the toast\'s Undo is gone at ten seconds');
  assert.equal(undo.link(), true, 'the card keeps the quieter link');
  assert.equal(undo.linkLeft(), LINK_MS - 10000);
  t = 1000 + LINK_MS - 1; assert.equal(undo.link(), true);
  t = 1000 + LINK_MS; assert.equal(undo.link(), false, 'for five minutes'); assert.equal(undo.linkLeft(), 0);
  // The next apply takes its place: one level only.
  t = 5000; undo.set('a1', 'x'); t = 6000; undo.set('b2', 'applied the look');
  assert.equal(undo.point().id, 'b2'); assert.equal(undo.point().at, 6000);
  undo.clear(); assert.equal(undo.link(), false);
  // A change that could not be marked offers no undo.
  undo.set('', 'applied the look'); assert.equal(undo.point(), null); assert.equal(undo.toast(), false);
  // mark asks the server before the change; a failure is no undo, never a blocked apply.
  const calls = [];
  assert.equal(await mark(async (path, opts) => { calls.push([path, opts.method]); return { id: 'p9', layers: 2 }; }), 'p9');
  assert.deepEqual(calls, [['/api/v1/undo', 'PUT']]);
  assert.equal(await mark(async () => { throw new Error('down'); }), '');
  // What pressing Undo reports.
  assert.deepEqual(undoResult(null), { text: 'Undone. The lights are as they were before.', warn: false, gone: true });
  assert.equal(undoResult({ status: 409 }).gone, true, 'a later change took its place');
  assert.match(undoResult({ status: 409 }).text, /can no longer be undone/);
  assert.equal(undoResult({ network: true }).gone, false, 'a failed request keeps the point for another try');
});

test('E: undo restores a stack exactly, through the layer API, and is never a power command', () => {
  const looks = read('panel/looks.js'), undo = read('undo.js');
  // The mark comes before the change, for every change to the lights made here.
  assert.match(looks, /const point = await mark\(api\);\s*try \{\s*await post\('\/api\/map\/preview\/promote'/, 'Put, Add, Update and Replace');
  assert.match(looks, /const point = live \? await mark\(api\) : '';/, 'Remove on a live look; a preview row is not the lights');
  // The restore is one request with the point's id: the server puts back the same layers, order, targets, brightness and parameters.
  assert.match(looks, /await post\('\/api\/v1\/undo', \{ id: p\.id \}\)/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'api', 'undo.go'), 'utf8');
  assert.match(server, /api\.app\.Stack\.Reinstate\(snapshot\)/);
  assert.match(server, /u\.id != id[\s\S]{0,80}StatusConflict/, 'after a second apply the first is no longer undoable');
  // Nothing in undo, client or server, speaks to a controller or to brightness.
  for (const [name, src] of [['undo.js', undo], ['undo.go', server.replace(/^\s*\/\/.*$/gm, '')]]) {
    assert.doesNotMatch(src, /json\/state|"on"\s*:|\bbri\b|\/api\/v1\/brightness|SetBrightness|turnOn/, `${name} sends no power or brightness command`);
  }
  const undoFn = /async function undoLast\(\) \{[\s\S]*?\n  \}/.exec(looks)[0];
  assert.doesNotMatch(undoFn, /brightness|turnOn|json\/state/);
  // Zone brightness changes are not undoable and offer no undo.
  assert.doesNotMatch(read('house-status.js'), /undo/i);
  // The toast carries Undo for TOAST_MS; the card link is quieter and goes on its timer.
  assert.match(looks, /if \(!r\.warn\) return S\.toast\([^;]*, \{ ms: TOAST_MS, actions \}\);/); // a phone's text is compact since series 2 round 5
  assert.match(looks, /<button type="button" class="target-btn" id="lkUndo"[^>]*>Undo last change<\/button>/);
  assert.match(looks, /if \(undo\.link\(\)\) undoTimer = setTimeout\(renderUndo, undo\.linkLeft\(\) \+ 50\);/);
  // The consequence is already on the button before the apply; nothing permanent was added.
  assert.match(looks, /label: `Put \$\{looks\} on the lights`/);
  // The fake controllers record what they are asked, and the Go test asserts no power-off.
  const goTest = fs.readFileSync(path.join(__dirname, '..', 'api', 'undo_test.go'), 'utf8');
  assert.match(goTest, /func TestUndoNeverSendsAPowerCommand/);
  assert.match(goTest, /if r\.PowerOff\(\) \{/);
});

test('E: on a phone the toast sits in the sheet above the sticky bar, not over the map', async () => {
  const { toastHome, sheetToastTop } = await import('./static/map-frame.js');
  assert.equal(toastHome(false, true, true), 'panelToasts', 'the sheet is up: messages go in it');
  assert.equal(toastHome(false, true, false), 'toasts', 'a peeking sheet or a side panel: over the map, as before');
  assert.equal(toastHome(true, true, true), 'caToasts', 'calibration keeps its own');
  // The toasts end 8 px above the bar; with no bar, above the sheet's bottom edge.
  assert.equal(sheetToastTop({ visible: 540, bar: 60, safe: 0 }), 472);
  assert.equal(sheetToastTop({ visible: 540, bar: 0, safe: 20 }), 512);
  assert.equal(sheetToastTop({ visible: 20, bar: 60, safe: 0 }), 0);
  assert.match(css, /\.panel-toasts \{ display: flex; position: absolute;[^}]*transform: translateY\(-100%\); \}/);
  assert.match(read('index.html'), /<div id="panelToasts" class="toasts panel-toasts"><\/div>/);
  assert.match(read('app.js'), /const box = \$\(toastHome\(S\.calibrating, !!\$\('caToasts'\), sheetUp\(\)\)\);/);
});

test('Refinement 1: preset actions are readable at rest, the same words at 390 and 1440', async () => {
  const src = read('panel/presets.js');
  // One row component: the swatch, the name and its line, then Preview, Pin or Pinned, and More.
  assert.match(src, /<div class="preset-body"[^>]*><span class="swatch"><\/span><div class="preset-title"><b>/);
  assert.match(src, /b\.innerHTML = `\$\{icon\('eye'\)\}<span class="lbl">\$\{on \? 'Previewing' : 'Preview'\}<\/span>`;/, 'Preview: the eye and the word');
  assert.match(src, /\$\{icon\(p\.pinned \? 'pinFilled' : 'pin'\)\}<span class="lbl">\$\{p\.pinned \? 'Pinned' : 'Pin'\}<\/span>/, 'an outline pin against a filled one, and the word');
  assert.match(src, /title="More: edit, duplicate or delete">\$\{icon\('more'\)\}<\/button>/, 'More is its glyph, with a title');
  // No rule hides a word on any pointer or width: the labels are the markup's, the same everywhere.
  assert.doesNotMatch(css, /\.preset-actions[^{]*\.lbl[^{]*\{/);
  // Fine pointers: 28 px buttons (--tap) on the row's own line; coarse keeps 44 px.
  const fine = css.slice(css.indexOf('@media (pointer: fine) {\n  html:not(.coarse) .preset-entry'));
  assert.match(fine, /html:not\(\.coarse\) \.preset-actions \{ flex-wrap: nowrap; gap: 4px; \}/);
  assert.match(css, /--tap: 28px;/); assert.match(css, /html\.coarse \{ --tap: 44px;/);
  // Pinned and unpinned differ without color: glyph, fill and word.
  assert.match(css, /\.preset-actions \[data-act=pin\]\[aria-pressed=true\] \{ background: rgba\(124, 196, 255, 0\.16\); \}/);
  // Hover and focus states on the row.
  assert.match(css, /@media \(hover: hover\) \{ \.preset-entry:hover \{ background: var\(--card2\); border-color: #94a3b8; \} \}/);
  assert.match(css, /\.preset-entry:focus-within \{ border-color: #94a3b8; \}/);
  // The name clamps at two lines, never fewer.
  assert.match(css, /\.preset-title b \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; \}/);
  // More: under its own button (the row's Pin stays in view); focus moves in only from the keyboard.
  const { openedByKeyboard } = await import('./static/panel/presets.js');
  assert.equal(openedByKeyboard({ detail: 0 }), true, 'Enter or Space');
  assert.equal(openedByKeyboard({ detail: 1 }), false, 'a mouse or a finger');
  assert.match(src, /if \(openedByKeyboard\(e\)\) items\[0\]\.focus\(\{ preventScroll: true \}\);/);
  assert.match(css, /\.preset-menu \{ position: absolute; z-index: 4; top: calc\(100% \+ 4px\); right: 0;/);
  assert.match(css, /\.preset-menu\.up \{ top: auto; bottom: calc\(100% \+ 4px\); \}/);
});

test('Refinement 2: Status leads with what needs action; one explanation in one place', async () => {
  const { leadsWithWarnings, headline, SENDING_NOTE, LATE_NOTE } = await import('./static/panel/status.js');
  // With at least one warning, the summary and the warnings come first; with none, the tiles lead.
  assert.equal(leadsWithWarnings({ cls: '' }, 0), false, 'nothing lit, nothing wrong: the tiles lead');
  assert.equal(leadsWithWarnings({ cls: 'ok' }, 0), false);
  assert.equal(leadsWithWarnings({ cls: 'warn' }, 0), true, 'a dark verdict is itself the warning');
  assert.equal(leadsWithWarnings({ cls: 'bad' }, 0), true, 'a controller fault');
  assert.equal(leadsWithWarnings({ cls: 'ok' }, 2), true, 'warning cards under a good verdict');
  assert.equal(leadsWithWarnings(headline({ cls: 'ok', text: 'Lit' }, '', 1), 1), true);
  const status = read('panel/status.js');
  // One element, moved (never copied), and only when its place changes.
  assert.match(status, /const tiles = \$\$\('#stTiles'\), before = warned \? \$\$\('#stBody'\) : \$\$\('#stVerdict'\);/);
  assert.match(status, /if \(tiles\.nextElementSibling !== before\) root\.insertBefore\(tiles, before\);/);
  assert.match(status, /placeTiles\(leadsWithWarnings\(head, issues\.length\)\);/);
  assert.equal(status.match(/id="stTiles"/g).length, 1);
  // The Controllers note explains "Sending" and does not repeat what the headline says about dark lights.
  assert.doesNotMatch(SENDING_NOTE, /dark|Nothing is lit/i);
  assert.match(SENDING_NOTE, /^Sending means /);
  assert.doesNotMatch(status, /so those frames are dark/);
  // Late frames: one line, under Diagnostics.
  assert.match(LATE_NOTE, /^A late frame started after the next was due/);
  assert.ok(LATE_NOTE.length <= 95, 'one line at the panel\'s width');
  assert.match(status, /<details id="stDiag" class="section-disclosure"><summary>Diagnostics<\/summary><div class="stats" id="stDiagStats"><\/div><p class="muted small" id="stLateNote">\$\{LATE_NOTE\}<\/p><\/details>/);
});

test('Refinement 3: one toggle idiom: a box with a check, never a circle', () => {
  // The box: one size token, one shape, for a real checkbox and for a toggle pill.
  const box = /^input\[type=checkbox\] \{[^}]*\}/m.exec(css)[0];
  assert.match(box, /width: var\(--box\); height: var\(--box\);/);
  assert.match(box, /border: 1\.5px solid var\(--control-line\); border-radius: 4px;/);
  assert.match(css, /input\[type=checkbox\]:checked \{ background: var\(--accent\) var\(--check\) center \/ 82% no-repeat; border-color: var\(--accent\); \}/);
  const pill = /^\.chips\.toggles > button::before \{[^}]*\}/m.exec(css)[0];
  assert.match(pill, /width: var\(--box\); height: var\(--box\);[^}]*border: 1\.5px solid var\(--control-line\); border-radius: 4px;/, 'the same box inside the pill');
  assert.match(css, /\.chips\.toggles > button\.on::before \{ background: var\(--accent\) var\(--check\) center \/ 82% no-repeat; border-color: var\(--accent\); \}/);
  // Off and on differ without color: an empty box against a filled one with a check.
  assert.doesNotMatch(pill, /var\(--check\)/);
  // No independent toggle draws a circle.
  for (const rule of css.match(/(input\[type=checkbox\]|\.chips\.toggles > button)[^{]*\{[^}]*\}/g)) assert.doesNotMatch(rule, /border-radius: (50%|999px)/, rule.slice(0, 60));
  // Every independent toggle exposes its state: aria-pressed on a pill, a real checkbox otherwise.
  const setup = read('panel/setup.js');
  for (const id of ['suNodes', 'suLabels', 'suControllers', 'suEven']) assert.match(setup, new RegExp(`<button type="button" id="${id}" aria-pressed="false"`), id);
  assert.match(setup, /<div class="chips toggles" id="suLayers"><\/div>/, 'Parts of the model');
  assert.match(setup, /press\(b, l\.visible\);/);
  assert.match(read('util.js'), /b\.setAttribute\('aria-pressed', on \? 'true' : 'false'\)/);
  assert.match(read('panel/presets.js'), /<label class="check"><input type="checkbox" id="prPinned"> Pin to Looks<\/label>/);
  assert.match(read('panel/calibrate.js'), /<label class="check small"><input type="checkbox" id="caNext"> Go to next after<\/label>/);
  // Circles stay for one-of-many only; segmented bars are unchanged.
  assert.doesNotMatch(css, /\.seg > button::before/);
  assert.match(design, /\*\*Toggles\.\*\*[\s\S]{0,400}a box with a check/);
});

test('Refinement 4: one apply bar: Clear beside the primary, at the panel\'s foot, and one verb', async () => {
  const looks = read('panel/looks.js');
  // Clear preview is in the bar's one row with the primary, on every layout; it has left the card's header.
  const bar = /<div class="bar-main">[\s\S]*?<\/div>\s*<div class="bar-line">/.exec(looks)[0];
  assert.ok(bar.indexOf('id="lkClear"') >= 0 && bar.indexOf('id="lkClear"') < bar.indexOf('id="lkPushAll"'), 'Clear, then the primary, in one row');
  assert.match(bar, /id="lkClear" class="icon-btn bar-clear" aria-label="Clear preview"/);
  assert.doesNotMatch(looks, /placeClear|stage-head'\)\.append|clearHome/);
  assert.doesNotMatch(css, /stage-head > #lkClear|^\s*#lkClear \{/m);
  // Tops level: the row stretches its buttons to one height.
  assert.match(css, /\.bar-main \{ display: flex; gap: 8px; align-items: stretch; \}/);
  // The bar is at the panel's foot in every state: the tab is a column as tall as the panel, the bar pushed down.
  assert.match(css, /#tab-looks:not\(\[hidden\]\) \{ display: flex; flex-direction: column; min-height: 100%; \}/);
  assert.match(css, /#tab-looks > \.look-bar \{ margin-top: auto; margin-bottom: calc\(-1 \* var\(--content-bottom\)\); \}/);
  // On a phone Clear is compact, its word alone, and a full tap target (44 px on coarse pointers).
  const phone = css.slice(css.indexOf('.bar-main .swap { display: inline-block;'));
  assert.match(phone, /\.bar-clear \{ min-width: var\(--tap\); padding: 0 8px; \}/);
  assert.match(css, /html\.coarse \{ --tap: 44px;/);
  // One verb for the action: "put on the lights". No "apply" in any string a person reads.
  const { stageSub, applyPlan, onLights, applyResult, swapLabel } = await import('./static/panel/looks.js');
  assert.equal(stageSub({ rows: 0, stale: false, word: 'Tap', compact: true }), 'Tap a look to preview it. The lights change only when you put it on them.');
  assert.equal(applyPlan({ n: 2, updates: false, house: 0, hidden: [], mode: 'replace' }).label, 'Put 2 looks on the lights');
  assert.equal(onLights('The look'), 'The look is on the lights');
  assert.equal(onLights('2 looks', true), '2 looks are on the lights');
  assert.equal(applyResult(onLights('The look'), { dark: '' }).text, 'The look is on the lights.');
  assert.equal(swapLabel('replace'), 'Add instead'); assert.equal(swapLabel('add'), 'Replace instead');
  const strings = looks.match(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g) || [];
  // The icon's name and a class name are not words anyone reads.
  const said = strings.filter((q) => /\bappl(y|ied|ies|ying)\b/i.test(q.replace(/icon\('apply'\)|apply-one|^'apply'$/g, '')));
  assert.deepEqual(said, [], 'the string audit: one verb, and it is not "apply"');
  assert.match(looks, /S\.fail\('put the look on the lights', e\)/);
  assert.match(looks, /It goes on the lights when you update them\./);
});

test('Refinement 5: search stays put: a placeholder that fits, one inline field on Looks and Presets', async () => {
  const { placeholderFor, fitPlaceholder, textField } = await import('./static/field.js');
  const width = (t) => t.length * 7.4; // about 14 px text
  // The longest candidate that fits; the shortest when none does. Never a cut word.
  assert.equal(placeholderFor(['Search looks', 'Search'], 237, width), 'Search looks');
  assert.equal(placeholderFor(['Search looks', 'Search'], 60, width), 'Search');
  assert.equal(placeholderFor(['Search looks', 'Search'], 10, width), 'Search', 'the shortest is the floor');
  for (const room of [30, 45, 60, 90, 120, 240]) {
    const p = placeholderFor(['Search presets', 'Search'], room, width);
    assert.ok(width(p) <= room || p === 'Search', `${room} px: "${p}"`);
  }
  // Without a canvas (or before layout) it is the shortest, which always fits.
  const input = { clientWidth: 0, placeholder: 'Search looks', addEventListener() {} };
  fitPlaceholder(input, ['Search looks', 'Search'], { createElement() { throw new Error('no canvas'); } });
  assert.equal(input.placeholder, 'Search');
  // Both tabs: the same component, wrapper and wiring.
  const looks = read('panel/looks.js'), presets = read('panel/presets.js');
  assert.match(looks, /<div class="lib-filters">[\s\S]*?textField\(\{ label: 'Find a look', id: 'lkFind', type: 'search', placeholder: 'Search looks', clearable: true \}\)/);
  assert.match(presets, /<div class="lib-filters">\$\{textField\(\{ label: 'Find a preset', id: 'prSearch', type: 'search', placeholder: 'Search presets', clearable: true \}\)\}<\/div>/);
  assert.match(looks, /fitPlaceholder\(\$\$\('#lkFind'\), \['Search looks', 'Search'\]\);/);
  assert.match(presets, /fitPlaceholder\(\$\('#prSearch'\), \['Search presets', 'Search'\]\);/);
  assert.match(presets, /wireClear\(\$\('#prSearch'\), renderList, root\.parentElement\);/);
  // One placement rule: inline, the label's words folded away (still the input's name), never stacked.
  assert.match(css, /^\.lib-filters \{ display: flex; flex-wrap: nowrap;/m);
  assert.match(css, /^\.lib-filters \.field \{ flex: 1 1 auto; margin: 0; min-width: 0; \}/m);
  assert.match(css, /^\.lib-filters \.field > \.lbl \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\); white-space: nowrap; \}/m);
  assert.match(textField({ label: 'Find a preset', id: 'x', clearable: true }), /<label class="field clearable"><span class="lbl">Find a preset<\/span><input/);
  // The resting field keeps its whole width for its words: the x's room is the query's.
  assert.match(css, /\.field\.clearable:has\(\.field-clear:not\(\[hidden\]\)\) input \{ padding-right: 36px; \}/);
  assert.doesNotMatch(css, /^\.field\.clearable input \{ padding-right/m);
  // The row is one line whether the field is resting, focused or holding a query, so the results below never move.
  assert.doesNotMatch(css, /\.lib-filters[^{]*\{[^}]*flex-wrap: wrap/);
  // The empty-search sentence is one string per tab, whatever the detent.
  const { noMatch } = await import('./static/panel/looks.js');
  assert.deepEqual(noMatch('presets', 'zz'), { kind: 'empty', title: 'No presets match “zz”', detail: 'Try Pinned or Effects.' });
  assert.match(presets, /title: S\.presets\.length \? `No presets match “\$\{\$\('#prSearch'\)\.value\.trim\(\)\}”` : 'No presets yet'/);
  assert.doesNotMatch(css, /data-detent[^{]*\.state-text/);
});

test('Refinement 6: level card rows: a sub line sits under its name, and a row\'s cards are one height', () => {
  // Top-aligned content: nothing pushes the type line (or Previewing, or Live) to the card's foot.
  assert.match(css, /^\.preset \{ justify-content: flex-start; \}/m);
  for (const rule of css.match(/^\.preset \.(sub|in-badge|live-badge)[^{]*\{[^}]*\}/gm)) assert.doesNotMatch(rule, /margin-top: auto/, rule.slice(0, 50));
  assert.doesNotMatch(css, /\.preset \.sub, \.preset \.in-badge \{ margin-top: auto; \}/);
  // Equal heights come from the grid: its rows stretch their cards, and no card sets its own height.
  const grid = /^\.cards \{[^}]*\}/m.exec(css)[0];
  assert.match(grid, /display: grid;/);
  assert.doesNotMatch(grid, /align-items: (start|flex-start|center)/);
  assert.doesNotMatch(/^\.preset \{\n[^}]*\}/m.exec(css)[0], /(^|[\s;])height:/, 'a least height, never a fixed one');
  // The name still wraps to two lines rather than being cut.
  assert.match(css, /\.preset \.name \{\s*display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;/);
});

test('Refinement 7: one disclosure style per level, a focus ring of its own', () => {
  // Disclosures: the base rule is the inline tier; the section tier is a class. None is sized by its id.
  assert.match(css, /^details > summary \{[^}]*font-size: var\(--t-m\); font-weight: 600; \}/m);
  assert.match(css, /^\.section-disclosure > summary \{ font-size: var\(--t-h2\); font-weight: 600; color: #f3f4f6; \}/m);
  assert.doesNotMatch(css, /#[A-Za-z]+ > summary \{[^}]*font-(size|weight)/, 'no id-specific disclosure size or weight');
  assert.match(read('panel/setup.js'), /<details id="suAdvanced" class="section-disclosure"><summary>Advanced<\/summary>/);
  assert.match(read('panel/status.js'), /<details id="stDiag" class="section-disclosure"><summary>Diagnostics<\/summary>/);
  assert.match(read('panel/status.js'), /<details id="stRunsMore"><summary><\/summary>/, 'All N runs: the inline tier');
  assert.match(read('panel/status.js'), /<details><summary>Details<\/summary>/);
  // The focus ring: a near-white ring with a gap, not the accent blue of a selected or pinned control.
  const ring = /^:focus-visible \{[^}]*\}/m.exec(css)[0];
  assert.match(ring, /outline: 2px solid #f8fafc; outline-offset: 2px;/);
  assert.doesNotMatch(ring, /var\(--accent\)/);
  for (const rule of css.match(/[^{}]*:focus-visible[^{]*\{[^}]*outline:[^}]*\}/g)) assert.doesNotMatch(rule, /outline: [^;]*var\(--accent\)/, rule.slice(0, 60));
  assert.match(css, /\.preset-actions \[data-act=pin\]\[aria-pressed=true\] \{ color: var\(--accent\); border-color: var\(--accent\); \}/, 'pinned is the accent: the ring is not');
  // (Round 3 showed the Looks heading on a phone's full sheet; series 2 round 5 took it out: the state card is the heading.)
  assert.match(css, /^  \.tab \.looks-head \{ display: none; \}/m);
  assert.doesNotMatch(css, /body\[data-detent=full\] \.tab \.looks-head/);
  assert.match(read('panel/looks.js'), /<div class="looks-head"><h1 class="title">Looks<\/h1><\/div>/);
});

test('E follow-up: undo is withdrawn when the stack is no longer the one this page left', () => {
  const looks = read('panel/looks.js');
  // Undo is offered for the stack this page left. If the looks on the lights are no longer those
  // (another screen or Home Assistant added or removed one), undoing would take that change back too.
  assert.match(looks, /const stackKey = \(\) => S\.house\.filter\(\(l\) => !l\.ephemeral\)\.map\(\(l\) => l\.id\)\.join\(','\);/);
  assert.match(looks, /undo\.set\(id, what\);\s*undoStack = stackKey\(\);/);
  assert.match(looks, /if \(undo\.point\(\) && S\.houseStatus === 'available' && stackKey\(\) !== undoStack\) \{ undo\.clear\(\); clearTimeout\(undoTimer\); \}/);
  assert.match(design, /the\s+offer is withdrawn rather than take that change back too/);
});

test('C follow-up: the caption has its line of the map, and a focused controller row keeps its focus', () => {
  const app = read('app.js'), status = read('panel/status.js');
  // The tap hint is framed around like the breadcrumb whose place it holds: no light is drawn under it.
  assert.match(app, /crumbs: !\$\('mapHint'\)\.hidden \? below\('mapHint'\) : !\$\('crumbs'\)\.hidden \? below\('crumbs'\) : null,/); // the caption may sit under the breadcrumb since C3
  assert.match(app, /tap \? tapHint\(S\.coarse \? 'Tap' : 'Click'\) : '';\s*placeCrumbs\(\);\s*setInsets\(\);/);
  // A controller row that points at the map is focusable; a poll redraws the list and gives the focus back.
  assert.match(status, /const focusedCtl = document\.activeElement\?\.closest\?\.\('#stCtl li\[data-ctl\]'\)\?\.dataset\.ctl;/);
  assert.match(status, /if \(focusedCtl\) \[\.\.\.\$\$\('#stCtl'\)\.children\]\.find\(\(li\) => li\.dataset\.ctl === focusedCtl\)\?\.focus\(\{ preventScroll: true \}\);/);
});
