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
  assert.match(read('sheet.js'), /e\.target === opening && e\.target\.open/, 'an opened disclosure comes into view');
});

test('a status failure is the shared state with no raw server text and no empty sections', async () => {
  const { loadFailure } = await import('./static/panel/status.js');
  const st = loadFailure(Object.assign(new Error('Internal Server Error'), { status: 500 }));
  assert.equal(st.kind, 'error');
  assert.doesNotMatch(st.detail, /Internal Server Error/);
  assert.match(loadFailure({ network: true }).detail, /isn't responding/);
  const status = read('panel/status.js');
  assert.match(status, /<div id="stBody" hidden>[\s\S]*<h2 class="status-head">Controllers/, 'sections wait for a reading');
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
  assert.match(w.summary, /^Shed eave: some saved measurements no longer match/);
  assert.doesNotMatch(w.summary, /anchors\.yaml|:22/);
  assert.deepEqual(w.fix, { label: 'Calibrate this run', run: 'shed-eave' });
  assert.equal(w.detail, raw);
  assert.match(warningSummary(G, 'layout.yaml:3: run shed-eave: shed-sw–shed-sw-2 has 90 pixels where its drawn length implies about 60 (1.50× the run\'s density); check').summary, /^Shed eave: the lights are spaced tighter than drawn\.$/);
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
  assert.match(read('panel/looks.js'), /`Previewing on \$\{nameOf/);
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
  assert.match(read('panel/looks.js'), /return S\.toast\(r\.text, \{ ms: TOAST_MS, warn: true,/);
  assert.match(read('app.js'), /opts\.warn \? ' warn'/);
});

test('B36: Apply closes Show on', () => {
  assert.match(read('panel/looks.js'), /S\.fail\('put the look on the lights', e\);[^\n]*\n\s+openPicker\(false\);/);
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
  assert.match(partial.notSetDetail, /B outputs 1 and 2/);
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
  assert.match(read('panel/looks.js'), /const row = cards\.get\('preview:' \+ added\.id\)\.el;\s*reveal\(row\.offsetParent \? row : \$\$\('#lkPrevSum'\), true\)/);
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
  assert.match(looks, /bri-label[^>]*>\$\{icon\('sun'\)\}<span class="bri-word">Brightness/);
});

test('a real type scale: h2 and h3 differ, and body text is larger on desktop', () => {
  assert.match(css, /--t-m: 14px/);
  assert.match(css, /--t-h3: 15px/);
  assert.match(css, /--t-h2: 17px/);
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
  assert.equal(applyResult('The look is on the lights', { dark: '' }).warn, false);
  const r = applyResult('The look is on the lights', none);
  assert.equal(r.warn, true);
  assert.equal(r.text, 'The look is on the lights. Yard is at 0%, so it stays dark.');
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
  assert.doesNotMatch(/\.target-select b \{[^}]*\}/.exec(css)[0], /ellipsis|nowrap/);
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
  assert.match(cal, /if \(isGap\) parts\.push\(`<p class="cal-how">\$\{NO_CURSOR_HOW\.gap\}/);
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
  for (const rule of [/^\.swatch \{[^}]*\}/m, /^\.layer \.name-line \.strip \{[^}]*\}/m, /^\.picker-swatch \{[^}]*\}/m, /^\.inspect \.chip-color \{[^}]*\}/m]) {
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
  // Round 3: a toggle pill leads with the checkbox's box, checked when on.
  assert.match(css, /\.chips\.toggles > button\.on::before \{ background: var\(--accent\) var\(--check\) center \/ 82% no-repeat;/);
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
  assert.match(looks, /label: 'On:'/);
  assert.doesNotMatch(looks, />Apply to</);
  assert.doesNotMatch(looks, /Next look on/);
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
  assert.match(looks, /front \? 'In front' : ''/, 'the top row says it is in front');
  assert.match(looks, /name-line"><small class="kind"><\/small><span class="strip">/, 'the chip leads the row');
});

test('Status splits what matters from diagnostics, and repeats no amber', async () => {
  const status = read('panel/status.js');
  assert.match(status, /<details id="stDiag" class="section-disclosure"><summary>Diagnostics/);
  assert.ok(status.indexOf("'frames late'") > status.indexOf('stDiagStats').valueOf(), 'frame numbers are in the diagnostics');
  const { groupIssues } = await import('./static/panel/status.js');
  const spacing = (s) => ({ summary: s, kind: 'spacing', fix: { label: 'Calibrate this run', run: 'r' } });
  assert.equal(groupIssues([spacing('a'), spacing('a')]).length, 1, 'a repeat is dropped');
  const out = groupIssues([{ summary: 'dark', fix: null }, spacing('a'), { summary: 'other', fix: null }, spacing('b')]);
  assert.deepEqual(out.map((x) => x.summary), ['dark', 'The lights are spaced differently than drawn in 2 places.', 'other']);
  assert.equal(out[1].group.length, 2);
  assert.match(css, /\.run-rows li \{ display: grid; grid-template-columns: minmax\(0, 1fr\) max-content 6\.4em;/);
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
  // The pill itself is the box: on only changes its fill and edge, never its size.
  const on = /\.chips > button\.on \{ ([^}]*) \}/.exec(css)[1];
  assert.doesNotMatch(on, /width|height|padding|min-height/);
  assert.match(css, /\.chips:not\(\.toggles\) > button\.on::before/, 'only a picked place uses a bare check');
});

test('B78: a per-unit has no stray space, and other units keep theirs', async () => {
  const { showQty } = await import('./static/util.js');
  assert.equal(showQty('density', 2), '2 /m·s');
  assert.equal(showQty('rate', 0.2), '0.2 /s');
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
  assert.match(head[0], /id="lkTargetLabel">Preview on</);
  // A preview layer's place is a control of its own, on its own card.
  assert.match(src, /className: 'place target-select'/);
  assert.match(src, /<span class="muted">\$\{pc\.label\}<\/span><b>\$\{esc\(pc\.text\)\}<\/b>/);
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
  // The toast stands alone, wherever the banner is.
  const shown = applyResult('The look is on the lights', dark, 'Lantern is on the lights');
  assert.equal(shown.warn, true);
  assert.equal(shown.text, 'Lantern is on the lights. Porch is at 0%, so it stays dark.');
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
  assert.match(looks, /class="muted">\$\{pc\.label\}</, 'where the look goes, in words');
  const { applyResult } = await import('./static/panel/looks.js');
  const dark = { dark: 'none', zones: ['Yard'], message: 'x' };
  assert.equal(applyResult('x', { dark: '' }, 'y').text, 'x.');
  assert.equal(applyResult('x', dark, 'y').warn, true);
});

test('one section heading style, Setup in order, and matching segments', () => {
  const setup = read('panel/setup.js');
  assert.doesNotMatch(setup, /<h3 class="sub">(Color the map by|Which lights|Show on the map)/);
  assert.ok(setup.indexOf('<h1') < setup.indexOf('<h2 class="sub">Color') && setup.indexOf('<h2 class="sub">Color') < setup.indexOf('<h3 class="sub">Model detail'));
  assert.match(css, /\.group-head \{ margin: 10px 0 6px; \}/, 'Pinned presets is an h2 like Preview');
  assert.doesNotMatch(css, /\.seg\.five > button \{[^}]*font-size/, 'segments match the 14px segments below');
});

test('desktop footer keeps to the panel bottom; legend folds; boot has the tab icons; labels fit a phone', async () => {
  // Round 3 (one apply bar): the bar is at the panel's foot in every state; sticky still covers the tall case.
  assert.match(css, /#tab-looks > \.look-bar \{ margin-top: auto;/);
  assert.match(read('panel/setup.js'), /legend-toggle/);
  assert.match(css, /\.legend\.folded > :not\(\.legend-toggle\) \{ display: none/);
  assert.match(css, /\.target-list \{[^}]*padding-bottom: 12px/, 'the last chips clear the sticky bar');
  const html = read('index.html');
  const icons = html.match(/<span class="ico" data-icon="\w+">/g);
  assert.equal(icons.length, 5);
  for (const ic of icons) assert.ok(html.includes(ic + '<svg'), ic);
  const { icon } = await import('./static/icons.js');
  assert.ok(html.includes(icon('looks')), 'the same drawing the app uses');
  assert.match(read('panel/presets.js'), /title="More: edit, duplicate or delete">\$\{icon\('more'\)\}<\/button>/, 'More carries the kebab, named by its title (round 3)');
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
  assert.match(presets, /title="More: edit, duplicate or delete">\$\{icon\('more'\)\}<\/button>/);
  assert.match(looks, /\$\{icon\('tweak'\)\}Tweak/);
  assert.match(looks, /\$\{icon\('close'\)\}<span>Remove/);
  assert.match(looks, /\$\{icon\('apply'\)\}Put only this on the lights/);
  for (const m of overlay.matchAll(/<span class="(sw[^"]*)" style="background:rgb/g)) assert.equal(m[1], 'sw', 'categories are the plain swatch');
});

test('the polish round: tall primaries, ringed thumbs, a real glyph, even segments, empty actions and the bar says what it does', async () => {
  assert.doesNotMatch(css, /\.setup-cal button\.go, \.calibrate button\.go \{ min-height/, 'one primary height per viewport: the tap size (Refinement 1)');
  assert.match(css, /input\[type=range\]::-webkit-slider-thumb \{[^}]*border: 2px solid #0d0e10/);
  assert.match(css, /input\[type=range\]::-moz-range-thumb \{[^}]*border: 2px solid #0d0e10/);
  assert.doesNotMatch(read('form.js'), /repeating-linear-gradient\(135deg, #4a5361/, 'no hatch');
  assert.match(read('form.js'), /uses the look's colors/);
  assert.match(css, /\.seg > button \+ button \{ border-left: 0;/, 'a selected segment has no heavier left edge');
  const { stateHTML } = await import('./static/states.js');
  assert.match(stateHTML({ title: 'x', action: { id: 'a1', label: 'Create a preset' } }), /<button type="button" class="go" id="a1">Create a preset<\/button>/);
  assert.doesNotMatch(stateHTML({ title: 'x' }), /class="go"/);
  assert.match(read('panel/presets.js'), /id: 'prEmptyNew', label: 'Create a preset'/);
  assert.match(read('panel/looks.js'), /id: 'lkEmptyNew', label: 'Create a preset'/);
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
  assert.match(app, /\$\('tab-' \+ id\)\.innerHTML = skeletonHTML\(id\)/, 'as a skeleton of its layout (round 2, refinement 7), labeled for a screen reader');
  assert.match(read('states.js'), /aria-label="\$\{label\}"/);
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
  assert.match(/\.seg > button:disabled, \.seg > button\[aria-disabled=true\]:not\(\.on\) \{[^}]*\}/.exec(css)[0], /color: var\(--disabled\)/);
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

test('the half sheet is one fixed height on every tab', () => {
  const sheet = read('sheet.js');
  assert.match(sheet, /const HALF = 0\.64;/);
  assert.doesNotMatch(sheet, /TALL_/);
  assert.match(sheet, /half: Math\.max\(HALF_MIN \+ sb, Math\.round\(h \* HALF\)\), full: h - STRIP/);
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
  const master = applyResult('The look is on the lights', { dark: 'none', message: 'Brightness is at 0%, so nothing shows.', zones: [] }, 'Lantern is on the lights');
  assert.equal(master.warn, true);
  assert.equal(master.text, 'Lantern is on the lights. Brightness is at 0%, so nothing shows.');
  assert.equal(master.zones, undefined, 'no zones to turn on, so no button');
  assert.equal(applyResult('The look is on the lights', { dark: '' }).text, 'The look is on the lights.');
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
  assert.match(looks, /\$\{icon\('close'\)\}<span>Clear<span class="wide"> preview<\/span><\/span>/);
  assert.match(presets, /id="prNew" class="icon-btn">\$\{icon\('plus'\)\}/);
  assert.match(setup, /icon\('target'\)\}\$\{running/);
  assert.match(status, /\$\{icon\('target'\)\}Calibrate/);
  assert.match(cal, /id="caConfirm"[^>]*>\$\{icon\('check'\)\}Confirm/);
  assert.match(looks, /id="lkTargetLabel">Preview on</);
  assert.match(looks, /<span class="muted">\$\{pc\.label\}<\/span><b>\$\{esc\(pc\.text\)\}/, "the card's own control keeps its name");
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
  assert.equal((cal.match(/MOVE_HOW\}/g) || []).length, 1, 'said at the intro; on a step, once, beside the buttons');
  assert.match(cal, /id="caHow">Use −\/\+ until it matches the circled point/);
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
    else { assert.equal(m.text, 'Lights: unknown'); assert.equal(m.detail, " · couldn't refresh"); assert.notEqual(m.cls, 'house'); assert.match(m.title, /failed/); }
  }
  assert.equal(mapStatus({ connected: true, fresh: false, show: 'house', preview: previewing }).text, 'Lights: unknown', 'a hidden preview changes nothing');
  assert.equal(mapStatus({ connected: true, fresh: false, show: '', preview: idle, lit: { dark: 'none', message: 'x' } }).text, 'Lights: unknown', 'stale zones are not news');
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
  assert.match(css, /\.bar-clear \{ flex: none; white-space: nowrap;/);
  assert.match(css, /\.bar-note \{[^}]*white-space: nowrap/);
});

test('B106, B108, B112: nothing is reserved for what is gone, and Apply leaves the panel where it was', () => {
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /heldSlot|slotBefore|minHeight/, 'B112: no fixed slot');
  assert.doesNotMatch(css, /looks-slot/);
  assert.match(/async function apply[\s\S]*?\n  \}\n/.exec(looks)[0], /applying = false;\s+renderStage\(\);[\s\S]*?root\.parentElement\.scrollTop = 0;/, 'B117: after Apply the heading is in view');
  assert.match(looks, /if \(applying\) return;/, 'B106: rows are not dropped and re-added mid-Apply');
  assert.match(css, /\.content \{ overflow-anchor: none;/, 'B106: the browser does not re-scroll for a swapped row');
  assert.match(looks, /S\.panel\.layout\(\) === 'sheet' && S\.panel\.tab\(\) === 'looks' && !S\.panel\.collapsed\(\)/, 'B108: beside the map a click does not scroll the grid');
});

test('B117: leaving Calibrate lands at the top of the panel, its heading in view', () => {
  const body = /function close\(\) \{[\s\S]*?\n  \}/.exec(read('panel/calibrate.js'))[0];
  assert.match(body, /openTab\(to\);\s+\/\/[^\n]*\n\s+S\.panel\?\.toTop\?\.\(\);/);
});

test('B118: pressing Calibrate while the page starts up does nothing wrong, and says it is loading', async () => {
  const { calibrateButton } = await import('./static/panel/setup.js');
  const b = {}, S = {};
  const show = calibrateButton(b, S);
  assert.equal(b.disabled, true, 'off until calibrate exists');
  assert.match(b.innerHTML, /Loading/);
  assert.doesNotThrow(() => b.onclick());
  let opened = 0;
  S.calib = { open: () => { opened++; } };
  show();
  assert.equal(b.disabled, false);
  assert.match(b.innerHTML, /Calibrate$/);
  b.onclick();
  assert.equal(opened, 1);
  show(true);
  assert.match(b.innerHTML, /Resume calibrating/);
  S.offline = true;
  show();
  assert.equal(b.disabled, true, 'offline keeps it off');
  assert.match(b.innerHTML, /Resume calibrating/, 'the words remember the session');
});

test('B120: the action bar never truncates its note and clears the phone edge', () => {
  const looks = read('panel/looks.js');
  assert.match(looks, /note\.scrollWidth > note\.clientWidth \+ 1\) bar\.classList\.add\('note-below'\)/);
  assert.match(css, /\.look-bar\.note-below \.bar-note \{[^}]*flex: 0 0 100%; white-space: normal/);
  assert.match(css, /\.look-bar \{ display: block; padding: 8px 12px; \}/);
  assert.match(css, /\.bar-main \.go \{ flex: 1 1 auto; \}/, 'the action takes what the mode link leaves of the row (Refinement 4)');
  assert.match(css, /  \.bar-line \{ display: none; \}/, 'Clear moved to the stage header; the note to its line');
});

test('B122: every Tweak slider takes its name from its row, and color channels keep theirs', () => {
  const form = read('form.js');
  assert.match(form, /querySelectorAll\('input\[type=range\]:not\(\[aria-label\]\)'\)\) r\.setAttribute\('aria-label', label\)/);
  assert.match(form, /slider\.setAttribute\('aria-label', name\)/);
});

test('B123: output names in a tight cluster hide and are counted, never overlap', async () => {
  const { placeLabels } = await import('./static/overlay.js');
  const measure = (l) => l.text.length * 6;
  // Eight outputs on one spot, every place around them already marked.
  const queued = Array.from({ length: 8 }, (_, i) => ({ text: `Board output ${i + 1}`, x: 100, y: 100, color: '#fff', rank: 2, budget: true, clear: true }));
  const placed = placeLabels(queued, { marks: [{ x0: 0, x1: 300, y0: 0, y1: 90 }], width: 1000, height: 800, measure });
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j];
    assert.ok(!(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1), `${a.text} overlaps ${b.text}`);
  }
  assert.ok(placed.every((l) => !(l.x0 < 300 && l.y0 < 90)), 'none sits on a mark');
  assert.equal(placed.length + placed.hidden, 8, 'the rest are counted for the no-room note');
  assert.ok(placed.hidden > 0);
  const overlay = read('overlay.js');
  assert.match(overlay, /output \$\{o\.output\}`, q\[0\] \+ 10, q\[1\] - 8, `rgb\(\$\{o\.color\}\)`, MAJOR, true, true\)/);
});

test('the action bar sits right below short content and sticks over tall content', () => {
  assert.doesNotMatch(css, /#tab-looks \{ display: flex/);
  assert.match(css, /\.look-bar \{\s*\/\*[^*]*\*\/\s*position: sticky; bottom: calc\(-1 \* var\(--content-bottom\)\)/);
});

test('one section-heading step, with a smaller h3 nested under Advanced', () => {
  assert.doesNotMatch(css, /\.stage-head h2 \{[^}]*font-size/, 'the stage heading is a section heading');
  assert.match(css, /\.tab h2\.sub, \.tab h3\.sub \{[^}]*color: #f3f4f6/);
  assert.doesNotMatch(css, /\.tab h2\.sub, \.tab h3\.sub \{[^}]*font-size: var\(--t-h3\)/);
  assert.match(css, /#suAdvanced > summary \{ font-size: var\(--t-h2\)/);
  assert.match(css, /#suAdvanced h3\.sub \{ font-size: var\(--t-m\)/);
  assert.match(css, /\.calibrate h3 \{ font-size: var\(--t-h2\); \}/, 'Progress');
});

test('one word for taking a layer off, Pin matches the Presets tab, and the empty Preview toggle says why', async () => {
  const looks = read('panel/looks.js'), icons = read('icons.js'), path = (n) => new RegExp(`\\b${n}: '([^']+)'`).exec(icons)[1];
  assert.doesNotMatch(looks, /Take this look off|Take everything off/);
  assert.match(looks, /'Remove from the lights'/);
  assert.notEqual(path('pin'), path('presets'), 'Pinned is not "go to Presets"');
  const { showButton } = await import('./static/map-status.js');
  const s = showButton('', { ready: true, failed: false, canPreview: false, word: 'Click' });
  assert.equal(s.ariaDisabled, true);
  assert.match(s.title, /^No preview yet/);
});

test('More settings keeps controls in one right column with help on one line of the row', () => {
  assert.match(css, /\.form details > \.f, \.form details > \.f\.stack \{ grid-template-columns: minmax\(0, var\(--label-w\)\) minmax\(0, 1fr\)/);
  assert.match(css, /\.form \.f \.doc \{ grid-column: 1 \/ -1;/);
});

test('the desktop panel is wider from 1280 px, and the phone is unchanged', () => {
  assert.match(css, /@media \(min-width: 1280px\) \{\s*:root \{ --panel-w: 580px; \}/);
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

test('unused palette colors fold into one line per layer, which names them', () => {
  const form = read('form.js');
  assert.match(form, /takes its colors from the palette\./, 'says why');
  assert.match(form, /const names = g\.colors\.filter\(\(c\) => c\.ignored\(\)\)\.map\(\(c\) => c\.label\)/, 'the colors it means are in the line');
  assert.match(form, /c\.row\.hidden = c\.ignored\(\)/);
});

test('camera: no Overhead code and no named-view text is left', () => {
  const scene = read('scene.js');
  assert.doesNotMatch(scene, /overhead|named view|named\(/i);
  assert.doesNotMatch(read('panel/setup.js'), /overhead|suCamMode|named views/);
});

test('the card picker opens under its own button, even with the Tweak form open', () => {
  assert.match(read('panel/looks.js'), /picker\.style\.top = at\.up \? '' : place\.bottom - row\.getBoundingClientRect\(\)\.top \+ 4/);
});

test('B111: a row\'s name has its own line, above the controls', () => {
  const looks = read('panel/looks.js');
  const row = /el\.innerHTML = `\s*<div class="name-line">[\s\S]*?<div class="slot">/.exec(looks)[0];
  assert.ok(row.indexOf('class="name-line"') < row.indexOf('class="controls"'), 'name first');
  assert.doesNotMatch(/<div class="name-line">.*?<\/div>/.exec(row)[0].replace(/<button[^>]*row-expand[\s\S]*?<\/button>/, ''), /<button|<input/, 'no control but the phone chevron shares its line');
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
  assert.match(status, /id="stTurnOn">\$\{icon\('check'\)\}\$\{esc\(turnOnLabel\(zeroNames\)\)\}/, 'the brightness card has the Turn on action');
  assert.match(status, /renderIssues\(issues, /, 'drawn from the list the headline counted');
});

test('B114: library cards clamp the name to two lines and keep the subtitle on a fixed row', () => {
  assert.match(css, /\.preset \.name \{ font-size: var\(--t-h3\); font-weight: 600; line-height: 1\.3; \}/);
  assert.match(css, /-webkit-line-clamp: 2/);
  assert.match(css, /\.preset \.sub, \.preset \.in-badge \{ height: 1\.4em;[^}]*white-space: nowrap/);
});

test('B115: icon buttons in the Tweak form keep the icon beside the label', () => {
  const form = read('form.js');
  assert.match(form, /add\.className = 'icon-btn'; add\.innerHTML = `\$\{icon\('plus'\)\}Add color/);
  assert.match(form, /rm\.className = 'icon-btn'; rm\.innerHTML = `\$\{icon\('minus'\)\}Remove/);
  assert.match(css, /button\.icon-btn \{ display: inline-flex;/);
});

test('Tweak is the sliders, and Setup a gear', () => {
  const icons = read('icons.js'), path = (n) => new RegExp(`\\b${n}: '([^']+)'`).exec(icons)[1];
  assert.notEqual(path('tweak'), path('setup'));
  assert.doesNotMatch(path('tweak'), /M8 4\.5a4\.5/, 'not the stopwatch all three reviewers read');
  assert.match(path('tweak'), /^M2 4\.5h6\.5/, 'horizontal sliders');
  assert.match(read('index.html'), new RegExp(path('setup').slice(0, 20).replace(/\./g, '\\.')), 'the tab bar paints the gear before the script runs');
  assert.notEqual(path('tweak'), path('edit'));
});

test('Setup: Advanced is nested under Advanced, a size below the top-level sections', () => {
  assert.match(css, /#suAdvanced > :not\(summary\) \{[^}]*border-left/);
  assert.match(css, /#suAdvanced h3\.sub \{ font-size: var\(--t-m\)/);
});

test('a phone: the stage is the first content, and the sheet rises for Tweak only', () => {
  const looks = read('panel/looks.js');
  assert.match(css, /\.tab \.looks-head \{ display: none; \}/);
  assert.doesNotMatch(looks, /S\.panel\.setDetent\('full'\);\n\s+if \(cards\.has\('preview:' \+ added\.id\)\)/, 'adding a look leaves the sheet where it is');
  assert.match(looks, /S\.panel\.layout\(\) === 'sheet' && S\.panel\.detent\(\) !== 'full'/);
  assert.match(css, /body:not\(\[data-detent\]\) \.panel \{ visibility: hidden; \}/, 'the sheet is not drawn before its height');
  assert.match(read('sheet.js'), /panel\.classList\.add\('dragging'\);\n\s+refresh\(true\)/, 'no rise from the peek on load');
});

test('opening the color editor keeps the row side by side', () => {
  assert.doesNotMatch(css, /\.form \.f:has\(\.color-picker\[open\]\) > \.ctl/);
  assert.match(css, /\.color-picker\[open\] > \.color-mixer \{ margin-left:/);
});

test('B124: Map updates sits in Advanced like its sibling groups', () => {
  const setup = read('panel/setup.js');
  const advanced = setup.slice(setup.indexOf('id="suAdvanced"'), setup.indexOf('</details>', setup.indexOf('id="suRate"')));
  assert.match(advanced, /<div id="suRateGroup"><h3 class="sub">Map updates<\/h3>\s*<div class="seg" id="suRate"/, 'in one wrapper, so .tab .seg fills the wrapper');
  assert.doesNotMatch(advanced, /\n {4}<div class="seg"/, 'no segmented control is a direct child of the indented block');
});

test('B125: a row\'s Goes on list never scrolls the row\'s name away', async () => {
  const { pickerPlace } = await import('./static/panel/looks.js');
  const base = { nameTop: 640, rowTop: 630, rowBottom: 700, viewTop: 108, viewBottom: 744, chrome: 110, natural: 400, maxScroll: 1000 };
  const low = pickerPlace(base);
  assert.equal(low.up, false);
  assert.ok(base.nameTop - low.scroll >= base.viewTop, 'the name stays on screen');
  assert.ok(base.rowBottom - low.scroll + 4 + 110 + low.list <= base.viewBottom, 'the list ends above the bar');
  assert.equal(low.scroll, 220 - (744 - 700 - 4 - 110), 'it scrolls only as far as the list needs');
  const huge = pickerPlace({ ...base, viewBottom: 300, nameTop: 240, rowTop: 230, rowBottom: 290 });
  assert.equal(huge.scroll, 240 - 108, 'never further than the name reaching the top');
  const end = pickerPlace({ ...base, maxScroll: 0 });
  assert.equal(end.up, true, 'at the end of the list it opens upward');
  assert.equal(end.scroll, 0);
  assert.equal(end.list, 400, 'capped by the list, with the room above it');
  assert.equal(pickerPlace({ ...base, nameTop: 60, rowTop: 50, rowBottom: 110 }).scroll, -48, 'a name above the view comes back');
  const short = pickerPlace({ ...base, natural: 90, maxScroll: 0, nameTop: 500, rowTop: 490, rowBottom: 560 });
  assert.equal(short.up, true, 'with too little room below, the roomier side takes it');
  assert.equal(short.list, 90, 'and the list is no taller than it needs');
  const cramped = pickerPlace({ ...base, viewBottom: 600, nameTop: 300, rowTop: 290, rowBottom: 360, viewTop: 280, maxScroll: 0 });
  assert.equal(cramped.up, false, 'both sides cramped: below');
  assert.equal(cramped.list, 126, 'the list is capped to the room and scrolls');
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks.slice(looks.indexOf('function fitRowPicker'), looks.indexOf('escapeCloses(el, () => !picker.hidden')), /scrollIntoView/, 'the place is worked out, not left to scrollIntoView');
});

test('B126: Calibrating is said only during an active session', async () => {
  const { calLabel, loadState } = await import('./static/panel/calibrate.js');
  assert.equal(calLabel(undefined), 'Calibration', 'loading');
  assert.equal(loadState({ st: null, error: '' }).kind, 'loading');
  assert.equal(calLabel(null), 'Calibration', 'failed');
  assert.equal(loadState({ st: null, error: 'x' }).kind, 'error');
  assert.equal(calLabel({ active: false }), 'Calibration', 'idle');
  assert.equal(calLabel({ active: true }), 'Calibrating', 'running');
  assert.match(read('panel/calibrate.js'), /\$\$\('#caLabel'\)\.textContent = calLabel\(st\)/);
  const { mapStatus } = await import('./static/map-status.js');
  assert.equal(mapStatus({ connected: true, measuring: 'other' }).text, 'Calibration', 'the pill has the same rule');
  assert.equal(mapStatus({ connected: true, measuring: 'other', calActive: true }).text, 'Calibrating');
  assert.equal(mapStatus({ connected: true, measuring: 'bands', calActive: true }).text, 'Test bands');
});

test('the library scope and a row\'s place are one kind of control (round 3, move C)', () => {
  // Round 3 replaced the underlined word in a sentence with a labeled, select-styled button; the row's place uses the same style.
  const looks = read('panel/looks.js');
  assert.match(looks, /<span class="muted" id="lkTargetLabel">Preview on<\/span><button type="button" class="target-select" id="lkTarget"/);
  assert.match(looks, /className: 'place target-select'/);
  assert.match(/^button\.target-select \{[^}]*\}/m.exec(css)[0], /border: 1px solid var\(--control-line\)/);
});

test('phone previewing: one map band on every tab, and only the person moves the sheet', () => {
  const looks = read('panel/looks.js'), app = read('app.js'), sheet = read('sheet.js');
  assert.doesNotMatch(looks + sheet, /keepBand|PREVIEW_BAND|fullStrip|risePreview/);
  assert.match(app, /else if \(previewRanges\(\)\.length\) S\.view\.frameTight\(rangeIds\(previewRanges\(\)\)\)/, 'the camera frames the lit runs in the band');
  assert.match(read('scene.js'), /frameTight\(ids\) \{/);
});

test('Preview, Pin and More share one button style; Pinned keeps its state', () => {
  const rules = css.match(/^\.preset-actions \[data-act=(?:try|pin|more)\][^{]*\{[^}]*\}/gm).join('\n');
  assert.doesNotMatch(rules, /border-color: transparent|font-weight|background: var/, 'no button of the three has its own weight or ghost state');
  assert.match(css, /\.preset-actions \[data-act=pin\]\[aria-pressed=true\] \{ color: var\(--accent\); border-color: var\(--accent\); \}/);
  assert.match(css, /\.preset-actions \[data-act=pin\]\[aria-pressed=true\] \{ background: rgba\(124, 196, 255, 0\.16\); \}/, 'Pinned is filled, so it differs without color (round 3)');
  assert.match(read('panel/presets.js'), /icon\(p\.pinned \? 'pinFilled' : 'pin'\)/);
});

test('search fields are one pattern on Looks and Presets', () => {
  assert.match(read('panel/looks.js'), /textField\(\{ label: 'Find a look', id: 'lkFind', type: 'search', placeholder: 'Search looks', clearable: true \}\)/);
  assert.match(read('panel/presets.js'), /<div class="lib-filters">\$\{textField\(\{ label: 'Find a preset', id: 'prSearch', type: 'search', placeholder: 'Search presets', clearable: true \}\)\}<\/div>/);
  assert.match(css, /\.lib-filters \.field \{ flex: 1 1 auto;/, 'inline on every layout (round 3)');
  const wide = css.slice(css.indexOf('@media (min-width: 700px), (max-height: 499.98px) and (orientation: landscape)'));
  assert.match(wide, /\.lib-filters \{ flex-wrap: nowrap; \}\s*\.lib-filters \.field \{ flex: 1 1 auto; \}/, 'one row with the segments on the wide panel (D: the room is the Library\'s)');
  assert.match(wide, /\.lib-filters \.field > \.lbl \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\);/, 'folded, still the input\'s name');
});

test('Remove takes a layer off with an X and the word at every size; Delete keeps the trash can', () => {
  assert.doesNotMatch(read('panel/looks.js'), /icon\('trash'\)/);
  assert.match(read('panel/presets.js'), /icon\('trash'\)\}Delete/);
  assert.doesNotMatch(css, /\[data-a=remove\]:not\(\.worded\) span/, 'never hidden, at either size');
  assert.match(css, /\.layer \.bri \{[^}]*flex: 1 1 60px;[^}]*min-width: 60px;/, 'the slider shrinks before a label wraps');
});

test('library card rows reserve no second line for names that fit one', () => {
  const name = /^\.preset \.name \{ font-size[^}]*\}/m.exec(css)[0];
  assert.doesNotMatch(name, /(^|\s|;)height:/, 'no fixed two-line height');
  assert.match(css, /-webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere/, 'a long name still clamps to two lines');
  assert.match(css, /\.preset \.sub, \.preset \.in-badge \{ margin-top: auto; \}/, 'even bottoms within a row');
  assert.match(/^\.cards \{[^}]*\}/m.exec(css)[0], /display: grid/, 'a grid row takes its tallest card');
});

test('a failed light status read says so on the pill and on Apply, and never blocks Apply', async () => {
  const { mapStatus } = await import('./static/map-status.js');
  const { applyTitle } = await import('./static/panel/looks.js');
  assert.equal(mapStatus({ connected: true, fresh: false, reading: true, show: '', preview: { previewing: false } }).text, 'Lights: checking…', 'loading is not a failure');
  const showing = mapStatus({ connected: true, fresh: false, show: '', preview: { previewing: true } });
  assert.equal(showing.detail, ' · lights unknown');
  assert.match(applyTitle({ label: 'Put 1 look on the lights', note: '' }, true), /^Put 1 look on the lights\. The lights' current state is unknown\.$/);
  assert.equal(applyTitle({ label: 'L', note: 'N' }, false), 'N');
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks.slice(looks.indexOf('function renderBar'), looks.indexOf('function fitNote')), /\.disabled/, 'Apply is never disabled for this');
});

test('More settings group by what they affect, and help waits to be wanted', async () => {
  const { groupParams } = await import('./static/form.js');
  const row = (name) => ({ p: { name }, from: 0 });
  const few = groupParams(['speed', 'blend'].map(row));
  assert.deepEqual(few.map((g) => g.label), [''], 'a short list stays one list');
  const plain = groupParams(['lifetime', 'seed', 'mapping', 'reverse', 'offset', 'opacity', 'blend', 'white', 'smooth', 'fade_in', 'fade_out'].map(row));
  assert.deepEqual(plain.map((g) => g.label), ['Color', 'Timing', 'Placement', 'Layering']);
  assert.deepEqual(plain.find((g) => g.label === 'Timing').rows.map((r) => r.p.name), ['lifetime', 'smooth', 'fade_in', 'fade_out']);
  const layered = groupParams(['gradient.blend', 'gradient.span', 'sparkle.decay', 'sparkle.seed', 'mapping', 'reverse', 'opacity'].map(row));
  assert.deepEqual(layered.map((g) => g.label), ['Gradient', 'Sparkle', 'Placement', 'Layering']);
  const one = groupParams(['a.b', 'a.c', 'a.d', 'a.e', 'a.f', 'a.g', 'a.h'].map(row));
  assert.deepEqual(one.map((g) => g.label), [''], 'one kind adds nothing');
  assert.equal(groupParams(['unheard_of', 'b', 'c', 'd', 'e', 'f', 'speed'].map(row)).at(-1).label, 'Other');
  assert.match(css, /\.form \.f\.hinted > \.doc \{ display: none; \}/);
  assert.match(css, /\.form \.f\.hinted\.show-doc > \.doc, \.form \.f\.hinted > \.ctl:focus-within ~ \.doc \{ display: block; \}/);
  const form = read('form.js');
  assert.match(form, /field\(wled, label, bindingSlider\(b, lf\), null, title\)/, 'the WLED controls above More do not change');
});

test('disclosures come in two documented tiers', () => {
  assert.match(css, /Disclosures come in three tiers/);
  assert.match(css, /details > summary \{[^}]*font-size: var\(--t-m\);/);
  assert.match(css, /\.section-disclosure > summary, #suAdvanced > summary \{ font-size: var\(--t-h2\); font-weight: 600;/);
  assert.match(read('form.js'), /more\.className = 'form-disclosure'/);
  assert.match(read('panel/status.js'), /id="stDiag" class="section-disclosure"/);
});

test('wording: In front explains itself, and the apply toast stands alone', async () => {
  assert.match(read('panel/looks.js'), /'Shown over the layers below it'/);
  const { applyResult } = await import('./static/panel/looks.js');
  const four = { dark: 'none', zones: ['A', 'B', 'C', 'D'], message: 'x' };
  assert.equal(applyResult('The look is on the lights', four, 'Lantern is on the lights').text, 'Lantern is on the lights. 4 zones are at 0%, so they stay dark.');
  const two = { dark: 'part', zones: ['Street', 'Yard'], ids: ['s', 'y'], message: 'x' };
  const r = applyResult('The look is on the lights', two, 'Lantern is on the lights');
  assert.equal(r.text, 'Lantern is on the lights. Street and Yard are at 0%, so they stay dark.');
  assert.deepEqual(r.zones, { ids: ['s', 'y'], names: ['Street', 'Yard'] }, 'carries the same fix as the banner');
  for (const o of [four, two]) assert.doesNotMatch(applyResult('the look', o, 'x').text, /\b(above|below)\b/);
  assert.match(read('app.js'), /opts\.action/, 'a toast can carry its fix');
});

test('on a phone the worded Remove leaves the place name its room', () => {
  assert.match(css, /\.layer \.controls \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; \}/);
  assert.match(css, /\.layer \.tweak \{ grid-column: 2; grid-row: 2; \}/);
});

test('B127: a run row keeps a gutter before Calibrate and one edge for its figures', () => {
  const css = read('ui.css');
  assert.match(css, /\.run-rows li \{ display: grid; grid-template-columns: minmax\(0, 1fr\) max-content 6\.4em; column-gap: 12px; \}/);
});

test('B128: an area wholly covered by smaller ones leaves the key', async () => {
  const { areaPaint } = await import('./static/overlay.js');
  const area = (count, ...ranges) => ({ area: { count, ranges } });
  // A whole-zone area, then two parts that cover it exactly.
  const covered = [area(100, [0, 99]), area(60, [0, 59]), area(40, [60, 99])];
  assert.deepEqual(areaPaint(covered).order, [0, 1, 2], 'biggest first');
  assert.deepEqual([...areaPaint(covered).seen].sort(), [1, 2], 'the whole-zone area shows nowhere');
  // One pixel left over is still a color on the map.
  const partly = [area(100, [0, 99]), area(60, [0, 59]), area(39, [60, 98])];
  assert.deepEqual([...areaPaint(partly).seen].sort(), [0, 1, 2]);
  assert.deepEqual([...areaPaint([{ area: undefined }, area(5, [0, 4])]).seen], [1], 'a part with no area is skipped');
});

test('B129: the Tweak form has one wider label column, stacked on the narrow panel', () => {
  const css = read('ui.css');
  assert.match(css, /--label-w: 11em;/);
  assert.doesNotMatch(css, /8\.5em/);
  assert.match(css, /\(max-width: 1099\.98px\) and \(min-width: 700px\)[^{]*\{\s*\.form \.f, \.form details > \.f, \.form details > \.f\.stack \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test('B130: a disclosure is never larger than its container heading', () => {
  const css = read('ui.css');
  assert.match(css, /Disclosures come in three tiers/);
  assert.match(css, /\.form-disclosure > summary \{ font-size: var\(--t-h3\); font-weight: 600;/);
  assert.match(css, /\.layer \.name-line b \{[^}]*font-size: var\(--t-h3\)/, "a layer card's title is at least its More settings");
  assert.match(read('panel/status.js'), /id="stDiag" class="section-disclosure"/);
});

test('Turn on shares no glyph with the brightness slider, and is never a power symbol', () => {
  for (const f of ['panel/looks.js', 'panel/status.js']) assert.doesNotMatch(read(f), /icon\('sun'\)\}\$\{esc\(turnOnLabel/, f);
  assert.doesNotMatch(read('icons.js'), /\bpower:/);
});

test('two stretches of a run read alike and still count as two, with the points in Details', async () => {
  const { groupIssues } = await import('./static/panel/status.js');
  const one = (detail) => ({ summary: 'Run: spaced tighter than drawn.', kind: 'spacing', detail, plain: detail, fix: { label: 'Calibrate this run', run: 'r' } });
  const out = groupIssues([one('a–b'), one('c–d'), one('a–b')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].group.length, 2, 'a repeat is the same detail, not the same words');
  assert.match(read('panel/status.js'), /data-one="\$\{j\}">[\s\S]*?<details><summary>Details<\/summary><p class="plain" title="\$\{esc\(one\.detail\)\}"/);
});

test('an open More settings scrolls inside the panel beside the map', () => {
  assert.match(read('ui.css'), /\.layer \.form-disclosure\[open\] \{ max-height: 55vh; overflow-y: auto; overscroll-behavior: contain; \}/);
});

test('a layer row gives the slider the width the place does not use', () => {
  assert.match(read('ui.css'), /\.place-row \{[^}]*flex: 0 1 auto; max-width: 41%;/);
});

test('a phone row gives its name the room the place does not use', () => {
  // The name's column stretches; the place and level are as wide as their words.
  assert.match(read('ui.css'), /\.layer \.name-line \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto auto var\(--tap\);/);
});

test('B129: a long slider value never overruns the shared right edge', () => {
  assert.match(read('ui.css'), /\.form \.f \.ctl output \{ flex: none; min-width: 4\.8em; \}/);
});

test('B132: a phone row\'s Goes on keeps its place name; Remove drops its word first', () => {
  const looks = read('panel/looks.js');
  // The name is a flex item with a floor, not one that collapses to nothing.
  assert.match(css, /\.place b \{ font-weight: 500; flex: 1 1 auto; min-width: 8ch;/);
  // On the sheet the place takes the row's first column whole, one line.
  const phone = css.slice(css.indexOf('@media (max-width: 699.98px) and (orientation: portrait)'));
  assert.match(phone, /\.layer \.place-row \{ grid-column: 1; grid-row: 1; max-width: none; \}/);
  assert.match(phone, /\.layer \.place b \{ display: block; white-space: nowrap; text-overflow: ellipsis; \}/);
  // When the two cannot share the line, Remove loses its word, not the name.
  assert.match(phone, /\.layer\.tight \[data-a=remove\] span \{ display: none; \}/);
  assert.match(looks, /function fitControls\(c\)/);
  assert.match(looks, /box\.scrollWidth > box\.clientWidth \+ 1\) el\.classList\.add\('tight'\)/);
  assert.match(looks, /rm\.setAttribute\('aria-label', part \? 'Remove here' : 'Remove'\)/, 'the icon-only Remove still has its name');
});

test('B133: on a phone a Tweak row stacks, and a slider track gets the card\'s width', () => {
  // The one-column form rule covers the phone sheet, not only the 300 px side panel.
  assert.match(css, /\(max-width: 1099\.98px\) and \(min-width: 700px\),[^{]*\(max-width: 699\.98px\) and \(orientation: portrait\), \(max-width: 699\.98px\) and \(min-height: 500px\) \{\s*\.form \.f, \.form details > \.f, \.form details > \.f\.stack \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  // A slider's value stays at the right of its label's line; the track takes the next.
  assert.match(css, /\.form \.f\.slider > \.ctl \{ display: contents; \}/);
  assert.match(css, /\.form \.f\.slider > \.ctl > output \{ grid-column: 2; grid-row: 1; text-align: right; \}/);
  assert.match(css, /\.form \.f\.slider > \.ctl > input\[type=range\] \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
  assert.match(css, /\.form \.channel-row input\[type=range\] \{ grid-column: 1 \/ -1; grid-row: 2; \}/, 'the mixer channels stack the same way');
  assert.match(read('form.js'), /c\.querySelector\(':scope > input\[type=range\]'\) && c\.querySelector\(':scope > output'\)\) f\.classList\.add\('slider'\)/);
});

test('B134: a collapsed phone row keeps the look\'s name whole; place and level take a second line', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 699.98px) and (orientation: portrait)'));
  assert.match(phone, /\.layer\.two-line \.name-line b \{ grid-column: 2 \/ 5; white-space: normal;[^}]*-webkit-line-clamp: 2; \}/);
  assert.match(phone, /\.layer\.two-line \.line-place \{ grid-column: 2; grid-row: 2;/);
  assert.match(phone, /\.layer\.two-line \.line-level \{ grid-column: 3; grid-row: 2;/);
  assert.match(phone, /\.layer\.two-line \.line-level::before \{ content: '· '; \}/, 'Everything · 100%');
  const looks = read('panel/looks.js');
  assert.match(looks, /if \(name\.scrollWidth > name\.clientWidth \+ 1\) el\.classList\.add\('two-line'\)/);
  assert.match(looks, /new ResizeObserver\(\(\) => \{ for \(const c of cards\.values\(\)\) fitControls\(c\); fitStageHead\(\); fitDark\(\); \}\)\.observe\(\$\$\('#lkRows'\)\)/, 'refits on a resize');
});

test('B135: toasts arriving together fold into one, and the phone sheet shows one at a time', async () => {
  const { foldable, merged, MERGE_WINDOW } = await import('./static/toast-merge.js');
  const plain = (at) => ({ at, error: false, action: null });
  // Within the window two plain messages fold; a stale one does not, beside the map.
  assert.deepEqual(foldable([plain(1000)], {}, 'wide', 2000), [plain(1000)]);
  assert.deepEqual(foldable([plain(0)], {}, 'wide', MERGE_WINDOW + 1), []);
  // On the sheet there is one toast at a time, however old the earlier one.
  assert.deepEqual(foldable([plain(0)], {}, 'sheet', 60000), [plain(0)]);
  // An error keeps its own card; nothing folds into an action's toast.
  assert.deepEqual(foldable([{ at: 1000, error: true }], {}, 'sheet', 1500), []);
  assert.deepEqual(foldable([plain(1000)], { action: { label: 'Turn on' } }, 'sheet', 1500), []);
  assert.deepEqual(foldable([plain(1000)], { error: true }, 'sheet', 1500), []);
  // The newest message leads; the earlier text is its detail line.
  assert.deepEqual(merged('Applied the look.', [], [{ text: 'Turned on Street and Yard.', details: [] }]), { text: 'Applied the look.', details: ['Turned on Street and Yard.'] });
  assert.deepEqual(merged('Third.', ['own detail'], [{ text: 'First.', details: ['a'] }, { text: 'Second.', details: [] }]), { text: 'Third.', details: ['own detail', 'Second.', 'First.', 'a'] });
  const app = read('app.js');
  assert.match(app, /const folded = foldable\(showing, \{ error: err \|\| opts\.error, action: opts\.action \|\| opts\.actions\?\.\[0\] \}, S\.panel \? S\.panel\.layout\(\) : 'wide', Date\.now\(\)\)/);
  assert.match(app, /for \(const t of folded\) t\.el\.remove\(\)/);
});

test('B136: a configured camera distance never holds the lights small in the map band', () => {
  const scene = read('scene.js');
  // The older { from, to } view gives its angle only; the distance is the fit.
  assert.doesNotMatch(scene, /minDist/, 'no distance floor on a framed camera');
  assert.match(scene, /return \{ dir: from\.clone\(\)\.sub\(to\)\.normalize\(\), target: to \};/);
  assert.match(scene, /let d = fitDistance\(cam\.dir, target, corners\(\)\);/);
  assert.match(scene, /if \(lights\.length\) d = centerOn\(cam\.dir, target, lights\);/);
  assert.match(read('../../../docs/design.md'), /it gives the angle, and the\s+distance is worked out the same way/);
});

test('B137: the palette note names the colors it replaces, by the layer that ignores them', async () => {
  const { unusedNote } = await import('./static/form.js');
  assert.equal(unusedNote(['Gradient color 1', 'Gradient color 2'], 'gradient'), 'Gradient color 1 and 2 are not used: the gradient takes its colors from the palette.');
  assert.equal(unusedNote(['Color 1', 'Color 2', 'Color 3'], ''), 'Color 1 to 3 are not used: this effect takes its colors from the palette.');
  assert.equal(unusedNote(['Color 1', 'Color 3'], ''), 'Color 1 and 3 are not used: this effect takes its colors from the palette.');
  assert.equal(unusedNote(['Color 2'], ''), 'Color 2 is not used: this effect takes its colors from the palette.');
  assert.equal(unusedNote([], ''), '');
  const form = read('form.js');
  // One line per layer, in the place of the colors it stands in for: never
  // under another layer's control that is in use.
  assert.match(form, /for \(const g of groups\.values\(\)\) g\.colors\[g\.colors\.length - 1\]\.row\.after\(g\.line\)/);
  assert.match(form, /g\.line\.textContent = unusedNote\(names, owner\)/);
  assert.doesNotMatch(form, /'This effect takes its colors from the palette\.'/);
});

test('Move A: the phone sheet opens to the task at the half detent', async () => {
  const { compactStage } = await import('./static/panel/looks.js');
  // One line: the long title gives way, the sub follows the dot in lower case.
  assert.deepEqual(compactStage({ title: "Previewing over what's on the lights", sub: 'Replaces Porch glitter', preview: 1, live: 1 }), { title: 'Previewing', sub: 'replaces Porch glitter' });
  assert.deepEqual(compactStage({ title: 'On the lights', sub: '', preview: 0, live: 1 }), { title: 'On the lights', sub: '' });
  assert.deepEqual(compactStage({ title: 'Previewing', sub: "Couldn't refresh. This is the last known state.", preview: 1, live: 0 }).sub, "couldn't refresh. This is the last known state.");
  const looks = read('panel/looks.js');
  assert.match(looks, /if \(compact\(\)\) head = compactStage\(/);
  assert.match(looks, /S\.on\('detent', renderStage\)/, 'the stage re-renders as the sheet moves');
  const phone = css.slice(css.indexOf('@media (max-width: 699.98px) and (orientation: portrait)'));
  assert.match(phone, /body\[data-detent=half\] \.stage-head \{ display: flex; align-items: baseline; flex-wrap: wrap;/);
  assert.match(phone, /body\[data-detent=half\] \.stage-head > small:not\(:empty\)::before \{ content: '· '; \}/);
  assert.match(phone, /body\[data-detent=half\] \.lib-filters \{ flex-wrap: nowrap;/, 'filters and search share a line');
  assert.match(phone, /body\[data-detent=half\] \.lib-filters \.field > \.lbl \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\);/, 'folded away, still the input\'s name');
  assert.match(phone, /body\[data-detent=half\] \.tab-intro \{ display: none; \}/, "Presets' explanation waits for the full sheet");
  assert.match(read('panel/presets.js'), /class="muted small tab-intro"/);
  const { textField } = await import('./static/field.js');
  assert.match(textField({ label: 'Find a look', id: 'x' }), /<label class="field"><span class="lbl">Find a look<\/span><input/);
});

test('Move B: library tiles show the effect moving, from the renderer\'s own sprite', async () => {
  const { spriteURL, spriteStyle, tileState, hashParams, FRAMES, FPS, MID, createTiles } = await import('./static/tiles.js');
  assert.equal(FRAMES, 30); assert.equal(FPS, 10); assert.equal(MID, 15);
  assert.equal(spriteURL('effect', 'glitter'), '/api/v1/effects/glitter/strip.png?r=3');
  assert.match(spriteURL('preset', 'warm white', { color: '#fff' }), /^\/api\/v1\/presets\/warm%20white\/strip\.png\?v=[0-9a-z]+&r=3$/);
  assert.notEqual(hashParams({ color: '#fff' }), hashParams({ color: '#000' }), 'an edited preset gets a new picture');
  // The sprite's trail fills the swatch under the fade (B3); the drawn strip shows beneath it until it loads, or when there is none.
  const style = spriteStyle('/api/v1/effects/solid/strip.png', 'rgb(255,160,0)');
  assert.match(style, /url\(\/api\/v1\/effects\/solid\/strip\.png\), linear-gradient\(rgb\(255,160,0\), rgb\(255,160,0\)\)/, 'a plain color is a flat gradient layer, so the declaration holds');
  assert.match(spriteStyle('/x.png', 'linear-gradient(90deg, red, blue)'), /url\(\/x\.png\), linear-gradient\(90deg, red, blue\);/);
  assert.match(style, /background-size: auto, 100% 100%, auto/);
  assert.match(style, /background-position: 0 0, 0 calc\(var\(--swatch-h, 30px\) \* \(29 - var\(--tile-row, 15\)\) \/ 30\), 0 0/);
  // When the tiles step, hold, or hold the still frame.
  assert.equal(tileState({ reduced: false, hidden: false, visible: true, previewing: false }), 'running');
  assert.equal(tileState({ reduced: false, hidden: false, visible: true, previewing: true }), 'slow', 'the map is the preview: the tiles step at half rate behind it (B2)');
  assert.equal(tileState({ reduced: false, hidden: false, visible: false, previewing: false }), 'paused', 'off screen');
  assert.equal(tileState({ reduced: false, hidden: true, visible: true, previewing: false }), 'paused', 'page hidden');
  assert.equal(tileState({ reduced: true, hidden: false, visible: true, previewing: false }), 'still');
  // The clock, on a fake document: it steps the containers it watches and stops for a preview.
  const handlers = {};
  const S = { preview: null, on: (ev, fn) => { handlers[ev] = fn; } };
  const box = { style: { vars: {}, setProperty(k, v) { this.vars[k] = v; } } };
  const doc = { hidden: false, addEventListener() {} };
  const tiles = createTiles(S, doc);
  tiles.watch(box);
  assert.equal(box.style.vars['--tile-row'], MID, 'a tile starts at the still frame');
  assert.equal(tiles.state(), 'running');
  S.preview = { layers: [{}] }; handlers.preview();
  assert.equal(tiles.state(), 'slow');
  S.preview = null; handlers.preview();
  assert.equal(tiles.state(), 'running');
  await new Promise((r) => setTimeout(r, 1000 / FPS * 2.5));
  assert.ok(box.style.vars['--tile-row'] !== MID, 'it stepped');
  doc.hidden = true; handlers.preview(); // pauses: stops the timer so the test can end
  assert.equal(tiles.state(), 'paused');
  assert.match(read('panel/presets.js'), /const sprite = spriteURL\('preset', p\.id, p\.params, effect\), drawn = lookStrip\(S, p\.effect, p\.params\);\s*row\.querySelector\('\.swatch'\)\.style\.cssText = spriteStyle\(sprite, drawn\)/, 'preset rows use the preset\'s own sprite');
  assert.match(read('app.js'), /S\.tiles = createTiles\(S\)/);
});

test('Refinement 1: one toggle vocabulary', () => {
  // An independent on/off is a pill that fills when on. Round 3 settled its state mark: the
  // checkbox's box, never a circle (a circle is one-of-many).
  assert.doesNotMatch(css, /\.chips\.toggles > button(\.on)?::before \{[^}]*border-radius: 50%/, 'no radio-like dot inside a toggle pill');
  assert.doesNotMatch(css, /--check-on/);
  assert.match(css, /\.chips > button\.on \{ background: var\(--on\); border-color: var\(--accent\);/, 'a pill fills when on');
  // Nothing disabled or inert is dashed: inert fades instead.
  for (const m of css.matchAll(/([^{}]+)\{[^}]*border-style: dashed[^}]*\}/g)) assert.doesNotMatch(m[1], /button|\.go|\.chip/, 'no dashed border on any button');
  assert.match(css, /\[inert\] button, \[inert\] \.picker-btn, \[inert\] \.chip \{ opacity: 0\.55; cursor: not-allowed; \}/);
  // One primary height per viewport: no primary asks for more than the tap size.
  assert.doesNotMatch(css, /button\.go[^{]*\{[^}]*min-height/);
  // The disclosure tiers keep their sizes, with one chevron and one weight.
  assert.match(css, /details > summary \{[^}]*font-weight: 600; \}/);
  assert.equal((css.match(/details > summary::before \{/g) || []).length, 1, 'one chevron for every tier');
});

test('Refinement 2: sticky bars never clip', () => {
  const app = read('app.js');
  // Scrolling into view lands a tab bar's height below the top edge and an action bar's height above the bottom.
  assert.match(css, /\.content \{ scroll-padding-top: var\(--tabs-h, 44px\); \}/);
  assert.match(app, /style\.setProperty\('--tabs-h', document\.querySelector\('\.tabs'\)\.offsetHeight \+ 'px'\)/);
  assert.match(css, /scroll-padding-bottom: calc\(var\(--look-bar, 0px\) \+ 8px\)/);
  // A short fade at the top edge, stuck in place, so a heading scrolled under it reads as scrolled rather than cut.
  const fade = /\.content::before \{([^}]*)\}/.exec(css)[1];
  assert.match(fade, /position: sticky; top: 0;/);
  assert.match(fade, /height: 14px; margin: 0 -12px -14px/, 'the fade takes no room of its own');
  assert.match(fade, /linear-gradient\(var\(--panel-bg\), transparent\)/);
  assert.match(fade, /pointer-events: none/);
  // The connection banner stays above the fade.
  assert.match(css, /\.offline-banner \{ position: sticky; top: 0; z-index: 3;/);
});

test('Refinement 3: map labels readable', async () => {
  const { thinArrows, ARROW_GAP, plate, placeLabels } = await import('./static/overlay.js');
  // Direction arrows are thinned by their room on screen: none within ARROW_GAP of another, the longest edges first.
  assert.equal(ARROW_GAP, 24);
  const kept = thinArrows([{ x: 0, y: 0, len: 10 }, { x: 10, y: 0, len: 50 }, { x: 40, y: 0, len: 20 }, { x: 10, y: 20, len: 5 }]);
  assert.deepEqual(kept.map((k) => k.x), [10, 40]);
  for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) assert.ok(Math.hypot(kept[i].x - kept[j].x, kept[i].y - kept[j].y) >= ARROW_GAP);
  // Every label sits on the same dark rounded plate, colored or gray.
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k === 'roundRect' || k === 'fill' || k === 'stroke' || k === 'beginPath' ? (...a) => calls.push([k, ...a]) : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
  plate(ctx, { x0: 10, x1: 60, y0: 20, y1: 35 });
  assert.deepEqual(calls.find((c) => c[0] === 'roundRect'), ['roundRect', 10, 20, 50, 15, 4]);
  const overlay = read('overlay.js');
  assert.match(overlay, /plate\(ctx, p\);/, 'the one plate behind every placed label');
  assert.match(overlay, /CTRL_OFF, MAJOR/, 'gray not-in-config controllers are labels like the rest, so they get it too');
  // A Wiring label on the map never carries the GPIO: that lives in the key, with the swatch's title, so no label is cut for it.
  assert.doesNotMatch(overlay, /label\(`\$\{controllerName\(g, o\.controller\)\} \$\{outputName\(o\)\}`/);
  assert.match(overlay, /GPIO \$\{o\.gpio\}<\/span>/);
  assert.match(overlay, /<span title="\$\{esc\(`\$\{name\} \$\{outputName\(o\)\}: /);
  // Pointing at a controller in the key picks it out: the others' runs recolor dimmer and their labels fade.
  assert.match(overlay, /async function focus\(id\)/);
  assert.match(overlay, /dimmed\(o\.controller\) \? o\.color\.map\(\(v\) => Math\.round\(v \* DIM\)\)/);
  const placed = placeLabels([{ text: 'a', x: 10, y: 10, color: '#fff', rank: 2, alpha: 0.35 }], { measure: () => 10 });
  assert.equal(placed[0].alpha, 0.35, 'a faded label keeps its fade through placement');
  const setup = read('panel/setup.js');
  assert.match(setup, /row\.onpointerenter = \(\) => pick\(true\); row\.onpointerleave = \(\) => pick\(false\);/);
  assert.match(setup, /if \(S\.coarse\) row\.onclick = \(\) => pick\(ov\.st\.focus !== id\);/);
  assert.match(css, /\.key-row\.dim \{ opacity: 0\.45; \}/);
});

test('Refinement 4: the phone footer says Replace once', async () => {
  const { swapLabel, applyPlan } = await import('./static/panel/looks.js');
  const looks = read('panel/looks.js');
  // One primary button whose label states the mode, and a text link to the other mode under it.
  assert.equal(swapLabel('replace'), 'Add instead');
  assert.equal(swapLabel('add'), 'Replace instead');
  for (const mode of ['replace', 'add']) {
    const plan = applyPlan({ n: 1, house: 1, hidden: ['Dusk'], mode });
    assert.equal([plan.label, swapLabel(mode)].filter((t) => /Replace/.test(t)).length, 1, `${mode}: one control says Replace`);
  }
  assert.equal(applyPlan({ n: 1, house: 1, hidden: ['Dusk'], mode: 'add' }).label, 'Add 1 look on top');
  assert.match(looks, /<button type="button" class="target-btn swap" id="lkSwap" hidden><\/button>/);
  assert.match(looks, /\$\$\('#lkSwap'\)\.hidden = !plan\.choice;\s*\$\$\('#lkSwap'\)\.textContent = swapLabel\(mode\);/);
  assert.match(looks, /\$\$\('#lkSwap'\)\.onclick = \(\) => \{ mode = mode === 'add' \? 'replace' : 'add'; renderStage\(\); \};/);
  // The desktop keeps its Replace/Add pair and never shows the link; the phone the reverse.
  assert.match(css, /^\.bar-main \.swap \{ display: none; \}/m);
  assert.match(css, /  \.bar-main \.seg \{ display: none; \}\n  \.bar-main \.swap \{ display: inline-block; flex: none; min-height: var\(--tap\);/);
  assert.doesNotMatch(css, /\.bar-main \{ flex-wrap: wrap/, 'the bar stays one row, so the half detent keeps its library row');
});

test('Refinement 5: a section status has its own slot', () => {
  const status = read('panel/status.js');
  assert.equal((status.match(/<h2 class="status-head">/g) || []).length, 3, 'Controllers, Runs and Power');
  assert.match(css, /\.status-head \{ display: flex; align-items: baseline; gap: 8px; \}/, 'heading and status share a baseline');
  assert.match(css, /\.status-head > small \{ margin-left: auto; min-width: 0; white-space: nowrap;/, 'right-aligned, never wrapping');
  // A phone keeps the status on its own line under the words.
  assert.match(css, /max-width: 699\.98px[^{]*\{\s*h2 small, h3 small \{ display: block;[^}]*\}\s*\.status-head \{ display: block; \}/);
});

test("Refinement 6: Calibrate's weight on Setup", () => {
  const setup = read('panel/setup.js');
  assert.match(setup, /<div class="row"><button type="button" id="suCal" class="go icon-btn"><\/button><div class="muted small" id="suCalN"><\/div><\/div>/, 'the count shares the row; the button is content width (round 2, refinement 3)');
  assert.match(setup, /classList\.toggle\('started', \(st\?\.measured \|\| 0\) >= 1\)/, 'from the first measured point');
  assert.match(css, /\.setup-cal:not\(\.started\) #suCalN \{ flex: 1 1 100%; \}/, 'at 0 measured the count takes its own line');
  assert.doesNotMatch(css, /#suCal \{ flex: none; \}/, 'no rule needed to shrink it: it was never stretched');
});

test('Refinement 7 (round 1) and 2 (round 2): the Power note is plain; the key and controllers are one disclosure away', async () => {
  const { powerSummary, SET_CURRENT, CURRENT_KEY } = await import('./static/panel/status.js');
  const name = (id) => id.toUpperCase();
  const bare = (controller, output) => ({ controller, output, known: false });
  const sentences = (s) => s.split(/(?<=\.)\s+/).length;
  const none = powerSummary({ estimate: [bare('a', 1), bare('b', 1), bare('b', 2)], controllers: [{ ma: 0, known: false }, { ma: 0, known: false }], stage: { scale: 1 } }, name);
  assert.equal(none.notSet, `Power estimate unavailable: no LED current is set for any output. ${SET_CURRENT}`);
  assert.equal(SET_CURRENT, "Set each output's LED current in the site config; Glowstack has no screen for it yet.");
  assert.doesNotMatch(none.notSet, /led_ma|max_ma|\bA\b|\bB\b/, 'the note names no config key and no controller');
  assert.equal(sentences(none.notSet), 2, 'at most two sentences');
  assert.equal(CURRENT_KEY, 'power.led_ma', 'the key is the one in the controllers config');
  assert.match(none.notSetDetail, /power\.led_ma/, 'the detail names the key');
  assert.match(none.notSetDetail, /Missing for A output 1 and B outputs 1 and 2\.$/, 'and lists the controllers and outputs');
  const partial = powerSummary({ estimate: [{ controller: 'a', output: 1, known: true }, bare('b', 1)], controllers: [{ ma: 1500, known: true }, { ma: 0, known: false }], stage: { scale: 1 } }, name);
  assert.equal(partial.notSet, `Power estimate is partial: 1 output has no LED current set. ${SET_CURRENT}`);
  assert.doesNotMatch(partial.notSet, /\bB\b|led_ma/);
  assert.match(partial.notSetDetail, /Missing for B output 1\.$/);
  const full = powerSummary({ estimate: [{ controller: 'a', output: 1, known: true }], controllers: [{ ma: 1, known: true }], stage: { scale: 1 } });
  assert.equal(full.notSet, '');
  assert.equal(full.notSetDetail, '');
  const src = read('panel/status.js');
  assert.match(src, /const notSetDetails = \(sum\) => sum\.notSetDetail \? `<details><summary>Details<\/summary><p class="plain">\$\{esc\(sum\.notSetDetail\)\}<\/p><\/details>` : ''/, 'the detail sits under a Details disclosure like the warning cards');
  assert.equal((src.match(/\$\{notSetDetails\(sum\)\}/g) || []).length, 2, 'in both the nothing-known and the partial branches');
  assert.doesNotMatch(src, /max_ma on each output/, 'the old sentence naming the wrong key is gone');
});

test('Refinement 3 (round 2): one primary-action shape per role', () => {
  // Every primary in the UI, with its context. A new one must be added here
  // with its rule: full width only in a sticky action bar.
  const primaries = [
    { file: 'panel/looks.js', re: /<button type="button" class="go icon-btn" id="lkPushAll">/, bar: '.bar-main' },
    { file: 'panel/calibrate.js', re: /<div class="cal-confirm"><button type="button" class="go icon-btn" id="caConfirm"/, bar: '.cal-confirm' },
    { file: 'panel/presets.js', re: /<button type="button" id="prSave" class="go icon-btn">\$\{icon\('check'\)\}Save preset<\/button>/, bar: '.editor-actions' },
    { file: 'panel/setup.js', re: /<button type="button" id="suCal" class="go icon-btn">/, bar: null },
    { file: 'panel/calibrate.js', re: /'Start calibrating'\}`, \(\) => session\.start\([^)]*\)[^,]*, 'go icon-btn'\)/, bar: null },
    { file: 'states.js', re: /<button type="button" class="go" id="\$\{esc\(action\.id\)\}">/, bar: null },
    { file: 'dialog.js', re: /<button value="yes" class="\$\{danger \? 'danger' : 'go'\}">/, bar: null },
  ];
  for (const p of primaries) assert.match(read(p.file), p.re, `${p.file}: ${p.re}`);
  // No other primary exists.
  const all = ['panel/looks.js', 'panel/calibrate.js', 'panel/presets.js', 'panel/setup.js', 'panel/status.js', 'states.js', 'dialog.js', 'app.js', 'sheet.js', 'form.js'].map((f) => read(f)).join('\n');
  assert.equal((all.match(/class="go\b|class="\$\{danger \? 'danger' : 'go'\}"|'go icon-btn'|'go'/g) || []).length, primaries.length, 'every primary is in the list above');
  assert.doesNotMatch(all, /go grow/, 'an inline primary is never stretched');
  // The three action bars stretch theirs; nothing else does.
  for (const bar of ['.bar-main', '.cal-confirm', '.editor-actions']) assert.match(css, new RegExp(`\\${bar} \\.go \\{ flex: 1`), `${bar} stretches its primary`);
  assert.equal((css.match(/\.go \{ flex: 1/g) || []).length, 4, 'those three, plus the phone block repeating the Looks footer rule');
  assert.match(css, /\.editor-actions \{ position: sticky/);
  assert.match(css, /\.look-bar \{[^}]*position: sticky/);
  // Labels: a verb first, sentence case.
  for (const label of ['Create a preset', 'Save preset', 'Confirm', 'Start calibrating', 'Change effect']) assert.match(all, new RegExp(label));
  assert.doesNotMatch(all, /label: 'New preset'/, 'the empty-state primary is verb first');
  // The rule is written down.
  const design = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'design.md'), 'utf8');
  assert.match(design, /\*\*Primary actions\.\*\* One shape per role\. A primary \(the green `\.go`\s+button\) is full width only in a sticky action bar/);
  assert.match(design, /Labels are a verb first in sentence case/);
});

test('Refinement 4 (round 2): the chip names what is on the lights, with weight', async () => {
  const { mapStatus, badgeHTML, litWords, zonesPhrase, NAMES_SHOWN } = await import('./static/map-status.js');
  const base = { connected: true, show: '', target: false, preview: { previewing: false }, lit: { dark: '', zones: [], ids: [], message: '' } };
  const two = mapStatus({ ...base, looks: ['Lantern', 'Porch glitter'], levels: [1, 1, 1, 1] });
  assert.equal(two.text, 'Lantern, Porch glitter on the lights');
  assert.equal(two.detail, ' · 4 zones at 100%');
  assert.equal(two.cls, 'house');
  assert.equal(two.short, '2 looks on the lights', 'the phone says the state and the count');
  assert.equal(badgeHTML(two), '<span><b>Lantern, Porch glitter</b> on the lights<span class="detail"> · 4 zones at 100%</span></span>', 'names in weight, the state word plain');
  assert.equal(badgeHTML(two, true), '<span class="stack"><span>2 looks on the lights</span><span class="detail">4 zones at 100%</span></span>');
  // Two names, then a count.
  assert.equal(NAMES_SHOWN, 2);
  assert.equal(litWords(['A', 'B', 'C', 'D'], [1]).names, 'A, B, +2 more');
  assert.equal(litWords(['Solo'], null).text, 'Solo on the lights');
  assert.equal(litWords(['Solo'], null).short, '1 look on the lights');
  assert.equal(litWords(['Solo'], null).detail, '', 'no reading, no level');
  // Levels: one figure when the zones agree, a range when not, zones at 0 left out.
  assert.equal(zonesPhrase([1, 1]), '2 zones at 100%');
  assert.equal(zonesPhrase([0.5, 1, 0]), '2 zones at 50–100%');
  assert.equal(zonesPhrase([0, 0]), '');
  assert.equal(zonesPhrase(null), '');
  // A hidden preview is still said; nothing on the lights reads as before.
  assert.equal(mapStatus({ ...base, preview: { previewing: true }, show: 'house', looks: ['Lantern'], levels: [1] }).detail, ' · 1 zone at 100% · preview hidden');
  assert.equal(mapStatus(base).text, 'Showing the lights');
  assert.equal(mapStatus({ ...base, lit: { dark: 'none', zones: ['Yard'], ids: ['a'], message: 'x' }, looks: ['Lantern'], levels: [0] }).text, 'Lights: dark', 'dark zones come first');
  // The chip is body size; the state word is in the text color, the green on the rim.
  assert.match(css, /\.badge \{[^}]*font-size: var\(--t-m\)/);
  assert.match(css, /\.badge\.house \{ color: var\(--fg\); border-color: #24543a; \}/);
  assert.match(css, /  \.badge \{ max-width: calc\(100% - 204px\); font-size: var\(--t-meta\); \}/, 'the phone chip has the room for its longest first line at 14 px');
  assert.match(css, /\.badge b \{ font-weight: 600; \}/);
  // Wired from the stack and the brightness reading; no control in the chip.
  const app = read('app.js');
  assert.match(app, /looks: S\.house\.filter\(\(l\) => !l\.ephemeral\)\.map\(\(l\) => layerName\(S, l\)\)/);
  assert.match(app, /levels: S\.statusData\?\.brightness && S\.geo\?\.zones \? S\.geo\.zones\.map\(\(z\) => S\.statusData\.brightness\.zones\?\.\[z\.id\] \?\? 1\) : null/);
  assert.match(app, /S\.on\('house', badge\)/, 'redrawn when the stack changes');
  assert.doesNotMatch(read('index.html'), /<span id="badge"[^>]*>[^<]*<(input|button)/, 'nothing in the chip is a slider or a button');
});

test('Refinement 5 (round 2): a denser desktop library and compact preset rows', () => {
  // Looks: three columns at the 580 px pane (no four), spacing of 6 and 4 so a fourth row fits at 1440x900.
  assert.match(css, /@media \(min-width: 1280px\) \{ \.cards \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
  assert.doesNotMatch(css, /\.cards[^{]*\{[^}]*repeat\(4, minmax/, 'no four-column library grid (Status\'s tile row is four across by design)');
  assert.match(css, /\.cards \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(132px, 1fr\)\); gap: 6px; \}/);
  assert.match(css, /\.stage \{ margin: 0 0 6px;/);
  assert.match(css, /\.catalog-head \{[^}]*margin: 4px 0 4px; \}/);
  assert.match(css, /\.lib-filters \{[^}]*margin: 0 0 4px; \}/);
  // Presets: on a fine pointer the row is one line. Round 3 put the words back on its buttons.
  const fine = css.slice(css.indexOf('@media (pointer: fine) {'));
  assert.match(fine, /html:not\(\.coarse\) \.preset-entry \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; align-items: center;/);
  assert.doesNotMatch(css, /\.preset-actions \.lbl \{[^}]*(clip|display: none)/, 'the words show at rest on every pointer');
  assert.match(css, /\.preset-actions \[data-act=more\] \{ width: var\(--tap\); min-width: var\(--tap\); padding: 0; \}/);
  const src = read('panel/presets.js');
  assert.match(src, /data-act="pin"[^>]*aria-label="\$\{esc\(\(p\.pinned \? 'Unpin ' : 'Pin '\) \+ presetName\(p\)\)\}" title="\$\{p\.pinned \? 'Unpin from Looks' : 'Pin to Looks'\}"/, 'Pin has a title and an aria-label');
  assert.match(src, /<span class="lbl">\$\{p\.pinned \? 'Pinned' : 'Pin'\}<\/span>/);
  assert.match(src, /data-act="more"[^>]*aria-label="\$\{esc\(`More for \$\{presetName\(p\)\}`\)\}" title="More: edit, duplicate or delete">\$\{icon\('more'\)\}<\/button>/);
  assert.match(src, /b\.innerHTML = `\$\{icon\('eye'\)\}<span class="lbl">\$\{on \? 'Previewing' : 'Preview'\}<\/span>`;\s*b\.setAttribute\('aria-label', on \? 'Previewing' : 'Preview'\);/);
  assert.match(src, /row\.querySelector\('\[data-act=try\]'\)\.onclick = row\.querySelector\('\.preset-body'\)\.onclick/, 'the row body previews');
});

test('Refinement 6 (round 2): Status leads with four tiles; the warnings stay beneath in amber', async () => {
  const { litCount, tileFacts } = await import('./static/panel/status.js');
  const { minusCount } = await import('./static/util.js');
  assert.equal(minusCount([[0, 9], [20, 29]], [[5, 24]]), 10, 'pixels of a not in b');
  assert.equal(minusCount([[0, 9]], []), 10);
  assert.equal(minusCount([[0, 9]], [[0, 9]]), 0);
  const g = { areas: [{ id: 'a', ranges: [[0, 9]] }, { id: 'b', ranges: [[10, 19]] }], zones: [{ id: 'a', area: 'a' }, { id: 'b', area: 'b' }] };
  assert.equal(litCount(g, { brightness: { master: 1, zones: { a: 1, b: 0 } } }, [[[0, 19]]]), 10, 'the dark zone is not lit');
  assert.equal(litCount(g, { brightness: { master: 1, zones: { a: 1, b: 1 } } }, [[[0, 4]], [[2, 7]]]), 8, 'overlaps count once');
  assert.equal(litCount(g, { brightness: { master: 0, zones: {} } }, [[[0, 19]]]), 0);
  assert.equal(litCount(g, {}, null), null, 'layers not read yet');
  const health = { up: 1, n: 2, cls: 'bad', text: "Controllers: 1 isn't reachable" };
  const facts = tileFacts({ lit: 10, total: 20, health, late: 0, fps: { measured: 40.02, target: 40 }, power: { overall: '1.08 A', limiting: 'None needed', partial: false, anyKnown: true } });
  assert.deepEqual(facts.map((f) => [f.v, f.label, f.cls]), [['10', 'lights lit', 'warn'], ['1 of 2', 'controllers', 'bad'], ['0', 'late frames', ''], ['1.08 A', 'power estimate', '']]);
  assert.equal(facts[3].power, true, 'the power tile links to the Power section');
  const full = tileFacts({ lit: 20, total: 20, health: { up: 2, n: 2, cls: 'ok', text: '' }, late: 3, fps: { measured: 39, target: 40 }, power: null });
  assert.deepEqual(full.map((f) => [f.v, f.cls]), [['20', 'ok'], ['2 of 2', 'ok'], ['3', 'warn'], ['—', '']]);
  const notSet = tileFacts({ lit: 0, total: 0, health: { up: 2, n: 2, cls: 'ok', text: '' }, late: 0, fps: { measured: 40, target: 40 }, power: { overall: 'Unknown', limiting: 'Unknown', partial: false, anyKnown: false } });
  assert.equal(notSet[0].cls, '', 'nothing on the lights is not a warning');
  assert.deepEqual([notSet[3].v, notSet[3].cls], ['Not set', '']);
  assert.match(notSet[3].title, /Opens the Power note/);
  assert.equal(tileFacts({ lit: null, total: 0, health: { up: 0, n: 2, cls: '', text: '' }, late: 0, fps: { measured: 0, target: 40 }, power: null })[0].v, '—');
  // Markup and wiring: tiles first, the verdict (with its warning count) and the warnings beneath.
  const status = read('panel/status.js');
  assert.ok(status.indexOf('id="stTiles"') < status.indexOf('id="stVerdict"') && status.indexOf('id="stVerdict"') < status.indexOf('id="stIssues"'), 'tiles, verdict, warnings');
  assert.match(status, /lastPower = pw;\s*if \(last\) renderTiles\(last\);/, 'the power reading redraws the tiles');
  assert.match(status, /f\.power \? ' type="button" id="stPowerTile"' : ''/);
  assert.match(status, /\$\$\('#stHealth'\)\.hidden = !readAt;/, 'the plain health line only when the reading is stale: the tile says it otherwise');
  assert.match(status, /const byFault = \[\.\.\.g\.controllers\]\.sort\(\(a, b\) => \(healthOf\(st\.health, a\.id\)\?\.reachable === false \? 0 : 1\) - \(healthOf\(st\.health, b\.id\)\?\.reachable === false \? 0 : 1\)\);/, 'an unreachable controller sorts first');
  assert.match(css, /\.tiles \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); grid-auto-rows: 1fr; gap: 6px; margin: 0 0 10px; \}/);
  assert.match(css, /\.tiles \.stat\.bad b \{ color: #fca5a5; \}\s*\.tiles \.stat\.warn b \{ color: var\(--warn\); \}/, 'state colors on the figure');
  const phone = css.slice(css.indexOf('@media (max-width: 699.98px)'));
  assert.match(phone, /\.tiles \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/, 'two by two on a phone');
  assert.match(css, /\.verdict\.warn \{ color: var\(--warn\); \}/, 'the warning beneath stays amber');
});

test('Refinement 7 (round 2): a designed loading state, painted before the script runs', async () => {
  const { skeletonHTML } = await import('./static/states.js');
  const html = read('index.html');
  // The shell is static: dark page, brand, chip, tab bar with its icons, the map's loading card.
  assert.match(html, /<meta name="theme-color" content="#0d0e10">/);
  assert.match(html, /<div id="bootLoading" class="state loading boot-loading" role="status">[^<]*<span class="spinner" aria-hidden="true"><\/span><div class="state-text"><b>Loading Glowstack…<\/b>/);
  assert.match(html, /<div class="tabs" role="tablist">\s*<button type="button" role="tab" data-tab="looks" title="Looks"><span class="ico" data-icon="looks"><svg/);
  // The Looks skeleton is in the HTML, verbatim the same as the helper's, so the first paint has it.
  const looks = skeletonHTML('looks');
  assert.ok(html.includes(`<section id="tab-looks" class="tab" role="tabpanel">${looks}</section>`), 'index.html carries skeletonHTML(\'looks\')');
  assert.match(looks, /^<div class="skeleton" role="status" aria-busy="true" aria-label="Loading Looks…">/);
  assert.equal((looks.match(/<div class="preset skel-card">/g) || []).length, 6, 'two rows of three cards at the wide panel');
  for (const cls of ['looks-head', 'stage skel-stage', 'lib-filters', 'cards']) assert.ok(looks.includes(`class="${cls}"`), `${cls}: the real layout's classes, so the columns follow the same rules`);
  assert.doesNotMatch(looks, /Loading Looks…<\/b>|spinner/, 'shapes, not a sentence card');
  assert.match(skeletonHTML('presets'), /class="preset-entry skel-card"/);
  assert.match(skeletonHTML('status'), /class="tiles"/);
  assert.match(skeletonHTML('setup'), /aria-label="Loading Setup…"/);
  // The script fills the other tabs the same way, before its first wait.
  const app = read('app.js');
  assert.match(app, /function showLoadingTabs\(\) \{\s*for \(const id of \['looks', 'presets', 'setup', 'status'\]\) \$\('tab-' \+ id\)\.innerHTML = skeletonHTML\(id\);/);
  assert.doesNotMatch(app, /title: `Loading \$\{name\}…`/);
  // Still shapes: no animation, so nothing to exempt for reduced motion.
  const skel = css.slice(css.indexOf('.skel {'), css.indexOf('.skeleton .stage'));
  assert.doesNotMatch(skel, /animation/);
  assert.match(css, /\.skel-stage \{ min-height: 132px;/, 'the stage block is the size of the common first state');
  assert.match(css, /\.skel-tile \{ height: 80px;/, 'a tile\'s height');
});

test('B138: the compact state card never cuts its own words', async () => {
  const { stageSub, compactStage, subBelow } = await import('./static/panel/looks.js');
  // The half sheet's first-use hint is short and complete, with the lights' rule in it.
  assert.equal(stageSub({ rows: 0, stale: false, word: 'Tap', compact: true }), 'Tap a look to preview it. The lights change only when you put it on them.');
  assert.equal(stageSub({ rows: 0, stale: false, word: 'Tap' }), "Tap a look below to preview it on the map; the lights don't change.", 'the full sheet keeps the long one');
  assert.equal(stageSub({ rows: 1, stale: false, word: 'Tap', compact: true }), '');
  assert.equal(compactStage({ title: 'Nothing on the lights', sub: 'Tap a look to preview it. The lights change only when you put it on them.', preview: 0, live: 0 }).sub, 'tap a look to preview it. The lights change only when you put it on them.');
  // The sub takes its own line when it does not fit whole beside the state; an empty sub never does.
  assert.equal(subBelow('replaces Lantern and Porch glitter', 240, 120), true);
  assert.equal(subBelow('replaces Lantern', 100, 120), false);
  assert.equal(subBelow('', 10, 0), false);
  const looks = read('panel/looks.js');
  assert.match(looks, /stageSub\(\{[^}]*compact: compact\(\)/, 'the compact header asks for the short hint');
  assert.match(looks, /if \(subBelow\(sub\.textContent, sub\.scrollWidth, sub\.clientWidth\) \|\| \(sub\.textContent && sub\.offsetTop > \$\$\('#lkStageTitle'\)\.offsetTop \+ 4\)\) head\.classList\.add\('sub-below'\)/);
  assert.match(looks, /renderBar\(prev\);\s*fitStageHead\(\);/, 'measured after the bar may have set the sub');
  assert.match(looks, /fitControls\(c\); fitStageHead\(\); fitDark\(\); \}\)\.observe/, 'refits on a resize');
  const phone = css.slice(css.indexOf('@media (max-width: 699.98px) and (orientation: portrait)'));
  const sub = /body\[data-detent=half\] \.stage-head > small \{([^}]*)\}/.exec(phone)[1];
  assert.doesNotMatch(sub, /text-overflow/, 'no ellipsis on the compact header');
  assert.match(phone, /body\[data-detent=half\] \.stage-head\.sub-below > small \{ display: block; flex: 0 0 100%; order: 3; white-space: normal; overflow: visible;/);
  assert.match(phone, /body\[data-detent=half\] \.stage-head\.sub-below > small::before \{ content: none; \}/, 'no dot at the start of its own line');
  assert.match(phone, /body\[data-detent=half\] \.stage-head\.sub-below > small::first-letter \{ text-transform: uppercase; \}/, 'a line of its own starts with a capital');
});

test('B139: a sprite shows the whole look, a show asks for none, and a dark sprite gives way to the drawn strip', async () => {
  const { spriteURL, spriteStyle, splitLayers, spriteLit, guardSprite, DARK, SPRITE_REV } = await import('./static/tiles.js');
  // The catalog marks a show; its tile keeps the drawn strip and never asks for a 404.
  assert.equal(spriteURL('preset', 'evening-show', {}, { id: 'evening', show: true }), '');
  assert.equal(spriteURL('effect', 'evening', null, { id: 'evening', show: true }), '');
  assert.equal(spriteURL('effect', 'chase', null, { id: 'chase' }), '/api/v1/effects/chase/strip.png?r=3');
  assert.equal(SPRITE_REV, 3, 'the renderer draws a sparse look denser for its swatch now (B3); old cached sprites are not shown');
  const bare = spriteStyle('', 'linear-gradient(90deg, red, blue)');
  assert.match(bare, /^background-image: linear-gradient\(90deg, red, blue\);/);
  assert.doesNotMatch(bare, /url\(/);
  // Sparkle's drawn strip is specks over a color. The color is not an image layer (it voided the
  // whole declaration, a black tile): it is the background color under the layers.
  const specks = 'linear-gradient(90deg, #0b0d10 0 7%, transparent 7% 9%, #0b0d10 9% 100%), rgb(255,255,255)';
  const sparkle = spriteStyle('/api/v1/effects/sparkle/strip.png?r=2', specks);
  assert.match(sparkle, /^background-image: linear-gradient\(to bottom, [^;]*\), url\(\/api\/v1\/effects\/sparkle\/strip\.png\?r=2\), linear-gradient\(90deg, #0b0d10 0 7%, transparent 7% 9%, #0b0d10 9% 100%\); /);
  assert.match(sparkle, /; background-color: rgb\(255,255,255\)$/);
  assert.deepEqual(splitLayers(specks), ['linear-gradient(90deg, #0b0d10 0 7%, transparent 7% 9%, #0b0d10 9% 100%)', 'rgb(255,255,255)']);
  assert.doesNotMatch(spriteStyle('/x.png', 'rgb(1,2,3)'), /background-color/, 'a strip of one color is a flat layer, as before');
  assert.equal(DARK, 8);
  // A black bar is not a picture, nor is a stray dot; a sparse sparkle is.
  const dark = new Uint8ClampedArray(60 * 30 * 4);
  assert.equal(spriteLit(dark, 60, 30), false);
  dark[(5 * 60 + 10) * 4] = 200;
  assert.equal(spriteLit(dark, 60, 30), false, 'one lit pixel in 30 frames is nothing');
  for (let k = 0; k < 30; k += 2) dark[(k * 60 + 10) * 4] = 200;
  assert.equal(spriteLit(dark, 60, 30), true, 'a sparkle every other frame shows');
  // Without an Image (node), the guard leaves the tile alone; with a sprite URL of none it does nothing.
  const el = { style: { cssText: 'x' } };
  guardSprite(el, '', 'red'); guardSprite(el, '/x.png', 'red');
  assert.equal(el.style.cssText, 'x');
  const looks = read('panel/looks.js'), presets = read('panel/presets.js');
  assert.match(looks, /spriteURL\('preset', p\.id, p\.params, e\)/, 'a preset card knows its effect, so a show gets no sprite');
  assert.match(looks, /spriteURL\('effect', e\.id, null, e\)/);
  assert.match(looks, /guardSprite\(b\.querySelector\('\.swatch'\), sprite, strip\)/);
  assert.match(presets, /guardSprite\(row\.querySelector\('\.swatch'\), sprite, drawn\)/);
});

test('B140: a preview row and a live row share one layout', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 699.98px) and (orientation: portrait)'));
  // The badge is one width in every row: Preview's. So a name's column is the same width whichever
  // row it is in, and the one-line rule turns at the same name length.
  assert.match(phone, /\.layer \.name-line \.kind \{ min-width: 5\.1em; text-align: center; box-sizing: border-box; \}/);
  // The preview row is told apart by its badge color and a faint tint, not by a different layout.
  assert.match(phone, /\.layer\.preview \{ background: rgba\(182, 156, 255, 0\.07\);/);
  assert.doesNotMatch(phone, /\.layer\.preview \.name-line \{/, 'no preview-only grid');
  assert.doesNotMatch(phone, /\.layer\.preview \.name-line b \{/, 'no preview-only name rule');
  const looks = read('panel/looks.js');
  assert.match(looks, /el\.classList\.remove\('tight', 'two-line'\);/, 'one fit for both lanes');
  assert.doesNotMatch(looks, /lane === 'preview'[^\n]*two-line/, 'the two-line rule does not look at the lane');
});

test('A2: the half sheet keeps the Library in reach while previewing; the search grows to the row; Presets keeps its sentence', async () => {
  const { liveSummary, liveNames, fitText, liveFold } = await import('./static/panel/looks.js');
  const { textField, searching } = await import('./static/field.js');
  // One line for the live rows while a preview is present on the half sheet; the chevron opens them in place.
  assert.equal(liveSummary([{ name: 'Lantern' }, { name: 'Porch glitter' }], (l) => l.name), '2 looks on the lights · Lantern, Porch glitter');
  assert.equal(liveSummary([{ name: 'Lantern' }], (l) => l.name), '1 look on the lights · Lantern');
  assert.equal(liveSummary([], (l) => l.name), '');
  // The words shown fit the line whole: two names, then one, then the count and state word (round 2:
  // the sentence itself was cut at 390 px). The whole sentence stays as the button's accessible name.
  const three = [{ name: 'Lantern' }, { name: 'Porch glitter' }, { name: 'Candy' }];
  assert.equal(liveNames(three, (l) => l.name), '3 looks: Lantern, Porch glitter, +1 more');
  assert.equal(liveNames(three, (l) => l.name, 1), '3 looks: Lantern, +2 more');
  assert.equal(liveNames(three, (l) => l.name, 0), '3 looks on the lights');
  assert.equal(liveNames([{ name: 'Lantern' }], (l) => l.name), '1 look: Lantern');
  assert.equal(liveNames([], (l) => l.name), '');
  const box = { textContent: '', clientWidth: 100, get scrollWidth() { return this.textContent.length * 10; } };
  assert.equal(fitText(box, ['twelve chars', 'ten chars!', 'short']), 'ten chars!', 'the first candidate that fits');
  assert.equal(fitText(box, ['far too long a line']), 'far too long a line', 'or the last');
  const looksSrc = read('panel/looks.js');
  assert.match(looksSrc, /sum\.setAttribute\('aria-label', liveSummary\(house, nameOf\)\);\s*fitText\(sum\.querySelector\('\.text'\), \[2, 1, 0\]\.map\(\(shown\) => liveNames\(house, nameOf, shown\)\)\);/);
  assert.deepEqual(liveFold({ compact: true, preview: 1, live: 2, open: false }), { summary: true, folded: true });
  assert.deepEqual(liveFold({ compact: true, preview: 1, live: 2, open: true }), { summary: true, folded: false }, 'opened in place: the summary stays, the rows show');
  assert.deepEqual(liveFold({ compact: true, preview: 0, live: 2, open: false }), { summary: false, folded: false }, 'no preview: every row');
  assert.deepEqual(liveFold({ compact: false, preview: 1, live: 2, open: false }), { summary: false, folded: false }, 'the full sheet shows every row');
  const looks = read('panel/looks.js');
  assert.match(looks, /<button type="button" class="live-sum" id="lkLiveSum" aria-expanded="false" hidden><small class="kind">Live<\/small><span class="text"><\/span>\$\{icon\('chevronDown'\)\}<\/button>/);
  assert.match(looks, /liveFold\(\{ compact: compact\(\), preview: prev\.length, live: house\.length, open: liveOpen \}\)/);
  assert.match(looks, /\$\$\('#lkLiveSum'\)\.onclick = \(\) => \{ liveOpen = !liveOpen; renderStage\(\); \};/);
  const phone = css.slice(css.indexOf('@media (max-width: 699.98px) and (orientation: portrait)'));
  assert.match(phone, /body\[data-detent=half\] #lkRows\.live-folded \.layer\.house \{ display: none; \}/);
  assert.match(phone, /body\[data-detent=half\] \.live-sum \{ display: grid; \}/);
  assert.match(css, /\.live-sum \{ display: none;/, 'the summary is the half sheet\'s');
  // The search: in use when focused or holding a query; then it takes the row and the other segments
  // slide out, the chosen one staying with its icon and word.
  assert.equal(searching(true, ''), true);
  assert.equal(searching(false, 'glit'), true);
  assert.equal(searching(false, '  '), false);
  assert.match(textField({ label: 'Find a look', id: 'lkFind', type: 'search', clearable: true }), /<label class="field clearable"><span class="lbl">Find a look<\/span><input [^>]*><button type="button" class="field-clear" id="lkFindClear" aria-label="Clear Find a look" hidden>×<\/button>/);
  assert.doesNotMatch(textField({ label: 'Name', id: 'x' }), /field-clear/);
  assert.match(looks, /wireClear\(\$\$\('#lkFind'\), renderCatalog, document\.getElementById\('content'\)\)/, 'clearing restores the panel\'s scroll');
  assert.match(looks, /<button type="button" data-filter="pinned">\$\{icon\('pin'\)\}<span>Pinned<\/span><\/button><button type="button" data-filter="presets">\$\{icon\('presets'\)\}<span>All presets<\/span><\/button><button type="button" data-filter="effects">\$\{icon\('looks'\)\}<span>Effects<\/span><\/button>/);
  assert.match(css, /\.lib-filters \.seg > button > \.icon \{ display: none; \}/, 'icons only while searching on the half sheet');
  // Round 3: the same growth at every detent of the sheet, not only the half.
  assert.match(phone, /body\[data-detent\] \.lib-filters \.field\.searching \{ flex: 1 1 100%; \}/);
  assert.match(phone, /body\[data-detent\] \.lib-filters:has\(\.field\.searching\) \.seg > button:not\(\.on\) \{ display: none; \}/);
  assert.match(phone, /body\[data-detent\] \.lib-filters:has\(\.field\.searching\) \.seg > button\.on > \.icon \{ display: block; \}/);
  assert.match(css, /\.field-clear \{ position: absolute; right: 2px;/);
  assert.match(css, /input\[type=search\]::-webkit-search-cancel-button \{ display: none;/, 'not two clear buttons: the browser\'s is off');
  const field = read('field.js');
  assert.match(field, /if \(input\.value && before === null && scroller\) before = scroller\.scrollTop;/, 'the scroll is kept from the query\'s first character');
  assert.match(field, /if \(scroller && before !== null\) scroller\.scrollTop = before;/);
  // Presets' compact header: one short sentence, whole, where the intro was.
  assert.match(read('panel/presets.js'), /<p class="muted small tab-intro-compact">Saved looks\. Pin one to show it on Looks\.<\/p>/);
  assert.match(css, /\.tab-intro-compact \{ display: none; \}/);
  assert.match(phone, /body\[data-detent=half\] \.tab-intro-compact \{ display: block;/);
  assert.doesNotMatch(/body\[data-detent=half\] \.tab-intro-compact \{[^}]*\}/.exec(phone)[0], /ellipsis|nowrap/);
});

test('B2: tiles keep moving behind a preview and rest on a lit frame', async () => {
  const { tileState, rateOf, createTiles, FPS, SLOW_FPS, MID } = await import('./static/tiles.js');
  assert.equal(SLOW_FPS, 5);
  assert.equal(rateOf('running'), FPS); assert.equal(rateOf('slow'), SLOW_FPS); assert.equal(rateOf('paused'), 0); assert.equal(rateOf('still'), 0);
  // The full pause is for off-screen tiles and a hidden page; reduced motion holds the resting frame.
  assert.equal(tileState({ reduced: false, hidden: false, visible: false, previewing: true }), 'paused');
  assert.equal(tileState({ reduced: true, hidden: false, visible: true, previewing: true }), 'still');
  // The clock changes rate with the state, without losing its place.
  const handlers = {};
  const S = { preview: { layers: [{}] }, on: (ev, fn) => { handlers[ev] = fn; } };
  const box = { style: { vars: {}, setProperty(k, v) { this.vars[k] = v; } } };
  const doc = { hidden: false, addEventListener() {} };
  const tiles = createTiles(S, doc);
  tiles.watch(box);
  assert.equal(tiles.state(), 'slow'); assert.equal(tiles.rate(), SLOW_FPS);
  await new Promise((r) => setTimeout(r, 1000 / SLOW_FPS * 2.5));
  assert.ok(box.style.vars['--tile-row'] !== MID, 'it stepped behind the preview');
  S.preview = null; handlers.preview();
  assert.equal(tiles.rate(), FPS);
  doc.hidden = true; handlers.preview();
  assert.equal(tiles.rate(), 0);
  // The resting frame is the server's: the sprite's fullest row sits at MID (api/strip.go restFrame).
  const strip = fs.readFileSync(path.join(__dirname, '..', 'api', 'strip.go'), 'utf8');
  assert.match(strip, /const StripRest = StripFrames \/ 2/);
  assert.match(strip, /restFrame\(img\)/);
  assert.equal(MID, 15);
  // Round 3 (B3) dropped the "Effect ·" prefix: the swatch and the Effects segment say it.
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /kindMark|kind-mark/);
  assert.match(looks, /`Preview \$\{name\} here`, spriteURL\('preset', p\.id, p\.params, e\)\)/);
  assert.doesNotMatch(css, /kind-mark/);
  const { MOTION } = await import('./static/tiles.js');
  for (const [id, words] of Object.entries(MOTION)) assert.ok(words.length <= 25, `${id}: "${words}" is cut on a card`);
});

test('D: the preview has no clock controls; the room went to the Library', () => {
  const looks = read('panel/looks.js'), app = read('app.js');
  for (const word of [/clock/i, /scrub/i, /lkPlay|lkBack|lkFwd|lkSpeed|lkLive\b/, /togglePause/, /'pause'|'resume'|'seek'|'step'/]) {
    assert.doesNotMatch(looks, word, `looks.js: ${word}`);
  }
  assert.doesNotMatch(app, /togglePause|e\.key === ' '/, 'Space does nothing to the preview');
  assert.doesNotMatch(css, /clock|step-pair/, 'no clock styles');
  assert.doesNotMatch(read('sheet.js'), /keepsPlace|quietOpen/, 'nothing asks to open quietly any more');
  assert.doesNotMatch(looks, /data-quiet-open/);
  const design = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'design.md'), 'utf8');
  assert.doesNotMatch(design, /\*\*Time control\*\*/);
  assert.doesNotMatch(design, /Space\s+pauses or resumes the preview clock/);
});

test('Refinement 1 (round 2): a toggle pill says off as well as on', () => {
  // The leading mark (round 3: a box, not round 2's dot): empty when off, checked when on; drawn, so nothing is read out.
  assert.match(css, /\.chips\.toggles > button::before \{ content: ''; flex: none; width: var\(--box\); height: var\(--box\); box-sizing: border-box; border: 1\.5px solid var\(--control-line\); border-radius: 4px; background: var\(--field\); \}/);
  assert.match(css, /\.chips\.toggles > button\.on::before \{ background: var\(--accent\) var\(--check\) center \/ 82% no-repeat; border-color: var\(--accent\); \}/);
  // Every toggle pill exposes aria-pressed from its first paint, and press() keeps it right.
  const setup = read('panel/setup.js');
  for (const id of ['suNodes', 'suLabels', 'suControllers', 'suEven']) assert.match(setup, new RegExp(`<button type="button" id="${id}" aria-pressed="false"`), id);
  assert.match(setup, /press\(b, l\.visible\);\s*b\.textContent = modelPartLabel/, 'model part pills are pressed on creation');
  assert.match(read('util.js'), /b\.setAttribute\('aria-pressed', on \? 'true' : 'false'\)/);
  // The plain Hide key / Show key button is not a toggle pill: no dot.
  assert.match(setup, /className: 'legend-toggle', textContent: folded \? 'Show key' : 'Hide key'/);
  assert.doesNotMatch(css, /\.legend-toggle[^{]*::before/);
  assert.doesNotMatch(setup, /legend-toggle[^\n]*chips/);
  // Segmented bars are untouched.
  assert.doesNotMatch(css, /\.seg > button::before/);
});
