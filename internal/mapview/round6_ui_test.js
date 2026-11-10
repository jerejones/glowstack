// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for series 2 round 6 of the UI review: its bugs (B150 to B152), the
// three states of a run (C3), the type system (T) and the refinements.
// Run with: node --test internal/mapview/round6_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (f) => fs.readFileSync(path.join(__dirname, 'static', f), 'utf8');
const css = () => read('ui.css');
const design = () => fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'design.md'), 'utf8');

// fakeCtx records what is stroked: each stroke as { width, op, color, path }.
function fakeCtx() {
  const strokes = [];
  let path = [];
  return {
    strokes, lineWidth: 1, strokeStyle: '', globalCompositeOperation: 'source-over', lineDash: [],
    beginPath() { path = []; }, moveTo(x, y) { path.push(['M', x, y]); }, lineTo(x, y) { path.push(['L', x, y]); },
    setLineDash(d) { this.lineDash = d; },
    stroke() { strokes.push({ width: this.lineWidth, op: this.globalCompositeOperation, color: this.strokeStyle, dash: this.lineDash, path }); },
  };
}

test('B150: what the panel points at is a thin outline, never a tube over every run', async () => {
  const { OUTLINE, outlineWidths, outlineChunks, strokeOutline, RUN_LINE } = await import('./static/map-control.js');
  // The outline is thin and clear of the run: for a 5 px lit run its two edges are 1.5 px each, 2 px away.
  assert.ok(OUTLINE.width <= 2 && OUTLINE.gap >= 1);
  assert.deepEqual(outlineWidths(5), { inner: 9, outer: 12 });
  assert.equal(OUTLINE.pointed, 0.5, 'half strength');
  // A run that shrinks with distance is cut where its width changes by a pixel; the pieces share the point between them.
  const far = [[0, 0, 8], [10, 0, 8.2], [20, 0, 6.6], [30, 0, 5]];
  const chunks = outlineChunks([far]);
  assert.deepEqual([...chunks.keys()], [8, 7], 'a piece takes the width it starts at');
  assert.deepEqual(chunks.get(8), [[far[0], far[1], far[2]]]);
  assert.deepEqual(chunks.get(7), [[far[2], far[3]]]);
  assert.deepEqual(outlineChunks([[[4, 4, 5]]]).get(5), [[[4, 4, 5]]], 'one pixel on screen still has an outline');
  // Drawn as the outer stroke, then the inside cut back out: nothing is left over the lights.
  const ctx = fakeCtx();
  strokeOutline(ctx, [[[0, 0, 5], [50, 0, 5]]]);
  assert.deepEqual(ctx.strokes.map((s) => [s.width, s.op]), [[12, 'source-over'], [9, 'destination-out']]);
  assert.equal(ctx.strokes[0].color, OUTLINE.color);
  assert.equal(ctx.globalCompositeOperation, 'source-over', 'left as it was found');
  // No view draws a pointing halo any more, and an unlit run's line is the same whatever is pointed at.
  for (const f of ['scene.js', 'plan.js']) assert.doesNotMatch(read(f), /setHighlight|POINT_ALPHA|pointGroup|pointed/, f);
  const overlay = read('overlay.js');
  assert.match(overlay, /drawOutline\(rangeParts\(pt\.ranges, 'pointed' \+ pt\.key\), OUTLINE\.pointed \* k\);/);
  assert.match(overlay, /for \(const ri of unlit\) if \(ri !== hovered\) \{ strokeRun\(all\[ri\], RUN_LINE\.installed\);/, 'the unlit line has one style');
  assert.ok(RUN_LINE.installed.width <= 2);
  assert.match(design(), /a thin outline at half strength/);
});

test('B151: the state card is as tall as what it shows', () => {
  const looks = read('panel/looks.js'), sheet = css();
  // The Undo link's line is in the page only while the link is the one Undo on screen: no held, blank line.
  assert.match(looks, /\$\$\('#lkUndoLine'\)\.hidden = !p;/);
  assert.doesNotMatch(looks, /classList\.toggle\('held'/);
  assert.doesNotMatch(sheet, /\.stage-undo\.held/);
  assert.match(sheet, /\.stage-undo\[hidden\] \{ display: none; \}/);
  // Bottom padding is top padding: 8 px of card and 2 px of heading above; under a last row (6 px of its own) the card gives 4 px, and the link has 2 px under it.
  assert.match(sheet, /\.stage \{ margin: 0 0 6px; padding: 8px;/);
  assert.match(sheet, /\.stage-head \{ display: grid; gap: 1px; padding: 2px 4px; \}/);
  assert.match(sheet, /\.stage:has\(> #lkRows > \.layer\):not\(:has\(> \.stage-undo:not\(\[hidden\]\)\)\):not\(:has\(> #lkStageState:not\(:empty\)\)\) \{ padding-bottom: 4px; \}/);
  assert.match(sheet, /\.stage-undo \{ margin: 4px 4px 2px;/);
  // A phone's rows bring no padding of their own under them, so the card gives all of it: 10 px at full, 6 px at half.
  assert.match(sheet, /\n  \.stage:has\(> #lkRows > \.layer\)[^{]*\{ padding-bottom: 10px; \}\n  body\[data-detent=half\] \.stage:has\(> #lkRows > \.layer\)[^{]*\{ padding-bottom: 6px; \}\n  #lkRows > \.layer\.two-line:last-of-type \.name-line \{ padding-bottom: 0; \}/);
  assert.match(design(), /keeps no room for one/);
});
