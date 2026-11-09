// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression tests for bugs found in UI review. Run with:
// node --test internal/mapview/regressions_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (f) => fs.readFileSync(path.join(__dirname, 'static', f), 'utf8');
const css = read('ui.css');

test('desktop calibration frames most of the stage: the toggle at the bottom is no top inset', async () => {
  const { frameInsets } = await import('./static/map-frame.js');
  // The side layout's toggle sits at the stage's bottom, at 860 of 900.
  const side = frameInsets({ height: 900, chips: 44, crumbs: null, controls: 892, layout: 'wide', full: false, covered: 0, calibrating: true, calTop: 0, floats: 40 });
  assert.ok(900 - side.top - side.bottom > 700, `framed height ${900 - side.top - side.bottom}`);
  assert.equal(side.top, 50);
});

test('phone calibration still frames below the toggle, which is at the top there', async () => {
  const { frameInsets } = await import('./static/map-frame.js');
  const sheet = frameInsets({ height: 844, chips: 52, crumbs: null, controls: 60, layout: 'sheet', full: true, covered: 700, calibrating: true, calTop: 354, floats: 0 });
  assert.equal(sheet.top, 66);
  assert.equal(sheet.bottom, 844 - 354 + 6);
});

test('outside calibration the sheet is what covers the map', async () => {
  const { frameInsets } = await import('./static/map-frame.js');
  assert.deepEqual(frameInsets({ height: 844, chips: 52, crumbs: null, controls: 400, layout: 'sheet', full: false, covered: 380, calibrating: false, calTop: 0, floats: 0 }), { top: 58, bottom: 386 });
});

test('a zone at 0 brightness is named where a look was applied, and only that zone', async () => {
  const { darkZones, darkMessage } = await import('./static/house-status.js');
  const geo = {
    areas: [{ id: 'yard', ranges: [[0, 9]] }, { id: 'porch', ranges: [[10, 19]] }],
    zones: [{ id: 'yard', name: 'Yard', area: 'yard' }, { id: 'porch', name: 'Porch', area: 'porch' }],
  };
  const b = { master: 1, zones: { yard: 0, porch: 0.5 } };
  assert.deepEqual(darkZones(geo, b, [[0, 4]]), ['Yard']);
  assert.deepEqual(darkZones(geo, b, [[12, 14]]), [], 'the look is only on the lit zone');
  assert.deepEqual(darkZones(geo, null, [[0, 4]]), [], 'no reading yet');
  const say = darkMessage(['Yard']);
  assert.match(say, /^Yard is at 0% brightness/);
  assert.match(say, /Home Assistant/);
  assert.match(darkMessage(['Yard', 'Porch', 'Shed']), /^Yard, Porch and Shed are at/);
  assert.equal(darkMessage([]), '');
  const status = read('panel/status.js');
  assert.match(status, /darkMessage\(darkZones\(/);
  assert.match(read('panel/looks.js'), /S\.toast\(dark/);
});

test('sticky bars never cover what scrolls into view', () => {
  assert.match(css, /\.content \{[^}]*scroll-padding-bottom: calc\(var\(--look-bar, 0px\)/);
  assert.match(css, /\.cal-body \{[^}]*scroll-padding-bottom/);
  const looks = read('panel/looks.js');
  assert.match(looks, /setProperty\('--look-bar', bar\.offsetHeight/);
  assert.match(looks, /if \(!panel\.hidden\) panel\.scrollIntoView/, 'opened clock controls come into view');
});

test('a status failure is the shared state with no raw server text and no empty sections', async () => {
  const { loadFailure } = await import('./static/panel/status.js');
  const st = loadFailure(Object.assign(new Error('Internal Server Error'), { status: 500 }));
  assert.equal(st.kind, 'error');
  assert.doesNotMatch(st.detail, /Internal Server Error/);
  assert.match(loadFailure({ network: true }).detail, /isn't responding/);
  const status = read('panel/status.js');
  assert.match(status, /<div id="stBody" hidden>[\s\S]*<h2>Controllers/, 'sections wait for a reading');
  assert.match(status, /stBody'\)\.hidden = false/);
});

test('Pin and Pinned take the same width', () => {
  assert.match(css, /\.preset-actions \[data-act=pin\] \{ width: [\d.]+em;/);
});

test('the map chip keeps its space before the dot', async () => {
  const { badgeHTML, mapStatus } = await import('./static/map-status.js');
  const m = mapStatus({ connected: true, target: false, show: '', preview: { previewing: false } });
  assert.equal(badgeHTML(m), '<span>Showing the lights<span class="detail"> · nothing in preview</span></span>');
  assert.match(css, /\.badge \{[\s\S]*?display: inline-flex/, 'the chip is flex, which is why it needs the wrapper');
});

test('a parameter on the WLED list is not repeated under More', async () => {
  const { moreParams } = await import('./static/form.js');
  const schema = [
    { name: 'palette', type: 'palette' }, { name: 'speed', type: 'speed' }, { name: 'colors', type: 'colors' }, { name: 'brightness', type: 'fraction' },
    { name: 'bands', type: 'list', fields: [{ name: 'width' }, { name: 'color' }] }, { name: 'stops', type: 'list', fields: [{ name: 'at' }] },
  ];
  const bindings = [{ param: 'palette' }, { param: 'colors.0' }, { param: 'colors.1' }, { param: 'bands.0.width' }, { param: 'bands.0.color' }];
  const rest = moreParams(schema, bindings, ['brightness']);
  assert.deepEqual(rest.map((r) => r.p.name), ['speed', 'colors', 'bands', 'stops']);
  assert.equal(rest.find((r) => r.p.name === 'colors').from, 2, 'colors 1 and 2 are bound');
  assert.equal(rest.find((r) => r.p.name === 'bands').from, 1, 'the first band is bound in full');
  assert.equal(rest.find((r) => r.p.name === 'stops').from, 0);
});

test('Setup and calibration count the same thing, and a step never reads as a tally', async () => {
  const { calCount, stepPlace } = await import('./static/panel/calibrate.js');
  const st = { anchors: 2, measured: 1, progress: [{ done: true }, { done: false }, { done: false }] };
  assert.equal(calCount(st).text, '1 of 3 steps done');
  assert.equal(stepPlace(1, { done: false }), 'Step 2 in the list · not done yet');
  assert.doesNotMatch(stepPlace(1, { done: true }), / of /, 'visited out of order, "step N of M" read as a count');
  const setup = read('panel/setup.js');
  assert.match(setup, /calCount\(st\)/);
  assert.doesNotMatch(setup, /points? measured/);
});

test('the page humanizes ids as the server does', async () => {
  const { humanize } = await import('./static/util.js');
  for (const [id, want] of JSON.parse(fs.readFileSync(path.join(__dirname, '../names/testdata/humanize.json'), 'utf8'))) assert.equal(humanize(id), want, id);
});

const G = {
  runs: [{ id: 'shed-eave', name: 'Shed eave' }, { id: 'unmapped-yard', name: 'Yard' }],
  nodes: [{ id: 'shed-sw', name: 'Shed SW' }, { id: 'shed-sw-2', name: 'Shed SW 2' }],
  controllers: [{ id: 'unassigned-board', name: 'Board' }],
  areas: [], zones: [],
};

test('server messages read with names, and a longer id is not cut by a shorter one', async () => {
  const { humanText } = await import('./static/names.js');
  assert.equal(humanText(G, 'shed-sw-2 at unassigned-board:12 on run shed-eave'), 'Shed SW 2 at Board:12 on run Shed eave');
  assert.equal(humanText(G, 'not-shed-sw stays'), 'not-shed-sw stays');
});

test('a layout warning has plain words, a fix and the raw text behind it', async () => {
  const { warningSummary } = await import('./static/names.js');
  const raw = 'anchors.yaml:22: run shed-eave: 2 measurements in anchors.yaml were taken when it had 300 LEDs; it now has 200. If LEDs were added';
  const w = warningSummary(G, raw);
  assert.match(w.summary, /measurements on Shed eave no longer match/);
  assert.doesNotMatch(w.summary, /anchors\.yaml|:22/);
  assert.deepEqual(w.fix, { label: 'Calibrate this run', run: 'shed-eave' });
  assert.equal(w.detail, raw);
  assert.match(warningSummary(G, 'layout.yaml:3: run shed-eave: shed-sw–shed-sw-2 has 90 pixels where its drawn length implies about 60 (1.50× the run\'s density); check').summary, /Between Shed SW and Shed SW 2 on Shed eave, the lights are spaced tighter than drawn/);
  assert.equal(warningSummary(G, 'x.yaml:1: something else').fix.tab, 'setup');
});

test('status shows warnings under the verdict and colors a healthy one', () => {
  assert.match(css, /\.verdict\.ok \{ color: var\(--house\)/);
  const status = read('panel/status.js');
  assert.ok(status.indexOf('stIssues') < status.indexOf('stBody'), 'warnings come before the long sections');
  assert.doesNotMatch(status, /<h2>Warnings/);
});

test('the place picker hides internal areas and reads names', async () => {
  const { buildTree, targetGroups, nodeName } = await import('./static/select.js');
  const geo = {
    pixels: { count: 4, run: [0, 0, 1, 1] },
    runs: [{ id: 'unmapped-yard', name: 'Yard' }, { id: 'shed', name: 'Shed' }],
    areas: [{ id: 'status-broken', name: 'Status broken', internal: true, ranges: [[2, 2]], includes: [] }, { id: 'west', name: 'West', ranges: [[0, 0]], includes: [] }],
    zones: [],
  };
  const tree = buildTree(geo);
  const labels = targetGroups(tree).flatMap((g) => g.items.map((i) => i.label));
  assert.ok(labels.includes('West'));
  assert.ok(labels.includes('Yard'), labels.join());
  assert.ok(!labels.some((l) => /status/i.test(l)), labels.join());
  assert.equal(nodeName(tree.node('run', 'unmapped-yard')), 'Yard');
});

test('calibration rows wrap instead of cutting a name', () => {
  assert.doesNotMatch(/\.cal-prog li \.name span \{[^}]*\}/.exec(css)[0], /ellipsis|nowrap/);
});

test('calibration navigation and utilities are separate rows', () => {
  assert.match(read('panel/calibrate.js'), /cal-nav cal-util/);
});

function overlayFor(extra = {}) {
  return import('./static/overlay.js').then(({ createOverlay }) => {
    const nodes = [{ id: 'a', name: 'Alpha', plan: 0, x: 50, y: 50, z: 0 }, { id: 'b', name: 'Beta', plan: 0, x: 60, y: 54, z: 0 }, { id: 'c', name: 'Gamma', plan: 0, x: 400, y: 400, z: 0 }];
    const S = { geo: { pixels: { count: 0 }, controllers: [{ id: 'c1', name: 'Board', base: 0, outputs: [] }], mappings: [], zones: [], edges: [], runs: [], nodes }, plan: 0, hover: -1, pinned: -1, view: { toScreen: (x, y) => [x, y], size: () => ({ w: 1000, h: 800 }) }, ...extra };
    const overlay = createOverlay(S);
    overlay.st.nodes = overlay.st.labels = true;
    const out = { plates: 0, texts: [] };
    const ctx = { fillRect() { out.plates++; }, beginPath() {}, arc() {}, fill() {}, stroke() {}, closePath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, fillText(t) { out.texts.push(t); }, measureText: (t) => ({ width: t.length * 6 }) };
    return { overlay, ctx, out };
  });
}

test('map labels sit on a backing plate', async () => {
  const { overlay, ctx, out } = await overlayFor();
  overlay.draw(ctx);
  assert.equal(out.plates, out.texts.length);
  assert.ok(out.texts.includes('Gamma'), 'and use display names');
});

test('labels stay out from under the legend and the map controls', async () => {
  const { overlay, ctx, out } = await overlayFor({ labelAvoid: () => [{ x0: 350, x1: 700, y0: 300, y1: 500 }] });
  overlay.draw(ctx);
  assert.ok(!out.texts.includes('Gamma'), out.texts.join());
});

test('during a calibration step, neighbors clear the target label', async () => {
  const cal = { active: true, side: 0, cursors: [{ index: 0, estimate: 0, controller: 'c1', node: 'a', run: 'r', label: 'a' }], target: { kind: 'anchor' } };
  const { overlay, ctx, out } = await overlayFor({ calibrating: true, cal });
  overlay.draw(ctx);
  assert.ok(out.texts.includes('Alpha'), 'the target keeps its name');
  assert.ok(!out.texts.includes('Beta'), `neighbor still drawn: ${out.texts}`);
  assert.ok(out.texts.includes('Gamma'), 'far labels stay');
});

test('the sheet says Expand in words', () => {
  assert.match(read('sheet.js'), /<span class="lbl">\$\{up \? 'Expand' : 'Collapse'\}/);
});
