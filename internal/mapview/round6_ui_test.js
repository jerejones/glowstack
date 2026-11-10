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
  for (const f of ['scene.js', 'plan.js']) assert.doesNotMatch(read(f), /setHighlight|POINT_ALPHA|pointGroup/, f);
  const overlay = read('overlay.js');
  assert.match(overlay, /drawOutline\(rangeParts\(pt\.ranges, 'pointed' \+ pt\.key\), OUTLINE\.pointed \* k\);/);
  assert.match(overlay, /for \(const ri of unlit\) strokeLine\(ctx, all\[ri\], RUN_LINE\.installed\);/, 'the unlit line has one style');
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

test('B152: Escape always reaches "Stop calibrating?", and Enter then stops', async () => {
  const { typingField, stepRise, MIN_MAP } = await import('./static/panel/calibrate.js');
  const { calKey } = await import('./static/cal-points.js');
  const { confirmHTML } = await import('./static/dialog.js');
  // A checkbox is not typing: with the focus on the dock's "Go to next after" box, Escape still asks.
  for (const type of ['checkbox', 'radio', 'range', 'button']) assert.equal(typingField({ tagName: 'INPUT', type }), false, type);
  for (const type of ['text', 'number', 'search', '']) assert.equal(typingField({ tagName: 'INPUT', type }), true, type || 'no type');
  assert.equal(typingField({ tagName: 'TEXTAREA' }), true);
  assert.equal(typingField({ tagName: 'SELECT' }), true);
  assert.equal(typingField({ tagName: 'DIV', isContentEditable: true }), true);
  for (const el of [{ tagName: 'BUTTON' }, { tagName: 'CANVAS' }, { tagName: 'BODY' }, { tagName: 'SUMMARY' }, { tagName: 'LI' }, null]) assert.equal(typingField(el), false);
  const esc = { code: 'Escape', key: 'Escape' };
  // From the map, the dock, the progress list and the body: every focus that is not typing.
  for (const at of [{}, { button: true }, { field: typingField({ tagName: 'INPUT', type: 'checkbox' }) }, { field: typingField({ tagName: 'CANVAS' }), button: false }]) assert.deepEqual(calKey(esc, at), { stop: true });
  assert.equal(calKey(esc, { field: typingField({ tagName: 'INPUT', type: 'number' }) }), null, 'a field being typed in keeps its keys');
  const cal = read('panel/calibrate.js');
  assert.match(cal, /const field = typingField\(t\) \|\| !!root\.querySelector\('\.picker\.open'\);/);
  // The question is a dialog whose focus opens on Stop, with each button's key beside it; other questions still open on the safe answer.
  const stop = confirmHTML({ title: 'Stop calibrating?', confirm: 'Stop', cancel: 'Keep calibrating', danger: true, focus: 'confirm', keys: true });
  assert.match(stop, /<button value="no">Keep calibrating<kbd>Esc<\/kbd><\/button><button value="yes" class="danger" autofocus>Stop<kbd>Enter<\/kbd><\/button>/);
  const other = confirmHTML({ title: 'Discard your changes?', confirm: 'Discard', danger: true });
  assert.match(other, /<button value="no" autofocus>Cancel<\/button><button value="yes" class="danger">Discard<\/button>/);
  assert.match(cal, /confirm: 'Stop', cancel: 'Keep calibrating', danger: true, focus: 'confirm', keys: true \}\);/);
  assert.match(read('dialog.js'), /d\.showModal\(\);/, 'a modal dialog, not an inline line');
  // The Stop button's hint says what Escape does.
  assert.match(cal, /id="caStop"[^>]*title="End calibration and return the lights to normal\. Esc asks first; Enter then stops\."/);
  assert.match(css(), /html\.coarse dialog\.confirm kbd \{ display: none; \}/, 'no key hints on touch');
});

test('B152: a phone step\'s controls show together above the dock', async () => {
  const { stepRise, MIN_MAP } = await import('./static/panel/calibrate.js');
  // The sheet rises by what the heading-to-Previous-and-Next span lacks, and no more than the map strip can give.
  assert.equal(stepRise(190, 197, 154), 0, 'it fits: nothing moves');
  assert.equal(stepRise(206, 147, 154), 59, 'the dock grew a Back row: the sheet rises by the shortfall');
  assert.equal(stepRise(206.4, 147, 154), 60, 'whole pixels, rounded up');
  assert.equal(stepRise(400, 147, 154), 154, 'never past the least strip of map');
  assert.equal(stepRise(400, 147, -20), 0, 'a short screen that has no strip to give keeps its sheet');
  assert.equal(MIN_MAP, 200);
  const cal = read('panel/calibrate.js');
  assert.match(cal, /const head = body\.querySelector\('\.cal-step'\), nav = body\.querySelector\('\.cal-step ~ \.cal-nav'\);/);
  assert.match(cal, /const rise = span \? stepRise\(span\.bottom - span\.top, body\.clientHeight, root\.getBoundingClientRect\(\)\.top - MIN_MAP\) : 0;/);
  assert.match(cal, /if \(span && stepChanged\) body\.scrollTop = Math\.min\(span\.top, Math\.max\(body\.scrollTop, span\.bottom - body\.clientHeight\)\);/, 'only a new step moves the scroll: a poll never does');
  assert.match(design(), /Escape then Enter stops/);
});

// ---------- C3: three states of a run ----------

const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const rgbOf = (c) => /rgb\((\d+), (\d+), (\d+)\)/.exec(c).slice(1).map(Number);
const BG = [13, 14, 16]; // the map's background (scene.js setClearColor, ui.css --bg)

test('C3: not lit is a line: thin, dashed, warm, and nothing else on the run', async () => {
  const { RUN_LINE, LIT_WIDTH, strokeLine } = await import('./static/map-control.js');
  const line = RUN_LINE.installed, rgb = rgbOf(line.color);
  assert.ok(line.width >= 1 && line.width <= 1.5, `1 to 1.5 px, never a tube: ${line.width}`);
  assert.ok(Array.isArray(line.dash) && line.dash.length === 2 && line.dash[0] >= 2 && line.dash[1] >= 2, 'dashed: the cue that survives grayscale');
  assert.ok(contrast(rgb, BG) >= 3, `at least 3:1 on the map: ${contrast(rgb, BG).toFixed(2)}`);
  assert.ok(rgb[0] > rgb[1] && rgb[1] > rgb[2], 'a warm neutral: red over green over blue, where the model\'s lines are blue over red');
  assert.ok(rgb[0] - rgb[2] <= 60, 'still a neutral, not a color a light would show');
  // The default model line (scene.js DEFAULTS: #d9e8ff at 0.28, halved for the simple drawing) over the background.
  const model = [0xd9, 0xe8, 0xff].map((v, i) => Math.round(BG[i] + (v - BG[i]) * 0.28 * 0.5));
  assert.ok(model[2] > model[0], 'the model is cool');
  assert.ok(contrast(rgb, model) >= 3, `and 3:1 against the default model line: ${contrast(rgb, model).toFixed(2)}`);
  // Never more light than a lit run at 20% brightness: per pixel of run, this line's color across its 1.25 px for the dashed share of its length, against a fifth of white across the lit width.
  const duty = line.dash[0] / (line.dash[0] + line.dash[1]);
  assert.ok(lum(rgb) * line.width * duty < lum([51, 51, 51]) * LIT_WIDTH, `quiet: ${(lum(rgb) * line.width * duty).toFixed(3)} against ${(lum([51, 51, 51]) * LIT_WIDTH).toFixed(3)}`);
  assert.ok(line.width < LIT_WIDTH / 3, 'a lit run is at least three times as wide');
  // Stroked dashed, and the dash is put back.
  const ctx = fakeCtx();
  strokeLine(ctx, [[[0, 0], [40, 0]]], line);
  assert.deepEqual(ctx.strokes[0].dash, line.dash);
  assert.equal(ctx.strokes[0].width, line.width);
  assert.deepEqual(ctx.lineDash, []);
  // The views draw nothing per pixel on a run with nothing lit: the line is all there is.
  const scene = read('scene.js'), plan = read('plan.js'), overlay = read('overlay.js');
  assert.match(scene, /if \(quiet > 0\.5 && flags < 1\.0 && dot\(rgb, rgb\) < 0\.0004\) \{ gl_Position = vec4\(2\.0, 2\.0, 2\.0, 1\.0\);/);
  assert.match(scene, /setQuietRuns\(runs\) \{/);
  assert.match(plan, /if \(quiet\.has\(px\.run\[p\]\)\) continue;/);
  assert.match(overlay, /S\.view\.setQuietRuns\?\.\(quiet\);/);
  assert.match(overlay, /for \(const ri of unlit\) strokeLine\(ctx, all\[ri\], RUN_LINE\.installed\);/);
});

test('C3: selected is an outline in the interaction blue; hover is the same at half strength', async () => {
  const { OUTLINE, RUN_LINE, TARGET_COLOR, outlineWidths, LIT_WIDTH } = await import('./static/map-control.js');
  const sheet = css();
  // The one accent: the page's interaction blue, not the preview's purple, the lights' green or a warning's amber.
  const accent = /--accent: (#[0-9a-f]{6});/.exec(sheet)[1];
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  assert.deepEqual(rgbOf(OUTLINE.color), hex(accent));
  for (const name of ['preview', 'house', 'warn']) assert.notDeepEqual(rgbOf(OUTLINE.color), hex(new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(sheet)[1]), name);
  assert.notEqual(OUTLINE.color, TARGET_COLOR);
  assert.ok(contrast(rgbOf(OUTLINE.color), BG) >= 4.5);
  // Thin, with a gap: the lit pixels inside are not drawn over.
  const w = outlineWidths(LIT_WIDTH);
  assert.ok(w.inner >= LIT_WIDTH + 2 && w.outer - w.inner === 2 * OUTLINE.width && OUTLINE.width <= 2);
  assert.equal(OUTLINE.pointed, 0.5);
  // No halo is left anywhere: no fill and no blur over the colors.
  for (const f of ['scene.js', 'plan.js']) assert.doesNotMatch(read(f), /HALO|haloGroup|haloPath|setSelection/, f);
  const overlay = read('overlay.js');
  assert.match(overlay, /if \(sel && sel\.length\) \{ drawOutline\(rangeParts\(sel, 'selected' \+ JSON\.stringify\(sel\)\), 1\); next\.selected = true; \}/);
  assert.match(overlay, /if \(run && !\(sel && within\(sel, S\.tree\.runSets\[hr\]\)\)\) \{ drawOutline\(run, OUTLINE\.pointed\); next\.hovered = true; \}/);
  assert.equal(RUN_LINE.hovered, undefined, 'hover is not a brighter line any more');
  assert.match(read('app.js'), /function applySelection\(\) \{\s*if \(S\.view\) markDirty\(\);\s*\}/);
});

test('C3: the key lists the states on screen, with swatches the map\'s own strokes draw', async () => {
  const { STATE_KEY, statesShown, stateKeyHTML, drawSwatch, paintSwatches, SWATCH, RUN_LINE, OUTLINE, outlineWidths, LIT_WIDTH, TARGET_COLOR } = await import('./static/map-control.js');
  assert.deepEqual(STATE_KEY.map(([, words]) => words), ['Not lit', 'Lit', 'Previewing', 'Selected', 'Pointed at', 'Calibrating this point', 'Points close together: tap to pick one', 'Needs calibrating']);
  assert.deepEqual(statesShown({ installed: true, lit: true, selected: true }), ['installed', 'lit', 'selected']);
  assert.deepEqual(statesShown({ installed: true, lit: true, previewed: true }), ['installed', 'previewed'], 'lit runs are "Previewing" while a preview is on the map: one entry, never both');
  assert.deepEqual(statesShown({ lit: false, installed: false }), []);
  const html = stateKeyHTML(['installed', 'lit', 'selected', 'hovered']);
  assert.equal((html.match(/<canvas class="sw rs" data-swatch="/g) || []).length, 4, 'a canvas per state');
  // Each swatch is drawn by the stroke the map uses, at the map's width.
  const drawn = (id) => { const ctx = Object.assign(fakeCtx(), { arcs: [], arc(...a) { this.arcs.push(a); } }); drawSwatch(ctx, id); return ctx; };
  const unlit = drawn('installed').strokes;
  assert.deepEqual([unlit[0].width, unlit[0].color, unlit[0].dash], [RUN_LINE.installed.width, RUN_LINE.installed.color, RUN_LINE.installed.dash]);
  assert.ok(drawn('lit').strokes.every((s) => s.width === LIT_WIDTH), 'the lit width');
  const sel = drawn('selected').strokes, w = outlineWidths(LIT_WIDTH);
  assert.deepEqual(sel.map((s) => [s.width, s.op]), [[w.outer, 'source-over'], [w.inner, 'destination-out']]);
  assert.equal(sel[0].color, OUTLINE.color);
  assert.equal(drawn('hovered').strokes[0].color, `rgba(${OUTLINE.rgb}, ${OUTLINE.pointed})`, 'the same outline at half strength');
  assert.equal(drawn('warned').strokes[0].width, RUN_LINE.warned.width);
  const ring = drawn('target');
  assert.equal(ring.strokes[0].color, TARGET_COLOR);
  assert.equal(ring.arcs.length, 1);
  assert.ok(w.outer <= SWATCH.h, 'the outline fits its swatch');
  // paintSwatches sizes each canvas for the screen and draws it.
  const painted = [];
  const canvas = (id) => ({ dataset: { swatch: id }, width: 0, height: 0, getContext: () => Object.assign(fakeCtx(), { setTransform(...a) { painted.push([id, a[0]]); }, arc() {} }) });
  const cs = [canvas('installed'), canvas('selected')];
  paintSwatches({ querySelectorAll: () => cs }, 2);
  assert.deepEqual(painted, [['installed', 2], ['selected', 2]]);
  assert.deepEqual([cs[0].width, cs[0].height], [SWATCH.w * 2, SWATCH.h * 2]);
  // Setup's own copy of the key (the one a phone's half sheet shows) lists the states too.
  const setup = read('panel/setup.js');
  assert.match(setup, /\$\$\('#suLegend'\)\.innerHTML = more \? more \+ states : '';/);
  assert.match(css(), /body\[data-detent=half\]:not\(\.calibrating\) \.legend\.states-only, body\[data-detent=full\]:not\(\.calibrating\) \.legend\.states-only \{ display: flex; \}/, 'the one-line key is on the map at every detent, on Setup too');
  assert.match(setup, /paintSwatches\(key\); paintSwatches\(\$\$\('#suLegend'\)\);/);
  assert.match(css(), /canvas\.sw\.rs, #stage canvas\.sw\.rs \{ position: static;/);
  const doc = design();
  assert.match(doc, /\*\*not lit is a line, lit is light,\s+selected is an outline\.\*\*/);
});

test('C3: a Reset view button, only while the camera is away from the default framing', async () => {
  const { RESET_VIEW, showResetView, doubleTap, fitHint, showFitHint } = await import('./static/map-control.js');
  // Absent, not disabled, at the default view; there after any move; never while calibrating or over a full sheet.
  assert.equal(showResetView({ away: false }), false);
  assert.equal(showResetView({ away: true }), true);
  for (const why of ['calibrating', 'failed', 'full']) assert.equal(showResetView({ away: true, [why]: true }), false, why);
  assert.equal(RESET_VIEW.label, 'Reset view');
  assert.ok(RESET_VIEW.ease > 0 && RESET_VIEW.ease <= 400, 'it eases back');
  // The hint line it replaced is gone, with its strings.
  assert.equal(fitHint, undefined);
  assert.equal(showFitHint, undefined);
  const app = read('app.js'), page = read('index.html'), sheet = css();
  assert.doesNotMatch(app + page + read('map-control.js'), /to see the whole house|fitHint/);
  // One named, focusable button beside the Preview/Lights toggle, in the page's markup, hidden until needed.
  assert.match(page, /<span class="seg" id="showSeg"[\s\S]*?<\/span>\s*<button type="button" id="resetView" class="reset-view" data-tip="[^"]+" hidden>Reset view<\/button>\s*<\/div>/);
  assert.equal((page.match(/<button[^>]*>Reset view<\/button>/g) || []).length, 1, 'one button');
  assert.match(sheet, /\.reset-view\[hidden\] \{ display: none; \}/);
  assert.match(app, /const show = showResetView\(\{ away: !!S\.view && !S\.view\.cameraState\(\)\.auto, calibrating: S\.calibrating,/);
  assert.match(app, /for \(const ev of \['camera', 'detent', 'view', 'tab'\]\) S\.on\(ev, renderReset\);/);
  assert.match(read('panel/calibrate.js'), /S\.renderReset\?\.\(\);/, 'entering and leaving Calibrate redraws it');
  // One press eases to the default framing, at once under reduced motion; the focus is not dropped when the button goes.
  assert.match(app, /S\.view\.resetView\(reducedMotion\.matches \? 0 : RESET_VIEW\.ease\);/);
  assert.match(app, /if \(had && !show\) \(\$\('showSeg'\)\.querySelector\('button\.on'\)/);
  // The default framing is the site's view fitted to the lights; the device's remembered camera is not touched.
  const scene = read('scene.js');
  const reset = scene.slice(scene.indexOf('    resetView(ease = 0) {'), scene.indexOf('    // forget clears the remembered camera'));
  assert.match(reset, /Object\.assign\(cam, siteView\(\), \{ mode: 'street', auto: true, fov: viewFov \}\);/);
  assert.match(reset, /if \(lights\.length\) d = centerOn\(cam\.dir, target, lights\);\s*glide\(cam\.dir, target, d, ease\);/);
  assert.doesNotMatch(reset, /save\(|remember\(/, 'Setup\'s Default changes the stored camera; this does not');
  assert.match(read('plan.js'), /resetView\(\) \{ this\.restore\(\); \},/);
  // The labels on the map keep clear of it, like the rest of the chrome.
  assert.ok((await import('./static/overlay.js')).CHROME.includes('#resetView'));
  // The double tap still fits, and one on a run still climbs the selection.
  assert.equal(doubleTap({ onRun: false }), 'fit');
  assert.equal(doubleTap({ onRun: true }), 'tap');
  assert.equal(doubleTap({ onRun: true, calibrating: true }), 'fit', 'the mode\'s own framing');
  assert.match(app, /const onRun = !S\.calibrating && was\.run >= 0;/, 'the run the first tap was on: the map may have moved under the finger since');
  assert.match(app, /tapAt\(t\.x, t\.y, was\.run\);/);
  assert.match(app, /if \(was\.cleared && !S\.sel\) select\(was\.cleared\.node, was\.cleared\.chain\);/, 'seeing the whole house does not cost the selection');
  // One button, not a toolbar: no view buttons came back.
  assert.doesNotMatch(page + app, /Fit lights|map-toolbar|data-view="(street|overhead|free|fit)"|>(Street|Overhead|Free|Fit)</i);
  assert.match(design(), /\*\*Reset view\*\*/);
});

test('C3: a double-tap fit leaves the view framed, not handed back to the user', () => {
  const scene = read('scene.js');
  // The tap that asks for the fit is a gesture the orbit controls hold; the fit's own move must not count as that gesture's.
  assert.match(scene, /function setView\(name\) \{\s*if \(name === 'fit'\) \{[\s\S]{0,420}?grab = null;\s*cam\.dir = camera\.position/);
  assert.match(scene, /fitAll\(\) \{\s*cancelAnimationFrame\(gliding\);\s*grab = null;/);
});

// ---------- T: a type system ----------

test('T: five sizes per pointer type, and every font size in the stylesheet is one of them', async () => {
  const sheet = css();
  const TOKENS = ['t-title', 't-section', 't-body', 't-sub', 't-fine'];
  const root = /:root \{([\s\S]*?)\n\}/.exec(sheet)[1];
  const fine = Object.fromEntries(TOKENS.map((t) => [t, +new RegExp(`--${t}: (\\d+)px;`).exec(root)[1]]));
  assert.deepEqual(fine, { 't-title': 24, 't-section': 17, 't-body': 14, 't-sub': 13, 't-fine': 12 });
  // Touch is each a step up, and both ways of being coarse say the same.
  const coarse = (rule) => Object.fromEntries(TOKENS.map((t) => [t, +new RegExp(`--${t}: (\\d+)px;`).exec(rule)[1]]));
  const narrow = /:root \{ --layout: sheet;([^}]*)\}/.exec(sheet)[1];
  const media = /@media \(pointer: coarse\) \{ :root \{([^}]*)\}/.exec(sheet)[1], forced = /html\.coarse \{([^}]*)\}/.exec(sheet)[1];
  assert.deepEqual(coarse(media), { 't-title': 26, 't-section': 18, 't-body': 15, 't-sub': 14, 't-fine': 13 });
  assert.deepEqual(coarse(forced), coarse(media));
  assert.deepEqual(coarse(narrow), coarse(media), 'a phone-width screen has the touch sizes');
  // No other size token is defined, and none is used.
  assert.deepEqual([...new Set([...sheet.matchAll(/--(t-[a-z0-9]+):/g)].map((m) => m[1]))].sort(), [...TOKENS].sort());
  assert.deepEqual([...new Set([...sheet.matchAll(/var\(--(t-[a-z0-9]+)\)/g)].map((m) => m[1]))].sort(), [...TOKENS].sort());
  // Every font-size, and every font shorthand that sets one, is a token: no px, em, rem or percentage.
  for (const m of sheet.matchAll(/font-size:\s*([^;}]+)/g)) assert.match(m[1], /^var\(--t-(title|section|body|sub|fine)\)$/, m[0]);
  for (const m of sheet.matchAll(/[^-]font:\s*([^;}]+)/g)) assert.match(m[1], /^(inherit|var\(--t-(title|section|body|sub|fine)\)[ /])/, m[0]);
  // Scripts set no size of their own on the page (the map's canvas labels are drawn, not styled).
  for (const f of ['app.js', 'sheet.js', 'form.js', 'tiles.js', 'panel/looks.js', 'panel/presets.js', 'panel/setup.js', 'panel/status.js', 'panel/calibrate.js', 'index.html']) assert.doesNotMatch(read(f), /font-size:|fontSize = [a-z0-9.]+ \+ 'px'|fontSize = ['`]\d/, f);
  // The one script that sizes text (a Status figure that would not fit) steps along the scale's own tokens.
  assert.match(read('panel/status.js'), /el\.style\.fontSize = `var\(--\$\{token\}\)`;/);
  assert.deepEqual((await import('./static/panel/status.js')).FIGURE_STEPS, ['t-section', 't-body', 't-sub']);
});

test('T: primary against secondary, the floor, weights, numerals and line length', () => {
  const sheet = css();
  const size = (sel) => { for (const m of sheet.matchAll(new RegExp(`(^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'g'))) { const t = /font(?:-size)?: var\(--(t-[a-z]+)\)/.exec(m[2]); if (t) return t[1]; } return assert.fail(`no size for ${sel}`); };
  // A name is primary; what explains it is secondary.
  assert.equal(size('.preset .name'), 't-body');
  assert.match(sheet, /\.preset \.name \{ font-size: var\(--t-body\); font-weight: 600;/);
  assert.equal(size('.layer .name-line b'), 't-body');
  assert.equal(size('small'), 't-sub');
  assert.equal(size('.stage-head small'), 't-sub');
  assert.equal(size('.stat span'), 't-sub');
  assert.equal(size('.cal-nudge-how'), 't-sub', 'the nudge instructions are read to act: not the fine size');
  assert.equal(size('.legend-toggle'), 't-sub');
  // The fine size is only for table heads and key hints.
  const fineUsers = [...sheet.matchAll(/(^|\n)\s*([^{}\n]+) \{[^}]*var\(--t-fine\)[^}]*\}/g)].map((m) => m[2].trim()).filter((s) => !/^(:root|html\.coarse|@media)/.test(s));
  assert.deepEqual(fineUsers.sort(), ['.calibrate kbd', '.power thead th', 'dialog.confirm kbd']);
  // Three weights: 400, 600, and 650 for the page title alone.
  const weights = [...sheet.matchAll(/([^{}\n]+)\{[^}]*font-weight: (\d+)/g)];
  assert.deepEqual([...new Set(weights.map((m) => m[2]))].sort(), ['400', '600', '650']);
  assert.deepEqual([...sheet.matchAll(/(^|\n)([^{}\n]+) \{[^}]*font-weight: 650/g)].map((m) => m[2].trim()), ['h1.title']);
  // Tabular numerals are the page's default.
  assert.match(sheet, /html, body \{[^}]*font-variant-numeric: tabular-nums;/);
  // Prose wraps at about 70 characters.
  assert.match(sheet, /p\.help, div\.help, \.tab > p\.muted, \.cal-nudge-how, \.stage-head small \{ max-width: 70ch; \}/);
  const doc = design();
  for (const t of ['--t-title', '--t-section', '--t-body', '--t-sub', '--t-fine']) assert.ok(doc.includes('`' + t + '`'), t);
  assert.match(doc, /Five sizes per pointer type/);
});

// ---------- Refinements ----------

test('Refinement 1: one name, one place', async () => {
  const { cardSubject } = await import('./static/inspect.js');
  const { stateLines, fitLine, SOMEWHERE, liveFold, sameLook, oneLane } = await import('./static/panel/looks.js');
  const app = read('app.js'), sheet = css();
  // Hovering a run shows the pointer's tag and nothing else: no timer opens the docked card.
  const hover = app.slice(app.indexOf('function hoverAt(x, y) {'), app.indexOf('// ---------- inspect ----------'));
  assert.doesNotMatch(hover, /inspect\(|setTimeout/);
  assert.match(hover, /hoverLabel\(p, x, y\);/);
  // The card is the selection's (named as the breadcrumb's last crumb is) or a pinned light's (named for its run).
  assert.match(app, /showSelectionCard\(\);\s*S\.emit\('select', S\.sel\);/);
  assert.match(app, /inspect\(S\.sel \? selPixel : -1\);/, 'unpinning goes back to the selection\'s card, or to none');
  const sel = { name: 'Porch', zone: 'Front', above: ['Front'] };
  assert.deepEqual(cardSubject({ selected: sel, run: 'Porch rail', zone: 'Front', chain: ['Front', 'Porch'] }), { name: 'Porch', zone: 'Front', chain: ['Front'] });
  assert.deepEqual(cardSubject({ pinned: true, selected: sel, run: 'Porch rail', zone: 'Front', chain: ['Front', 'Porch'] }), { name: 'Porch rail', zone: 'Front', chain: ['Front', 'Porch'] });
  assert.equal(cardSubject({ selected: { name: 'Front', zone: 'Front', above: [] } }).zone, '', 'a zone is not said to be in itself');
  // A crumb says its kind in its tooltip and in the folded menu, so an area and a run with alike names are told apart.
  assert.match(app, /title="\$\{esc\(cut \? name : `\$\{nodeKinds\(nd\)\} · \$\{nd\.count\} px`\)\}"/);
  assert.match(app, /<small>\$\{esc\(crumbKind\(nd\)\)\}<\/small>/);
  // A card that is live somewhere else says where, or "on part of the house": never "elsewhere".
  assert.equal(SOMEWHERE, 'on part of the house');
  assert.deepEqual(stateLines('Live on Porch rail'), ['Live on Porch rail', 'Live on part of the house', 'Live']);
  const fits = (n) => (t) => t.length <= n;
  assert.equal(fitLine(stateLines('Live on Porch rail'), fits(20)), 'Live on Porch rail');
  assert.equal(fitLine(stateLines('Live on the long north wing eave'), fits(26)), 'Live on part of the house');
  for (const f of ['panel/looks.js', 'panel/presets.js', 'library.js']) assert.doesNotMatch(read(f).replace(/\/\/[^\n]*/g, ''), /(Live|Previewing) elsewhere/, f);
  // "This look:" and its place are one line; too narrow, the control takes its own line and the rest wrap under it.
  assert.match(sheet, /\.place-row \{ display: flex; align-items: center; min-width: 0; min-height: var\(--tap\); flex: 0 0 auto; max-width: 100%; \}/);
  assert.match(sheet, /\.place b \{[^}]*display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
  assert.match(sheet, /\.layer \.controls \{ display: flex; flex-wrap: wrap;/);
  // One state marker per row: with every row in the state the heading names, no pill repeats it.
  assert.equal(oneLane({ preview: 1, live: 0 }), true);
  assert.equal(oneLane({ preview: 0, live: 2 }), true);
  assert.equal(oneLane({ preview: 1, live: 1 }), false, 'mixed rows keep their pills');
  assert.equal(oneLane({ preview: 0, live: 0 }), false);
  assert.match(sheet, /\.stage\.one-lane \.layer \.name-line \.kind \{ width: 0;/);
  // The same look live and previewing: the live rows fold to their one line on every layout.
  const key = (l) => l.preset;
  assert.equal(sameLook([{ preset: 'a' }], [{ preset: 'b' }, { preset: 'a' }], key), true);
  assert.equal(sameLook([{ preset: 'a' }], [{ preset: 'b' }], key), false);
  assert.deepEqual(liveFold({ compact: false, preview: 1, live: 1, open: false, same: true }), { summary: true, folded: true });
  assert.deepEqual(liveFold({ compact: false, preview: 1, live: 1, open: false, same: false }), { summary: false, folded: false }, 'different looks: both rows, as before');
  assert.deepEqual(liveFold({ compact: false, preview: 1, live: 1, open: true, same: true }), { summary: true, folded: false }, 'the chevron opens them');
  assert.match(sheet, /#lkRows\.same-look\.live-folded > \.layer\.house \{ display: none; \}/);
});

test('Refinement 2: Status tiles that read alone', async () => {
  const { tileFacts, tileHTML, lateFacts, lateLabel, LATE_SHARE } = await import('./static/panel/status.js');
  const base = { lit: 12, total: 12, health: { up: 3, n: 3, cls: 'ok', text: '' }, fps: { measured: 40, target: 40 } };
  const tiles = (o) => tileFacts({ ...base, ...o });
  // Four tiles, one structure: a value, then a label, then at most one muted line.
  for (const power of [null, { anyKnown: false, overall: '', limiting: '' }, { anyKnown: true, overall: '4.10 A', limiting: 'Off' }]) {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const html = tiles({ late: 3, frames: 144000, power }).map((f) => tileHTML(f, esc));
    assert.equal(html.length, 4);
    for (const h of html) assert.match(h, /^<(div|button)[^>]*><b>[^<]+<\/b><span>[^<]+(<svg[^]*?<\/svg>)?<\/span>(<small>[^<]+(<svg[^]*?<\/svg>)?<\/small>)?<\/(div|button)>$/);
  }
  // The power tile with nothing configured: a quiet dash, its own label, and the words as the link's line.
  const gap = tiles({ late: 0, power: { anyKnown: false, overall: '', limiting: '' } })[3];
  assert.deepEqual([gap.v, gap.label, gap.more], ['—', 'power estimate', 'Not configured']);
  // The late tile: a unit in its label and a period in its third line, with the share the server's counts give.
  const late = (n, frames) => tiles({ late: n, frames, power: null })[2];
  assert.deepEqual([late(3, 144000).v, late(3, 144000).label, late(3, 144000).more], ['3', 'late frames', 'since start · < 0.1%']);
  assert.deepEqual([late(1, 100).label, late(1, 100).more], ['late frame', 'since start · 1.0%']);
  assert.equal(late(0, 5000).more, 'since start · 0%');
  assert.equal(late(5000, 144000).more, 'since start · 3.5%');
  assert.equal(lateLabel(2), 'late frames');
  // Neutral up to 1% of frames, amber above.
  assert.equal(LATE_SHARE, 0.01);
  assert.equal(late(1, 100).cls, '');
  assert.equal(late(2, 100).cls, 'warn');
  assert.equal(lateFacts({ late: 2, frames: 100 }).line, 'since start · 2.0%');
  // Its explanation is one tap away, not a hover: the tile is a button that opens Diagnostics, where the one line is.
  assert.match(tileHTML(late(3, 144000)), /^<button type="button" id="stLateTile" class="stat link" title="[^"]*Opens the explanation under Diagnostics\."/);
  const status = read('panel/status.js');
  assert.match(status, /\$\$\('#stLateTile'\)\.onclick = \(\) => openDiagnostics\(\);/);
  assert.match(status, /<details id="stDiag"[^>]*><summary>Diagnostics<\/summary>[\s\S]*?id="stLateNote">\$\{LATE_NOTE\}<\/p><\/details>/);
  assert.match(design(), /"since start ·\s+0\.2%"/);
  // A phone's two rows of tiles are each as tall as their own tiles: no blank third line in the row that has none.
  assert.match(css(), /@media \(max-width: 699\.98px\) \{ \.tiles \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); grid-auto-rows: auto; \} \}/);
});

test('Refinement 3: even card rows: a grid with a two-line name keeps a two-line title slot in every card', async () => {
  const sheet = css();
  // Names clamp at two lines, as before, and every card reserves both: 2 lines at the name's 1.3 line height.
  assert.match(sheet, /\.preset \.name \{ font-size: var\(--t-body\); font-weight: 600; line-height: 1\.3; \}/);
  assert.match(sheet, /\.preset \.name \{\s*display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;/);
  // The slot is kept by every card of a grid in which some name takes two lines; a grid of one-line names is level without it.
  assert.match(sheet, /\n\.cards\.tall-names \.preset \.name \{ min-height: 2\.6em; \}/);
  const { tallNames } = await import('./static/panel/looks.js');
  assert.equal(tallNames([[18, 18.2], [18, 18.2]]), false);
  assert.equal(tallNames([[18, 18.2], [36, 18.2]]), true);
  assert.equal(tallNames([]), false);
  assert.match(read('panel/looks.js'), /grid\.classList\.toggle\('tall-names', tallNames\(/);
  // The one place it is not used: a phone's half detent, where it cost a floor (a whole row of the library).
  assert.match(sheet, /\nbody\[data-detent=half\] \.cards\.tall-names \.preset \.name \{ min-height: 0; \}/);
  assert.match(design(), /two-line title slot/);
});

test('Refinement 4: Calibrate\'s cluster marker is a count, and the key explains it', async () => {
  const { COUNT, clusterCount, clusterWords, clusterTitle, drawCluster, CLUSTER_KEY, MARKER, CLUSTER } = await import('./static/cal-points.js');
  const { STATE_KEY, statesShown, stateKeyHTML, drawSwatch } = await import('./static/map-control.js');
  // The figure is a count: a multiplication sign before it, in a smaller, quieter face than a point's name (600 14 px, white).
  assert.equal(clusterCount(3), '×3');
  assert.equal(clusterCount(12), '×12');
  assert.match(COUNT.font, /^600 11px /);
  assert.notEqual(COUNT.color, '#fff');
  // What the marker says for itself: its tooltip on the map and the head of its list.
  assert.equal(clusterWords(8), '8 points here');
  const clusters = [{ x: 100, y: 100, points: [1, 2, 3] }, { x: 300, y: 100, points: [1] }];
  assert.equal(clusterTitle(clusters, 104, 98), '3 points here: click to pick one');
  assert.equal(clusterTitle(clusters, 104, 98, true), '3 points here: tap to pick one');
  assert.equal(clusterTitle(clusters, 300, 100), '', 'a marker that stands alone is a point, not a cluster');
  assert.equal(clusterTitle(clusters, 200, 300), '');
  const cal = read('panel/calibrate.js'), app = read('app.js');
  assert.match(cal, /id="caCluster" role="group" aria-label="\$\{clusterWords\(clusterList\.length\)\}"><div class="cluster-head"><span><b>\$\{clusterWords\(clusterList\.length\)\}\.<\/b> Choose one:/);
  assert.match(app, /const title = S\.calibrating \? clusterTitle\(S\.overlay\.calClusters\(\), x, y, S\.coarse\) : '';/);
  // Drawn as a ring with the count inside; two digits take a wider ring.
  const ctx = Object.assign(fakeCtx(), { arcs: [], texts: [], arc(...a) { this.arcs.push(a); }, fill() {}, fillText(t) { this.texts.push([t, this.font]); } });
  assert.equal(drawCluster(ctx, 50, 50, 3), COUNT.radius);
  assert.deepEqual(ctx.texts, [['×3', COUNT.font]]);
  assert.equal(ctx.strokes[0].width, MARKER.width);
  assert.equal(drawCluster(ctx, 50, 50, 12), COUNT.wide);
  assert.ok(2 * COUNT.wide <= CLUSTER.coarse + 4, 'still smaller than the reach of a finger');
  // The key has an entry for it while one is on the map, drawn by the same code, after the target's.
  assert.deepEqual(STATE_KEY.find(([id]) => id === 'cluster'), ['cluster', CLUSTER_KEY]);
  assert.deepEqual(statesShown({ target: true, cluster: true }), ['target', 'cluster']);
  assert.match(stateKeyHTML(['cluster']), /<canvas class="sw rs tall" data-swatch="cluster" width="26" height="26"/);
  const sw = Object.assign(fakeCtx(), { texts: [], arc() {}, fill() {}, fillText(t) { this.texts.push(t); } });
  drawSwatch(sw, 'cluster', 26, 26);
  assert.deepEqual(sw.texts, ['×3']);
  const overlay = read('overlay.js');
  assert.match(overlay, /cluster: !!S\.calibrating && shown\(\)\.nodes && calClusters\.some\(\(c\) => c\.points\.length > 1\)/);
  // Every marker type Calibrate draws has its key entry: measured, estimated, point, shared corner (the points' key), the target and the cluster (the states').
  assert.match(overlay, /<i class="sw ring" style="color:#5ddc8a"><\/i>measured<\/span><span><i class="sw ring dash" style="color:#ffb347"><\/i>estimated<\/span>/);
  assert.ok(STATE_KEY.some(([id, words]) => id === 'target' && words === 'Calibrating this point'));
  assert.match(design(), /"×3" in a ring/);
});

test('Refinement 5: icon buttons say what they are, in a tooltip drawn in the page', async () => {
  const { tipSpot, tipFor, installTooltips, HOVER_MS, PRESS_MS } = await import('./static/tooltip.js');
  assert.equal(HOVER_MS, 400);
  assert.ok(PRESS_MS >= 400 && PRESS_MS <= 600, 'a long press');
  // Above the control, centered; below when there is no room above; held inside the viewport; never over the control.
  const a = { left: 100, right: 128, top: 200, bottom: 228 };
  assert.deepEqual(tipSpot(a, 80, 24, 1440, 900), { left: 74, top: 170, below: false });
  const top = { left: 100, right: 128, top: 8, bottom: 36 };
  assert.deepEqual(tipSpot(top, 80, 24, 1440, 900), { left: 74, top: 42, below: true });
  assert.equal(tipSpot({ left: 2, right: 30, top: 200, bottom: 228 }, 120, 24, 390, 844).left, 4);
  assert.equal(tipSpot({ left: 360, right: 388, top: 200, bottom: 228 }, 120, 24, 390, 844).left, 266);
  for (const [anchor, W, H] of [[a, 1440, 900], [top, 1440, 900], [{ left: 180, right: 210, top: 820, bottom: 840 }, 390, 844]]) {
    const at = tipSpot(anchor, 90, 24, W, H);
    assert.ok(at.top + 24 <= anchor.top || at.top >= anchor.bottom, 'never over its own control');
  }
  // Its text is the control's data-tip, unless the control already shows those words.
  assert.equal(tipFor({ dataset: { tip: 'Clear the selection' }, innerText: '' }), 'Clear the selection');
  assert.equal(tipFor({ dataset: { tip: 'Brightness' }, innerText: 'Brightness\n100%' }), '', 'a phone shows the word beside the icon already');
  assert.equal(tipFor({ dataset: {}, innerText: 'Preview' }), '');
  assert.equal(tipFor(null), '');
  // One element, aria-hidden: the control's accessible name stays its own.
  const made = [];
  const listeners = {};
  const doc = { createElement: () => { const el = { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } }; made.push(el); return el; }, body: { append() {} }, addEventListener: (ev) => { listeners[ev] = true; }, defaultView: { innerWidth: 1440, innerHeight: 900 } };
  const tips = installTooltips(doc);
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].id, made[0].hidden, made[0].attrs['aria-hidden']], ['tip', true, 'true']);
  for (const ev of ['pointerover', 'pointerout', 'focusin', 'focusout', 'keydown', 'pointerdown', 'pointerup']) assert.ok(listeners[ev], ev);
  // Shown for a control, placed, and hidden again.
  const control = { dataset: { tip: 'More: edit, duplicate or delete' }, innerText: '', isConnected: true, getBoundingClientRect: () => a };
  Object.assign(made[0], { offsetWidth: 180, offsetHeight: 24 });
  tips.show(control);
  assert.deepEqual([made[0].hidden, made[0].textContent, made[0].style.top], [false, 'More: edit, duplicate or delete', '170px']);
  tips.hide();
  assert.equal(made[0].hidden, true);
  const src = read('tooltip.js');
  assert.match(src, /if \(el && el !== shownFor\) later\(el, HOVER_MS\);/, 'hover: after 400 ms');
  assert.match(src, /if \(el && e\.target\.matches\?\.\(':focus-visible'\)\) show\(el\);/, 'keyboard focus: at once');
  assert.match(src, /later\(el, PRESS_MS\);/, 'touch: a long press');
  assert.match(src, /if \(!shownFor\.isConnected \|\| r\.bottom < 0 \|\| r\.top > view\.innerHeight \|\| !\(r\.width > 0\)\) hide\(\); else show\(shownFor\);/, 'a scroll moves it with its control: focusing a control scrolls it into view');
  assert.match(css(), /\.tip \{ position: fixed;[^}]*font-size: var\(--t-sub\);[^}]*pointer-events: none; \}/);
  assert.match(read('app.js'), /installTooltips\(document\);/);
  // Every icon-only control named in the plan has it, and none keeps a native title beside it.
  const uses = {
    'app.js': [/class="x" aria-label="Clear the selection" data-tip="Clear the selection">/, /aria-label="Dismiss" data-tip="Dismiss">/],
    'panel/looks.js': [/id="lkTargetClear" aria-label="Next look: back to Everything" data-tip="Back to Everything" hidden>/, /<div class="bri" data-tip="Brightness"><span class="bri-label">\$\{icon\('sun'\)\}/, /id="lkPickClose" aria-label="Close" data-tip="Close">/],
    'panel/presets.js': [/data-act="more"[^>]*data-tip="More: edit, duplicate or delete">\$\{icon\('more'\)\}/],
    'index.html': [/<div id="handle" class="handle" role="slider" tabindex="0" aria-label="Expand the panel" data-tip="Expand the panel"/, /id="railToggle" class="rail-toggle" data-tip="Collapse the panel" aria-label="Collapse the panel"/, /id="resetView" class="reset-view" data-tip="[^"]+" hidden>/],
    'field.js': [/class="field-clear"[^>]*data-tip="Clear" hidden>/],
    'form.js': [/rm\.dataset\.tip = 'Remove';/],
  };
  for (const [f, res] of Object.entries(uses)) for (const re of res) assert.match(read(f), re, `${f}: ${re}`);
  for (const f of ['index.html', 'app.js', 'field.js', 'panel/looks.js', 'panel/presets.js', 'panel/calibrate.js']) {
    for (const m of read(f).matchAll(/<[a-z]+\b[^>]*data-tip="[^>]*>/g)) assert.doesNotMatch(m[0], /\stitle="/, `${f}: a native title beside the tooltip: ${m[0].slice(0, 80)}`);
  }
  // Nothing else gained one: a control with words keeps to its words ("Hide key" stays a text button).
  const all = ['index.html', 'app.js', 'field.js', 'form.js', 'sheet.js', 'panel/looks.js', 'panel/presets.js', 'panel/setup.js', 'panel/status.js', 'panel/calibrate.js'].map(read).join('\n');
  assert.equal((all.match(/data-tip[=`]|dataset\.tip = /g) || []).length, 14); // the handle's is also set as its detent changes
  assert.doesNotMatch(read('panel/setup.js'), /data-tip|dataset\.tip/);
  assert.match(design(), /one small tooltip, drawn in the page/);
});

test('Refinement 6: the phone shell\'s edges: a toast row, a handle that says which way, Pinned the same on both', async () => {
  const { toastRow, sheetToastTop } = await import('./static/map-frame.js');
  const { handleWords, DETENT_WORDS } = await import('./static/sheet.js');
  const { moreGroup, showMore, moreHeading, MORE_OPEN, MORE_GAP } = await import('./static/panel/looks.js');
  const sheet = css(), app = read('app.js'), looks = read('panel/looks.js');
  const phone = sheet.slice(sheet.indexOf('@media (max-width: 699.98px)'));
  // (a) The sheet's toast has a row of its own above the tab bar: the scroll area gives up its height and a gap.
  assert.equal(toastRow({ height: 46 }), 54);
  assert.equal(toastRow({ height: 45.2 }), 54, 'whole pixels');
  assert.equal(toastRow({ height: 0 }), 0, 'no toast, no row');
  assert.equal(toastRow({ height: 46, bar: 60 }), 0, 'above the apply bar it sits as before: the bar does not move under a thumb');
  assert.match(phone, /\.content \{ flex: none; height: calc\(var\(--sheet-visible\) - var\(--handle\) - var\(--tabbar\) - var\(--safe-b\) - var\(--toast-row, 0px\)\);/);
  assert.match(app, /\$\('content'\)\.style\.setProperty\('--toast-row', toastRow\(\{ height: inSheet \? \$\('panelToasts'\)\.offsetHeight : 0, bar: bar \? bar\.offsetHeight : 0 \}\) \+ 'px'\);/);
  assert.match(app, /new MutationObserver\(\(\) => placeToasts\(\)\)\.observe\(\$\('panelToasts'\), \{ childList: true \}\);/, 'the row comes and goes with the toast');
  assert.equal(sheetToastTop({ visible: 540, bar: 0, safe: 48 }), 484, 'the toast itself is where it was: directly above the tab bar');
  // (b) The handle says which way a tap goes, in its name, its tooltip and its shape; there is still no Expand button.
  assert.equal(handleWords('peek'), 'Expand the panel');
  assert.equal(handleWords('half'), 'Expand the panel');
  assert.equal(handleWords('full'), 'Collapse the panel');
  assert.deepEqual(Object.keys(DETENT_WORDS), ['peek', 'half', 'full']);
  assert.match(read('sheet.js'), /handle\.setAttribute\('aria-label', handleWords\(d\)\);\s*handle\.dataset\.tip = handleWords\(d\);/);
  assert.match(phone, /\.handle i::before \{ left: 0; transform-origin: 100% 50%; transform: rotate\(-13deg\); \}/, 'up: the middle is the high point');
  assert.match(phone, /body\[data-detent=full\] \.handle i::before \{ transform: rotate\(13deg\); \}/, 'down at full');
  assert.doesNotMatch(read('index.html'), /<button[^>]*>\s*(Expand|Collapse)/);
  // (c) Pinned lists the same groups on both viewports: the pinned looks, then "More looks (N)" as a disclosure.
  const base = { filter: 'pinned', query: '', rest: 9, empty: 400, choice: null };
  assert.deepEqual(moreGroup({ ...base, layout: 'wide' }), { show: true, open: true }, 'beside the map, open when the pane would otherwise be empty');
  assert.deepEqual(moreGroup({ ...base, layout: 'wide', empty: MORE_GAP }), { show: true, open: false }, 'listed, closed, when the pinned looks fill the pane');
  assert.deepEqual(moreGroup({ ...base, layout: 'sheet', detent: 'full' }), { show: true, open: false }, 'a phone\'s full sheet: the same group, closed by default');
  assert.deepEqual(moreGroup({ ...base, layout: 'sheet', detent: 'half' }), { show: false, open: false }, 'a half sheet is unchanged');
  assert.deepEqual(moreGroup({ ...base, layout: 'sheet', detent: 'peek' }), { show: false, open: false });
  assert.deepEqual(moreGroup({ ...base, layout: 'sheet', detent: 'full', choice: true }), { show: true, open: true }, 'opened by hand, it stays open');
  assert.deepEqual(moreGroup({ ...base, layout: 'wide', choice: false }), { show: true, open: false }, 'closed by hand, it stays closed');
  for (const o of [{ filter: 'presets' }, { query: 'glit' }, { rest: 0 }]) assert.equal(moreGroup({ ...base, layout: 'wide', ...o }).show, false);
  assert.equal(showMore({ ...base, layout: 'wide' }), true);
  assert.equal(moreHeading(9), 'More looks (9)');
  assert.equal(MORE_OPEN, 'glowstack.looks.more');
  assert.match(looks, /<details id="lkMoreBox" class="lib-more" hidden><summary class="lib-group" id="lkMoreHead">More looks<\/summary><div class="cards" id="lkMore"><\/div><\/details>/);
  assert.match(looks, /\$\$\('#lkMoreHead'\)\.onclick = \(e\) => \{ e\.preventDefault\(\); save\(MORE_OPEN, !\$\$\('#lkMoreBox'\)\.open\); refitMore\(\); \};/);
  assert.match(looks, /for \(const ev of \['layout', 'preview', 'house', 'ready', 'detent'\]\) S\.on\(ev, refitMore\);/);
  assert.match(design(), /More looks \(9\)/);
});
