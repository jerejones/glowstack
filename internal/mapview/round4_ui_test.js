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

test('B145: the fit margin scales with the pane and counts a marker\'s ring', async () => {
  const { framePad, frameMargin, FRAME_MARGIN, MARKER_RING, fitDepth } = await import('./static/map-frame.js');
  assert.equal(FRAME_MARGIN, 0.04);
  // At least 4% of the free rectangle's width at each side, never under 12 px, at every pane width.
  for (const width of [320, 390, 700, 860, 940, 1340, 2560]) {
    const { side } = framePad({ width, height: 600 });
    assert.ok(side >= width * 0.04 - 0.05 && side >= 12, `${width}: ${side}`);
  }
  // The two desktop panes at 1440x900 clear 36 px; a phone gives up under 16 px a side.
  assert.ok(framePad({ width: 860, height: 800 }).side >= 36.5);
  assert.ok(framePad({ width: 940, height: 800 }).side >= 38);
  assert.ok(framePad({ width: 390, height: 240 }).side <= 16);
  // The same proportion above and below (frameInsets has taken 6 px already), and a phone's short band keeps its 8 px.
  const tall = framePad({ width: 860, height: 800 });
  assert.ok(tall.edge + 6 >= 800 * 0.04 && Math.abs((tall.edge + 6) / 800 - tall.side / 860) < 0.005, JSON.stringify(tall));
  assert.ok(framePad({ width: 390, height: 240 }).edge + 6 >= 9);
  assert.ok(frameMargin(940) > frameMargin(390));
  // Where markers are drawn their ring is framed too, at the sides and above and below.
  const plain = framePad({ width: 940, height: 700 }), marked = framePad({ width: 940, height: 700, markers: true });
  assert.equal(Math.round((marked.side - plain.side) * 10) / 10, MARKER_RING);
  assert.equal(Math.round((marked.edge - plain.edge) * 10) / 10, MARKER_RING);
  assert.ok(MARKER_RING >= 11 + 1, 'Wiring\'s ring is 11 px and its stroke 2');
  // A point at the depth the fit gives draws its dot inside the pad.
  const k = 800 / (2 * Math.tan(20 * Math.PI / 180)), half = 430, pad = plain.side;
  const depth = fitDepth(12, 0.033, k, half, pad);
  assert.ok(12 * k / depth + Math.max(1.5, 1.35 * 0.033 * k / depth / 2) <= half - pad + 1e-6);
  // app.js passes the free rectangle and whether markers show; the fit looks at every light, not a sample.
  const app = read('app.js');
  assert.match(app, /framePad\(\{ width: stage\.width, height: stage\.height - top - bottom, markers: /);
  assert.match(app, /shown\.nodes \|\| shown\.mode === 'outputs'/);
  assert.match(read('scene.js'), /Math\.floor\(n \/ 30000\)/);
  assert.match(read('plan.js'), /Math\.max\(W - 2 \* padSide, 1\) \/ w/);
  assert.doesNotMatch(read('index.html') + app, /Reset view|Fit lights|map-toolbar/i, 'default framing only: no new control');
  assert.match(design, /at least 4% of the free rectangle/);
});

test('B146: the sheet\'s grabber and tabs are an opaque header; the first card is whole at rest', () => {
  // The fade that says "scrolled" is drawn only while something is scrolled under the content's top edge.
  const fade = /\.content::before \{[^}]*\}/.exec(css)[0];
  assert.match(fade, /opacity: 0;/, 'at rest the fade is not drawn over the first card\'s top border');
  assert.match(css, /\.content\.scrolled::before \{ opacity: 1; \}/);
  const sheet = read('sheet.js');
  assert.match(sheet, /classList\.toggle\('scrolled', \$\('content'\)\.scrollTop > 0\)/);
  assert.match(sheet, /addEventListener\('scroll', markScrolled/);
  // On the phone the grabber and the tab strip have their own opaque background, and the content is its own scroller below them.
  const phone = css.slice(css.indexOf('/* bottom sheet */'));
  assert.match(phone, /\.handle, \.tabs \{ background: var\(--panel-bg\); \}/);
  assert.match(phone, /body\[data-detent=half\] \.content, body\[data-detent=full\] \.content \{ overflow-y: auto; \}/);
  const html = read('index.html');
  assert.ok(html.indexOf('id="handle"') < html.indexOf('class="tabs"') && html.indexOf('class="tabs"') < html.indexOf('id="content"'), 'header first, then the scroller');
  assert.doesNotMatch(/\.tabs \{[^}]*\}/.exec(phone)[0], /position: (sticky|absolute)/, 'the tabs are not laid over the content');
  // The first card starts with a gap under the tab strip, so its border and both corners show.
  assert.match(css, /body\[data-detent=half\] \.stage \{ padding: 6px 8px; margin: 4px 0 6px; \}/);
});

test('C2: the tap hint is said once, on the Looks map, and says what the tap does', async () => {
  const { tapHint, showTapHint } = await import('./static/map-control.js');
  assert.equal(tapHint('Tap'), 'Tap a run on the map to choose where the next look goes.');
  assert.equal(tapHint('Click'), 'Click a run on the map to choose where the next look goes.');
  // On Looks only, until the first selection, never while calibrating.
  assert.equal(showTapHint({ seen: false, selected: false, tab: 'looks' }), true);
  for (const tab of ['presets', 'setup', 'status']) assert.equal(showTapHint({ seen: false, selected: false, tab }), false, tab);
  assert.equal(showTapHint({ seen: false, selected: false, tab: 'looks', calibrating: true }), false);
  assert.equal(showTapHint({ seen: true, selected: false, tab: 'looks' }), false, 'after one selection, never again');
  assert.equal(showTapHint({ seen: false, selected: true, tab: 'looks' }), false);
  // One caller: the map's caption. Its text is in the page only while it shows, and the tab change redraws it.
  const sources = ['app.js', 'panel/looks.js', 'panel/presets.js', 'panel/setup.js', 'panel/status.js', 'panel/calibrate.js', 'states.js', 'index.html'].map(read);
  assert.equal(sources.join('').match(/tapHint\(/g).length, 1, 'tapHint is called in one place');
  const app = read('app.js');
  assert.match(app, /showTapHint\(\{ seen: hintSeen\(\), selected: !!S\.sel, tab: S\.panel\.tab\(\),/);
  assert.match(app, /box\.textContent = box\.hidden \? '' : tapHint\(/);
  assert.match(app, /S\.on\('tab', renderHint\);/);
  // No string describes selecting as lighting.
  for (const src of sources) assert.doesNotMatch(src, /to light just|light just that part|run on the map to light/i);
  assert.doesNotMatch(read('panel/looks.js'), /lkTip/);
  assert.match(design, /choose where the\s+next look goes/);
});

test('C2: no halo at rest; the halo is for a selection or for what the panel points at', async () => {
  const control = await import('./static/map-control.js');
  assert.equal(control.restPoint, undefined);
  const app = read('app.js');
  assert.doesNotMatch(app, /restPoint/);
  const point = app.slice(app.indexOf('function applyPoint()'), app.indexOf('S.applyPoint = applyPoint;'));
  assert.match(point, /let show = pointed;/);
  assert.doesNotMatch(point, /targetRanges|detent/, 'nothing but what is pointed at is ever shown');
});

test('C2: one state language for runs on the map', async () => {
  const { RUN_LINE, TARGET_COLOR, runLit, unlitRuns, LINGER, statesShown, stateKeyHTML, STATE_KEY } = await import('./static/map-control.js');
  // The installed line: neutral (no hue), thin, at least 3:1 on the map's background, and not the selection's width.
  const rgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(RUN_LINE.installed.color).slice(1).map(Number);
  assert.ok(rgb[0] === rgb[1] && rgb[1] === rgb[2], 'neutral gray');
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  assert.ok(ratio(rgb, [13, 14, 16]) >= 3, `contrast ${ratio(rgb, [13, 14, 16])}`);
  assert.ok(RUN_LINE.installed.width <= 2 && RUN_LINE.installed.width < 15, 'thin: the halo is 15 px or more');
  // Hovered is brighter and wider; warned is amber and wider still; the target has the one reserved color.
  assert.ok(RUN_LINE.hovered.width > RUN_LINE.installed.width && RUN_LINE.warned.width > RUN_LINE.hovered.width);
  assert.notEqual(RUN_LINE.hovered.color, RUN_LINE.installed.color);
  assert.equal(RUN_LINE.warned.color, 'rgb(245, 158, 11)');
  assert.equal(TARGET_COLOR, '#22d3ee');
  for (const style of Object.values(RUN_LINE)) assert.notEqual(style.color, TARGET_COLOR);
  // A run is lit when any of its pixels is; a lit run has no line, and keeps none for LINGER after going dark.
  const frame = new Uint8Array(30);
  assert.equal(runLit(frame, [[0, 9]]), false);
  frame[3 * 7 + 1] = 40;
  assert.equal(runLit(frame, [[0, 4]]), false);
  assert.equal(runLit(frame, [[0, 4], [6, 9]]), true);
  const seen = [];
  assert.deepEqual(unlitRuns([false, true, false], seen, 1000), [0, 2]);
  assert.deepEqual(unlitRuns([false, false, false], seen, 1000 + LINGER - 1), [0, 2], 'just dark: still no line');
  assert.deepEqual(unlitRuns([false, false, false], seen, 1000 + LINGER), [0, 1, 2]);
  // The key lists a state only while it is on screen, in one order, on one line.
  assert.deepEqual(statesShown({}), []);
  assert.equal(stateKeyHTML([]), '');
  assert.deepEqual(statesShown({ previewed: true, installed: true, hovered: false }), ['installed', 'previewed']);
  assert.deepEqual(statesShown({ target: true, selected: true, installed: true, hovered: true, warned: true, previewed: true }), STATE_KEY.map(([id]) => id));
  const key = stateKeyHTML(['installed', 'selected']);
  assert.match(key, /^<div class="key states"><span data-state="installed"><i class="sw rs line"><\/i>Not lit<\/span><span data-state="selected"><i class="sw rs halo"><\/i>Selected<\/span><\/div>$/);
  assert.match(css, /\.legend\.states-only \.key\.states \{ flex-wrap: nowrap; \}/, 'one line');
  assert.match(css, /\.sw\.rs\.line \{ background: rgb\(122, 122, 122\); \}/, 'the key shows the line as it is drawn');
  // The overlay draws the lines under everything else, only over the live colors, never in a calibration step.
  const overlay = read('overlay.js');
  assert.match(overlay, /if \(o\.mode === 'live' && S\.rgb && S\.tree && !\(S\.calibrating && S\.cal\?\.active\)\)/);
  assert.match(overlay, /runLines\(o\);\s*if \(o\.mode === 'flow'/);
  assert.match(overlay, /if \(unlit\.has\(hovered\)\) \{ strokeRun\(all\[hovered\], RUN_LINE\.hovered\);/);
  // The key is repainted when the states change, and a states-only key takes nothing from the framing.
  assert.match(read('panel/setup.js'), /key\.classList\.toggle\('states-only', !!states && !\(legendHTML \+ note\)\);/);
  assert.match(read('app.js'), /\|\| \$\('legend'\)\.classList\.contains\('states-only'\);/);
  for (const word of ['Installed, not lit', 'Hovered', 'Selected', 'Previewed', 'Calibration target']) assert.ok(design.includes(`| ${word}`), word);
});

test('C2: the map points at the panel, and a warning outlines its run in amber', async () => {
  const { markRunRows } = await import('./static/panel/status.js');
  const rows = ['shed-eave', 'fence-west', 'porch'].map((id) => { const cls = new Set(); return { dataset: { runRow: id }, cls, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } }; });
  const root = { querySelectorAll: () => rows };
  for (const id of ['fence-west', 'porch', 'shed-eave']) {
    markRunRows(root, id);
    assert.deepEqual(rows.filter((r) => r.cls.has('map-hover')).map((r) => r.dataset.runRow), [id], 'that row and no other');
  }
  markRunRows(root, '');
  assert.equal(rows.filter((r) => r.cls.has('map-hover')).length, 0);
  const app = read('app.js'), status = read('panel/status.js');
  assert.match(app, /S\.emit\('hoverRun', S\.hoveredRun\);/);
  assert.match(app, /hoverRun\(-1\);/, 'leaving the map clears it');
  assert.match(status, /S\.on\('hoverRun', markHoverRun\);/);
  assert.match(status, /markRunRows\(root, S\.hoveredRun \|\| ''\); \/\/ rows redrawn by a poll keep the map's hover/);
  assert.match(css, /\.list-rows li\[data-run-row\]\.map-hover[^{]*\{ background: var\(--card\);/, 'the row\'s own hover background');
  // The warning: its row carries the run, and pointing at it sets the amber outline and nothing else.
  assert.match(status, /data-warn-run="\$\{esc\(it\.fix\.run\)\}"/);
  assert.match(status, /S\.warnRun\?\.\(el\.dataset\.warnRun \|\| el\.dataset\.runRow\)/);
  assert.match(app, /S\.warnRun = \(id\) => \{/);
  assert.match(read('overlay.js'), /if \(all\[warned\]\) \{ strokeRun\(all\[warned\], RUN_LINE\.warned\);/);
});

test('C2: the next look\'s target is told from a layer\'s without reading the label', async () => {
  const { targetControl, placeControl } = await import('./static/panel/looks.js');
  const next = targetControl('Everything', true);
  assert.match(next.aria, /next/);
  assert.equal(next.title, 'Where the next look goes');
  assert.doesNotMatch(placeControl('Everything').title, /next/);
  const looks = read('panel/looks.js');
  assert.match(looks, /id="lkTarget"[^>]*title="Where the next look goes"/);
  assert.match(looks, /<h2 class="group-head">Library<\/h2>\s*<div class="target-ctl">/, 'beside the Library heading');
  assert.match(css, /\.catalog-head \{[^}]*justify-content: flex-start;/);
  assert.match(looks, /className: 'place target-select'/, 'the row\'s control is made inside its row');
});
