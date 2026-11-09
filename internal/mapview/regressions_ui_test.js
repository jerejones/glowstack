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
    const S = { geo: { pixels: { count: 0 }, controllers: [{ id: 'c1', name: 'Board', base: 0, outputs: [] }], controller_locations: extra.geoExtra ? [{ id: 'back-shed', controller: -1, plan: 0, x: 200, y: 200, z: 0 }] : [], mappings: [], zones: [], edges: [], runs: [], nodes }, plan: 0, hover: -1, pinned: -1, view: { toScreen: (x, y) => [x, y], size: () => ({ w: 1000, h: 800 }) }, ...extra };
    const overlay = createOverlay(S);
    overlay.st.nodes = overlay.st.labels = true;
    const out = { plates: 0, texts: [] };
    const ctx = { fillRect() { out.plates++; }, rect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, closePath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, fillText(t) { out.texts.push(t); }, measureText: (t) => ({ width: t.length * 6 }) };
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

test('the picker moves through a list and finds by name', async () => {
  const { matchOptions, stepActive } = await import('./static/picker.js');
  assert.equal(stepActive('ArrowDown', 0, 3), 1);
  assert.equal(stepActive('ArrowDown', 2, 3), 2);
  assert.equal(stepActive('ArrowUp', 0, 3), 0);
  assert.equal(stepActive('End', 0, 3), 2);
  assert.equal(stepActive('a', 0, 3), null);
  assert.deepEqual(matchOptions([{ label: 'Party' }, { label: 'Rainbow' }], ' RAIN').map((o) => o.label), ['Rainbow']);
});

test('no native select is left in the panels', () => {
  for (const f of ['form.js', 'panel/presets.js']) assert.doesNotMatch(read(f), /createElement\('select'\)|<select/, f);
  for (const f of ['panel/setup.js', 'panel/calibrate.js']) assert.match(read(f), /upgradeSelects\(/, f);
});

test('settings under More are YAML, read and written by the server', () => {
  const form = read('form.js');
  assert.match(form, /as YAML/);
  assert.doesNotMatch(form, /written as JSON/);
  assert.match(form, /\/api\/map\/params\//);
});

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('input borders reach 3:1 on every surface and field', () => {
  const line = /--field-line: (#[0-9a-f]{6})/.exec(css)[1], field = /--field: (#[0-9a-f]{6})/.exec(css)[1];
  for (const bg of [field, '#111317', '#15181d', '#1c2027']) assert.ok(contrast(line, bg) >= 3, `${bg}: ${contrast(line, bg).toFixed(2)}`);
});

test('there is one page title per tab, one row tall', () => {
  for (const f of ['panel/looks.js', 'panel/presets.js', 'panel/setup.js', 'panel/status.js']) {
    assert.equal((read(f).match(/<h1 class="title">/g) || []).length, 1, f);
    assert.doesNotMatch(read(f), /<h2 class="title">/, f);
  }
  for (const sel of ['h1\\.title', '\\.looks-head', '\\.library-heading']) assert.match(css, new RegExp(`${sel} \\{[^}]*min-height: var\\(--title-row\\)`), sel);
});

test('pressed chips carry a keyline and the one SVG check, with no text for screen readers', () => {
  assert.match(css, /\.chips > button\.on \{[^}]*box-shadow/);
  assert.doesNotMatch(css, /\\2713/);
  assert.match(css, /\.chips > button\.on::before \{\s*content: '';[^}]*mask: var\(--check\)/);
  assert.match(css, /--check: url\("data:image\/svg\+xml[^;]*M3 8\.5l3\.2 3\.2L13 5/, 'the same path as the check icon');
});

test('single-choice sets are segmented and the show-on-map group has a name', () => {
  const setup = read('panel/setup.js');
  assert.match(setup, /class="seg grid" id="suModes"/);
  assert.ok(setup.indexOf('Show on the map') > setup.indexOf('Color the map by'));
});

test('pinned is one symbol, the Presets bookmark', () => {
  assert.doesNotMatch(read('icons.js'), /\bstar\b/);
  assert.match(read('panel/presets.js'), /presetsFilled/);
});

test('Remove looks the same in both lanes, and layer bars follow the lane', () => {
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /class="danger" data-a="remove"/);
  assert.match(looks, /c\.lane === 'preview' \? 'var\(--preview\)' : 'var\(--house\)'/);
  assert.match(looks, /and \$\{ls\.length - 1\} more/);
});

test('a look in preview somewhere else stays marked', () => {
  assert.match(read('panel/looks.js'), /In preview elsewhere/);
  assert.match(css, /\.preset\.elsewhere \{/);
});

test('offline follows a lost connection, not startup', () => {
  const app = read('app.js');
  assert.match(app, /ws\.onclose = [^\n]*setOffline\(true\)/);
  assert.doesNotMatch(app, /S\.offline = true/);
});

// ---------- round 3 review ----------

test('B27: a redraw keeps what was chosen in the calibration pickers', async () => {
  const { readFields, restoreFields } = await import('./static/panel/calibrate.js');
  const body = (vals) => ({ querySelector: (sel) => { const n = /name=(\w+)/.exec(sel)[1]; return n in vals ? vals[n] : null; } });
  const before = { run: { value: 'fence-east' }, ctl: { value: 'yard' }, a: { value: '' } };
  const saved = readFields(body(before));
  assert.deepEqual(saved, { run: 'fence-east', ctl: 'yard' }, 'an empty field keeps nothing');
  const after = { run: { value: 'shed-eave' }, ctl: { value: 'shed' }, a: { value: '' } };
  restoreFields(body(after), saved);
  assert.equal(after.run.value, 'fence-east');
  assert.equal(after.ctl.value, 'yard');
  assert.match(read('panel/calibrate.js'), /readFields\(body\);\s+body\.innerHTML = parts\.join\(''\);\s+upgradeSelects\(body\);\s+restoreFields\(body, fields\)/);
});

test('B28: Escape closes a popover and stops there', async () => {
  const { escapeCloses } = await import('./static/picker.js');
  let handler, closed = 0, open = true;
  escapeCloses({ addEventListener: (_, fn) => { handler = fn; } }, () => open, () => { closed++; });
  const press = (key) => { const e = { key, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } }; handler(e); return e; };
  assert.equal(press('a').stopped, false);
  assert.equal(closed, 0);
  assert.equal(press('Escape').stopped, true, 'it must not go on to clear the selection');
  assert.equal(closed, 1);
  open = false;
  assert.equal(press('Escape').stopped, false, 'a closed popover leaves the key alone');
  const looks = read('panel/looks.js');
  assert.match(looks, /escapeCloses\(el, \(\) => !picker\.hidden, \(\) => \{ openPicker\(false\); targetBtn\.focus\(\); \}\)/, 'Show on returns focus');
  assert.match(looks, /setAttribute\('aria-expanded', on \? 'true' : 'false'\)/);
  assert.match(read('form.js'), /escapeCloses\(box, \(\) => box\.open/, 'the color editor');
  assert.match(read('picker.js'), /escapeCloses\(el, \(\) => !pop\.hidden, \(\) => close\(true\)\)/, 'the picker');
});

test('B29: calibration names wrap, undoing the single-line .nv rule', () => {
  const rule = /\.cal-prog li \.name \{[^}]*\}/.exec(css)[0];
  assert.match(rule, /white-space: normal/);
  assert.match(rule, /overflow: visible/);
});

test('B33: toasts sit above the map toggle and legend, and over the phone calibration sheet', async () => {
  const { toastBottom } = await import('./static/map-frame.js');
  assert.equal(toastBottom({ height: 900, layout: 'wide', calibrating: false, calTop: 0, floats: 120 }), 128);
  assert.equal(toastBottom({ height: 844, layout: 'sheet', calibrating: false, calTop: 354, floats: 450 }), 458, 'above the sheet and its toggle');
  assert.equal(toastBottom({ height: 844, layout: 'sheet', calibrating: true, calTop: 354, floats: 800 }), 498);
  assert.match(read('app.js'), /\.filter\(\(r\) => r\.height\)/, 'a legend hidden by CSS has no top');
});

test('B34: picker lists show whole rows, and Show on has no scroll of its own', () => {
  assert.match(css, /\.picker-list \{[^}]*max-height: calc\(var\(--tap\) \* var\(--picker-rows\)\)[^}]*scroll-snap-type: y mandatory/);
  assert.match(css, /\.picker-option \{[^}]*height: var\(--tap\)[^}]*scroll-snap-align: start/);
  assert.doesNotMatch(css, /\.target-list \{[^}]*max-height/);
  assert.match(css, /\.picker-pop \{[^}]*scroll-margin/);
});

test('B35: a warning toast is the warning color', () => {
  assert.match(css, /\.toast\.warn \{ border-left-color: var\(--warn\)/);
  assert.match(read('panel/looks.js'), /S\.toast\(dark, \{ ms: 9000, warn: true \}\)/);
  assert.match(read('app.js'), /opts\.warn \? ' warn'/);
});

test('B36: Apply closes Show on', () => {
  assert.match(read('panel/looks.js'), /S\.fail\('apply the look', e\);[^\n]*\n\s+openPicker\(false\);/);
});

test('B37: the inspect card reads like the panel', async () => {
  const { showingLabel } = await import('./static/form.js');
  const S = { presets: [{ id: 'lantern-glow', name: 'Lantern glow', effect: 'bands', params: {} }], catalog: { effects: [{ id: 'chase', name: 'Chase', params: [] }] } };
  assert.equal(showingLabel(S, { layer: 'p1', preview: true, preset: 'lantern-glow', effect: 'bands' }, 'everything'), 'Lantern glow (in preview) on everything');
  assert.equal(showingLabel(S, { layer: 'x', effect: 'chase' }, 'Porch'), 'Chase on Porch');
  assert.doesNotMatch(read('app.js'), /sh\.layer|preset ' \+ esc/);
});

test('B38: Chase and Sparkle strips show what those effects paint', async () => {
  const { lookStrip } = await import('./static/form.js');
  const S = { palettes: [{ id: 'default', name: 'Default', stops: [] }, { id: 'color-1', name: 'Color 1', stops: [] }], catalog: { effects: [
    { id: 'chase', params: [{ name: 'width', default: '0.2 m' }, { name: 'spacing', default: '1 m' }, { name: 'colors', type: 'colors', default: ['#ffffff'] }, { name: 'background', default: '#000000' }] },
    { id: 'sparkle', params: [{ name: 'color', type: 'color', default: '#ffffff' }, { name: 'palette', type: 'palette', default: 'Default' }] },
  ] } };
  const chase = lookStrip(S, 'chase', {});
  assert.match(chase, /rgb\(255,255,255\)/);
  assert.match(chase, /rgb\(0,0,0\)/, 'the gaps between pulses');
  const two = lookStrip(S, 'chase', { colors: ['#ff0000', '#00ff00'], background: '#0000ff' });
  for (const c of ['rgb(255,0,0)', 'rgb(0,255,0)', 'rgb(0,0,255)']) assert.ok(two.includes(c), `${c} in ${two}`);
  const sparkle = lookStrip(S, 'sparkle', { color: '#ff0000' });
  assert.match(sparkle, /^linear-gradient\(90deg, #0b0d10 .*transparent/, 'specks, not a bar');
  assert.match(sparkle, /rgb\(255,0,0\)$/);
});

test('B39: map controller labels use display names, even for a board the config lacks', async () => {
  const { overlay, ctx, out } = await overlayFor({ geoExtra: true });
  overlay.st.nodes = overlay.st.labels = false;
  overlay.st.controllers = true;
  overlay.draw(ctx);
  assert.ok(out.texts.includes('Back shed'), out.texts.join());
  assert.ok(!out.texts.includes('back-shed'), out.texts.join());
});

test('B40: an opened Tweak form scrolls into view', () => {
  assert.match(read('panel/looks.js'), /form\.el\.scrollIntoView\(\{ block: 'nearest'/);
});

test('Escape on a confirm dialog leaves the sheet where it is', () => {
  assert.match(read('app.js'), /t\.closest\?\.\('dialog'\)\) return;[\s\S]{0,300}e\.key === 'Escape'/);
});

const LIGHTS = { zones: [{ id: 'yard', name: 'Yard', area: 'yard' }, { id: 'porch', name: 'Porch', area: 'porch' }], areas: [{ id: 'yard', ranges: [[0, 9]] }, { id: 'porch', ranges: [[10, 19]] }] };

test('B31: the Status headline says whether anything is lit, before controller health', async () => {
  const { lightsVerdict } = await import('./static/panel/status.js');
  const zones = (yard, porch) => ({ master: 1, zones: { yard, porch } });
  const v = (b, layers, ranges) => lightsVerdict(LIGHTS, { brightness: b, layers }, ranges);
  assert.deepEqual(v(zones(1, 1), 0, []), { cls: '', text: 'Nothing is lit: no looks are on the lights' });
  assert.deepEqual(v(zones(1, 1), 2, [[[0, 4]], [[10, 12]]]), { cls: 'ok', text: 'Lit: 2 looks on the lights' });
  assert.equal(v(zones(0, 0), 1, [[[0, 19]]]).cls, 'warn');
  assert.match(v(zones(0, 0), 1, [[[0, 19]]]).text, /^Nothing is lit/);
  assert.match(v(zones(0, 1), 1, [[[0, 4]]]).text, /^Nothing is lit/, 'its only layer is in the dark zone');
  assert.equal(v(zones(0, 1), 1, [[[0, 19]]]).text, 'Partly lit: Yard at 0%');
  assert.equal(v(zones(0, 1), 1, [[[10, 12]]]).cls, 'ok', 'a dark zone with nothing on it costs nothing');
  assert.equal(v({ master: 0, zones: { yard: 1 } }, 1, [[[0, 4]]]).text, 'Nothing is lit: brightness is at 0%');
  assert.match(v(zones(0, 0), 1, null).text, /every zone/, 'layers not read yet');
  const status = read('panel/status.js');
  assert.ok(status.indexOf('id="stVerdict"') < status.indexOf('id="stHealth"'), 'lit first, health second');
});

test('B30: unknown outputs read as unknown or partial, by name', async () => {
  const { powerSummary } = await import('./static/panel/status.js');
  const name = (id) => id.toUpperCase();
  const known = { controller: 'a', output: 1, known: true }, bare = (output) => ({ controller: 'b', output, known: false });
  const partial = powerSummary({ estimate: [known, bare(1), bare(2)], controllers: [{ ma: 1500, known: true }, { ma: 0, known: false }], stage: { scale: 1 } }, name);
  assert.equal(partial.limiting, 'None needed on the outputs with a current set');
  assert.equal(partial.overall, 'At least 1.50 A');
  assert.match(partial.notSet, /B outputs 1 and 2/);
  const none = powerSummary({ estimate: [bare(1)], controllers: [{ ma: 0, known: false }], stage: { scale: 1 } }, name);
  assert.equal(none.limiting, 'Unknown');
  assert.equal(none.overall, 'Unknown');
  assert.match(none.notSet, /its draw/);
  const all = powerSummary({ estimate: [known], controllers: [{ ma: 2000, known: true }], stage: { scale: 1 } }, name);
  assert.equal(all.limiting, 'None needed');
  assert.equal(all.overall, '2.00 A');
  assert.equal(all.notSet, '');
  assert.equal(powerSummary({ estimate: [known], controllers: [], stage: { scale: 0.5, group: 'g' } }).limiting, 'Dimmed to 50.0% (group g)');
  assert.doesNotMatch(read('panel/status.js'), /Not set</, 'no per-output Not set rows');
});

test('the status run list leads with problems and never offers Calibrate on a run with no points', () => {
  const status = read('panel/status.js');
  assert.match(status, /id="stRunsMore"/);
  assert.match(status, /\$\{points \? `<span class="val"/);
  assert.doesNotMatch(status, /<tfoot>/, 'totals come first');
});

test('an open After limiting disclosure survives the poll', () => {
  assert.match(read('panel/status.js'), /wasOpen = box\.querySelector\('details'\)\?\.open/);
});
