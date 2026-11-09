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
  assert.doesNotMatch(say, /Home Assistant/, 'one sentence: the button is the fix');
  assert.match(darkMessage(['Yard', 'Porch', 'Shed']), /^Yard, Porch and Shed are at/);
  assert.equal(darkMessage([]), '');
  const status = read('panel/status.js');
  assert.match(status, /darkMessage\(zeroNames\)/);
  assert.match(read('panel/looks.js'), /applyToast\(S, what, outcome,/);
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
  assert.equal(stepPlace({ done: false }), "This step isn't done yet", 'no step number to read against the count');
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
  assert.match(css, /\.chips:not\(\.toggles\) > button\.on::before \{\s*content: '';[^}]*mask: var\(--check\)/);
  assert.match(css, /--check: url\("data:image\/svg\+xml[^;]*M3 8\.5l3\.2 3\.2L13 5/, 'the same path as the check icon');
});

test('single-choice sets are segmented and the show-on-map group has a name', () => {
  const setup = read('panel/setup.js');
  assert.match(setup, /class="seg five" id="suModes"/);
  assert.ok(setup.indexOf('Show on the map') > setup.indexOf('Color the map by'));
});

test('pinned is one symbol, a pin, so the bookmark means only Presets', () => {
  assert.doesNotMatch(read('icons.js'), /\bstar\b/);
  assert.match(read('panel/presets.js'), /pinFilled/);
  assert.doesNotMatch(read('panel/presets.js'), /presetsFilled/);
});

test('Remove looks the same in live and preview rows, and a row\'s edge says which it is', () => {
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /class="danger" data-a="remove"/);
  assert.match(looks, /c\.lane === 'preview' \? 'var\(--preview\)' : 'var\(--house\)'/);
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
  globalThis.document = { addEventListener: (_, fn) => { handler = fn; } };
  escapeCloses({ isConnected: true, getClientRects: () => [1] }, () => open, () => { closed++; });
  const press = (key) => { const e = { key, stopped: false, target: null, preventDefault() {}, stopPropagation() { this.stopped = true; } }; handler(e); return e; };
  assert.equal(press('a').stopped, false);
  assert.equal(closed, 0);
  assert.equal(press('Escape').stopped, true, 'it must not go on to clear the selection');
  assert.equal(closed, 1);
  open = false;
  assert.equal(press('Escape').stopped, false, 'a closed popover leaves the key alone');
  delete globalThis.document;
  const looks = read('panel/looks.js');
  assert.match(looks, /escapeCloses\(el, \(\) => !picker\.hidden, \(\) => \{ const back = opener; openPicker\(false\); back\.focus\(\); \}\)/, 'Show on returns focus');
  assert.match(looks, /setAttribute\('aria-expanded', on \? 'true' : 'false'\)/);
  assert.match(read('form.js'), /escapeCloses\(box, \(\) => box\.open/, 'the color editor');
  assert.match(read('picker.js'), /escapeCloses\(el, \(\) => !pop\.hidden, \(\) => close\(true\)\)/, 'the picker');
});

test('B29: calibration names wrap, undoing the single-line .nv rule', () => {
  const rule = /\.cal-prog li \.name \{[^}]*\}/.exec(css)[0];
  assert.match(rule, /white-space: normal/);
  assert.match(rule, /overflow: visible/);
});

test('B33: toasts sit above the map toggle and legend', async () => {
  const { toastBottom } = await import('./static/map-frame.js');
  assert.equal(toastBottom({ height: 900, layout: 'wide', calibrating: false, calTop: 0, floats: 120 }), 128);
  assert.equal(toastBottom({ height: 844, layout: 'sheet', calibrating: false, calTop: 354, floats: 450 }), 458, 'above the sheet and its toggle');
  assert.equal(toastBottom({ height: 844, layout: 'sheet', calibrating: true, calTop: 354, floats: 530 }), 538, 'above the key too');
  assert.match(read('app.js'), /\.filter\(\(\[r, keep\]\) => r\.height && keep\(r\)\)/, 'a legend hidden by CSS has no top');
});

test('B34: picker lists show whole rows, and Show on has no scroll of its own', () => {
  assert.match(css, /\.picker-list \{[^}]*max-height: calc\(var\(--tap\) \* var\(--picker-rows\)\)[^}]*scroll-snap-type: y mandatory/);
  assert.match(css, /\.picker-option \{[^}]*height: var\(--tap\)[^}]*scroll-snap-align: start/);
  assert.doesNotMatch(css, /\.target-list \{[^}]*max-height/);
  assert.match(css, /\.picker-pop \{[^}]*scroll-margin/);
});

test('B35: a warning toast is the warning color', () => {
  assert.match(css, /\.toast\.warn \{ border-left-color: var\(--warn\)/);
  assert.match(read('panel/looks.js'), /return S\.toast\(r\.text, r\.warn \? \{ ms: 9000, warn: true \} : r\.neutral/);
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
  assert.match(read('panel/looks.js'), /reveal\(c\.el\);/);
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
  assert.equal(v(zones(0, 0), 1, [[[0, 19]]]).text, 'Lights are dark: 2 zones at 0%');
  assert.equal(v(zones(0, 1), 1, [[[0, 4]]]).text, 'Lights are dark: 1 zone at 0%', 'its only layer is in the dark zone');
  assert.equal(v(zones(0, 1), 1, [[[0, 19]]]).text, 'Partly lit: Yard at 0%');
  assert.equal(v(zones(0, 1), 1, [[[10, 12]]]).cls, 'ok', 'a dark zone with nothing on it costs nothing');
  assert.equal(v({ master: 0, zones: { yard: 1 } }, 1, [[[0, 4]]]).text, 'Nothing is lit: brightness is at 0%');
  assert.match(v(zones(0, 0), 1, null).text, /Lights are dark: 2 zones/, 'layers not read yet');
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
  assert.match(src, /placed\.some\(\(b\) => hit\(box, b, l\.budget \? NAME_ROOM : LABEL_GAP\)\)/);
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
  assert.match(read('panel/looks.js'), /reveal\(cards\.get\('preview:' \+ added\.id\)\.el, true\)/);
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
  assert.equal(effectSummary({ id: 'solid', name: 'Solid', params: [{ name: 'color', type: 'color' }] }), 'Solid · Single color');
  const { count, plural } = await import('./static/util.js');
  assert.equal(count(22322), '22,322');
  assert.equal(plural(22322, 'light'), '22,322 lights');
  assert.equal(plural(1, 'light'), '1 light');
  assert.doesNotMatch(read('panel/calibrate.js'), /anchors\.yaml<\/code>/);
  assert.doesNotMatch(read('panel/status.js'), /'map draw'/);
});

test('the brightness warning is said once per screen, and its toast leaves with the tab', () => {
  const looks = read('panel/looks.js');
  assert.match(looks, /darkToast = applyToast\(S, what, outcome,/, 'the result of Apply, once');
  assert.match(looks, /S\.on\('tab', \(\) => \{ darkToast\?\.remove\(\)/);
  assert.doesNotMatch(looks, /note\.className = orig \? 'note copy-note' : dark/, 'not on every card as well');
  const status = read('panel/status.js');
  assert.doesNotMatch(status, /stDark/, 'one issues list on Status');
  assert.match(status, /statusIssues\(lit\.cls === 'warn' \? '' : darkMessage\(zeroNames\)/, 'a dark verdict is its own card');
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
  assert.match(looks, /bri-label[^>]*>\$\{icon\('sun'\)\}<span class="bri-word">Brightness/);
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

test('the default model is dimmer and simpler, with full detail in Setup', () => {
  const scene = read('scene.js');
  assert.match(scene, /load\(DETAIL, 'simple'\) === 'full' \? 'full' : 'simple'/, 'simple unless this device chose otherwise');
  assert.match(scene, /m\.material\.depthTest = detail === 'simple'/, 'lines behind a wall are hidden');
  assert.match(scene, /const SIMPLE_LINES = 0\.5;/);
  assert.match(read('panel/setup.js'), /data-detail="full"/);
});

test('fine-detail layers are named, not guessed from the rest', async () => {
  const src = read('scene.js').match(/const isFineDetail = (.*);/)[1];
  const isFine = eval(src);
  for (const n of ['detail lines', 'fine-detail', 'trim_lines']) assert.ok(isFine(n), n);
  for (const n of ['walls lines', 'detailed', 'walls faces']) assert.ok(!isFine(n), n);
});

test('the map model is dim so the lights lead', () => {
  assert.match(read('scene.js'), /lines: \{ color: '#d9e8ff', opacity: 0\.28 \}/);
});

test('B53: a failed refresh keeps the last state on Looks and says so', async () => {
  const { stageSub, stageTitle } = await import('./static/panel/looks.js');
  assert.match(stageSub({ rows: 2, stale: true, word: 'Tap' }), /last known/);
  assert.equal(stageTitle({ live: 1, preview: 0, read: true, status: 'unavailable' }), 'On the lights', 'the last reading stays named');
  assert.equal(stageTitle({ live: 0, preview: 0, read: true, status: 'unavailable' }), 'Nothing on the lights', 'the empty stage stays');
  assert.match(stageTitle({ live: 0, preview: 0, read: false, status: 'loading' }), /Checking/, 'no reading yet: nothing claimed');
  assert.match(stageTitle({ live: 0, preview: 0, read: false, status: 'unavailable' }), /Couldn't read/);
  assert.equal(stageSub({ rows: 0, stale: false, word: 'Tap' }), "Tap a look below to preview it on the map; the lights don't change.");
  assert.equal(stageSub({ rows: 1, stale: false, word: 'Tap' }), '');
  assert.match(css, /\.stage\.stale \.stage-head small \{ color: var\(--warn\)/);
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

test('B66: the phone calibration sheet never rests with a row cut in half', async () => {
  const { sheetShift } = await import('./static/panel/calibrate.js');
  const rows = [{ top: 0, bottom: 100 }, { top: 100, bottom: 144 }, { top: 150, bottom: 190 }];
  assert.equal(sheetShift(rows, 120), 26, 'the smallest move that lands between rows');
  assert.equal(sheetShift(rows, 146), 0, 'an edge between rows moves nothing');
  assert.equal(sheetShift([{ top: 0, bottom: 100 }, { top: 110, bottom: 150 }], 112), -6, 'upward when that is nearer');
  // Two rows that overlap: the edge has to clear both.
  assert.equal(sheetShift([{ top: 0, bottom: 44 }, { top: 40, bottom: 84 }], 60, 64), 28);
  assert.equal(sheetShift([{ top: 0, bottom: 400 }], 200), 0, 'a tall block is left to scroll');
  assert.match(css, /\.cal-dock \{ flex: none;/, 'the dock is a flex sibling, so it cannot cover the scroller');
});

test('B67: the pixel field has room for its whole placeholder', () => {
  assert.doesNotMatch(read('panel/calibrate.js'), /placeholder="Pixel number"[^>]*width:8em/);
  assert.match(css, /\.cal-pixel \{[^}]*min-width: 9em/);
});

test('B68: Preview holds one width, so Pin and More do not shift', () => {
  assert.match(css, /\.preset-actions \[data-act=try\] \{ width: 8\.4em; padding: 0;/);
});

test('B64: Apply reports what really happened, and the chip says so too', async () => {
  const { lightOutcome } = await import('./static/house-status.js');
  const { applyResult } = await import('./static/panel/looks.js');
  const { mapStatus } = await import('./static/map-status.js');
  const geo = { areas: [{ id: 'a', ranges: [[0, 9]] }, { id: 'b', ranges: [[10, 19]] }], zones: [{ id: 'yard', name: 'Yard', area: 'a' }, { id: 'porch', name: 'Porch', area: 'b' }] };
  const dark = { master: 1, zones: { yard: 0, porch: 1 } };
  const none = lightOutcome(geo, dark, [[[0, 9]]]);
  assert.equal(none.dark, 'none');
  assert.equal(lightOutcome(geo, dark, [[[0, 19]]]).dark, 'part');
  assert.equal(lightOutcome(geo, dark, [[[10, 19]]]).dark, '');
  assert.equal(lightOutcome(geo, { master: 0, zones: {} }, [[[10, 19]]]).dark, 'none', 'the master at 0 is dark too');
  assert.equal(applyResult('the look to the lights', { dark: '' }).warn, false);
  const r = applyResult('the look to the lights', none);
  assert.equal(r.warn, true);
  assert.match(r.text, /but they stay dark\. Yard is at 0% brightness/);
  const chip = mapStatus({ connected: true, show: 'house', preview: { previewing: false }, target: false, lit: none });
  assert.equal(chip.text, 'Lights: dark');
  assert.equal(chip.detail, ', zones at 0%');
  assert.equal(mapStatus({ connected: true, show: '', preview: { previewing: true }, target: false, lit: none }).text, 'Showing your preview', 'a preview on the map is still a preview');
  assert.doesNotMatch(read('panel/looks.js'), /S\.toast\(`Applied \$\{list/, 'no success toast before the brightness is known');
});

test('B65: the phone keeps a color key above the sheet, not at the toggle', async () => {
  assert.match(css, /body\[data-detent=peek\]:not\(\.calibrating\) \.legend[^{]*\{ display: flex; \}/);
  assert.match(css, /\.legend \{ display: none; left: 8px; right: 8px; bottom: calc\(var\(--sheet-visible\) \+ 8px\)/);
  const { frameInsets } = await import('./static/map-frame.js');
  const f = frameInsets({ height: 844, chips: 52, crumbs: null, controls: 52, layout: 'sheet', covered: 68, calibrating: false, calTop: 0, floats: 160 });
  assert.equal(f.bottom, 166, 'framing keeps the house above the key');
});

test('B70: a failed map load keeps the navigation and the preset library', () => {
  const app = read('app.js');
  assert.match(app, /try \{ S\.geo = await api\('\/api\/map\/geometry'\); \} catch \(e\) \{ await startWithoutMap\(e\); return; \}/);
  assert.match(app, /showMapError\('load the map', e, serverUp\)/);
  assert.match(app, /S\.presetLibrary = createPresets\(S, \$\('tab-presets'\)\);\n  for \(const \[id, name\] of NEEDS_MAP\)/);
  assert.match(app, /showMapError\('draw the map', e\);\n    S\.view = blank\(\);/, 'a model that fails to draw leaves the tabs working');
  assert.match(read('index.html'), /id="mapError"/);
});

test('the action bar holds one button, a choice and a way out', async () => {
  const { applyPlan, replaceNote } = await import('./static/panel/looks.js');
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /lkBarName|lkBarStrip/, 'the look shows on its row, not again in the footer');
  assert.doesNotMatch(looks, /Add to lights/, 'Add is a choice beside the button, not a second one');
  assert.equal(applyPlan({ n: 2, house: 0, hidden: [], mode: 'replace' }).label, 'Put 2 looks on the lights');
  assert.equal(applyPlan({ n: 1, house: 1, hidden: [], mode: 'replace' }).label, 'Add 1 look on top');
  assert.equal(applyPlan({ n: 1, house: 1, hidden: [], mode: 'replace' }).choice, false, 'nothing covered: nothing to choose');
  const covered = applyPlan({ n: 2, house: 1, hidden: ['Dusk'], mode: 'replace' });
  assert.equal(covered.label, "Replace what's on the lights with 2 looks");
  assert.equal(covered.choice, true);
  assert.equal(covered.replace, true);
  assert.equal(covered.note, 'Replaces Dusk');
  assert.equal(applyPlan({ n: 2, house: 3, hidden: ['Dusk'], mode: 'replace' }).note, 'Replaces Dusk · 2 more stay');
  const added = applyPlan({ n: 2, house: 1, hidden: ['Dusk'], mode: 'add' });
  assert.equal(added.label, 'Add 2 looks on top');
  assert.equal(added.replace, false);
  assert.match(applyPlan({ n: 1, updates: true, house: 1, hidden: [], mode: 'replace' }).label, /^Update 1 look/);
  assert.equal(replaceNote([]), '');
  assert.equal(replaceNote(['Glitter']), 'Replaces Glitter');
  assert.match(looks, /Clear preview/, 'clearing reads apart from a row\'s Remove');
});

test('the target control is a popover, and a long place name is not cut off', () => {
  const rule = /\.target-picker \{[^}]*\}/.exec(css)[0];
  assert.match(rule, /position: absolute/);
  assert.match(rule, /box-shadow/);
  assert.doesNotMatch(/\.target-btn b \{[^}]*\}/.exec(css)[0], /ellipsis|nowrap/);
});

test('every panel warns with the same card, in the same nouns', async () => {
  const { warningHTML } = await import('./static/states.js');
  assert.match(warningHTML('Porch is at 0%'), /class="issue solo"[\s\S]*Porch is at 0%/);
  assert.doesNotMatch(css, /dark-note|cal-warn/);
  assert.doesNotMatch(read('panel/calibrate.js'), /cal-warn/);
  assert.doesNotMatch(read('panel/looks.js'), /Could not load your looks|Take this layer|'Layer brightness|"Layer brightness/);
});

test('Status tiles are even, uptime is words, and file names stay out of the way', async () => {
  const { readableDuration } = await import('./static/panel/status.js');
  const { warningSummary } = await import('./static/names.js');
  assert.match(css, /\.stats \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  for (const [raw, said] of [['45s', '45 s'], ['16m2s', '16 min'], ['3h5m12s', '3 h 5 min'], ['2h0m0s', '2 h'], ['51h0m9s', '2 days 3 h'], ['0s', '0 s'], ['not a time', 'not a time']]) assert.equal(readableDuration(raw), said);
  const w = warningSummary({ runs: [{ id: 'run-a', name: 'Front edge' }], nodes: [], controllers: [] }, 'anchors.yaml:22: run run-a: has a problem');
  assert.match(w.plain, /^The saved measurements, line 22: /);
  assert.doesNotMatch(w.plain, /anchors\.yaml|run-a/);
});

test('the last polish: pin glyph, type sizes, contrast and the Preview reason', () => {
  assert.match(read('panel/presets.js'), /icon\(p\.pinned \? 'pinFilled' : 'pin'\)/);
  assert.match(css, /--t-help: 14px/);
  assert.match(css, /--t-meta: 14px/);
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const card2 = /--card2: (#[0-9a-f]{6})/.exec(css)[1];
  const strong = /--line-strong: (#[0-9a-f]{6})/.exec(css)[1];
  assert.ok(ratio(strong, card2) >= 3, `control border ${strong} on a raised card`);
  assert.ok(ratio(/\.handle i \{[^}]*background: (#[0-9a-f]{6})/.exec(css)[1], card2) >= 3, 'sheet handle');
  const app = read('app.js');
  assert.match(app, /aria-disabled/, 'a tap on the unavailable Preview still explains itself');
  assert.doesNotMatch(app, /t\.disabled = !m\.canPreview/);
  assert.match(read('overlay.js'), /MAJOR, S\.panel\?\.layout\?\.\(\) === 'sheet'\)/, 'controller labels thin on the small map');
});

test('B62: test bands and gaps bring their step back into view, and a gap asks only for a length', () => {
  const cal = read('panel/calibrate.js');
  assert.match(cal, /stepKey !== shownStep/, 'the step comes back into view when it changes');
  assert.match(cal, /if \(!isGap\) parts\.push\(`<div class="cal-read">/, 'a gap has no pixel to have moved');
  assert.match(cal, /isGap \? NO_CURSOR_HOW\.gap/);
});

test('B56: Previous and Next are placed before the instructions', () => {
  const src = read('panel/calibrate.js');
  assert.ok(src.indexOf('parts.push(nav());') < src.indexOf('class="cal-how"'));
});

test('B57: the list marks the current step and scrolls to it only when it changes', async () => {
  const src = read('panel/calibrate.js');
  assert.match(src, /aria-current="step"/);
  assert.match(src, /here-tag">Now</);
  assert.match(src, /stepKey !== shownStep/);
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
  for (const rule of [/^\.preset \.strip \{[^}]*\}/m, /^\.layer \.name-line \.strip \{[^}]*\}/m, /^\.picker-swatch \{[^}]*\}/m, /^\.inspect \.chip-color \{[^}]*\}/m]) {
    assert.match(rule.exec(css)[0], /var\(--rim\)/, String(rule));
  }
  assert.doesNotMatch(css, /solid #000?[67]/);
  const { choiceStrip } = await import('./static/form.js');
  const S = { palettes: [{ id: 'color-1', name: 'Color 1' }] };
  assert.match(choiceStrip(S, 'color-1', 'solid', ['#000000']), /svg\+xml/);
  assert.match(choiceStrip(S, 'color-1', 'solid', []), /svg\+xml/);
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
  assert.equal(modelPartLabel('site-lines', 'lines'), 'Site outline');
  assert.equal(modelPartLabel('walls-lines', 'lines'), 'Walls outline');
  const setup = read('panel/setup.js'), looks = read('panel/looks.js'), cal = read('panel/calibrate.js');
  assert.doesNotMatch(setup, />Even runs too</);
  assert.doesNotMatch(setup, />Copy view</);
  assert.match(looks, />Goes on</);
  assert.doesNotMatch(looks, />Apply to</);
  assert.doesNotMatch(looks, /Next look on/);
  assert.match(looks, /The lights keep running/);
  assert.doesNotMatch(cal, /At the estimate/);
});

test('the layer card keeps Remove beside Tweak, and long setting names take their own line', () => {
  assert.match(read('panel/looks.js'), /class="tweak icon-btn"[^\n]*data-a="remove"/);
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
  for (const piece of ["icon('edit')", "icon('copy')", "icon('trash')", 'ArrowDown', "escapeCloses(row.querySelector('.menu-wrap')"]) assert.ok(src.includes(piece), piece);
});

test('one word for previewing, in purple, and stacking is said out loud', () => {
  const looks = read('panel/looks.js'), presets = read('panel/presets.js');
  assert.doesNotMatch(looks, /In preview|>Try</);
  assert.match(presets, /'Previewing' : 'Preview'/);
  assert.doesNotMatch(presets, /Trying/);
  assert.match(css, /\[data-act=try\]\[aria-pressed=true\] \{ color: var\(--preview\)/);
  assert.match(looks, /front = rows\.length > 1 && l === rows\[0\]\[1\]/);
  assert.match(looks, /' · in front'/, 'the top row says it is in front');
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
  assert.match(css, /\.run-rows li \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 6\.5em 6\.4em; \}/);
  assert.match(css, /\.list-rows li \.what small \{[^}]*var\(--t-meta\)/, 'controller rows at 14px');
});

test('the phone sheet keeps Expand on the handle and tabs to themselves', () => {
  const sheet = /\/\* bottom sheet \*\/[\s\S]*?\.panel \{/.exec(css)[0];
  assert.match(sheet, /\.rail-toggle \{[^}]*position: absolute; top: calc\(var\(--handle\) - var\(--tap\)\)/);
  assert.match(sheet, /\.rail-toggle \{[^}]*height: var\(--tap\)/, 'a full tap tall box, not a pseudo-element');
  assert.match(sheet, /\.ico svg \{ width: 20px; height: 20px; \}/);
  assert.match(css, /--peek: 68px/);
  assert.match(read('sheet.js'), /const PEEK = 68;/);
});

test('a long look name wraps instead of being cut off', () => {
  assert.doesNotMatch(/^\.preset \.name \{[^}]*\}/m.exec(css)[0], /ellipsis/);
});

test('the runs line counts spacing warnings the way the card above does', () => {
  assert.match(read('panel/status.js'), /runsFine\(new Set\(/);
});

test('B73: only a run past the warning threshold says how far off it is', async () => {
  const { runOff, LENGTH_WARN } = await import('./static/panel/status.js');
  assert.equal(runOff(0, false), '');
  assert.equal(runOff(LENGTH_WARN - 0.001, false), '', 'just under the threshold');
  assert.equal(runOff(0.08, false), '8.0% off');
  assert.equal(runOff(0.08, true), '', 'a run in no zone yet is a state, not a fault');
  assert.doesNotMatch(read('panel/status.js'), /const off = mis &&/);
});

test('B76: controller labels drop repeated detail and keep whole words', async () => {
  const { controllerLabel } = await import('./static/names.js');
  const { shortLabel } = await import('./static/overlay.js');
  assert.equal(controllerLabel('Workshop', 'Octa board, north workshop'), 'Workshop · Octa board');
  assert.equal(controllerLabel('Workshop', 'Quad board, workshop'), 'Workshop · Quad board');
  assert.equal(controllerLabel('Porch', 'Porch,'), 'Porch', 'nothing but a repeat is nothing to add');
  assert.doesNotMatch(controllerLabel('Shed', 'Board one, Shed, garden'), /,$/);
  assert.equal(shortLabel('Short name'), 'Short name');
  const cut = shortLabel('Controller by the north gate, garden side');
  assert.ok(cut.endsWith('…') && cut.length <= 26, cut);
  assert.doesNotMatch(cut, /[,;:\s]…$/);
  assert.equal(cut, 'Controller by the north…', 'a whole word, never part of one');
});

test('B77: a toggle chip is the same box on and off', () => {
  const off = /\.chips\.toggles > button::before \{ ([^}]*) \}/.exec(css)[1];
  const on = /\.chips\.toggles > button\.on::before \{ ([^}]*) \}/.exec(css)[1];
  assert.match(off, /width: 12px; height: 12px/);
  assert.match(off, /border: 1px solid currentColor/);
  // The on state only fills the box: no size, border or mask of its own.
  assert.doesNotMatch(on, /width|height|border|mask/);
  assert.match(css, /\.chips:not\(\.toggles\) > button\.on::before/, 'only non-toggle chips use a bare check');
});

test('B78: a per-unit has no stray space, and other units keep theirs', async () => {
  const { showQty } = await import('./static/util.js');
  assert.equal(showQty('density', 2), '2/m/s');
  assert.equal(showQty('rate', 0.2), '0.2/s');
  assert.equal(showQty('speed', 3), '3 m/s');
  assert.equal(showQty('length', 2), '2 m');
});

test('B80: Calibrate Details uses plain names, with raw ids behind their own disclosure', async () => {
  const { sourceWords } = await import('./static/panel/calibrate.js');
  assert.equal(sourceWords('estimated'), 'Estimated from the layout');
  assert.equal(sourceWords('measured'), 'Measured');
  const src = read('panel/calibrate.js');
  assert.doesNotMatch(src, /<th>Target<\/th>/, 'the raw target is not a row');
  assert.doesNotMatch(src, /esc\(c\.controller\) \+ ':' \+ c\.index/, 'no raw id in the plain table');
  assert.match(src, /<details class="ids"/);
});

test('B71: the catalog control says where the next look goes, and a layer has its own place', () => {
  const src = read('panel/looks.js');
  // The control sits with what it governs: the catalog, above the cards.
  const head = /<div class="catalog-head"[\s\S]*?<div class="cards" id="lkPresets">/.exec(src);
  assert.ok(head, 'the Goes on control is in the catalog heading');
  assert.match(head[0], />New previews go on</);
  // A preview layer's place is a control of its own, on its own card.
  assert.match(src, /className: 'place icon-btn'/);
  assert.match(src, /<span class="muted">Goes on<\/span><b>\$\{esc\(placeName\)\}<\/b>/);
  assert.match(src, /\/api\/v1\/preview\/layers\/.*\{ target: value \}/, 'moving a layer patches only that layer');
  assert.match(src, /escapeCloses\(place, \(\) => pickFor === c/, 'Escape closes it, even with focus left on the button');
  // Choosing for a layer must not change where the next look goes.
  const move = /function choose\(value\) \{[\s\S]*?target = value;/.exec(src)[0];
  assert.match(move, /if \(pickFor\) \{ moveLayer\(pickFor, value\); return; \}/);
});

test('B72: anything cut by the sticky bar is scrolled clear after the sheet rises', async () => {
  const { underBar } = await import('./static/panel/looks.js');
  assert.equal(underBar({ top: 700, bottom: 820 }, 784), true, 'its slider is under the bar');
  assert.equal(underBar({ top: 500, bottom: 760 }, 784), false, 'fully above');
  assert.equal(underBar({ top: 800, bottom: 900 }, 784), false, 'wholly below is just further down the list');
  const src = read('panel/looks.js');
  assert.match(src, /S\.on\('detent', clearBar\)/);
  assert.match(read('app.js'), /S\.emit\('detent', d\)/);
  assert.match(css, /scroll-padding-bottom: calc\(var\(--look-bar, 0px\) \+ 8px\)/, 'the scroller reserves the bar');
});

test('B75: the dark warning is said once on a screen', async () => {
  const { applyResult } = await import('./static/panel/looks.js');
  const dark = { dark: 'none', zones: ['Porch'], message: 'Porch is at 0% brightness, so nothing shows there.' };
  // The banner says why: the toast only confirms, in a neutral color, and doesn't repeat it.
  const shown = applyResult('the look to the lights', dark, true);
  assert.equal(shown.warn, false);
  assert.equal(shown.neutral, true);
  assert.equal(shown.text, 'Applied the look to the lights.');
  // No card on screen (a collapsed panel): the toast is the warning.
  const hidden = applyResult('the look to the lights', dark, false);
  assert.equal(hidden.warn, true);
  assert.match(hidden.text, /0% brightness/);
  // The chip steps back while a card on the open tab explains it.
  assert.doesNotMatch(read('app.js'), /darkInPanel/, 'the chip says the same with or without the tab\'s warning');
  // Status: the verdict carries the fix instead of a card repeating it.
  const status = read('panel/status.js');
  assert.match(status, /statusIssues\(lit\.cls === 'warn' \? '' : darkMessage\(zeroNames\)/, 'a dark verdict is its own card');
  // A failed refresh: the now-line says so; the lane doesn't say it again.
  assert.match(read('panel/looks.js'), /S\.houseStatus === 'available' \|\| S\.houseRead \? null : houseState/);
});

test('B74: without the map Status still works, and the error names the real cause', async () => {
  const { bootFailure } = await import('./static/states.js');
  const e = { network: true };
  assert.match(bootFailure('load the map', e).detail, /isn't responding/, 'nothing answered');
  const partial = bootFailure('load the map', e, true);
  assert.match(partial.detail, /running, but the map data/);
  assert.doesNotMatch(partial.detail, /isn't responding/);
  const app = read('app.js');
  assert.match(app, /const NEEDS_MAP = \[\['looks', 'Looks'\], \['setup', 'Set up the map'\]\];/);
  assert.match(app, /S\.status = createStatus\(S, \$\('tab-status'\)\);\n[\s\S]*const loadLibrary/, 'Status starts in the mapless path');
  const { maplessVerdict } = await import('./static/panel/status.js');
  assert.equal(maplessVerdict({ layers: 2, brightness: { master: 1 } }).text, '2 looks on the lights');
  assert.equal(maplessVerdict({ layers: 0 }).text, 'Nothing is lit: no looks are on the lights');
  assert.equal(maplessVerdict({ layers: 2, brightness: { master: 0 } }).cls, 'warn');
});

test('B81: the phone calibrate map carries the point key, and framing keeps clear of it', async () => {
  assert.match(css, /body\.calibrating \.legend \{ display: flex; bottom: calc\(100% - var\(--cal-map\)/);
  const { frameInsets, toastBottom } = await import('./static/map-frame.js');
  const key = frameInsets({ height: 844, chips: 52, crumbs: null, controls: 60, layout: 'sheet', covered: 700, calibrating: true, calTop: 354, floats: 530 });
  assert.equal(key.bottom, 536, 'framing stops above the key');
  assert.equal(toastBottom({ height: 844, layout: 'sheet', calibrating: true, calTop: 354, floats: 530 }), 538);
});

test('calibrate key: each entry is drawn as the map draws it', () => {
  const src = read('overlay.js');
  assert.match(src, /sw ring" style="color:#5ddc8a"/);
  assert.match(src, /sw ring dash" style="color:#ffb347"/);
  assert.match(src, /sw dot/);
  assert.match(src, /sw diamond/);
  assert.match(src, /ring\(q, 8 \* k, measured \? '#5ddc8a' : '#ffb347', 2, measured \? null : \[3, 3\]\)/);
});

test('Setup leads with Calibrate and the color mode, and tucks the model behind Advanced', () => {
  const src = read('panel/setup.js');
  const at = (t) => src.indexOf(t);
  assert.ok(at('id="suCal"') < at('Color the map by') && at('Color the map by') < at('Which lights to show'), 'the order on the page');
  const adv = /<details id="suAdvanced">[\s\S]*?<\/details>/.exec(src)[0];
  assert.match(adv, /id="suModel"/);
  assert.match(adv, /id="suCamera"/);
  assert.match(css, /#suLayers > button \{[^}]*white-space: nowrap/, 'chip labels stay on one line');
});

test('polish: plain labels and counts', async () => {
  const { controllerFact } = await import('./static/panel/status.js');
  assert.deepEqual(controllerFact({ reachable: true, sending: true }), { text: 'Sending', cls: 'ok' });
  assert.deepEqual(controllerFact({ reachable: false, sending: true }), { text: 'Unreachable', cls: 'bad' });
  assert.equal(controllerFact({ reachable: true, sending: false }).text, 'Output off');
  assert.equal(controllerFact(null).text, 'No report');
  const status = read('panel/status.js'), cal = read('panel/calibrate.js');
  assert.match(status, /'look'\)\} in preview/);
  assert.doesNotMatch(status, /'sending'\)/);
  assert.match(cal, /const BETWEEN = 'Between runs'/);
  assert.match(cal, /test bands across a whole controller/);
  assert.match(cal, /Find either end of a run/);
});

test('polish: type, primary green and wiring colors', async () => {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const go = /--go: (#[0-9a-f]{6})/.exec(css)[1];
  assert.ok(1.05 / (lum(go) + 0.05) >= 6, `white on ${go} is at least 6:1`);
  assert.match(css, /--t-note: 13px/);
  assert.match(css, /\.error, \.err, \.field-err \{ color: #fca5a5; font-size: var\(--t-note\)/);
  const { nthColor } = await import('./static/util.js');
  // No two colors in the first 16 may be close enough to be taken for each other.
  const near = [];
  for (let a = 0; a < 16; a++) for (let b = a + 1; b < 16; b++) {
    const [x, y] = [nthColor(a), nthColor(b)];
    if (Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 40) near.push([a, b]);
  }
  assert.deepEqual(near, []);
});

test('polish: a preset row previews like a Looks card and its icons agree', () => {
  const src = read('panel/presets.js');
  assert.match(src, /querySelector\('\.preset-body'\)\.onclick = \(\) => S\.looks\.push/);
  assert.match(src, /icon\('eye'\)/);
  assert.match(read('panel/looks.js'), /className = 'target-group'/, 'places are grouped');
});

test('B82: Setup\'s map colors and labels stay on Setup, and come back there', async () => {
  const { overlayShown, createOverlay } = await import('./static/overlay.js');
  const { mapStatus } = await import('./static/map-status.js');
  const st = { mode: 'outputs', nodes: true, labels: true, controllers: true };
  assert.deepEqual(overlayShown(st, { tab: 'looks' }), { mode: 'live', nodes: false, labels: false, controllers: false });
  assert.deepEqual(overlayShown(st, { tab: 'presets' }).mode, 'live');
  assert.equal(overlayShown(st, { tab: 'setup' }), st, 'Setup shows what was chosen');
  assert.deepEqual(overlayShown(st, { tab: 'looks', calibrating: true }), { mode: 'live', nodes: true, labels: true, controllers: true }, 'calibration keeps its own view');
  // Saved on Setup, then a reload on Looks: the choice stays, the map doesn't show it.
  const saved = { v: 2, mode: 'outputs', labels: true };
  globalThis.localStorage = { getItem: () => JSON.stringify(saved), setItem() {} };
  try {
    let tab = 'looks';
    const ov = createOverlay({ geo: { pixels: { count: 0 }, mappings: [], zones: [], controllers: [] }, panel: { tab: () => tab } });
    assert.equal(ov.st.mode, 'outputs');
    assert.equal(ov.shown().mode, 'live');
    assert.equal(mapStatus({ connected: true, show: '', preview: { previewing: false }, mode: ov.shown().mode }).text, 'Showing the lights');
    tab = 'setup';
    assert.equal(mapStatus({ connected: true, show: '', preview: { previewing: false }, mode: ov.shown().mode }).text, 'Colored by Wiring');
  } finally { delete globalThis.localStorage; }
});

test('B83: the chip says nothing is lit the same way everywhere, quietly, and never green', async () => {
  const { mapStatus, badgeHTML } = await import('./static/map-status.js');
  const { lightOutcome } = await import('./static/house-status.js');
  const geo = { areas: [{ id: 'a', ranges: [[0, 9]] }, { id: 'b', ranges: [[10, 19]] }], zones: [{ id: 'a', name: 'Yard', area: 'a' }, { id: 'b', name: 'Porch', area: 'b' }] };
  const dark = { master: 1, zones: { a: 0, b: 0 } };
  const base = { connected: true, show: '', target: false, preview: { previewing: false } };
  // Apply at 0%: one layer in a zone at 0.
  const atZero = mapStatus({ ...base, lit: lightOutcome(geo, dark, [[[0, 4]]], true) });
  assert.equal(atZero.text, 'Lights: dark');
  assert.equal(atZero.cls, 'unlit', 'neutral: the panel has the warning');
  assert.notEqual(atZero.cls, 'house');
  assert.equal(atZero.detail, ', zones at 0%', 'says why, not which: the tab names them');
  // Partly lit, and nothing on the lights at all.
  assert.equal(mapStatus({ ...base, lit: lightOutcome(geo, dark, [[[0, 4]], [[20, 29]]], true) }).text, 'Lights: partly lit');
  const empty = mapStatus({ ...base, lit: lightOutcome(geo, { master: 1, zones: { a: 1, b: 1 } }, [], true) });
  assert.equal(empty.text, 'Lights: nothing lit');
  assert.equal(empty.detail, ' · no looks on them');
  // Before the first reading the chip doesn't claim either way.
  assert.equal(mapStatus({ ...base, lit: lightOutcome(geo, dark, [], false) }).text, 'Showing the lights');
  assert.match(badgeHTML(empty, true), /class="detail">no looks on them</, 'a phone stacks what detail there is');
  assert.equal(badgeHTML(atZero), '<span>Lights: dark<span class="detail">, zones at 0%</span></span>');
  assert.match(badgeHTML(atZero, true), /class="detail">zones at 0%</, 'stacked, without the comma');
  assert.doesNotMatch(css, /\.brand, \.badge \.detail \{ display: none/, 'the detail isn\'t hidden on a phone');
});

test('B84: Map unavailable holds while the page answers; Offline is only a lost server', async () => {
  const { mapStatus } = await import('./static/map-status.js');
  const mapless = { show: '', preview: null, target: false, mapless: true };
  assert.equal(mapStatus({ ...mapless, connected: true }).text, 'Map unavailable');
  assert.equal(mapStatus({ ...mapless, connected: false }).text, 'Offline');
  const app = read('app.js');
  assert.match(app, /\(err\) => !err\.network/, 'a 500 answer is not being offline');
  assert.match(app, /S\.setServerUp = /);
  assert.match(read('panel/status.js'), /if \(e\?\.network\) S\.setServerUp\?\.\(false\)/, 'only a network failure counts');
});

test('B85: without the map a warning offers Retry, and controllers keep their names', async () => {
  const { warningSummary, controllerName } = await import('./static/names.js');
  const g = { mapless: true, runs: [], nodes: [], controllers: [{ id: 'shed-north', name: 'Shed north' }, { id: 'unnamed-box' }] };
  const fix = warningSummary(g, 'layout.yaml:3: run shed-eave: a-b has 90 pixels where its drawn length implies about 60').fix;
  assert.equal(fix.label, 'Retry');
  assert.equal(fix.retry, true);
  assert.equal(warningSummary(g, 'scene s: run "x" isn\'t used').fix.label, 'Retry');
  assert.equal(controllerName(g, 'shed-north'), 'Shed north');
  assert.equal(controllerName(g, 'unnamed-box'), 'Unnamed box', 'derived the same way when the API sends no name');
  const status = read('panel/status.js');
  assert.match(status, /<b title="\$\{esc\(titled\)\}">\$\{esc\(controllerName\(g, c\.id\)\)\}/);
  assert.match(status, /fix\.retry \? location\.reload\(\)/);
});

test('B86: no two labels of any kind overprint; what is left out is counted and readable', async () => {
  const { placeLabels } = await import('./static/overlay.js');
  const { readableLabel, contrast, LABEL_PLATE, nthColor } = await import('./static/util.js');
  const measure = (l) => l.text.length * 6;
  // Every kind at once, piled on one corner of the map: outputs, controllers,
  // corners, points, gaps and a focused name.
  const kinds = [[2, false], [2, false], [1.2, true], [1, true], [0, true], [2.5, false]];
  const labels = Array.from({ length: 240 }, (_, i) => { const [rank, budget] = kinds[i % kinds.length]; return { text: `Label number ${i}`, x: 120 + (i * 13) % 300, y: 120 + (i * 7) % 180, color: '#fff', rank, budget }; });
  const placed = placeLabels(labels, { width: 900, height: 700, measure });
  const apart = (a, b) => a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
  placed.forEach((a, i) => placed.slice(i + 1).forEach((b) => assert.ok(apart(a, b), `${a.text} over ${b.text}`)));
  assert.ok(placed.hidden > 0, 'the crowded ones are left out');
  assert.equal(placed.hidden, labels.length - placed.length, 'and counted');
  assert.ok(placed.filter((p) => p.rank >= 2).length >= placed.filter((p) => p.rank < 1).length, 'the lower ranks give way');
  // A label anchored outside the view is not "hidden".
  assert.equal(placeLabels([{ text: 'off', x: -50, y: 10, color: '#fff', rank: 1, budget: true }], { width: 200, height: 200, measure, avoid: [{ x0: 0, x1: 200, y0: 0, y1: 200 }] }).hidden, 0);
  // Marks are kept clear of when there's another spot, but don't hide a label.
  const marks = [{ x0: 95, x1: 200, y0: 80, y1: 104 }];
  const near = placeLabels([{ text: 'Name', x: 100, y: 100, color: '#fff', rank: 1, budget: false }], { width: 400, height: 400, marks, measure });
  assert.ok(near.length === 1 && (near[0].y0 >= 104 || near[0].y1 <= 80 || near[0].x1 <= 95), JSON.stringify(near[0]));
  const parse = (s) => s.match(/\d+/g).map(Number);
  for (let i = 0; i < 48; i++) {
    const c = `rgb(${nthColor(i)})`;
    assert.ok(contrast(parse(readableLabel(c)), LABEL_PLATE) >= 4.5, c);
  }
  assert.ok(contrast(parse(readableLabel('rgb(249,115,22)')), LABEL_PLATE) >= 4.5);
  assert.equal(readableLabel('#ffffff'), 'rgb(255,255,255)');
  const overlay = read('overlay.js');
  assert.match(overlay, /nodeDisplay\(g, nd\.id\)/, 'names, not ids');
  assert.match(overlay, /runName\(g, id\)/);
  assert.match(read('panel/setup.js'), /label-note/);
});

test('B87: opening Tweak shows the first control above the bar, and the form as far as it fits', async () => {
  const { revealDelta } = await import('./static/panel/looks.js');
  // Below the bar, short enough to fit: its bottom comes up to the bar's top.
  assert.equal(revealDelta({ top: 760, bottom: 900 }, 280, 730), 170);
  // Taller than the view: its top goes to the view's top, not past it.
  assert.equal(revealDelta({ top: 760, bottom: 1700 }, 280, 730), 480);
  // Already in view.
  assert.equal(revealDelta({ top: 400, bottom: 700 }, 280, 730), 0);
  // Above the view: comes back down.
  assert.equal(revealDelta({ top: 200, bottom: 500 }, 280, 730), -80);
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /form\.el\.scrollIntoView/, 'not a smooth scroll that the rising sheet can interrupt');
  assert.match(looks, /revealing \|\| S\.panel\.tab\(\)/, 'the rising sheet does not scroll somewhere else first');
});

test('Looks leaves the grids alone when something previews, and a preview on an empty house says so', async () => {
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /hadPreview/, 'a preview no longer folds the grid under the pointer');
  assert.match(looks, /class="muted">Goes on</, 'where the look goes, in words');
  assert.match(looks, /clock-hint/, 'the clock says what it is for while closed');
  const { applyResult } = await import('./static/panel/looks.js');
  const dark = { dark: 'none', zones: ['Yard'], message: 'x' };
  assert.equal(applyResult('the look to the lights', dark, true).neutral, true, 'and not a third warning');
  assert.equal(applyResult('the look to the lights', dark, true).warn, false);
  assert.equal(applyResult('x', { dark: '' }, true).text, 'Applied x.');
});

test('one section heading style, Setup in order, and matching segments', () => {
  const setup = read('panel/setup.js');
  assert.doesNotMatch(setup, /<h3 class="sub">(Color the map by|Which lights|Show on the map)/);
  assert.ok(setup.indexOf('<h1') < setup.indexOf('<h2 class="sub">Color') && setup.indexOf('<h2 class="sub">Color') < setup.indexOf('<h3 class="sub">Model detail'));
  assert.match(css, /\.group-head \{ margin: 10px 0 6px; \}/, 'Pinned presets is an h2 like Preview');
  assert.doesNotMatch(css, /\.seg\.five > button \{[^}]*font-size/, 'segments match the 14px segments below');
});

test('desktop footer keeps to the panel bottom; legend folds; boot has the tab icons; labels fit a phone', async () => {
  assert.match(css, /#tab-looks > \.look-bar \{ margin-top: auto/);
  assert.match(read('panel/setup.js'), /legend-toggle/);
  assert.match(css, /\.legend\.folded > :not\(\.legend-toggle\) \{ display: none/);
  assert.match(css, /\.target-list \{[^}]*padding-bottom: 12px/, 'the last chips clear the sticky bar');
  const html = read('index.html');
  const icons = html.match(/<span class="ico" data-icon="\w+">/g);
  assert.equal(icons.length, 5);
  for (const ic of icons) assert.ok(html.includes(ic + '<svg'), ic);
  const { icon } = await import('./static/icons.js');
  assert.ok(html.includes(icon('looks')), 'the same drawing the app uses');
  assert.match(read('panel/presets.js'), /\$\{icon\('more'\)\}More/, 'More carries the kebab, like Preview and Pin carry theirs');
  assert.doesNotMatch(css, /\.color-picker summary::before \{ order: 2/, 'the chevron is a disclosure like the rest');
  assert.match(css, /\.calibrate h1\.title, \.cal-step h2 \{ font-size: var\(--t-h2\)/);
  assert.match(css, /text-wrap: balance/);
});

test('B93: a preset card has no reserved row, and its name is the largest text', () => {
  assert.doesNotMatch(css, /\.tab \.sub \{/, "Setup's heading rule must not reach the cards' type line");
  assert.match(css, /\.tab h2\.sub, \.tab h3\.sub \{/);
  assert.match(css, /\.preset \.name \{ font-size: var\(--t-h3\)/, 'the name takes the heading size');
  assert.match(css, /--t-meta: 14px/);
  assert.match(css, /--t-h3: 15px/, 'above the type line on desktop as well');
  assert.match(css, /\.preset \.sub, \.preset \.in-badge \{ height: 1\.4em;/, 'Previewing takes the type line\'s slot');
});

test('B90: the chip says connecting until the first socket result, with status data already in', async () => {
  const { mapStatus, badgeHTML } = await import('./static/map-status.js');
  const preview = { previewing: true };
  const waiting = mapStatus({ connected: false, connecting: true, show: '', preview, mode: 'live' });
  assert.equal(waiting.text, 'connecting…');
  assert.notEqual(waiting.cls, 'off', 'not red');
  assert.match(badgeHTML(waiting), /connecting…/);
  assert.equal(mapStatus({ connected: false, connecting: false, show: '', preview: null }).text, 'Offline', 'lost or refused');
  assert.equal(mapStatus({ connected: true, connecting: false, show: '', preview }).text, 'Showing your preview');
  const app = read('app.js');
  assert.match(app, /connected: S\.connected, connecting: S\.connecting/);
  assert.match(app, /ws\.onclose = \(\) => \{ S\.connected = false; S\.connecting = false;/, 'a failed first attempt is Offline');
});

test('B91: the inspect card stays open under the pointer and keeps still while it is reached', async () => {
  const { createAim, rectGap, cardCorner } = await import('./static/card-place.js');
  assert.equal(rectGap({ left: 10, top: 10, right: 20, bottom: 20 }, 15, 15), 0);
  assert.equal(rectGap({ left: 10, top: 10, right: 20, bottom: 20 }, 25, 10), 5);
  const aim = createAim(500);
  assert.equal(aim.step(100, 0), true, 'closing in');
  assert.equal(aim.step(50, 100), true);
  assert.equal(aim.step(70, 200), false, 'moving away ends it');
  assert.equal(aim.step(60, 300), true, 'closing in again');
  assert.equal(aim.step(10, 900), false, 'a sweep past the hold time inspects again');
  const base = { w: 1000, h: 700, cw: 240, ch: 100, top: 50 };
  const prev = cardCorner({ ...base, pixel: [100, 100] });
  assert.deepEqual(cardCorner({ ...base, pixel: [600, 300], prev }), prev, 'keeps its corner');
  assert.notDeepEqual(cardCorner({ ...base, pixel: [prev[0] + 10, prev[1] + 10], prev }), prev, 'moves off its own pixel');
  const app = read('app.js');
  assert.match(app, /pointerleave', \(e\) => \{ if \(!\$\('inspectCard'\)\.contains\(e\.relatedTarget\)\) endHover\(\)/);
  assert.match(app, /data-pin title="Keep this card open">\$\{icon\('pin'\)\}Pin</, 'Pin is visible on the card');
  assert.match(app, /LONG_PRESS/, 'the long press stays a shortcut');
  assert.match(app, /<summary>Technical details<\/summary>/, 'raw ids are labeled as such');
});

test('B91: Details reads as sentences, and raw ids stay in the technical rows', async () => {
  const { inspectSentences, inspectTechnical } = await import('./static/inspect.js');
  const d = { dead: false, dl: 0.0167, controller: 'shed', index: 12, run: 'eave-run', run_pixel: 12, edge: 'e1', dist: 1.5, x: 1, y: 2, z: 3, mappings: [{ id: 'front-sweep', u: 4.5, kind: 'flow', stretch: 2.3 }] };
  const text = inspectSentences(d, { run: 'Eave', output: { led: 13, count: 484, name: 'Shed 1' }, areas: ['Front'], zones: ['Porch', 'Yard'] }).join(' ');
  assert.match(text, /LED 13 of 484 on Shed 1/);
  assert.match(text, /It is in the Front area\./);
  assert.match(text, /zones Porch and Yard/);
  assert.match(text, /16\.7 mm/);
  assert.doesNotMatch(text, /front-sweep|eave-run/);
  const rows = inspectTechnical(d, { is3d: true, fmt: (v) => String(v) }).map(([k]) => k);
  assert.ok(rows.includes('front-sweep') && rows.includes('Controller pixel'));
});

test('B92: editing a preview of the lights is said once, inline', () => {
  const looks = read('panel/looks.js');
  assert.match(looks, /note\.textContent = orig \? `Editing a preview of/);
  assert.doesNotMatch(looks, /S\.toast\(`Editing a preview/);
});

test('B88: the phone key starts folded while calibrating, stays clear of the sheet and its button is whole', async () => {
  const { keyFolded } = await import('./static/panel/setup.js');
  assert.equal(keyFolded(null, true), true, 'folded by default on the calibrating strip');
  assert.equal(keyFolded(null, false), false, 'elsewhere it stays open by default');
  assert.equal(keyFolded(false, true), false, 'a person who opened it keeps it open');
  assert.equal(keyFolded(true, false), true);
  assert.match(css, /body\.calibrating \.legend \{ display: flex; bottom: calc\(100% - var\(--cal-map\) \+ var\(--cal-shift, 0px\) \+ 8px\); max-height: calc\(/, 'above the calibration sheet, shorter than the strip');
  assert.match(read('app.js'), /foldedCorner/, 'a folded key costs the target no framing');
});

test('B89: Calibrate is one scroll: no nested Progress scroller, and the step stays in view', async () => {
  const { stepScroll } = await import('./static/panel/calibrate.js');
  const prog = /\.cal-prog \{[^}]*\}/.exec(css)[0];
  assert.doesNotMatch(prog, /overflow|max-height/);
  assert.doesNotMatch(css, /\.cal-body > \.cal-prog|\.cal-body \{ display: flex/);
  assert.equal(stepScroll(null, 400, 10), 0);
  assert.equal(stepScroll({ bottom: 300 }, 400, 10), 0, 'already in view');
  assert.equal(stepScroll({ bottom: 500 }, 400, 200), 112, 'just far enough to show its row');
  assert.equal(stepScroll({ bottom: 900 }, 400, 60), 60, 'never past the step heading');
  assert.match(read('panel/calibrate.js'), /<details class="group"/, 'the runs fold; only the current one is open');
  assert.match(css, /\.cal-dock \{ flex: none;/, 'the dock cannot cover the scroller');
});

test('Stop and Close return to the tab Calibrate was opened from, also across a reload', async () => {
  const { returnTab } = await import('./static/panel/calibrate.js');
  assert.equal(returnTab('setup', 'status'), 'setup');
  assert.equal(returnTab('status', 'status'), '');
  assert.equal(returnTab('', 'status'), '', 'opened by the server, not from a tab: stay');
  assert.match(read('panel/calibrate.js'), /sessionStorage\.setItem\('calFrom', tab\)/);
});

test('0%: a layer over dark zones says so, and Status stops calling Sending good news', async () => {
  const { controllerFact, lightsVerdict } = await import('./static/panel/status.js');
  assert.deepEqual(controllerFact({ reachable: true, sending: true }, true), { text: 'Sending', cls: '' }, 'Sending stays, not green');
  assert.equal(controllerFact({ reachable: false, sending: true }, true).cls, 'bad', 'a real fault stays red');
  assert.match(lightsVerdict({ zones: [], areas: [] }, { brightness: { master: 0 }, layers: 1 }, null).text, /^Nothing is lit/);
});

test('essential metadata is 14px and a phone heading qualifier gets its own line', () => {
  assert.match(css, /--t-meta: 14px/);
  for (const sel of ['.place-row .meta', '.stage-head small', '.bri-label', '.stat span', '.list-rows li .what small', '.run-rows .len small', '.cal-step small', '.cal-prog li .value']) {
    assert.match(css, new RegExp(`${sel.replace(/[.]/g, '\\.')} \\{[^}]*font-size: var\\(--t-meta\\)`), sel);
  }
  assert.match(css, /max-width: 699\.98px[^{]*\{\s*h2 small, h3 small \{ display: block; margin-left: 0;/);
});

test('every secondary action on a card or row has its icon and word, and category keys share one swatch', () => {
  const looks = read('panel/looks.js'), presets = read('panel/presets.js'), overlay = read('overlay.js');
  assert.match(read('icons.js'), /more: 'M8 3\.5v\.01M8 8v\.01M8 12\.5v\.01'/, 'a vertical kebab');
  assert.match(presets, /\$\{icon\('more'\)\}More/);
  assert.match(looks, /\$\{icon\('tweak'\)\}Tweak/);
  assert.match(looks, /\$\{icon\('trash'\)\}<span>Remove/);
  assert.match(looks, /\$\{icon\('apply'\)\}Apply only this/);
  for (const m of overlay.matchAll(/<span class="(sw[^"]*)" style="background:rgb/g)) assert.equal(m[1], 'sw', 'categories are the plain swatch');
});

test('the polish round: tall primaries, ringed thumbs, a real glyph, even segments, empty actions and the bar says what it does', async () => {
  assert.match(css, /\.setup-cal button\.go, \.calibrate button\.go \{ min-height: max\(40px, var\(--tap\)\)/);
  assert.match(css, /input\[type=range\]::-webkit-slider-thumb \{[^}]*border: 2px solid #0d0e10/);
  assert.match(css, /input\[type=range\]::-moz-range-thumb \{[^}]*border: 2px solid #0d0e10/);
  assert.doesNotMatch(read('form.js'), /repeating-linear-gradient\(135deg, #4a5361/, 'no hatch');
  assert.match(read('form.js'), /uses the look's colors/);
  assert.match(css, /\.seg > button \+ button \{ border-left: 0;/, 'a selected segment has no heavier left edge');
  const { stateHTML } = await import('./static/states.js');
  assert.match(stateHTML({ title: 'x', action: { id: 'a1', label: 'New preset' } }), /<button type="button" class="go" id="a1">New preset<\/button>/);
  assert.doesNotMatch(stateHTML({ title: 'x' }), /class="go"/);
  assert.match(read('panel/presets.js'), /id: 'prEmptyNew', label: 'New preset'/);
  assert.match(read('panel/looks.js'), /id: 'lkEmptyNew', label: 'New preset'/);
});

test('a layered effect palette reads the colors of its own layer', async () => {
  const { layerPrefix } = await import('./static/form.js');
  assert.equal(layerPrefix('gradient.palette'), 'gradient.');
  assert.equal(layerPrefix('palette'), '');
  assert.match(read('form.js'), /value\(`\$\{prefix\}colors`\)/);
});

test('while a point is measured, marks yield to it and to the controller names', async () => {
  const { inZones } = await import('./static/overlay.js');
  const zones = [{ x0: 74, x1: 126, y0: 74, y1: 126 }];
  assert.equal(inZones([100, 100], zones), true);
  assert.equal(inZones([200, 100], zones), false);
  assert.equal(inZones([100, 100], []), false);
  const src = read('overlay.js');
  assert.match(src, /inZones\(p\.q, targetZones\) \|\| inZones\(p\.q, nameZones\)/, 'node marks yield to both');
  assert.match(src, /if \(!q \|\| inZones\(q, targetZones\)\) continue;/, 'a controller yields to the point being measured');
});

test('default framing centers the lights in the visible area, and leaves a placed camera alone', async () => {
  const { centerShift } = await import('./static/map-frame.js');
  assert.deepEqual(centerShift([[-1, -2, 0], [1, 2, 0]], 10), [0, 0], 'already centered');
  const [sx, sy] = centerShift([[0, 0, 0], [4, 2, 0]], 10);
  assert.ok(Math.abs(sx - 2) < 1e-9 && Math.abs(sy - 1) < 1e-9, 'the middle of what they span');
  assert.deepEqual(centerShift([], 10), [0, 0], 'nothing to center');
  const scene = read('scene.js');
  assert.match(scene, /const lights = cam\.auto \? litPoints\(\) : \[\];/, 'only views chosen by name are recentered');
});

test('B95: names on cards wrap to two lines instead of being cut, and rows set their own height', async () => {
  const css = read('ui.css');
  const wrap = /\.preset \.name \{\s*display: -webkit-box[^}]*\}/.exec(css)[0];
  assert.match(wrap, /-webkit-line-clamp: 2/);
  assert.doesNotMatch(wrap, /nowrap|ellipsis/);
  assert.doesNotMatch(/^\.cards \{[^}]*\}/m.exec(css)[0], /grid-auto-rows/, 'a tall row must not stretch every other row');
  const { cardSummary } = await import('./static/panel/looks.js');
  const gradient = { id: 'gradient', name: 'Gradient', params: [{ name: 'palette', type: 'palette' }] };
  assert.equal(cardSummary('Ember drift', gradient), 'Gradient', 'the family suffix goes');
  assert.equal(cardSummary('Gradient', gradient), 'Blended colors', 'never the card name twice');
  assert.equal(cardSummary('Stripes', { id: 'bands', name: 'Bands', params: [{ name: 'bands', type: 'list' }] }), 'Color bands');
});

test('B96: revealing a lane\'s first card brings the lane\'s heading, not a sliver of it', async () => {
  const { laneAim, revealDelta } = await import('./static/panel/looks.js');
  const card = { top: 540, bottom: 700 };
  // The sheet starts at 533: the heading above is what used to be cut.
  assert.equal(revealDelta(laneAim(card, 485, true), 541, 800), 485 - 541, 'scrolls back to the heading');
  assert.equal(revealDelta(laneAim({ top: 540, bottom: 900 }, 560, true), 541, 800), 19, 'a tall form never takes the heading past the top');
  assert.deepEqual(laneAim(card, 485, false), card, 'a later card has its own name for a heading');
  assert.doesNotMatch(read('panel/looks.js'), /el\.scrollIntoView\(\{ block: 'nearest', behavior: 'smooth' \}\)/, 'cards go through reveal');
});

test('B98: the stage is the one home for layers', () => {
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /lkNow|lkSlot|id="lkHouse"|id="lkPreview"/, 'no banner, lane or second section');
  assert.match(looks, /section class="stage" id="lkStage"/);
  assert.match(looks, /\[\.\.\.prev\.map\(\(l\) => \['preview', l\]\), \.\.\.house\.map\(\(l\) => \['house', l\]\)\]/, 'one list, the preview in front');
});

test('B94: the key\'s rows scroll on their own, with Hide key outside them', () => {
  const setup = read('panel/setup.js');
  assert.match(setup, /<div class="legend-rows">/);
  assert.match(/\.legend-rows \{[^}]*\}/.exec(css)[0], /overflow-y: auto/);
  const toggle = /\.legend-toggle \{[^}]*\}/g;
  assert.doesNotMatch(css.match(toggle).join(), /sticky/, 'a sticky button sat on top of the last rows');
  assert.match(/^\.legend \{[^}]*\}/m.exec(css)[0], /max-height: 45%/, 'its height is capped');
  assert.match(css, /max-height: 124px/, 'and on a phone');
});

test('B97: a failed calibration read or action is said in words, with Retry that repeats it', async () => {
  const { createSession } = await import('./static/panel/calibrate.js');
  const reply = (status, body) => async () => ({ ok: status < 400, status, statusText: 'x', text: async () => body });
  const storage = { getItem: () => null, setItem() {} };
  for (const body of ['{}', 'upstream exploded', '<html>Bad gateway</html>']) {
    const states = [];
    const s = createSession({ fetch: reply(503, body), storage, onState: (C) => states.push(C.error) });
    await s.poll();
    assert.match(s.C.error, /^Could not read the calibration state\. Glowstack answered with an error/, body);
    assert.ok(!s.C.error.includes(body), 'never the raw body');
    await s.poll();
    assert.equal(states.length, 1, 'a repeat of the same failure is not redrawn');
  }
  // A failed action names itself, Retry repeats the action.
  const sent = [];
  let status = 500;
  const s = createSession({ storage, onState() {}, fetch: async (url, o) => { sent.push([url, o.body]); return { ok: status < 400, status, text: async () => (status < 400 ? '{"active":true}' : 'nope') }; } });
  await s.nudge(10);
  assert.match(s.C.error, /^Could not move the test pixel\./);
  status = 200;
  await s.retry();
  assert.equal(s.C.error, '');
  assert.deepEqual(sent.at(-1), ['/api/v1/calibration/nudge', '{"by":10}']);
  // The server's own message is kept when there is one.
  const told = createSession({ storage, onState() {}, fetch: reply(400, '{"error":"pixel 900 is past the end"}') });
  await told.set(900);
  assert.equal(told.C.error, 'pixel 900 is past the end');
  const cal = read('panel/calibrate.js');
  assert.match(cal, /stateHTML\(\{ kind: 'error', title: C\.error/);
  assert.doesNotMatch(cal, /<div class="error">/);
  assert.doesNotMatch(cal, /text \|\| r\.statusText/);
});

test('each tab says it is loading until its own code draws it', () => {
  const app = read('app.js');
  assert.ok(app.indexOf('showLoadingTabs();') < app.lastIndexOf("await api('/api/map/geometry')"), 'before the first wait');
  assert.match(app, /kind: 'loading', title: `Loading \$\{name\}…`/);
});

test('the 0% warning is said once on a screen, with how the brightnesses combine', async () => {
  const { BRIGHTNESS_RULE, darkMessage } = await import('./static/house-status.js');
  assert.match(BRIGHTNESS_RULE, /multiplied by its zone's/);
  assert.match(darkMessage(['Porch']), /Porch is at 0% brightness/);
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /bri-note/, 'no second note on each card');
  assert.match(looks, /id="lkWords"[^\n]*\$\{BRIGHTNESS_RULE\}/, 'the rule lives in the glossary');
  assert.doesNotMatch(read('panel/status.js'), /BRIGHTNESS_RULE/);
  assert.doesNotMatch(read('map-status.js'), /at 0%`/);
});

test('a preview over an empty house is titled by what it is, and a hidden preview says so', async () => {
  const { stageTitle } = await import('./static/panel/looks.js');
  assert.equal(stageTitle({ live: 0, preview: 1 }), 'Previewing');
  assert.equal(stageTitle({ live: 2, preview: 1 }), "Previewing over what's on the lights");
  assert.equal(stageTitle({ live: 2, preview: 0 }), 'On the lights');
  assert.equal(stageTitle({ live: 0, preview: 0 }), 'Nothing on the lights');
  const looks = read('panel/looks.js');
  assert.match(looks, /lkMapNote'\)\.hidden = !\(prev\.length && S\.show === 'house'\)/);
  assert.match(looks, /if \(S\.show === 'house'\) \{ S\.setShow\(''\)/, 'opening a preview switches the map to it');
});

test('a zoomed-out run has one label, and a map strip too small to read has none', async () => {
  const { runCrowded, placeLabels } = await import('./static/overlay.js');
  assert.equal(runCrowded([[0, 0], [30, 0], [60, 0]]), true);
  assert.equal(runCrowded([[0, 0], [300, 0], [600, 0]]), false, 'zoomed in: each point has room');
  assert.equal(runCrowded([[0, 0]]), false);
  const measure = (l) => l.text.length * 6;
  const labels = [{ text: 'Porch rail', x: 100, y: 90, color: '#fff', rank: 1.1, budget: true }, { text: 'Pointed at', x: 200, y: 90, color: '#fff', rank: 2.5, budget: false }];
  const strip = placeLabels(labels, { width: 390, height: 844, measure, avoid: [{ x0: 8, x1: 300, y0: 8, y1: 52 }, { x0: 0, x1: 390, y0: 160, y1: 844 }] });
  assert.deepEqual(strip.map((p) => p.text), ['Pointed at'], 'only what the pointer is on');
  assert.equal(strip.hidden, 1, 'and the rest are counted as hidden');
  const roomy = placeLabels(labels, { width: 390, height: 844, measure, avoid: [{ x0: 8, x1: 300, y0: 8, y1: 52 }, { x0: 0, x1: 390, y0: 460, y1: 844 }] });
  assert.equal(roomy.length, 2);
  assert.match(read('scene.js'), /uAlpha: \{ value: 0\.5 \}/, 'the halo shows on an unlit model');
  assert.match(read('plan.js'), /globalAlpha = 0\.5; ctx\.strokeStyle = '#fff'/);
});

test('wording: one phrase for scope, a calm empty list, amber real-lights warning, nudge help by the buttons', () => {
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /class="muted">On</, 'the same control has one name');
  assert.match(read('panel/setup.js'), /None missing: every light shown is on the map\./);
  const cal = read('panel/calibrate.js');
  assert.match(cal, /warningHTML\('This changes the real lights until you stop\.'\)/);
  assert.ok(cal.indexOf('id="caHow"') < cal.indexOf('class="nudges"'), 'the explanation sits above the buttons');
  assert.match(cal, /\$\$\('#caHow'\)\.hidden = nudgeOff/);
  assert.match(cal, /A calibration is still running on the lights/);
  assert.match(read('app.js'), /setItem\(OWN_RELOAD, '1'\); location\.reload\(\)/);
});

test('polish: disabled segment, labeled color buttons, nothing to clear, quieter controllers', async () => {
  assert.doesNotMatch(/\.seg > button:disabled, \.seg > button\[aria-disabled=true\]:not\(\.on\) \{[^}]*\}/.exec(css)[0], /opacity/, 'a readable color, not half strength');
  assert.match(/\.seg > button:disabled, \.seg > button\[aria-disabled=true\]:not\(\.on\) \{[^}]*\}/.exec(css)[0], /color: var\(--muted\)/);
  assert.match(css, /\.form \.color-picker > summary::before \{ order: 2; \}/);
  const form = read('form.js');
  assert.match(form, /\$\{icon\('plus'\)\}Add color/);
  assert.match(form, /\$\{icon\('minus'\)\}Remove/);
  assert.match(read('panel/calibrate.js'), /'quiet icon-btn', !forgettable,/);
  const { sharedFact } = await import('./static/panel/status.js');
  const ok = { text: 'Sending', cls: 'ok' }, bad = { text: 'Unreachable', cls: 'bad' };
  assert.equal(sharedFact([ok, ok]), 'Sending');
  assert.equal(sharedFact([ok, bad]), '', 'a difference stays on its row');
  assert.equal(sharedFact([bad, bad]), '', 'bad news stays on each row');
  assert.equal(sharedFact([ok]), '');
  const status = read('panel/status.js');
  assert.match(status, /h\.lastSeen && !\(h\.reachable === true && h\.sending === true\)/, 'a healthy row skips Last answered');
  assert.doesNotMatch(status, /kit\.push\(nb\('version/, 'the version moved to the name tooltip');
});

test('the half sheet is one height on every tab, so the map holds still', () => {
  const sheet = read('sheet.js');
  assert.match(sheet, /const HALF = 0\.5;/);
  assert.match(sheet, /half: Math\.max\(HALF_MIN \+ sb, Math\.round\(h \* HALF\)\)/);
  assert.doesNotMatch(sheet, /READING|fitHalf/);
});

test('B102: a palette with its own colors says the look colors are unused', async () => {
  const { colorsUsed, ignoredColor } = await import('./static/form.js');
  const S = { palettes: [
    { id: 'default', name: 'Default', stops: [] }, { id: 'rainbow', name: 'Rainbow', stops: [[0, '#ff0000']] },
    { id: 'color-1', name: '* Color 1', stops: [] }, { id: 'colors-1-2', name: '* Colors 1&2', stops: [] }, { id: 'color-gradient', name: '* Color Gradient', stops: [] },
  ] };
  const schema = [{ name: 'palette', type: 'palette', default: 'Default' }, { name: 'colors', type: 'colors', default: ['#ffa000', '#000000', '#000000'] }];
  const inline = [[0, '#ff8000'], [1, '#ffff00']];
  assert.equal(colorsUsed(S, inline, 'gradient'), 0);
  for (const i of [0, 1, 2]) assert.equal(ignoredColor(S, schema, { palette: inline }, `colors.${i}`, 'gradient'), true);
  // Default on a gradient is Rainbow, which has colors of its own.
  assert.equal(ignoredColor(S, schema, {}, 'colors.0', 'gradient'), true);
  // Built from the look's colors: as many as the palette reads are in use.
  assert.equal(ignoredColor(S, schema, { palette: 'color-1' }, 'colors.0', 'gradient'), false);
  assert.equal(ignoredColor(S, schema, { palette: 'color-1' }, 'colors.1', 'gradient'), true);
  assert.equal(ignoredColor(S, schema, { palette: 'colors-1-2' }, 'colors.1', 'gradient'), false);
  assert.equal(ignoredColor(S, schema, { palette: 'color-gradient' }, 'colors.2', 'gradient'), false);
  // A color with no palette beside it always counts; so does a Default we can't read.
  assert.equal(ignoredColor(S, schema, {}, 'background', 'gradient'), false);
  const member = [{ name: 'sparks.palette', type: 'palette', default: 'Default' }];
  assert.equal(ignoredColor(S, member, {}, 'sparks.color', 'ember-glitter'), false);
});

const boxesHit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

test('B101: no label is drawn across the model, and a far one has a leader', async () => {
  const { placeLabels } = await import('./static/overlay.js');
  // A strip right under where the label asked to be.
  const strip = { x0: 90, x1: 500, y0: 60, y1: 150 };
  const solid = (b) => boxesHit(b, strip);
  const placed = placeLabels([{ text: 'origin Shed corner', x: 100, y: 110, color: '#fff', rank: 2 }], { width: 800, height: 400, measure: (l) => l.text.length * 7, solid });
  assert.equal(placed.length, 1);
  assert.equal(solid(placed[0]), false);
  assert.ok(placed[0].leader, 'moved far enough to need a line back');
});

test('B101: a label with nowhere clear is left out and counted, but the point being measured still shows', async () => {
  const { placeLabels } = await import('./static/overlay.js');
  const everywhere = () => true;
  const dropped = placeLabels([{ text: 'Porch', x: 100, y: 110, color: '#fff', rank: 1 }], { width: 800, height: 400, measure: () => 40, solid: everywhere });
  assert.equal(dropped.length, 0);
  assert.equal(dropped.hidden, 1);
  assert.equal(placeLabels([{ text: 'Corner', x: 100, y: 110, color: '#fff', rank: 3 }], { width: 800, height: 400, measure: () => 40, solid: everywhere }).length, 1);
});

test('B101: long labels are shortened on a phone, whatever their kind', async () => {
  const { placeLabels } = await import('./static/overlay.js');
  const placed = placeLabels([{ text: 'origin Northwest Garden Corner Post', x: 100, y: 100, color: '#fff', rank: 2 }], { width: 390, height: 300, measure: (l) => l.text.length * 7 });
  assert.ok(placed[0].text.length <= 18, placed[0].text);
  assert.ok(placed[0].x1 <= 390);
});

test('B101: a crowded map draws no two labels on each other or over the lights', async () => {
  const { placeLabels } = await import('./static/overlay.js');
  for (const [width, height] of [[1040, 900], [390, 300]]) {
    const strip = [{ x0: 0, x1: width, y0: height * 0.48, y1: height * 0.52 }, { x0: width * 0.48, x1: width * 0.52, y0: 0, y1: height }];
    const solid = (b) => strip.some((s) => boxesHit(b, s));
    const queued = Array.from({ length: 300 }, (_, i) => ({ text: `Crowded point number ${i}`, x: 40 + (i * 37) % (width - 80), y: 40 + (i * 53) % (height - 80), color: '#fff', rank: [1, 1.2, 2, 2.5][i % 4], budget: i % 4 < 2 }));
    const placed = placeLabels(queued, { width, height, measure: (l) => l.text.length * 6.5, solid });
    placed.forEach((a, i) => placed.slice(i + 1).forEach((b) => assert.equal(boxesHit(a, b), false, `${a.text} / ${b.text}`)));
    for (const l of placed) if (l.rank < 2.5) assert.equal(solid(l), false, l.text);
  }
});

test('B99: while calibrating, messages go in the panel and never over the map target', async () => {
  const { toastHome } = await import('./static/map-frame.js');
  assert.equal(toastHome(true, true), 'caToasts');
  assert.equal(toastHome(false, true), 'toasts');
  assert.equal(toastHome(true, false), 'toasts'); // before the panel exists
  const cal = read('panel/calibrate.js');
  assert.match(cal, /id="caToasts"/);
  assert.ok(cal.indexOf('caToasts') < cal.indexOf('id="caBody"'), 'above the scrolling body');
});

test('B100: the Goes on list is its own full sheet on a phone, with a way out', () => {
  const looks = read('panel/looks.js');
  assert.match(looks, /asSheet = on && S\.panel\.layout\(\) === 'sheet'/);
  assert.match(looks, /getElementById\('panel'\)/);
  assert.match(looks, /id="lkPickClose"/);
  assert.match(css, /\.target-picker\.as-sheet \{[^}]*position: absolute; inset: 0/);
  assert.match(css, /\.target-picker\.as-sheet \.target-list \{ flex: 1/);
});

test('B103: Preview and Lights are off until the map is ready, and say why', async () => {
  const html = read('index.html');
  assert.equal((html.match(/data-show="[^"]*" disabled title="Waiting for the map to load"/g) || []).length, 2);
  const { showButton } = await import('./static/map-status.js');
  const base = { canPreview: true, word: 'Tap' };
  assert.deepEqual(showButton('', { ...base, ready: false, failed: false }), { disabled: true, ariaDisabled: false, title: 'Waiting for the map to load' });
  assert.equal(showButton('house', { ...base, ready: true, failed: true }).disabled, true);
  assert.match(showButton('house', { ...base, ready: true, failed: true }).title, /Retry/);
  assert.equal(showButton('house', { ...base, ready: true, failed: false }).disabled, false);
  assert.equal(showButton('', { ...base, ready: true, failed: false }).disabled, false);
  // Ready with nothing in preview: still pressable, so it can say why not.
  const empty = showButton('', { ...base, canPreview: false, ready: true, failed: false });
  assert.equal(empty.disabled, false);
  assert.equal(empty.ariaDisabled, true);
});

test('Applying into a 0% zone never reports plain success alone', async () => {
  const { applyResult } = await import('./static/panel/looks.js');
  const shown = applyResult('the look to the lights', { dark: 'none', message: 'Yard is at 0%.' }, true);
  assert.equal(shown.neutral, true, 'the banner on screen carries the warning');
  assert.equal(shown.warn, false);
  const alone = applyResult('the look to the lights', { dark: 'part', message: 'Yard is at 0%.' }, false);
  assert.equal(alone.warn, true);
  assert.match(alone.text, /part of it stays dark\. Yard is at 0%/);
  assert.equal(applyResult('the look', { dark: '' }).text, 'Applied the look.');
});

test('the stage says why it is dark, once, inside the stage', () => {
  const looks = read('panel/looks.js');
  assert.ok(looks.indexOf('id="lkDark"') > looks.indexOf('id="lkStage"') && looks.indexOf('id="lkDark"') < looks.indexOf('section class="library"'));
  assert.equal([...looks.matchAll(/id="lkDark"/g)].length, 1);
});

test('Status: the verdict leads, the counts are a line, healthy is a check', async () => {
  assert.match(css, /\.verdict \{[^}]*font-size: var\(--t-verdict\)/);
  const status = read('panel/status.js');
  assert.ok(status.indexOf('id="stStats"') > status.indexOf('id="stPower"'), 'counts below the answers');
  assert.doesNotMatch(status, /stat\(count\(st\.layers\)/, 'the count of looks repeats the verdict');
  const { asOf, mark } = await import('./static/panel/status.js');
  assert.equal(asOf('Controllers: all 8 reachable', '6:10 PM'), 'Controllers: all 8 reachable at 6:10 PM');
  assert.equal(asOf('all sending', ''), 'all sending');
  assert.match(mark('ok'), /class="mark ok"[\s\S]*<svg/);
  assert.match(mark('bad'), /class="mark bad"/);
});

test('one control language: one slider, one selected fill, one readout', () => {
  assert.match(css, /input\[type=range\]::-webkit-slider-thumb \{ appearance: none/);
  assert.doesNotMatch(css, /accent-color/, 'no second slider look');
  assert.doesNotMatch(css, /\.channel-row input\[type=range\]::-webkit-slider-thumb/);
  assert.match(css, /\.tabs button\.on \{ background: var\(--on\)/);
  assert.match(css, /\.crumbs button\.on \{ background: var\(--on\)/);
  assert.match(css, /^output \{/m);
});

test('action buttons lead with an icon; the header says it sets new previews', () => {
  const looks = read('panel/looks.js'), setup = read('panel/setup.js'), status = read('panel/status.js'), presets = read('panel/presets.js'), cal = read('panel/calibrate.js');
  assert.match(looks, /html = `\$\{icon\('apply'\)\}<span>\$\{esc\(plan\.label\)\}/);
  assert.match(looks, /\$\{icon\('close'\)\}Clear preview/);
  assert.match(presets, /id="prNew" class="icon-btn">\$\{icon\('plus'\)\}/);
  assert.match(setup, /icon\('target'\)\}\$\{running/);
  assert.match(status, /\$\{icon\('target'\)\}Calibrate/);
  assert.match(cal, /id="caConfirm"[^>]*>\$\{icon\('check'\)\}Confirm/);
  assert.match(looks, /class="muted">New previews go on</);
  assert.match(looks, /<span class="muted">Goes on<\/span><b>\$\{esc\(placeName\)\}/, "the card's own control keeps its name");
});

test('vocabulary: the words are explained once, and Adjust is not a second Tweak', () => {
  const looks = read('panel/looks.js');
  for (const w of ['look', 'preset', 'effect', 'zone', 'area', 'run']) assert.match(/id="lkWords"[\s\S]*?<p[^>]*>([^<]*)</.exec(looks)[1], new RegExp(w));
  assert.doesNotMatch(looks, /Adjust/);
  assert.match(read('panel/setup.js'), /a run is one strip of lights/);
});

test('calibration says what is unmeasured and gives one instruction', async () => {
  const { stepPlace, MOVE_HOW } = await import('./static/panel/calibrate.js');
  assert.equal(stepPlace({ done: false, target: { kind: 'anchor' } }), "This point isn't measured yet");
  assert.equal(stepPlace({ done: false, target: { kind: 'gap' } }), "This step isn't done yet");
  assert.equal(stepPlace({ done: true, target: { kind: 'anchor' } }), 'Done');
  assert.match(MOVE_HOW, /−\/\+ to move the lit pixel along the real strip until it matches the circled point/);
  const cal = read('panel/calibrate.js');
  assert.equal((cal.match(/MOVE_HOW\}/g) || []).length, 2, 'used at the intro and on the step');
  assert.doesNotMatch(cal, /Move the white pixel onto/);
});

test('server messages read in place names, even for ids with no name', async () => {
  const { humanText, warningSummary } = await import('./static/names.js');
  const g = { runs: [{ id: 'shed-eave' }], nodes: [{ id: 'gate-post' }], controllers: [] };
  assert.equal(humanText(g, 'pixel out of range at gate-post on shed-eave'), 'pixel out of range at Gate post on Shed eave');
  assert.equal(warningSummary(g, 'run shed-eave: something else changed').summary, 'Shed eave: something else changed');
});

test('polish: no orphaned last word, brand on phones, state icons, a short wiring key', async () => {
  const { noOrphan } = await import('./static/util.js');
  assert.equal(noOrphan('Candy cane stripes'), 'Candy cane\u00a0stripes');
  assert.equal(noOrphan('Warm white'), 'Warm white');
  assert.equal(noOrphan('Very long lantern extravaganza'), 'Very long lantern extravaganza', 'too wide to join');
  assert.doesNotMatch(css, /max-width: 699\.98px\)[^{]*\{[^}]*\.brand \{ display: none/);
  const { stateHTML } = await import('./static/states.js');
  assert.match(stateHTML({ kind: 'error', title: 'x' }), /class="state error"[^>]*><svg/);
  assert.match(stateHTML({ kind: 'empty', title: 'x' }), /class="state empty"[^>]*><svg/);
  assert.doesNotMatch(stateHTML({ kind: 'loading', title: 'x' }), /<svg/);
  const overlay = read('overlay.js');
  assert.match(overlay, /class="key-row"/);
  assert.doesNotMatch(overlay, /\$\{count\(o\.count\)\} lights<\/div>/, 'one line per controller, not per output');
});

test('the library is one grid with a filter row, not three disclosures', () => {
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /lkOtherPresets|lkEffects|lkToPreview/);
  for (const f of ['pinned', 'presets', 'effects']) assert.match(looks, new RegExp(`data-filter="${f}"`));
  assert.match(looks, /id: 'lkFind', type: 'search'/);
  assert.match(looks, /\.\.\.lookCards\[which === 'effects' \? 'effects' : 'presets'\]\(named\)/);
});

test('a place that reads Everything is everything, even when one zone holds every light', async () => {
  const { nodeTarget } = await import('./static/select.js');
  assert.equal(nodeTarget({ members: [{ kind: 'run', id: 'r' }, { kind: 'area', id: 'a' }, { kind: 'zone', area: 'a' }, { kind: 'all' }] }), 'all');
  assert.equal(nodeTarget({ members: [{ kind: 'area', id: 'a' }, { kind: 'zone', area: 'a' }] }), 'a');
  assert.equal(nodeTarget({ members: [{ kind: 'run', id: 'r' }] }), 'run:r');
});

test('B107: the chip never vouches for the lights without a fresh reading', async () => {
  const { mapStatus } = await import('./static/map-status.js');
  const previewing = { previewing: true }, idle = { previewing: false };
  for (const connected of [true, false]) for (const fresh of [true, false]) for (const preview of [idle, previewing]) {
    const m = mapStatus({ connected, fresh, show: '', preview });
    if (!connected) assert.equal(m.text, 'Offline');
    else if (preview.previewing) assert.equal(m.text, 'Showing your preview');
    else if (fresh) assert.equal(m.cls, 'house');
    else { assert.equal(m.text, 'Lights: state unknown'); assert.notEqual(m.cls, 'house'); assert.match(m.title, /failed/); }
  }
  assert.equal(mapStatus({ connected: true, fresh: false, show: 'house', preview: previewing }).text, 'Lights: state unknown', 'a hidden preview changes nothing');
  assert.equal(mapStatus({ connected: true, fresh: false, show: '', preview: idle, lit: { dark: 'none', message: 'x' } }).text, 'Lights: state unknown', 'stale zones are not news');
  assert.equal(mapStatus({ connected: true, mapless: true, fresh: false, show: '', preview: null }).text, 'Map unavailable');
});

test('B110: Escape closes the newest open popover on screen, wherever focus is', async () => {
  let key = null;
  globalThis.document = { addEventListener: (type, fn, capture) => { assert.equal(type, 'keydown'); assert.equal(capture, true); key = fn; } };
  const { escapeCloses, closeTopPopover } = await import('./static/picker.js');
  const el = (shown = true) => ({ isConnected: true, getClientRects: () => (shown ? [1] : []) });
  const closed = [];
  let picker = true, editor = true, otherTab = true;
  escapeCloses(el(), () => editor, () => { editor = false; closed.push('editor'); });
  escapeCloses(el(false), () => otherTab, () => closed.push('other tab'));
  escapeCloses(el(), () => picker, () => { picker = false; closed.push('picker'); });
  const press = () => { let stopped = false; key({ key: 'Escape', target: { closest: () => null }, preventDefault() {}, stopPropagation() { stopped = true; } }); return stopped; };
  assert.equal(press(), true, 'the global handler never sees it');
  assert.deepEqual(closed, ['picker'], 'the inner popover goes first, and the hidden tab is left alone');
  assert.equal(press(), true);
  assert.deepEqual(closed, ['picker', 'editor']);
  assert.equal(press(), false, 'with none open the key goes on to the map');
  assert.equal(closeTopPopover(), false);
  delete globalThis.document;
});

test('B105: a controller fault leads the verdict, ahead of dark zones and warnings', async () => {
  const { headline, faultLine } = await import('./static/panel/status.js');
  const ok = { reachable: true }, down = { reachable: false };
  assert.equal(faultLine(['a', 'b'], { a: ok, b: down }, (id) => id.toUpperCase()), '1 controller unreachable: B');
  assert.equal(faultLine(['a', 'b'], { a: ok, b: ok }), '');
  assert.equal(faultLine(['a', 'b', 'c', 'd'], { a: down, b: down, c: down, d: down }), '4 controllers unreachable', 'a long list is a count');
  const unlit = { cls: '', text: 'Nothing is lit: no looks are on the lights' }, dark = { cls: 'warn', text: 'Partly lit: porch at 0%' }, lit = { cls: 'ok', text: 'Lit: 1 look on the lights' };
  assert.deepEqual(headline(unlit, '1 controller unreachable: B', 2), { cls: 'bad', text: '1 controller unreachable: B', second: unlit.text });
  assert.deepEqual(headline(dark, '', 2), { cls: 'warn', text: dark.text, second: '2 warnings to check below' }, 'dark zones outrank warnings, and the count stays');
  assert.deepEqual(headline(dark, '', 0), { cls: 'warn', text: dark.text, second: '' });
  assert.deepEqual(headline(lit, '', 2), { cls: 'warn', text: '2 warnings to check below', second: lit.text });
  assert.deepEqual(headline(lit, '', 0), { cls: 'ok', text: lit.text, second: '' });
});

const ZONES = {
  areas: [{ id: 'yard', ranges: [[0, 9]] }, { id: 'porch', ranges: [[10, 19]] }],
  zones: [{ id: 'yard', name: 'Yard', area: 'yard' }, { id: 'porch', name: 'Porch', area: 'porch' }],
};

test('the one-press fix only ever raises zones at 0% that are blocking a look', async () => {
  const { lightOutcome, onLevels, turnOnLabel } = await import('./static/house-status.js');
  const out = lightOutcome(ZONES, { master: 1, zones: { yard: 0, porch: 0.5 } }, [[[0, 4]]]);
  assert.deepEqual(out.ids, ['yard'], 'porch is lit, and has no look on it');
  assert.equal(turnOnLabel(['Yard']), 'Turn on Yard');
  assert.equal(turnOnLabel(['Yard', 'Porch']), 'Turn on all 2');
  const zones = [{ id: 'yard', brightness: 0, on_level: 0.4 }, { id: 'porch', brightness: 0.5, on_level: 1 }, { id: 'side', brightness: 0, on_level: 1 }];
  assert.deepEqual(onLevels(zones, ['yard', 'porch']), { yard: 0.4 }, 'a zone raised meanwhile is left alone, and so is one not asked for');
  assert.deepEqual(onLevels([{ id: 'yard', brightness: 0, on_level: 0 }], ['yard']), {}, 'never sends 0');
  const sources = ['house-status.js', 'panel/looks.js', 'panel/status.js'].map(read).join('');
  assert.doesNotMatch(sources, /["']?\bon["']?:\s*false/, 'nothing here turns anything off');
  assert.doesNotMatch(sources, /JSON\.stringify\(\{ master/, 'no master brightness control');
});

test('one 0% line in the stage, short enough for one row beside Turn on', async () => {
  const { zoneWarning } = await import('./static/house-status.js');
  const yard = { dark: 'none', zones: ['Yard'], ids: ['yard'], message: 'Yard is dark.' }, porch = { dark: 'part', zones: ['Porch'], ids: ['porch'], message: 'Porch is dark.' };
  const none = { dark: '', zones: [], ids: [], message: '' };
  assert.equal(zoneWarning(none, none, { previewing: true }), null);
  assert.equal(zoneWarning(yard, none, { previewing: false }).text, 'Stays dark: Yard at 0%');
  const landing = zoneWarning(none, porch, { previewing: true });
  assert.equal(landing.text, 'Partly dark: Porch at 0%');
  const both = zoneWarning(yard, porch, { previewing: true });
  assert.deepEqual(both.ids, ['yard', 'porch'], 'one button covers both');
  assert.equal(both.text, 'Stays dark: 2 zones at 0%');
  assert.match(both.detail, /Yard and Porch are at 0%/);
  const master = { dark: 'none', zones: [], ids: [], message: 'Brightness is at 0%, so nothing shows. Raise it in Home Assistant.' };
  assert.deepEqual(zoneWarning(master, none, { previewing: false }).ids, [], 'no button for that level');
});

test('B109: the bar\'s secondary controls never wrap, and its note stays on one line', () => {
  assert.match(css, /\.bar-line button \{ flex: none; white-space: nowrap;/);
  assert.match(css, /\.bar-note \{[^}]*white-space: nowrap/);
});

test('B106, B108, B112: nothing is reserved for what is gone, and Apply leaves the panel where it was', () => {
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /heldSlot|slotBefore|minHeight/, 'B112: no fixed slot');
  assert.doesNotMatch(css, /looks-slot/);
  assert.doesNotMatch(/async function apply[\s\S]*?\n  \}\n/.exec(looks)[0], /scrollTo/, 'B106: the scroll stays');
  assert.match(looks, /if \(applying\) return;/, 'B106: rows are not dropped and re-added mid-Apply');
  assert.match(css, /\.content \{ overflow-anchor: none;/, 'B106: the browser does not re-scroll for a swapped row');
  assert.match(looks, /S\.panel\.layout\(\) === 'sheet' && S\.panel\.tab\(\) === 'looks' && !S\.panel\.collapsed\(\)/, 'B108: beside the map a click does not scroll the grid');
});

test('the desktop panel is wider from 1280 px, and the phone is unchanged', () => {
  assert.match(css, /@media \(min-width: 1280px\) \{\s*:root \{ --panel-w: 500px; \}/);
  assert.match(css, /--layout: sheet; --panel-space: 0px/);
});

test('polish: apply and stop have their own icons, Calibrate no longer looks like a sparkle', () => {
  const icons = read('icons.js'), path = (n) => new RegExp(`\\b${n}: '([^']+)'`).exec(icons)[1];
  assert.notEqual(path('apply'), path('check'));
  assert.notEqual(path('stop'), path('close'));
  assert.match(path('target'), /a6 6 0/, 'a bullseye, unlike the four-point sparkle');
  assert.match(read('panel/calibrate.js'), /\$\{icon\('stop'\)\}Stop/);
  assert.match(read('panel/looks.js'), /in-badge">\$\{icon\('eye'\)\}/, 'Previewing reads the same on Looks and Presets');
});

test('unused palette colors fold into one line', () => {
  const form = read('form.js');
  assert.match(form, /`Not used: \$\{names\.map/, 'one line on a phone');
  assert.match(form, /replace\(\/ \/g, '\\u00a0'\)/, 'a color name never splits across lines');
  assert.match(form, /c\.row\.hidden = c\.ignored\(\)/);
});

test('camera: no Overhead code and no named-view text is left', () => {
  const scene = read('scene.js');
  assert.doesNotMatch(scene, /overhead|named view|named\(/i);
  assert.doesNotMatch(read('panel/setup.js'), /overhead|suCamMode|named views/);
});

test('the card picker opens under its own button, even with the Tweak form open', () => {
  assert.match(read('panel/looks.js'), /picker\.style\.top = pickFor\.el\.querySelector\('\.place-row'\)\.getBoundingClientRect\(\)\.bottom/);
});

test('B111: a row\'s name has its own line, above the controls', () => {
  const looks = read('panel/looks.js');
  const row = /el\.innerHTML = `\s*<div class="name-line">[\s\S]*?<div class="slot">/.exec(looks)[0];
  assert.ok(row.indexOf('class="name-line"') < row.indexOf('class="controls"'), 'name first');
  assert.doesNotMatch(/<div class="name-line">.*?<\/div>/.exec(row)[0], /<button|<input/, 'no control shares its line');
  for (const c of ['place-row', 'bri', 'tweak', 'data-a="remove"']) assert.ok(row.indexOf(c) > row.indexOf('class="controls"'), c);
  assert.match(css, /\.layer \.controls \{ display: flex; flex-wrap: wrap;/);
  assert.doesNotMatch(/^\.layer \.name-line b \{[^}]*\}/m.exec(css)[0], /nowrap|ellipsis|line-clamp/, 'the whole name, however long');
});

test('wiring marks: the output number has a dark disc to sit on, and the chip close icon is centered', () => {
  assert.match(read('overlay.js'), /ring\(q, 11, `rgb\(\$\{o\.color\}\)`, 2, null, 'rgba\(0,0,0,\.8\)'\)/);
  assert.match(read('overlay.js'), /600 13px/);
  assert.match(css, /\.crumbs \.x \{ display: inline-flex; align-items: center; justify-content: center;/);
});

test('B113: the Status count comes from the same list as the cards', async () => {
  const { statusIssues, headline } = await import('./static/panel/status.js');
  const spacing = { summary: 'Run 1 spacing differs', detail: 'x', fix: null };
  const cards = statusIssues('Porch is at 0% brightness, so nothing shows there.', [spacing]);
  assert.equal(cards.length, 2, 'two warning cards');
  assert.equal(headline({ cls: 'ok', text: 'Lit: 1 look on the lights' }, '', cards.length).text, '2 warnings to check below');
  assert.equal(statusIssues('', [spacing]).length, 1, 'a dark verdict has no card of its own');
  assert.equal(cards[0].darkZones, true, 'most urgent first');
  const status = read('panel/status.js');
  assert.match(status, /id="stTurnOn">\$\{icon\('sun'\)\}\$\{esc\(turnOnLabel\(zeroNames\)\)\}/, 'the brightness card has the Turn on action');
  assert.match(status, /renderIssues\(issues, /, 'drawn from the list the headline counted');
});

test('B114: library cards are one height, with the name in two lines and the subtitle on a fixed row', () => {
  assert.match(css, /\.preset \.name \{ font-size: var\(--t-h3\); font-weight: 600; height: 2\.6em;/);
  assert.match(css, /-webkit-line-clamp: 2/);
  assert.match(css, /\.preset \.sub, \.preset \.in-badge \{ height: 1\.4em;[^}]*white-space: nowrap/);
  assert.match(css, /\.cards:has\(> \.preset:nth-child\(4\):last-child\)/, 'four pins fill one row at the wide panel');
});

test('B115: icon buttons in the Tweak form keep the icon beside the label', () => {
  const form = read('form.js');
  assert.match(form, /add\.className = 'icon-btn'; add\.innerHTML = `\$\{icon\('plus'\)\}Add color/);
  assert.match(form, /rm\.className = 'icon-btn'; rm\.innerHTML = `\$\{icon\('minus'\)\}Remove/);
  assert.match(css, /button\.icon-btn \{ display: inline-flex;/);
});

test('Tweak has its own icon, not the Setup tab\'s sliders', () => {
  const icons = read('icons.js'), path = (n) => new RegExp(`\\b${n}: '([^']+)'`).exec(icons)[1];
  assert.notEqual(path('tweak'), path('setup'));
  assert.notEqual(path('tweak'), path('edit'));
});

test('Setup: Advanced is nested under Advanced, a size below the top-level sections', () => {
  assert.match(css, /#suAdvanced > :not\(summary\) \{[^}]*border-left/);
  assert.match(css, /#suAdvanced h3\.sub \{ font-size: var\(--t-m\)/);
  assert.match(css, /\.tab h2\.sub, \.tab h3\.sub \{[^}]*font-size: var\(--t-h3\)/);
});

test('a phone: the stage is the first content, and the sheet rises for a preview or Tweak', () => {
  const looks = read('panel/looks.js');
  assert.match(css, /\.tab \.looks-head \{ display: none; \}/);
  assert.match(looks, /S\.panel\.setDetent\('full'\);\n\s+if \(cards\.has\('preview:' \+ added\.id\)\)/);
  assert.match(looks, /S\.panel\.layout\(\) === 'sheet' && S\.panel\.detent\(\) !== 'full'/);
  assert.match(css, /body:not\(\[data-detent\]\) \.panel \{ visibility: hidden; \}/, 'the sheet is not drawn before its height');
  assert.match(read('sheet.js'), /panel\.classList\.add\('dragging'\);\n\s+refresh\(true\)/, 'no rise from the peek on load');
});

test('opening the color editor keeps the row side by side', () => {
  assert.doesNotMatch(css, /\.form \.f:has\(\.color-picker\[open\]\) > \.ctl/);
  assert.match(css, /\.color-picker\[open\] > \.color-mixer \{ margin-left:/);
});
