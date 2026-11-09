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
  const side = frameInsets({ height: 900, chips: 44, crumbs: null, controls: 892, layout: 'wide', covered: 0, calibrating: true, calTop: 0, floats: 40 });
  assert.ok(900 - side.top - side.bottom > 700, `framed height ${900 - side.top - side.bottom}`);
  assert.equal(side.top, 50);
});

test('phone calibration still frames below the toggle, which is at the top there', async () => {
  const { frameInsets } = await import('./static/map-frame.js');
  const sheet = frameInsets({ height: 844, chips: 52, crumbs: null, controls: 60, layout: 'sheet', covered: 700, calibrating: true, calTop: 354, floats: 0 });
  assert.equal(sheet.top, 66);
  assert.equal(sheet.bottom, 844 - 354 + 6);
});

test('outside calibration the sheet is what covers the map', async () => {
  const { frameInsets } = await import('./static/map-frame.js');
  assert.deepEqual(frameInsets({ height: 844, chips: 52, crumbs: null, controls: 52, layout: 'sheet', covered: 380, calibrating: false, calTop: 0, floats: 0 }), { top: 58, bottom: 386 });
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
  assert.match(read('sheet.js'), /e\.target === opening && e\.target\.open/, 'opened clock controls come into view');
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
  assert.equal(badgeHTML(m), '<span>Showing the lights<span class="detail"> · no preview</span></span>');
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
  assert.equal(stepPlace(1, { done: false }, 3), 'Step 2 of 3 · not done yet', 'the same total as the count');
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
    const ctx = { fillRect() { out.plates++; }, strokeRect() {}, rect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, closePath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, fillText(t) { out.texts.push(t); }, measureText: (t) => ({ width: t.length * 6 }) };
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
  assert.match(setup, /class="seg five" id="suModes"/);
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
  assert.match(read('panel/looks.js'), /Previewing elsewhere/);
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
  assert.match(read('app.js'), /\.filter\(\(r\) => r\.height/, 'a legend hidden by CSS has no top');
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
  assert.equal(showingLabel(S, { layer: 'p1', preview: true, preset: 'lantern-glow', effect: 'bands' }, 'everything'), 'Lantern glow (preview) on everything');
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
  assert.match(none.notSet, /any output/);
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
  assert.match(status, /\$\{points \? `<button/);
  assert.doesNotMatch(status, /<tfoot>/, 'totals come first');
});

test('an open After limiting disclosure survives the poll', () => {
  assert.match(read('panel/status.js'), /wasOpen = box\.querySelector\('details'\)\?\.open/);
});

test('a look on an area covering everything counts as the same place as All', async () => {
  const { lookAction } = await import('./static/panel/looks.js');
  const layers = [{ id: 'p1', target: 'all', preset: 'warm', params: {} }];
  const same = (a, b) => ['all', 'everything'].includes(a) && ['all', 'everything'].includes(b);
  assert.deepEqual(lookAction(layers, 'everything', { preset: 'warm' }, {}, same), { remove: 'p1' });
  assert.deepEqual(lookAction(layers, 'everything', { preset: 'warm' }), { add: true });
});

test('Apply offers Replace only for layers the preview would cover completely', async () => {
  const { replacedBy } = await import('./static/panel/looks.js');
  const areas = { all: [[0, 99]], left: [[0, 49]], right: [[50, 99]], gapped: [[0, 10], [60, 70]] };
  const rangesOf = (t) => areas[t] || null;
  const house = [{ id: 'a', target: 'left' }, { id: 'b', target: 'right' }, { id: 'c', target: 'gone' }];
  assert.deepEqual(replacedBy(house, [{ target: 'all' }], rangesOf).map((l) => l.id), ['a', 'b']);
  assert.deepEqual(replacedBy(house, [{ target: 'left' }], rangesOf).map((l) => l.id), ['a']);
  assert.deepEqual(replacedBy(house, [{ target: 'gapped' }], rangesOf), []);
  assert.deepEqual(replacedBy(house, [{ target: 'left' }, { target: 'right' }], rangesOf).map((l) => l.id), ['a', 'b'], 'two halves cover both');
  assert.deepEqual(replacedBy(house, [{ target: 'all' }], rangesOf, new Set(['a'])).map((l) => l.id), ['b'], 'an original is already being replaced');
});

test('labels never share pixels, and spacing labels at 1.00 stay off by default', async () => {
  const src = read('overlay.js');
  assert.match(src, /placed\.some\(\(b\) => hit\(box, b, l\.budget \? NAME_ROOM : 1\)\)/);
  assert.match(src, /!pct && !st\.evenSpacing/);
  assert.match(src, /evenSpacing: false/);
});

test('no segment wraps, the five map colors leave no orphan, and checkboxes are styled', () => {
  const css = read('ui.css');
  assert.match(css, /\.seg > button \{[^}]*white-space: nowrap/);
  assert.match(css, /\.tab \.seg\.five > button \{ padding: 0 3px/);
  assert.match(css, /input\[type=checkbox\] \{[^}]*appearance: none/);
});

test('internals stay off the screen', () => {
  assert.match(read('form.js'), /p\.name\.replace\(\/\^\\\*\\s\*\/, ''\)/);
  for (const f of ['panel/setup.js', 'util.js']) assert.doesNotMatch(read(f), /glowstack\.yaml/, f);
  assert.doesNotMatch(read('panel/calibrate.js'), /\+ goes toward the end/);
});

test('every lit pixel outweighs the model, and unlit ones keep their outline', () => {
  const scene = read('scene.js');
  assert.match(scene, /lit \? clamp\(s \* 1\.5/);
  assert.match(scene, /subdue\(anyLit\(/);
  assert.match(read('plan.js'), /Unlit: a dim outline/);
});

test('B52: a stretch flagged as off is far from the as-drawn color, and a small one is tinted', async () => {
  const { spacingColor } = await import('./static/util.js');
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const drawn = spacingColor(1);
  assert.ok(dist(spacingColor(0.8), drawn) > 150, `flagged tight is only ${dist(spacingColor(0.8), drawn)} from white`);
  assert.ok(dist(spacingColor(1.25), drawn) > 150, 'flagged loose');
  assert.ok(dist(spacingColor(0.95), drawn) > 30, '5% tight still reads');
  assert.deepEqual(spacingColor(null), [70, 70, 70], 'nothing drawn to compare with');
  assert.match(read('overlay.js'), /spacingColor\(m\.spacing\[p\]\)/, 'colors use spacing against the drawing, not a flow stretch');
});

test('B48: the chip names the color mode, and only when a color mode is on', async () => {
  const { mapStatus } = await import('./static/map-status.js');
  const preview = { previewing: true };
  assert.equal(mapStatus({ connected: true, show: '', preview, mode: 'outputs' }).text, 'Colored by Wiring');
  assert.equal(mapStatus({ connected: true, show: '', preview, mode: 'stretch' }).text, 'Colored by Spacing');
  assert.equal(mapStatus({ connected: true, show: '', preview, mode: 'live' }).text, 'Showing your preview');
  assert.equal(mapStatus({ connected: false, show: '', preview, mode: 'areas' }).text, 'Offline', 'being offline comes first');
  assert.equal(mapStatus({ connected: true, show: '', preview, target: true, mode: 'areas' }).text, 'Target pattern');
});

test('a controller label drops the words its name already says', async () => {
  const { controllerLabel } = await import('./static/names.js');
  assert.equal(controllerLabel('Shed', 'Shed'), 'Shed');
  assert.equal(controllerLabel('Shed north', 'Shed wall'), 'Shed north · wall');
  assert.equal(controllerLabel('Shed', ''), 'Shed');
  assert.equal(controllerLabel('Shed', 'Back wall'), 'Shed · Back wall');
});

test('map labels never overlap, however dense the scene', async () => {
  const { createOverlay } = await import('./static/overlay.js');
  const nodes = Array.from({ length: 400 }, (_, i) => ({ id: 'p' + i, name: `Sample point ${i}`, plan: 0, x: Math.sin(i) * 200, y: Math.cos(i * 1.7) * 120, z: 0, locations: [] }));
  const geo = { pixels: { count: 0, plan: [], x: [], y: [], z: [], edge: [] }, mappings: [], zones: [], controllers: [], nodes, edges: [], runs: [], controller_locations: [] };
  const S = { geo, plan: 0, hover: -1, pinned: -1, view: { toScreen: (x, y) => [x + 400, y + 300], size: () => ({ w: 800, h: 600 }) }, labelAvoid: () => [{ x0: 0, x1: 800, y0: 0, y1: 40 }] };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const overlay = createOverlay(S);
  overlay.st.labels = true; overlay.st.nodes = true;
  const ctx = new Proxy({ measureText: (t) => ({ width: t.length * 6.5 }), setLineDash() {}, arc() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, closePath() {}, fillRect() {}, strokeRect() {}, fillText() {} }, { get: (t, k) => (k in t ? t[k] : undefined), set: () => true });
  overlay.draw(ctx);
  const placed = overlay.placed();
  assert.ok(placed.length > 10, `${placed.length} placed`);
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j];
    assert.ok(!(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1), `${a.text} overlaps ${b.text}`);
  }
  assert.ok(placed.every((b) => b.y0 >= 40), 'clear of what it was told to avoid');
});

test('two overlay applies in flight write the legend once', async () => {
  const src = read('overlay.js');
  assert.match(src, /let legend = made\.legend;/);
  assert.doesNotMatch(src, /st\.legend \+=/);
});

test('B41: a tab change resets the panel scroller, and picking a look shows its card', () => {
  assert.match(read('sheet.js'), /if \(name !== tab\) \$\('content'\)\.scrollTop = 0/);
  assert.match(read('panel/looks.js'), /cards\.get\('preview:' \+ added\.id\)\?\.el\.scrollIntoView/);
});

test('B42: a palette the catalog has no name for still reads as something', async () => {
  const { paletteChoice } = await import('./static/form.js');
  const S = { palettes: [{ id: 'party', name: 'Party' }] };
  assert.deepEqual(paletteChoice(S, 'party'), { value: 'party' });
  assert.deepEqual(paletteChoice(S, [[0, '#ff0000'], [1, '#00ff00']]), { value: '__custom', label: 'Custom' }, 'inline stops');
  assert.deepEqual(paletteChoice(S, 'gone'), { value: 'gone', label: 'gone' });
  assert.deepEqual(paletteChoice(S, undefined), { value: 'default' });
});

test('B43: hover is not the keyboard cursor', () => {
  assert.match(css, /\.picker-option:hover \{ background: var\(--card2\); \}/);
  assert.match(css, /\.picker-option\.active \{ background: var\(--on\); \}/);
});

test('B44: Escape closes the inline editor the same way Cancel does', () => {
  const src = read('panel/presets.js');
  assert.match(src, /escapeCloses\(\$\('#prEditor'\), \(\) => !!draft && !busy, cancelEditor\)/);
  assert.match(src, /\$\('#prCancel'\)\.onclick = cancelEditor/);
  assert.match(read('app.js'), /S\.presetLibrary\.closeEditor\(\)/);
});

test('B45: whatever a tap opens in the panel scrolls clear of the bar', () => {
  const sheet = read('sheet.js');
  assert.match(sheet, /addEventListener\('toggle'/);
  assert.match(sheet, /e\.target === opening && e\.target\.open/, 'only when opened by hand, not by a poll');
  assert.match(read('panel/looks.js'), /S\.panel\.fitHalf = /);
  assert.match(read('panel/looks.js'), /S\.panel\.tab\(\) !== 'looks'\) content\.style\.removeProperty\('--look-bar'\)/, "another tab's scroll isn't padded for a bar it doesn't have");
});

test('B46: the phone boot loader is under the chip bar, not on the toggle', () => {
  const sheet = css.slice(css.indexOf('/* bottom sheet */'));
  assert.match(sheet, /\.boot-loading \{ top: calc\(max\(8px, env\(safe-area-inset-top\)\) \+ var\(--tap\) \+ 8px\); transform: translateX\(-50%\); \}/);
});

test('B47: offline controls look disabled', () => {
  assert.match(css, /\[inert\] button, \[inert\] \.picker-btn/);
  assert.match(read('app.js'), /\.inert = off/);
});

test('B49: a full sheet leaves the map room, with chip and toggle above it', async () => {
  const { frameInsets } = await import('./static/map-frame.js');
  assert.match(css, /--strip: 200px/);
  assert.match(read('sheet.js'), /const STRIP = 200/);
  assert.match(css, /Chip and toggle share one row[^]*?\.map-controls \{ top:/, 'in one place at every detent');
  const f = frameInsets({ height: 844, chips: 52, crumbs: null, controls: 52, layout: 'sheet', covered: 644, calibrating: false, calTop: 0, floats: 0 });
  assert.equal(f.top, 58, 'framing starts below the row');
  const c = frameInsets({ height: 844, chips: 52, crumbs: 96, controls: 52, layout: 'sheet', covered: 644, calibrating: false, calTop: 0, floats: 0 });
  assert.equal(c.top, 102, 'and below the crumbs when they are up');
});

test('B50: a phone preset row is one action, Pin and a More holding the rest; Delete is one style', () => {
  const src = read('panel/presets.js');
  assert.match(src, /data-act="more"[^>]*aria-haspopup="menu"/);
  assert.match(src, /role="menu" hidden>.*role="menuitem" data-act="edit".*role="menuitem" data-act="copy".*role="menuitem" data-act="delete" class="danger"/s);
  assert.match(css, /\.preset-menu \{ position: absolute/);
  assert.match(css, /\.preset-menu button\.danger \{ color: #fca5a5/);
});

test('B51: a field error is directly under its field, in one layout', () => {
  const src = read('panel/presets.js');
  assert.match(read('field.js'), /field-err/);
  assert.match(src, /markName\('Give the preset a name\.'\)/);
  const form = read('form.js');
  assert.match(form, /className: 'field-err'/);
  assert.doesNotMatch(form, /class="err grow"/);
  assert.match(css, /\.field-err \{ display: block; margin-top: 4px; \}/);
});

test('plain words: model parts, effect subtitles, and numbers with commas', async () => {
  const { modelPartLabel } = await import('./static/names.js');
  assert.equal(modelPartLabel('walls-lines', 'lines'), 'Walls outline');
  assert.equal(modelPartLabel('roofs faces', 'faces'), 'Roofs surfaces');
  assert.equal(modelPartLabel('trim', 'points'), 'Trim');
  const { effectSummary } = await import('./static/panel/looks.js');
  assert.equal(effectSummary({ id: 'bands', name: 'Bands', params: [{ name: 'bands', type: 'list' }] }), 'Color bands');
  assert.equal(effectSummary({ id: 'solid', name: 'Solid', params: [{ name: 'color', type: 'color' }] }), 'Solid · One color');
  const { count, plural } = await import('./static/util.js');
  assert.equal(count(22322), '22,322');
  assert.equal(plural(22322, 'light'), '22,322 lights');
  assert.equal(plural(1, 'light'), '1 light');
  assert.doesNotMatch(read('panel/calibrate.js'), /anchors\.yaml<\/code>/);
  assert.doesNotMatch(read('panel/status.js'), /'map draw'/);
});

test('the brightness warning is said once per screen, and its toast leaves with the tab', () => {
  const looks = read('panel/looks.js');
  assert.match(looks, /else if \(dark\) darkToast = S\.toast\(dark/, 'a toast only when the lane can\'t be read');
  assert.match(looks, /S\.on\('tab', \(\) => \{ darkToast\?\.remove\(\)/);
  assert.doesNotMatch(looks, /note\.className = orig \? 'note copy-note' : dark/, 'not on every card as well');
  const status = read('panel/status.js');
  assert.doesNotMatch(status, /stDark/, 'one issues list on Status');
  assert.match(status, /renderIssues\(st\.solve\.warnings \|\| \[\], dark\)/);
});

test('Everything is the one term, and the Runs group says why runs are missing', async () => {
  const { nodeName } = await import('./static/select.js');
  assert.equal(nodeName({ members: [{ kind: 'all', id: 'all', name: 'All' }] }), 'Everything');
  const looks = read('panel/looks.js');
  assert.match(looks, /A run that is a whole area or zone is listed there instead\./);
  assert.match(looks, /\$\$\('#lkLive'\)\.disabled = st\.following/, 'Now is an action, not a toggle');
  assert.doesNotMatch(looks, /press\(\$\$\('#lkLive'\)/);
  assert.match(looks, /<details class="clock-box" id="lkClockBox" hidden><summary>Preview clock/);
  assert.match(looks, /\$\$\('#lkClockBox'\)\.hidden = !prev\.length/);
  assert.match(looks, /bri-label[^>]*>\$\{icon\('sun'\)\}Brightness/);
});

test('a real type scale: h2 and h3 differ, and body text is larger on desktop', () => {
  assert.match(css, /--t-m: 14px/);
  assert.match(css, /--t-h3: 15px/);
  assert.match(css, /--t-h2: 18px/);
  assert.match(css, /^h1, h2 \{[^}]*font-size: var\(--t-h2\)/m);
  assert.match(css, /^h3 \{[^}]*font-size: var\(--t-h3\)/m);
});

test('the shared text input puts its error under the field', async () => {
  const { textField } = await import('./static/field.js');
  const html = textField({ label: 'Name', id: 'x' });
  assert.ok(html.indexOf('<input') < html.indexOf('field-err'), 'input first, then its error');
  assert.match(textField({ ariaLabel: 'Find', id: 'y', type: 'search' }), /aria-label="Find"/);
  assert.match(read('panel/presets.js'), /textField\(\{ label: 'Name', id: 'prName'/);
  assert.match(read('panel/looks.js'), /textField\(\{ ariaLabel: 'Find a place'/);
});

test('the map model is dim so the lights lead', () => {
  assert.match(read('scene.js'), /lines: \{ color: '#cfe3ff', opacity: 0\.2 \}/);
});

test('B53: a failed refresh keeps the last state on Looks and says so', async () => {
  const { nowLine } = await import('./static/panel/looks.js');
  const base = { previewing: false, word: 'Tap', nameOf: (ls) => ls[0].name };
  assert.equal(nowLine({ ...base, house: [], status: 'loading', read: false }), null, 'no reading yet: nothing to say');
  const empty = nowLine({ ...base, house: [], status: 'unavailable', read: true });
  assert.equal(empty.main, 'Nothing on the lights', 'the empty row stays');
  assert.match(empty.sub, /Couldn't refresh/);
  assert.equal(empty.stale, true);
  const some = nowLine({ ...base, house: [{ name: 'Dusk' }], status: 'unavailable', read: true });
  assert.equal(some.main, 'On the lights: Dusk');
  assert.match(some.sub, /last known/);
  assert.equal(nowLine({ ...base, house: [], status: 'available', read: true }).stale, false);
  assert.match(css, /\.now:not\(\.idle\):not\(\.stale\) small \{ display: none; \}/, 'the phone half sheet keeps the notice');
});

test('a failed action names what failed, and a stray error page is not shown as text', async () => {
  const { api, failure } = await import('./static/util.js');
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'x', text: async () => '{"error":"service unavailable"}' });
    assert.equal(failure('preview the look', await api('/x').catch((e) => e)), 'Could not preview the look: service unavailable.');
    globalThis.fetch = async () => ({ ok: false, status: 502, statusText: 'x', text: async () => '<html>Bad gateway</html>' });
    assert.doesNotMatch(failure('preview the look', await api('/x').catch((e) => e)), /html/);
  } finally { globalThis.fetch = real; }
});

test('a failed status refresh is its own line, so other redraws can not erase it', () => {
  const status = read('panel/status.js');
  assert.match(status, /id="stStale"/);
  assert.doesNotMatch(status, /stVerdict'\)\.textContent = "Couldn't refresh/);
  assert.match(status, /\$\$\('#stStale'\)\.hidden = true/);
});

test('B54: status captions wrap instead of clipping', () => {
  const rule = /^\.stat span \{[^}]*\}/m.exec(css)[0];
  assert.doesNotMatch(rule, /nowrap|ellipsis/);
});

test('B60: each status verdict says what it measured', async () => {
  const { runsFine, verdict } = await import('./static/panel/status.js');
  assert.match(runsFine(0), /^Run lengths: every run is within 5% of its drawing\.$/);
  assert.match(runsFine(1), /1 stretch inside a run is spaced differently/);
  assert.match(runsFine(3), /3 stretches inside a run are spaced/);
  assert.match(verdict(['a'], {}).text, /^Controllers: /);
  const { warningSummary } = await import('./static/names.js');
  const g = { runs: [{ id: 'eave', name: 'Eave' }], nodes: [], controllers: [] };
  assert.equal(warningSummary(g, 'layout.yaml:3: run eave: a–b has 40 pixels where its drawn length implies about 30').kind, 'spacing');
  assert.equal(warningSummary(g, 'other').kind, undefined);
});

test('B55: during a target pattern neither choice of the map control is on', async () => {
  const { mapStatus } = await import('./static/map-status.js');
  assert.equal(mapStatus({ connected: true, show: '', preview: { previewing: true }, target: true }).showing, 'target');
  assert.equal(mapStatus({ connected: true, show: 'house', preview: null, target: true }).showing, 'target');
});

test('B63: the chip is the one signal for a target pattern, at every width', () => {
  assert.doesNotMatch(read('index.html'), /showTarget|Showing the target pattern/);
  assert.doesNotMatch(css, /map-note/);
  assert.match(read('app.js'), /\$\('showSeg'\)\.hidden = m\.showing === 'target' \|\| m\.showing === 'calibration'/);
});

test('B62: test bands is a named calibration state on the chip, over a preview too', async () => {
  const { mapStatus } = await import('./static/map-status.js');
  const m = mapStatus({ connected: true, show: '', preview: { previewing: true }, target: false, measuring: 'bands' });
  assert.equal(m.text, 'Test bands');
  assert.equal(m.showing, 'calibration');
  assert.equal(mapStatus({ connected: false, show: '', preview: null, target: false, measuring: 'bands' }).text, 'Offline');
  assert.match(read('app.js'), /S\.calibrating && S\.cal\?\.active \? 'house' : S\.show/, 'the map streams the lights while calibrating');
});

test('B62: test bands keeps its heading and instructions, says how to leave, and why the dock is off', async () => {
  const { dockReason, stepTitle } = await import('./static/panel/calibrate.js');
  assert.equal(stepTitle({ target: { kind: 'bands', run: 'eave' } }).title, 'Check the test bands');
  assert.match(dockReason({ kind: 'bands', run: 'eave' }, undefined), /off while the test bands show\. Leave test bands/);
  assert.match(dockReason({ kind: 'gap' }, undefined), /Confirm length/);
  assert.match(dockReason({ kind: 'anchor' }, { fixed: true, index: 3 }), /fixed/);
  assert.equal(dockReason({ kind: 'anchor' }, { fixed: false, index: 3 }), '');
  const cal = read('panel/calibrate.js');
  assert.match(cal, /bands \? btn\('Leave test bands', leaveBands/);
  // The heading is built before, and outside of, the cursor branch.
  assert.ok(cal.indexOf('class="cal-step"') < cal.indexOf('const moved = c.index - c.estimate'));
});

test('B56: Previous and Next are placed before the instructions', () => {
  const src = read('panel/calibrate.js');
  assert.ok(src.indexOf('parts.push(nav());') < src.indexOf('class="cal-how"'));
});

test('B57: the list marks the current step and scrolls to it only when it changes', async () => {
  const { progCenter } = await import('./static/panel/calibrate.js');
  assert.equal(progCenter(400, 40, 200), 320);
  assert.equal(progCenter(20, 40, 200), 0, 'never above the top');
  const src = read('panel/calibrate.js');
  assert.match(src, /aria-current="step"/);
  assert.match(src, /here-tag">Step \$\{/);
  assert.match(src, /key !== shownHere/);
  assert.match(css, /\.cal-prog \{[^}]*overflow-y: auto/);
});

test('calibrate list: done rows are plain text with only the check in green', () => {
  assert.doesNotMatch(css, /\.cal-prog li\.done \{ color/);
  assert.match(css, /\.cal-prog li\.done \.icon \{ color: var\(--house\); \}/);
});

test('B58: the phone preset form is placed on purpose, with Save pinned', () => {
  const src = read('panel/presets.js');
  assert.match(src, /S\.panel\.setDetent\('full'\)/);
  assert.match(src, /focus\(\{ preventScroll: true \}\)/, 'autofocus must not scroll the heading away');
  assert.match(src, /id="prActions"/);
  assert.match(css, /\.editor-actions \{[^}]*position: sticky/);
  assert.match(css, /\.preset-editor \{[^}]*scroll-margin-top/);
});

test('B59: swatches carry a light rim, and a color palette with only black colors is not a black bar', async () => {
  for (const rule of [/^\.preset \.strip \{[^}]*\}/m, /^\.layer \.strip \{[^}]*\}/m, /^\.now \.strip \{[^}]*\}/m, /^\.picker-swatch \{[^}]*\}/m, /^\.inspect \.chip-color \{[^}]*\}/m]) {
    assert.match(rule.exec(css)[0], /var\(--rim\)/, String(rule));
  }
  assert.doesNotMatch(css, /solid #000?[67]/);
  const { choiceStrip } = await import('./static/form.js');
  const S = { palettes: [{ id: 'color-1', name: 'Color 1' }] };
  assert.match(choiceStrip(S, 'color-1', 'solid', ['#000000']), /repeating-linear-gradient/);
  assert.match(choiceStrip(S, 'color-1', 'solid', []), /repeating-linear-gradient/);
  assert.equal(choiceStrip(S, 'color-1', 'solid', ['#ff0000']), 'rgb(255,0,0)');
});

test('B61: a nav tab has a hover state', () => {
  assert.match(css, /\.tabs button:not\(\.on\):hover \{[^}]*background/);
});

test('the 404 page keeps the way around and puts its sentence above the links', () => {
  const page = read('404.html');
  for (const tab of ['looks', 'presets', 'setup', 'status']) assert.match(page, new RegExp(`href="/${tab}"`));
  assert.match(page, /classList\.add\('coarse'\)/, '?pointer=coarse works here too');
  assert.match(css, /\.not-found \.state \{ display: grid/);
});

test('name labels keep room around them, and a dense map shows only what fits', async () => {
  const { placeLabels } = await import('./static/overlay.js');
  const measure = (l) => l.text.length * 6;
  const labels = Array.from({ length: 300 }, (_, i) => ({ text: `Corner ${i} near the porch rail`, x: 100 + (i * 37) % 700, y: 60 + (i * 53) % 500, color: '#fff', rank: i % 5 === 0 ? 1.2 : 1, budget: true }));
  const placed = placeLabels(labels, { width: 900, height: 700, measure });
  assert.ok(placed.length > 5 && placed.length <= Math.floor(900 * 700 / 16000), `${placed.length} placed`);
  const apart = (a, b) => a.x1 + 10 <= b.x0 || b.x1 + 10 <= a.x0 || a.y1 + 10 <= b.y0 || b.y1 + 10 <= a.y0;
  placed.forEach((a, i) => placed.slice(i + 1).forEach((b) => assert.ok(apart(a, b), `${a.text} / ${b.text}`)));
  assert.ok(placed.filter((p) => p.rank === 1.2).length >= placed.filter((p) => p.rank === 1).length, 'the shared corners first');
  assert.ok(placed.every((p) => p.text.length <= 26), 'long names are cut short');
  const focus = placeLabels([...labels, { text: 'A very long name the pointer is on, shown whole', x: 200, y: 200, color: '#fff', rank: 2.5, budget: false }], { width: 900, height: 700, measure });
  assert.ok(focus.some((p) => p.text.startsWith('A very long name the pointer is on')), 'a focused label is shown whole, ahead of the budget');
  const sheet = placeLabels(labels, { width: 390, height: 844, avoid: [{ x0: 0, x1: 390, y0: 0, y1: 50 }, { x0: 0, x1: 390, y0: 460, y1: 844 }], measure });
  assert.ok(placed.length > sheet.length && sheet.length <= Math.floor(390 * 460 / 16000));
  assert.ok(sheet.every((p) => p.y1 <= 460));
});

test('spacing numbers are for the run in focus, not the whole map', () => {
  const src = read('overlay.js');
  assert.match(src, /if \(!pixels\.some\(inFocus\)\) continue;/);
  assert.match(src, /a run for its percentage/);
});

test('Setup uses one segmented style and one toggle chip style', () => {
  const setup = read('panel/setup.js');
  assert.doesNotMatch(setup, /seg grid/);
  assert.equal((setup.match(/class="chips toggles"/g) || []).length, 2);
  assert.doesNotMatch(css, /\.seg\.grid/);
  assert.match(css, /\.chips\.toggles > button::before/);
});

test('a control boundary is at least 3:1 where it identifies the control', () => {
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const surface of ['#111317', '#15181d', '#1c2027']) assert.ok(ratio('#6b7480', surface) >= 3, surface);
  assert.match(css, /^\.seg \{[^}]*var\(--control-line\)/m);
  assert.match(css, /background: var\(--card2\); border: 1px solid var\(--control-line\)/);
});

test('jargon is gone or explained', async () => {
  const { modelPartLabel } = await import('./static/names.js');
  assert.equal(modelPartLabel('detail-lines', 'lines'), 'Fine detail outline');
  assert.equal(modelPartLabel('site-lines', 'lines'), 'Ground and site outline');
  assert.equal(modelPartLabel('walls-lines', 'lines'), 'Walls outline');
  const setup = read('panel/setup.js'), looks = read('panel/looks.js'), cal = read('panel/calibrate.js');
  assert.doesNotMatch(setup, />Even runs too</);
  assert.doesNotMatch(setup, />Copy view</);
  assert.match(looks, /Next look on/);
  assert.match(looks, /The lights keep running/);
  assert.doesNotMatch(cal, /At the estimate/);
});

test('the layer card keeps Remove beside Tweak, and long setting names take their own line', () => {
  assert.match(read('panel/looks.js'), /class="tweak"[^\n]*data-a="remove"/);
  assert.match(read('form.js'), /label\.length > 16 \? 'f stack' : 'f'/);
  assert.match(css, /\.form \.f\.stack \{/);
});

test('one spinner at boot, and error bodies are all regular weight', () => {
  assert.doesNotMatch(read('app.js'), /title: 'Loading…'/);
  assert.match(css, /\.state-text span \{[^}]*font-weight: 400/);
  assert.match(css, /\.verdict \.state \{[^}]*font-weight: 400/);
});

test('preset row actions sit on the card edge, and More is a real menu', () => {
  assert.doesNotMatch(/^\.preset-actions \{[^}]*\}/m.exec(css)[0], /margin-left: -/);
  const src = read('panel/presets.js');
  for (const piece of ["icon('more')", "icon('edit')", "icon('copy')", "icon('trash')", 'ArrowDown', "escapeCloses(row.querySelector('.menu-wrap')"]) assert.ok(src.includes(piece), piece);
});

test('one word for previewing, in purple, and stacking is said out loud', () => {
  const looks = read('panel/looks.js'), presets = read('panel/presets.js');
  assert.doesNotMatch(looks, /In preview|>Try</);
  assert.match(presets, /'Previewing' : 'Preview'/);
  assert.doesNotMatch(presets, /Trying/);
  assert.match(css, /\[data-act=try\]\[aria-pressed=true\] \{ color: var\(--preview\)/);
  assert.match(looks, /Looks stack\. The top one in this list is in front wherever they overlap\./);
  assert.match(looks, /layers\.length > 1 && l === layers\[0\]/);
});

test('Status splits what matters from diagnostics, and repeats no amber', async () => {
  const status = read('panel/status.js');
  assert.match(status, /<details id="stDiag"><summary>Diagnostics/);
  assert.ok(status.indexOf("'frames late'") > status.indexOf('stDiagStats').valueOf(), 'frame numbers are in the diagnostics');
  const { groupIssues } = await import('./static/panel/status.js');
  const spacing = (s) => ({ summary: s, kind: 'spacing', fix: { label: 'Calibrate this run', run: 'r' } });
  assert.equal(groupIssues([spacing('a'), spacing('a')]).length, 1, 'a repeat is dropped');
  const out = groupIssues([{ summary: 'dark', fix: null }, spacing('a'), { summary: 'other', fix: null }, spacing('b')]);
  assert.deepEqual(out.map((x) => x.summary), ['dark', 'The lights are spaced differently than drawn in 2 places.', 'other']);
  assert.equal(out[1].group.length, 2);
  assert.match(css, /\.run-rows li \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto auto; \}/);
  assert.match(css, /\.list-rows li \.what small \{[^}]*var\(--t-help\)/, 'controller rows at 13px');
});

test('the phone sheet keeps Expand on the handle and tabs to themselves', () => {
  const sheet = /\/\* bottom sheet \*\/[\s\S]*?\.panel \{/.exec(css)[0];
  assert.match(sheet, /\.rail-toggle \{[^}]*position: absolute; top: 0/);
  assert.match(sheet, /\.rail-toggle::after \{[^}]*calc\(var\(--handle\) - var\(--tap\)\)/, 'a full tap tall');
  assert.match(sheet, /\.ico svg \{ width: 20px; height: 20px; \}/);
  assert.match(css, /--peek: 68px/);
  assert.match(read('sheet.js'), /const PEEK = 68;/);
  assert.match(read('panel/looks.js'), /const PEEK_CHROME = 68;/);
});

test('a long look name wraps instead of being cut off', () => {
  assert.doesNotMatch(/^\.preset \.name \{[^}]*\}/m.exec(css)[0], /ellipsis/);
});

test('the runs line counts spacing warnings the way the card above does', () => {
  assert.match(read('panel/status.js'), /runsFine\(new Set\(/);
});
