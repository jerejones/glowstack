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

test('F: Setup leads with calibration: a raised card, a bar that is done / total, one green button', async () => {
  const { progressBar } = await import('./static/cal-points.js');
  // The bar's fill is the count's fraction, to a tenth of a percent, and the words are the count.
  for (const [done, total] of [[40, 109], [0, 84], [33, 84], [84, 84], [1, 3]]) {
    const bar = progressBar(done, total);
    assert.ok(Math.abs(bar.share - done / total) < 1e-9);
    const width = +/width:([\d.]+)%/.exec(bar.html)[1];
    assert.ok(Math.abs(width / 100 - done / total) < 0.01, `${done}/${total}: ${width}%`);
    assert.equal(bar.words, `${done} of ${total} steps`);
    assert.match(bar.html, new RegExp(`role="progressbar"[^>]*aria-valuemax="${total}" aria-valuenow="${done}"`));
  }
  assert.equal(progressBar(0, 0).share, 0, 'nothing to count is an empty bar, not a division by zero');
  const setup = read('panel/setup.js');
  // The card is the first thing under the heading.
  assert.match(setup, /<h1 class="title">Set up the map<\/h1>\s*<section class="setup-cal lead" id="suCalCard"/);
  assert.match(setup, /id="suCalProgress" hidden><span id="suCalBar"><\/span><span class="muted small" id="suCalN"><\/span><\/div>\s*<div class="row"><button type="button" id="suCal" class="go icon-btn"><\/button><\/div>/, 'the bar and its count, then Calibrate at content width');
  assert.equal(setup.match(/class="go\b/g).length, 1, 'the one green control on Setup');
  // Complete: one line, and it stops leading.
  assert.match(setup, /complete \? `Calibrated: \$\{done\} of \$\{total\}` : bar\.words/);
  assert.match(setup, /card\.classList\.toggle\('lead', !complete\);/);
  assert.match(css, /\.setup-cal\.lead \{ background: var\(--card2\); border-left: 4px solid var\(--house\); box-shadow:/, 'a raised surface with a left accent');
  assert.match(css, /\.setup-cal\.complete \{ display: flex;[^}]*padding: 6px 12px;/);
  assert.match(css, /\.setup-cal\.complete button\.go \{ background: var\(--card\);/, 'no green once there is nothing left');
  assert.doesNotMatch(css, /\.setup-cal[^{]*\.go \{[^}]*width: 100%/, 'not the old full-width bar');
  // Calibrate's header shows the same bar.
  assert.match(read('panel/calibrate.js'), /\$\$\('#caBar'\)\.innerHTML = count \? progressBar\(st\.progress\.filter\(\(i\) => i\.done\)\.length, st\.progress\.length\)\.html : '';/);
});

test('F: markers too close to tell apart draw as one, and every point is reached in at most two taps', async () => {
  const { clusterPoints, clusterAt, tapsToReach, overlapShare, CLUSTER, MARKER } = await import('./static/cal-points.js');
  assert.deepEqual(CLUSTER, { coarse: 24, fine: 16 });
  const pt = (x, y, id) => ({ x, y, id });
  // Two points a finger cannot tell apart are one marker on a phone and two with a mouse.
  const pair = [pt(100, 100, 'a'), pt(118, 100, 'b'), pt(300, 100, 'c')];
  const coarse = clusterPoints(pair, CLUSTER.coarse);
  assert.deepEqual(coarse.map((c) => c.points.map((p) => p.id)), [['a', 'b'], ['c']]);
  assert.deepEqual([coarse[0].x, coarse[0].y], [109, 100], 'drawn at the middle of its points');
  assert.equal(clusterPoints(pair, CLUSTER.fine).length, 3);
  // Coincident points (a corner two runs share) are always one marker.
  assert.equal(clusterPoints([pt(50, 50, 'a'), pt(50, 50, 'b')], CLUSTER.fine).length, 1);
  // A row of evenly spaced points pairs up; it does not run together into one marker.
  const row = Array.from({ length: 12 }, (_, i) => pt(20 * i, 0, 'p' + i));
  const rowed = clusterPoints(row, CLUSTER.coarse);
  assert.ok(rowed.length >= 4 && Math.max(...rowed.map((c) => c.points.length)) <= 3, JSON.stringify(rowed.map((c) => c.points.length)));
  // Whatever goes in, every point comes out once, and no two markers are closer than the radius.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const radius of [CLUSTER.coarse, CLUSTER.fine]) {
    const pts = Array.from({ length: 109 }, (_, i) => pt(rnd() * 390, rnd() * 300, 'n' + i));
    const cs = clusterPoints(pts, radius);
    assert.equal(cs.reduce((a, c) => a + c.points.length, 0), pts.length);
    assert.equal(new Set(cs.flatMap((c) => c.points.map((p) => p.id))).size, pts.length);
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const d = Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y);
      assert.ok(d >= radius, `markers ${d} px apart`);
      // A cluster's disc is 11 px and its stroke 2: no two markers overlap by more than a quarter.
      assert.ok(overlapShare(d, 12) <= 0.25, `overlap ${overlapShare(d, 12)}`);
    }
    // One tap for a marker that stands alone, two through a cluster's list; a tap on a marker finds it.
    for (const c of cs) {
      assert.equal(tapsToReach(c), c.points.length > 1 ? 2 : 1);
      assert.equal(clusterAt(cs, c.x + 3, c.y - 2, radius), c);
    }
  }
  assert.equal(clusterAt(coarse, 200, 200, 24), null, 'a tap on nothing is not a marker');
  assert.equal(overlapShare(18, 9), 0);
  assert.equal(overlapShare(0, 9), 1);
  assert.ok(MARKER.radius * 2 + MARKER.width < CLUSTER.coarse, 'on a phone two resting markers never touch');
  // The overlay draws clusters with a count while calibrating; a tap on one opens a list instead of picking silently.
  const overlay = read('overlay.js'), cal = read('panel/calibrate.js'), app = read('app.js');
  assert.match(overlay, /clustered = clusterPoints\(pts, S\.coarse \? CLUSTER\.coarse : CLUSTER\.fine\);/);
  assert.match(overlay, /ctx\.fillText\(String\(c\.points\.length\), q\[0\], q\[1\] \+ 0\.5\);/);
  assert.match(app, /S\.calib\.tapAt\(x, y, p\);/);
  assert.match(cal, /if \(hit && hit\.points\.length === 1\) \{ pick\(hit\.points\[0\]\); return; \}\s*clusterList = hit \? hit\.points : null;/);
  assert.match(cal, /pointWords\(runLabel\(pt\.run\), pt\.n, pt\.of\)/, 'the list names the run and the point number');
  // Before a session a pick only says where Start begins: no light changes.
  assert.match(cal, /if \(C\.st\?\.active\) \{ session\.target\(\{ kind: 'anchor', run: pt\.run, node: pt\.node \}\); return; \}\s*picked = pt;/);
});

test('F: the current target is unmistakable', async () => {
  const { TARGET, MARKER, OTHERS, runPoints, pointWords } = await import('./static/cal-points.js');
  const { TARGET_COLOR, RUN_LINE } = await import('./static/map-control.js');
  assert.ok(TARGET.radius >= 1.5 * MARKER.radius, 'half again the radius of any other marker');
  assert.ok(TARGET.radius >= 1.5 * 11 - 3 && TARGET.width >= MARKER.width + 2, 'and at least 2 px thicker');
  assert.equal(TARGET.color, TARGET_COLOR, 'the one color kept for "current"');
  for (const style of Object.values(RUN_LINE)) assert.notEqual(style.color, TARGET.color);
  assert.equal(OTHERS, 0.4, 'every other marker drops to 40%');
  const overlay = read('overlay.js');
  assert.match(overlay, /ctx\.globalAlpha = S\.calibrating && S\.cal\?\.active && S\.cal\.target \? OTHERS : 1;/);
  assert.match(overlay, /ring\(q, on \? TARGET_RING\.radius : 10, on \? TARGET_RING\.color :/);
  assert.match(overlay, /if \(step && step\.kind === 'anchor' && step\.run === rp\.run && step\.node === rp\.node\) continue;/, 'the target is never inside a cluster');
  assert.match(overlay, /calClusters = clustered\.filter\(\(c\) => !at\.some\(/, 'and no marker is drawn under its ring');
  // Its label is always placed, inside the free map, whatever is in the way.
  const { placeLabels } = await import('./static/overlay.js');
  const measure = (l) => l.text.length * 7;
  const everywhere = () => true;
  const sheet = [{ x0: 0, x1: 390, y0: 0, y1: 56 }, { x0: 0, x1: 390, y0: 380, y1: 844 }];
  for (const [x, y] of [[200, 200], [380, 60], [5, 375], [200, 30], [200, 400]]) {
    const placed = placeLabels([{ text: 'Shed corner', x, y, color: '#fff', rank: 3 }, { text: 'Other', x: x + 4, y, color: '#fff', rank: 1 }], { avoid: sheet, width: 390, height: 844, measure, solid: everywhere, marks: [{ x0: 0, x1: 390, y0: 0, y1: 844 }] });
    const t = placed.find((p) => p.rank === 3);
    assert.ok(t, `the target's label at ${x},${y} is placed`);
    assert.ok(t.x0 >= 0 && t.x1 <= 390 && t.y0 >= 56 && t.y1 <= 380, `inside the free map: ${JSON.stringify([t.x0, t.y0, t.x1, t.y1])}`);
  }
  // In a step the other runs' names hide.
  assert.match(overlay, /const named = \(runs\) => stepRun === null \|\| !runs\.length \|\| runs\.includes\(stepRun\);/);
  assert.match(overlay, /if \(!o\.labels \|\| !named\(p\.runs\)\) continue;/);
  // Points are named by run and number.
  const run = { id: 'shed-eave', anchors: [{ node: 0, pixel: 0, source: 'end' }, { node: 1, pixel: 186, source: 'measured' }, { node: 2, pixel: 305, source: 'estimated' }, { node: 3, pixel: 481, source: 'end' }] };
  const nodes = [{ id: 'shed-se' }, { id: 'shed-sw' }, { id: 'shed-nw' }, { id: 'shed-ne' }];
  assert.deepEqual(runPoints(run, nodes), [{ run: 'shed-eave', node: 'shed-sw', pixel: 186, measured: true, n: 1, of: 2 }, { run: 'shed-eave', node: 'shed-nw', pixel: 305, measured: false, n: 2, of: 2 }]);
  assert.equal(pointWords('Shed eave', 2, 2), 'Shed eave, point 2 of 2');
});

test('F: Calibrate opens framed, and a step frames its run without taking the camera from a drag', async () => {
  const cal = read('panel/calibrate.js'), scene = read('scene.js');
  const { STEP_EASE, STEP_PAD } = await import('./static/panel/calibrate.js');
  assert.ok(STEP_EASE > 0 && STEP_EASE < 300, 'eases there in under 300 ms');
  assert.ok(STEP_PAD > 0.05, 'more room than a plain frame, so the runs beside it show');
  assert.match(cal, /if \(on\) S\.view\.fitAll\?\.\(\);/, 'entering the mode fits every run');
  assert.match(cal, /S\.view\.frameIds\(ids, \{ ease: calm\.matches \? 0 : STEP_EASE, pad: STEP_PAD \}\);/, 'no ease under reduced motion');
  assert.match(cal, /if \(ri >= 0 && S\.tree\) for \(const \[a, b\] of S\.tree\.runSets\[ri\]\)/, 'the whole run the point is on');
  assert.match(cal, /if \(S\.view\.dragging\?\.\(\)\) \{ setTimeout\(frameCursor, 300\); return; \}/, 'never while the map is being dragged');
  assert.match(cal, /if \(key === framed\) return;/, 'once per step: what the person moves is kept until the next step');
  // The view: a glide a drag cancels, a fit that is not remembered, and a drag flag that holds for the whole gesture.
  assert.match(scene, /controls\.addEventListener\('start', \(\) => \{\s*held = true;\s*cancelAnimationFrame\(gliding\);/);
  assert.match(scene, /controls\.addEventListener\('end', \(\) => \{ grab = null; held = false; \}\);/);
  assert.match(scene, /dragging: \(\) => held,/);
  const fit = scene.slice(scene.indexOf('fitAll() {'), scene.indexOf('// frameIds frames the given pixels'));
  assert.match(fit, /cam\.auto = true;\s*frame\(\);/);
  assert.doesNotMatch(fit, /remember\(\)/, 'the mode\'s framing is not saved as this device\'s camera');
  assert.match(read('plan.js'), /fitAll\(\) \{ auto = true; fit\(\); \},/);
  assert.doesNotMatch(read('index.html') + cal, /Reset view|Fit lights|data-view=/, 'framing by the mode, not a camera button');
});

test('F: the keys: minus and plus nudge, Shift is ten, Enter confirms, Escape asks to stop', async () => {
  const { calKey, NUDGE_KEYS } = await import('./static/cal-points.js');
  const key = (o) => ({ code: '', key: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...o });
  assert.deepEqual(calKey(key({ code: 'Minus', key: '-' })), { nudge: -1 });
  assert.deepEqual(calKey(key({ code: 'Equal', key: '=' })), { nudge: 1 }, 'the + key without Shift');
  assert.deepEqual(calKey(key({ code: 'Equal', key: '+', shiftKey: true })), { nudge: 10 });
  assert.deepEqual(calKey(key({ code: 'Minus', key: '_', shiftKey: true })), { nudge: -10 });
  assert.deepEqual(calKey(key({ code: 'NumpadAdd', key: '+' })), { nudge: 1 });
  assert.deepEqual(calKey(key({ code: 'NumpadSubtract', key: '-', shiftKey: true })), { nudge: -10 });
  assert.deepEqual(calKey(key({ code: 'Enter', key: 'Enter' })), { confirm: true });
  assert.deepEqual(calKey(key({ code: 'Escape', key: 'Escape' })), { stop: true });
  // Typing in a field is never taken; Enter on another button presses that button; shortcuts with a modifier are the browser's.
  for (const k of [{ code: 'Minus', key: '-' }, { code: 'Equal', key: '=' }, { code: 'Enter', key: 'Enter' }, { code: 'Escape', key: 'Escape' }]) assert.equal(calKey(key(k), { field: true }), null, k.key);
  assert.equal(calKey(key({ code: 'Enter', key: 'Enter' }), { button: true }), null);
  assert.deepEqual(calKey(key({ code: 'Minus', key: '-' }), { button: true }), { nudge: -1 });
  assert.equal(calKey(key({ code: 'Equal', key: '=', ctrlKey: true })), null, 'Ctrl + is the browser\'s zoom');
  assert.equal(calKey(key({ code: 'KeyA', key: 'a' })), null);
  // The pad shows its keys, on a fine pointer only; the dock keeps one primary.
  assert.deepEqual(NUDGE_KEYS, { '-10': 'Shift −', '-1': '−', 1: '+', 10: 'Shift +' });
  const cal = read('panel/calibrate.js');
  assert.match(cal, /<kbd>\$\{NUDGE_KEYS\[n\]\}<\/kbd>/);
  assert.match(cal, /id="caConfirm"[^>]*>\$\{icon\('check'\)\}Confirm<kbd>Enter<\/kbd>/);
  assert.match(css, /html\.coarse \.calibrate kbd \{ display: none; \}/);
  const dock = cal.slice(cal.indexOf('<div class="cal-dock"'), cal.indexOf('const $$ = (s) => root.querySelector(s);'));
  assert.equal(dock.match(/class="go\b/g).length, 1, 'Confirm is the dock\'s single primary');
  // Escape asks first, and stopping is the same Stop as the button's; the map's own Escape stands down.
  assert.match(cal, /else if \(k\.stop\) askStop\(\);/);
  assert.match(cal, /confirmDialog\(\{ title: 'Stop calibrating\?'[^}]*confirm: 'Stop', cancel: 'Keep calibrating', danger: true \}\);\s*asking = false;\s*if \(yes\) stop\(\);/);
  assert.match(cal, /if \(!open \|\| !C\.st\?\.active \|\| e\.defaultPrevented/, 'only while a step is on');
  assert.match(read('app.js'), /if \(S\.calibrating\) return; \/\/ calibration has its own keys/);
  // The warning and Stop are still there, as prominent as before.
  assert.match(cal, /warningHTML\('This changes the real lights until you stop\.'\)/);
  assert.match(cal, /<button type="button" id="caStop" class="danger icon-btn"/);
});

test('F: what is next is one line, and the last point can be fixed', async () => {
  const { nextTarget } = await import('./static/cal-points.js');
  const a = (run, node, done) => ({ target: { kind: 'anchor', run, node }, done });
  const progress = [a('eave', 'sw', true), a('eave', 'nw', false), a('tower', 'top', false), { target: { kind: 'link', from: 'top', to: 'mid' }, done: false }];
  assert.deepEqual(nextTarget(progress, null), { kind: 'anchor', run: 'eave', node: 'nw' }, 'before a session: the first point not done');
  assert.deepEqual(nextTarget(progress, { kind: 'anchor', run: 'eave', node: 'nw' }), { kind: 'anchor', run: 'tower', node: 'top' });
  assert.deepEqual(nextTarget(progress, { kind: 'anchor', run: 'tower', node: 'top' }), { kind: 'anchor', run: 'eave', node: 'nw' }, 'it wraps, as the server does');
  assert.equal(nextTarget([a('eave', 'sw', true), a('eave', 'nw', false)], { kind: 'anchor', run: 'eave', node: 'nw' }), null, 'the only one left is this one');
  assert.equal(nextTarget([a('eave', 'sw', true)], null), null);
  const cal = read('panel/calibrate.js');
  assert.match(cal, /<p class="cal-next" id="caNextLine"><b>Next:<\/b> \$\{upNext \? esc\(words\(upNext\)\) :/);
  // Back: the session reports the last confirmed target; the dock's Back reopens it.
  const { createSession } = await import('./static/panel/calibrate.js');
  const calls = [];
  const prev = { kind: 'anchor', run: 'eave', node: 'sw' };
  let state = { active: true, target: { kind: 'anchor', run: 'eave', node: 'nw' }, previous: prev, cursors: [{ index: 300 }], progress };
  const fetch = async (url, init = {}) => {
    calls.push([url.replace('/api/v1/calibration', ''), init.body ? JSON.parse(init.body) : null]);
    if (url.endsWith('/target')) state = { ...state, target: JSON.parse(init.body), cursors: [{ index: 186, estimate: 186, source: 'measured' }] };
    if (url.endsWith('/nudge')) state = { ...state, cursors: [{ ...state.cursors[0], index: state.cursors[0].index + JSON.parse(init.body).by }] };
    if (url.endsWith('/confirm')) state = { ...state, previous: state.target, stored: state.cursors[0].index };
    return { ok: true, status: 200, text: async () => JSON.stringify(state) };
  };
  const session = createSession({ fetch, storage: { getItem: () => null, setItem() {} }, onState() {} });
  await session.poll();
  await session.target(session.C.st.previous); // what Back does
  assert.deepEqual(session.C.st.target, prev);
  assert.equal(session.C.st.cursors[0].index, 186, 'reopened at its measured value');
  await session.nudge(-10); await session.nudge(-1);
  await session.confirm({ next: false });
  assert.equal(session.C.st.stored, 175, 'the second value is the one confirmed');
  assert.deepEqual(calls.map((c) => c[0]), ['', '/target', '/nudge', '/nudge', '/confirm']);
  assert.match(cal, /\$\$\('#caBack'\)\.onclick = \(\) => \{ if \(C\.st\?\.previous\) session\.target\(C\.st\.previous\); \};/);
  assert.match(cal, /id="caBack"[^>]*hidden>\$\{icon\('chevronLeft'\)\}Back to the previous point<\/button>/);
  assert.match(cal, /const back = active && st\.previous && JSON\.stringify\(st\.previous\) !== JSON\.stringify\(st\.target\) \? st\.previous : null;/);
  // Redo: every finished row offers it, and it reopens that row's target.
  assert.match(cal, /const redo = it\.done && !\(isHere && active\) \? `<button type="button" class="quiet redo" data-a="\$\{acts\.length - 1\}"[^>]*>Redo<\/button>` : '';/);
  assert.match(cal, /const go = \(\) => \(active \? session\.target\(it\.target\) : session\.start\(it\.target\)\);/);
  assert.match(cal, /e\.preventDefault\(\); e\.stopPropagation\(\); acts\[\+el\.dataset\.a\]\(\);/, 'a press on Redo is one request, not the row\'s as well');
});

test('F: progress reads at a glance: To do first and open, Done folded to a count', async () => {
  const { progressGroups } = await import('./static/cal-points.js');
  const a = (run, node, done) => ({ target: { kind: 'anchor', run, node }, done });
  const progress = [a('eave', 'sw', true), a('eave', 'nw', true), a('tower', 'top', false), a('fence', 'a', true), a('fence', 'b', false), a('porch', 'e', true), { target: { kind: 'gap', from: 'x', to: 'y' }, done: false }];
  const g = progressGroups(progress);
  assert.deepEqual(g.todo.map((x) => [x.key, x.done, x.total]), [['tower', 0, 1], ['fence', 1, 2], ['Between runs', 0, 1]], 'a run with anything left is To do, in the list\'s order');
  assert.deepEqual(g.done.map((x) => [x.key, x.done, x.total]), [['eave', 2, 2], ['porch', 1, 1]]);
  assert.equal(g.todoWords, '3 steps left in 3 runs');
  assert.equal(g.doneWords, '3 steps in 2 runs');
  assert.equal(g.todo.reduce((n, x) => n + x.items.length, 0) + g.done.reduce((n, x) => n + x.items.length, 0), progress.length, 'no step is dropped');
  const cal = read('panel/calibrate.js');
  assert.match(cal, /<h4 class="cal-part">To do <small class="muted">/);
  assert.match(cal, /<details class="cal-done" id="caDone"\$\{doneOpen \? ' open' : ''\}><summary>Done <small class="muted">\$\{esc\(sorted\.doneWords\)\}<\/small><\/summary>/, 'one line until opened');
  assert.ok(cal.indexOf('class="cal-part">To do') < cal.indexOf('class="cal-done"'), 'To do comes first');
  assert.match(cal, /<span class="g-bar" aria-hidden="true"><i style="width:\$\{Math\.round\(done \/ total \* 100\)\}%"><\/i><\/span><small class="muted">\$\{done\}\/\$\{total\}<\/small>/, 'each run has a small bar and n/n');
  assert.match(cal, /const doneOpen = openDone \|\| sorted\.done\.some\(\(gr\) => gr\.key === hereGroup\);/, 'Done opens by hand, or when the step is in it');
  // The map's hover shows on a run's row here too.
  assert.match(cal, /data-group="\$\{esc\(k\)\}" data-run-row="\$\{esc\(k\)\}"/);
  assert.match(cal, /S\.on\('hoverRun', markHover\);/);
  assert.match(design, /\*\*To do\*\*/);
});

test('Refinement 1: a phone\'s layer controls are grouped and the disclosure is labeled', () => {
  const looks = read('panel/looks.js');
  // The row is built in the desktop's order: place, brightness, Tweak, Remove.
  const row = /<div class="controls">[\s\S]*?<\/div>\s*<div class="note">/.exec(looks)[0];
  const at = (re) => row.search(re);
  assert.ok(at(/class="place-row"/) < at(/class="bri"/) && at(/class="bri"/) < at(/class="tweak icon-btn"/) && at(/class="tweak icon-btn"/) < at(/data-a="remove"/));
  // On the phone: row one is where it is and how bright, row two is Tweak then Remove.
  const phone = css.slice(css.indexOf('/* A row is one line until asked'));
  assert.match(phone, /\.layer \.place-row \{ grid-column: 1; grid-row: 1;/);
  assert.match(phone, /\.layer \.bri \{ grid-column: 2; grid-row: 1;/);
  assert.match(phone, /\.layer \.tweak \{ grid-column: 1; grid-row: 2;/);
  assert.match(phone, /\.layer \[data-a=remove\] \{ grid-column: 2; grid-row: 2;/);
  assert.doesNotMatch(phone, /\[data-a=remove\] span \{ display: none; \}/, 'Remove keeps its word');
  // The disclosure has a visible word, at the row's right, and still names the row for a screen reader.
  assert.match(looks, /class="icon-btn row-expand" aria-expanded="false"><span class="lbl">Controls<\/span>\$\{icon\('chevronDown'\)\}<\/button>/);
  assert.match(phone, /\.layer \.row-expand \{ display: inline-flex;[^}]*grid-column: 5; grid-row: 1; \}/);
  assert.match(looks, /el\.querySelector\('\.row-expand'\)\.setAttribute\('aria-label', line\.label\);/);
});

test('Refinement 2: nested cards step their background; Tweak\'s labels sit on the look name\'s edge', () => {
  // The Tweak form and the color mixer inside it have no border of their own: with the stage's, a setting label is at most two bordered surfaces deep.
  assert.match(css, /^\.form \{ background: var\(--card2\); border: 0;/m);
  assert.match(css, /^\.form \.color-mixer \{[^}]*background: #151a22; border: 0;/m);
  // The stronger outline is the primary card's (and popovers that float over the page).
  const strong = css.split('\n').filter((l) => /border: 1px solid var\(--line-strong\)/.test(l)).map((l) => l.trim().split(' {')[0]);
  for (const sel of strong) assert.match(sel, /^(\.stage|\.setup-cal|\.hover-label|\.target-picker|\.preset-menu|\.picker-pop)/, sel);
  assert.ok(strong.includes('.stage'), 'the primary card keeps it');
  // The form hangs under the look's name: looks.js measures where the name starts.
  assert.match(css, /\.layer \.slot > \.form \{ margin-left: var\(--name-in, 0px\); \}/);
  const looks = read('panel/looks.js');
  assert.match(looks, /const inset = name\.getBoundingClientRect\(\)\.left - form\.getBoundingClientRect\(\)\.left - \(parseFloat\(getComputedStyle\(form\)\.paddingLeft\) \|\| 0\);/);
  assert.match(looks, /c\.el\.querySelector\('\.slot'\)\.append\(form\.el\);\s*alignForm\(c\);/);
  assert.match(looks, /function fitControls\(c\) \{\s*alignForm\(c\);/, 'kept through a resize');
});

test('Refinement 3: the phone\'s search opens fully, with the list as a chip that still switches', async () => {
  const { chipFilter } = await import('./static/panel/looks.js');
  // A tap on a segment lists it; a tap on the chip beside an open search moves to the next list, around.
  assert.equal(chipFilter('effects', false), 'effects');
  assert.equal(chipFilter('pinned', true), 'presets');
  assert.equal(chipFilter('presets', true), 'effects');
  assert.equal(chipFilter('effects', true), 'pinned');
  const looks = read('panel/looks.js');
  assert.match(looks, /filter = chipFilter\(b\.dataset\.filter, b\.classList\.contains\('on'\) && searchingNow\(\)\);/);
  assert.match(looks, /\$\$\('#lkFilter'\)\.addEventListener\('mousedown', \(e\) => \{ if \(searchingNow\(\)\) e\.preventDefault\(\); \}\);/, 'the tap does not take the focus, so the row does not fold under the finger');
  // While searching: the field has the row, the other segments are out of it, the chip is as narrow as its word.
  const phone = css.slice(css.indexOf('/* The search takes the row while in use'));
  assert.match(phone, /body\[data-detent\] \.lib-filters \.field\.searching \{ flex: 1 1 100%; \}/);
  assert.match(phone, /\.lib-filters:has\(\.field\.searching\) \.seg > button:not\(\.on\) \{ display: none; \}/);
  assert.match(phone, /\.lib-filters:has\(\.field\.searching\) \.seg > button\.on \{ padding: 0 6px; gap: 0; font-size: var\(--t-s\);/);
  assert.match(css, /\.lib-filters \.seg > button > \.icon \{ display: none; \}/, 'the chip is its word');
  // The chip names the list, and the search is searching from focus: blur with nothing typed folds it back.
  const { searching } = await import('./static/field.js');
  assert.equal(searching(true, ''), true);
  assert.equal(searching(false, 'glitter'), true);
  assert.equal(searching(false, ''), false);
  assert.match(css, /\.lib-filters \{ display: flex; flex-wrap: nowrap;/, 'one line in every state: the results do not move');
});

test('Refinement 4: the power tile says "Not configured" and is a link; qualifiers sit by their headings', async () => {
  const { tileFacts, tileHTML } = await import('./static/panel/status.js');
  const facts = tileFacts({ lit: 0, total: 0, health: { up: 8, n: 8, cls: 'ok', text: '' }, late: 0, fps: { measured: 40, target: 40 }, power: { overall: 'Unknown', limiting: 'Unknown', partial: false, anyKnown: false } });
  assert.equal(facts[3].v, 'Not configured');
  assert.match(facts[3].title, /Go to the Power section\.$/);
  const tile = tileHTML(facts[3]);
  assert.match(tile, /^<button type="button" id="stPowerTile" class="stat link" title="/, 'a button, with a tooltip');
  assert.match(tile, /<span>power estimate<svg/, 'a chevron after its label');
  assert.doesNotMatch(tileHTML(facts[0]), /link|<svg/, 'the plain tiles are not links');
  assert.match(css, /button\.stat \{[^}]*cursor: pointer; \}/);
  assert.match(css, /button\.stat\.link:hover span, button\.stat\.link:focus-visible span \{ text-decoration: underline;/);
  // Activating it brings the Power heading into view and moves the focus there.
  const status = read('panel/status.js');
  assert.match(status, /<h2 class="status-head" id="stPowerHead" tabindex="-1">Power /);
  assert.match(status, /head\.scrollIntoView\(\{ block: 'start', behavior: 'smooth' \}\);\s*head\.focus\(\{ preventScroll: true \}\);/);
  // The qualifiers are 8 px after their headings, not flush right.
  const head = /^\.status-head \{[^}]*\}/m.exec(css)[0];
  assert.match(head, /gap: 0 4px;/);
  assert.doesNotMatch(css, /\.status-head > small \{[^}]*margin-left: auto/);
  assert.doesNotMatch(css, /\.status-head > small \{[^}]*text-align: right/);
  assert.match(status, /Controllers <small id="stCtlShared"><\/small>/);
  assert.match(status, /Runs <small>drawn vs measured length<\/small>/);
});

test('Refinement 5: a selected segment is 3:1 and heavier; the phone chip keeps its second line', async () => {
  // The segment: fill against fill at least 3:1, and a weight change.
  const hex = (name) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(css)[1];
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  assert.ok(ratio(hex('seg-on'), hex('card2')) >= 3, `selected against unselected: ${ratio(hex('seg-on'), hex('card2'))}`);
  assert.ok(ratio('#ffffff', hex('seg-on')) >= 4.5, 'its white label still reads');
  assert.match(css, /^\.seg > button\.on \{ background: var\(--seg-on\); color: #fff; font-weight: 600;/m);
  assert.match(css, /^\.seg > button \{[^}]*background: var\(--card2\);/m);
  for (const where of ['.map-controls', '.chipbar']) assert.match(css, new RegExp(`\\${where} \\.seg > button\\.on \\{ background: var\\(--seg-on\\); \\}`));
  // The phone's chip: two lines in every state, the second kept empty when there is nothing for it.
  const { badgeHTML } = await import('./static/map-status.js');
  const reserved = /<span class="detail reserved" aria-hidden="true">&nbsp;<\/span><\/span>$/;
  assert.match(badgeHTML({ text: 'Showing your preview', detail: '' }, true), reserved);
  assert.match(badgeHTML({ text: 'Showing your preview', detail: '' }, true), /^<span class="stack"><span>Showing your preview<\/span>/);
  assert.match(badgeHTML({ short: 'Target pattern', text: 'Target pattern', detail: '' }, true), reserved);
  const two = badgeHTML({ text: 'Lights: nothing lit', detail: ' · no looks on them' }, true);
  assert.match(two, /^<span class="stack"><span>Lights: nothing lit<\/span><span class="detail">no looks on them<\/span><\/span>$/);
  assert.doesNotMatch(badgeHTML({ text: 'Showing your preview', detail: '' }), /stack|reserved/, 'the desktop chip is one line, as before');
  assert.match(css, /body\.calibrating \.badge \.detail \{ visibility: hidden; \}/, 'kept while calibrating too');
});

test('Refinement 6: the desktop Looks panel fills with "More looks" when the Pinned list leaves room', async () => {
  const { showMore, MORE_GAP } = await import('./static/panel/looks.js');
  assert.equal(MORE_GAP, 120);
  const base = { layout: 'wide', filter: 'pinned', query: '', rest: 8, empty: 400 };
  assert.equal(showMore(base), true);
  assert.equal(showMore({ ...base, empty: 120 }), false, 'only when more than 120 px would be empty');
  assert.equal(showMore({ ...base, empty: 121 }), true);
  assert.equal(showMore({ ...base, layout: 'sheet' }), false, 'not on the phone');
  assert.equal(showMore({ ...base, layout: 'side' }), true);
  assert.equal(showMore({ ...base, filter: 'presets' }), false, 'the other segments list everything they have already');
  assert.equal(showMore({ ...base, query: 'glit' }), false, 'a search is the list it asked for');
  assert.equal(showMore({ ...base, rest: 0 }), false, 'nothing left to show');
  const looks = read('panel/looks.js');
  // Pinned first and labeled, then More looks: the unpinned presets, then the effects, as the same cards.
  assert.match(looks, /<h3 class="group-head lib-group" id="lkPinnedHead" hidden>Pinned<\/h3>\s*<div class="cards" id="lkPresets"><\/div>\s*<div id="lkMoreBox" hidden><h3 class="group-head lib-group" id="lkMoreHead">More looks<\/h3><div class="cards" id="lkMore"><\/div><\/div>/);
  assert.match(looks, /\[\.\.\.lookCards\.presets\(unpinned\), \.\.\.lookCards\.effects\(effects\)\]/);
  assert.match(looks, /\$\$\('#lkPinnedHead'\)\.hidden = !show;/);
  // Measured against the apply bar's place; the segments and the bar are not touched.
  assert.match(looks, /const floor = bar && !bar\.hidden && bar\.offsetParent \? bar\.getBoundingClientRect\(\)\.top : content\.getBoundingClientRect\(\)\.bottom;/);
  const more = looks.slice(looks.indexOf('function renderMore()'), looks.indexOf('// A tap on a segment lists that segment.'));
  assert.doesNotMatch(more, /lkFilter|lkBar'\)\.hidden =|filter =/);
  // Its cards behave as the list's own: marked while previewing or live, pointing at the map, their swatches animated.
  assert.match(looks, /for \(const b of root\.querySelectorAll\('\.preset'\)\)/);
  assert.match(looks, /pointOn\(\$\$\('#lkMore'\), '\.preset', here, S\);/);
  assert.match(looks, /S\.tiles\?\.watch\(\$\$\('#lkMore'\)\);/);
  // The stage is still the first thing in the tab: a preview leads.
  assert.ok(looks.indexOf('<section class="stage" id="lkStage"') < looks.indexOf('<section class="library"'));
});
