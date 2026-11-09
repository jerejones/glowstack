// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for the page's chrome: the map status, styles and sheet. Run with:
// node --test internal/mapview/chrome_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const css = fs.readFileSync(path.join(__dirname, 'static/ui.css'), 'utf8');

test('map status never disagrees with its toggle', async () => {
  const { mapStatus } = await import('./static/map-status.js');
  const live = { connected: true, target: false };
  const none = mapStatus({ ...live, show: '', preview: { previewing: false } });
  assert.equal(none.showing, 'lights', 'Preview must not be pressed with nothing previewing');
  assert.equal(none.canPreview, false);
  assert.equal(none.text + none.detail, 'Showing the lights · nothing in preview');
  const on = mapStatus({ ...live, show: '', preview: { previewing: true } });
  assert.equal(on.showing, 'preview');
  assert.equal(on.text, 'Showing your preview');
  const hidden = mapStatus({ ...live, show: 'house', preview: { previewing: true } });
  assert.equal(hidden.showing, 'lights');
  assert.equal(hidden.detail, ' · preview hidden');
  assert.equal(mapStatus({ ...live, show: '', preview: null }).showing, 'lights');
  assert.equal(mapStatus({ connected: false, show: '', preview: null }).cls, 'off');
});

test('.err is styled wherever it appears', () => {
  assert.match(css, /(^|\n|, )\.err[ ,][^{]*\{[^}]*color:/);
  assert.doesNotMatch(css, /\.form \.err/);
});

test('search shares the input rule and placeholders are readable', () => {
  assert.match(css, /input\[type=search\],[^{]*\{[^}]*background/);
  assert.match(css, /::placeholder \{ color: var\(--muted\); opacity: 1; \}/);
});

test('counts are pluralized', async () => {
  const { plural } = await import('./static/util.js');
  assert.equal(plural(1, 'output'), '1 output');
  assert.equal(plural(2, 'output'), '2 outputs');
  assert.equal(plural(0, 'output'), '0 outputs');
  for (const f of ['panel/status.js', 'panel/setup.js', 'panel/calibrate.js']) {
    const src = fs.readFileSync(path.join(__dirname, 'static', f), 'utf8');
    assert.doesNotMatch(src, /\.length\} outputs|\$\{g\.runs\.length\} runs|\$\{st\.anchors\} anchors/, f);
  }
});

test('dragging the sheet cannot select text', async () => {
  const { guardSelection } = await import('./static/sheet.js');
  let handler, dragging = false, prevented = 0;
  guardSelection({ addEventListener: (type, fn) => { assert.equal(type, 'selectstart'); handler = fn; } }, () => dragging);
  handler({ preventDefault: () => prevented++ });
  assert.equal(prevented, 0, 'selection works normally away from a drag');
  dragging = true;
  handler({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.match(css, /\.handle, \.tabs \{ user-select: none/);
});

// contrast is the WCAG ratio between two #rrggbb colors.
function contrast(a, b) {
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const token = (name) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(css)[1];

test('the palette passes AA, including the primary action in every state', () => {
  for (const name of ['go', 'go-hover', 'go-active']) assert.ok(contrast('#ffffff', token(name)) >= 4.5, name);
  for (const bg of ['bg', 'card', 'card2']) {
    assert.ok(contrast(token('fg'), token(bg)) >= 4.5, 'fg on ' + bg);
    assert.ok(contrast(token('muted'), token(bg)) >= 4.5, 'muted on ' + bg);
    assert.ok(contrast(token('preview'), token(bg)) >= 4.5, 'preview on ' + bg);
    assert.ok(contrast(token('house'), token(bg)) >= 4.5, 'house on ' + bg);
    assert.ok(contrast('#fca5a5', token(bg)) >= 4.5, 'error text on ' + bg);
  }
  assert.ok(contrast(token('muted'), '#0f1115') >= 4.5, 'placeholder');
});

test('secondary text passes AA on every pressed and raised surface', () => {
  const raised = token('muted-raised');
  assert.match(css, /button\.on, \.toast, \.cal-prog li\.here, \.cal-prog li:hover \{ --muted: var\(--muted-raised\); \}/);
  const surfaces = [...css.matchAll(/([^{}\n]*(?:\.on|\.here|li:hover)[^{}\n]*)\{[^}]*background: (#[0-9a-f]{6}|var\(--on\))/g)].filter((m) => !m[1].includes('.crumbs')).map((m) => [m[0], m[1], m[2] === 'var(--on)' ? token('on') : m[2]]);
  assert.ok(surfaces.length >= 5, surfaces.length + ' surfaces');
  for (const [, sel, bg] of [...surfaces, ['', '.toast', '#20242c']]) assert.ok(contrast(raised, bg) >= 4.5, `${sel.trim()} ${bg}`);
  assert.ok(contrast(token('house'), '#262c36') >= 4.5, 'a done step while current');
});

test('the startup message is on the map, not in the collapsed sheet', () => {
  const html = fs.readFileSync(path.join(__dirname, 'static/index.html'), 'utf8');
  assert.ok(html.indexOf('bootLoading') < html.indexOf('</main>'), 'inside the stage');
  assert.match(css, /\.boot-loading \{ position: absolute;/);
});

test('calibrating on a phone keeps the chips and toggle above the map, whatever the sheet detent', () => {
  const block = /body\.calibrating \{ --panel-space: 0px; \}[\s\S]*?\.calibrate \{/.exec(css)[0];
  assert.match(block, /body\.calibrating \.chipbar \{[^}]*bottom: auto/);
  assert.match(block, /body\.calibrating \.map-controls \{[^}]*bottom: auto/);
  assert.match(css, /body\.calibrating \.panel, body\.calibrating \.crumbs \{ display: none/);
});

test('a label near the map edge stays on the map', async () => {
  const { createOverlay } = await import('./static/overlay.js');
  const nodes = [{ id: 'a-very-long-node-name', plan: 0, x: 95, y: 40, z: 0 }];
  const S = { geo: { pixels: { count: 0 }, controllers: [], mappings: [], zones: [], edges: [], runs: [], nodes }, plan: 0, hover: -1, pinned: -1, view: { toScreen: (x, y) => [x, y], size: () => ({ w: 100, h: 100 }) } };
  const overlay = createOverlay(S);
  overlay.st.nodes = overlay.st.labels = true;
  let x = null, width = 0;
  overlay.draw({ fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, closePath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, strokeText() {}, fillText(t, at) { x = at; }, measureText: (t) => { width = t.length * 3; return { width }; } });
  assert.ok(x + width <= 100, `${x} + ${width}`);
});

test('a disabled primary action does not look like a faded primary', () => {
  assert.match(css, /button\.go:disabled \{[^}]*background: transparent/);
});

test('the type scale has four named sizes and no ad hoc ones', () => {
  assert.doesNotMatch(css, /font-size: (0\.\d+em|1\.\d+em|\d+px)/);
  assert.match(css, /--t-s: 12px/);
  assert.match(css, /h2, h3 \{[^}]*font-size: var\(--t-l\)/);
});

test('icons are SVG: no glyph icons are left in the page source', async () => {
  const glyphs = /[✦▤⚙◉⇥✕☆★⏸⏮⏭▶◀▸▾▴☀✓]/;
  const dir = path.join(__dirname, 'static');
  const files = [...fs.readdirSync(dir), ...fs.readdirSync(path.join(dir, 'panel')).map((f) => 'panel/' + f)].filter((f) => /\.(js|html|css)$/.test(f));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), glyphs, f);
  const { icon } = await import('./static/icons.js');
  assert.match(icon('close'), /<svg[^>]*aria-hidden="true"/);
  assert.throws(() => icon('nope'));
});

test('native confirm is gone from the panels', () => {
  const src = fs.readFileSync(path.join(__dirname, 'static/panel/presets.js'), 'utf8');
  assert.doesNotMatch(src, /[^a-zA-Z.]confirm\(/);
});

test('setting labels are in words; the key stays in the tooltip', async () => {
  const { humanize } = await import('./static/util.js');
  assert.equal(humanize('sparkle.color'), 'Sparkle color');
  assert.equal(humanize('fade_in'), 'Fade in');
  assert.equal(humanize('colors.0'), 'Color 1');
  assert.equal(humanize('shed-sw'), 'Shed SW');
  assert.equal(humanize('sparkle.colors.1'), 'Sparkle color 2');
});

test('status gives one verdict', async () => {
  const { verdict } = await import('./static/panel/status.js');
  const ok = { reachable: true }, down = { reachable: false };
  assert.equal(verdict(['a', 'b'], { a: ok, b: ok }).text, 'All 2 controllers healthy');
  assert.equal(verdict(['a', 'b'], { a: ok, b: down }).text, '1 controller needs attention');
  assert.equal(verdict(['a', 'b'], { a: down, b: down }).text, '2 controllers need attention');
  assert.equal(verdict(['a'], {}).text, 'No controller health reported yet');
  assert.equal(verdict(['a'], { a: ok }).text, 'The controller is healthy');
});

test('Setup chips do not repeat their kind', () => {
  const src = fs.readFileSync(path.join(__dirname, 'static/panel/setup.js'), 'utf8');
  assert.doesNotMatch(src, /<small[^>]*>\$\{esc\(l\.kind\)\}/);
  assert.match(src, /modelPartLabel\(l\.name, l\.kind\)/);
});

test('calibration leads with the step in words, not an internal id', async () => {
  const { stepTitle } = await import('./static/panel/calibrate.js');
  assert.deepEqual(stepTitle({ target: { kind: 'anchor', run: 'shed-eave', node: 'corner-1' } }), { title: 'Line up Corner 1', on: 'on Shed eave' });
  assert.equal(stepTitle({ target: { kind: 'end', run: 'porch', end: 'first' } }).title, 'Find the first end');
});

test('effect cards say something useful', async () => {
  const { effectKind } = await import('./static/panel/looks.js');
  assert.equal(effectKind({ params: [{ name: 'palette', type: 'palette' }] }), 'Palette colors');
  assert.equal(effectKind({ params: [{ name: 'a.color', type: 'color' }] }), 'Layered look');
  assert.equal(effectKind({ params: [{ name: 'color', type: 'color' }] }), 'One color');
});

test('the inspect card keeps clear of its pixel', async () => {
  const { cardCorner } = await import('./static/card-place.js');
  const base = { w: 1000, h: 800, cw: 240, ch: 200, top: 50 };
  assert.deepEqual(cardCorner({ ...base, pixel: [900, 100] }), [8, 58]);
  assert.deepEqual(cardCorner({ ...base, pixel: [100, 100] }), [752, 592]);
  assert.deepEqual(cardCorner({ ...base, pixel: null }), [752, 58]);
});

test('a Points setting leaked by an old build is dropped once, not forever', async () => {
  const { createOverlay } = await import('./static/overlay.js');
  const saved = new Map([['glowstack.overlays', JSON.stringify({ mode: 'live', nodes: true, labels: true })]]);
  const was = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) } });
  try {
    const S = { geo: { pixels: { count: 0 }, controllers: [], mappings: [], zones: [], edges: [], runs: [], nodes: [] }, plan: 0, view: {} };
    const first = createOverlay(S);
    assert.equal(first.st.nodes, false, 'the leaked setting is gone');
    assert.equal(first.st.labels, true, 'other settings stay');
    first.st.nodes = true;
    first.remember();
    assert.equal(createOverlay(S).st.nodes, true, 'turning Points on afterwards sticks');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: was });
  }
});

test('calibration progress reads in words, with the part that differs first', async () => {
  const { partName, progressRow, stepTitle } = await import('./static/panel/calibrate.js');
  assert.equal(partName('shed-north', 'shed-north-3'), 'Point 3');
  assert.equal(partName('shed-north', 'shed-n-3'), 'Point 3');
  assert.equal(partName('shed-eave', 'shed-eave-mid'), 'Mid');
  assert.equal(partName('tower', 'gate-post'), 'Gate post');
  const a = progressRow({ target: { kind: 'anchor', run: 'tower', node: 'tower-top' }, label: 'tower · tower-top', index: 344, done: true, source: 'measured' });
  assert.deepEqual(a, { name: 'Top', value: 'Pixel 344', title: 'Tower: Tower top' });
  assert.equal(progressRow({ target: { kind: 'anchor', run: 'tower', node: 'tower-top' }, index: 12, done: false }).value, 'About pixel 12');
  assert.equal(progressRow({ target: { kind: 'gap', from: 'a-1', to: 'b-2' }, length: 1.5, done: false }).value, '1.50 m planned');
  assert.equal(progressRow({ target: { kind: 'link', from: 'a-1', to: 'b-2' }, done: false, source: 'partial' }).name, 'Link A 1 to B 2');
  assert.equal(stepTitle({ target: { kind: 'link', from: 'a-1', to: 'b-2' } }).on, 'between A 1 and B 2');
  assert.equal(stepTitle({ target: { kind: 'anchor', run: 'r', node: 'n' } }, () => 'Label').title, 'Line up Label');
});

test('runs named unassigned read as a state, not a fault', async () => {
  const { runLabel } = await import('./static/panel/status.js');
  assert.deepEqual(runLabel('unassigned-side-yard'), { name: 'Side yard', unassigned: true });
  assert.deepEqual(runLabel('shed-eave'), { name: 'Shed eave', unassigned: false });
});

test('a run shorter than drawn warns like one that is longer', () => {
  const src = fs.readFileSync(path.join(__dirname, 'static/panel/status.js'), 'utf8');
  assert.match(src, /const mis = Math\.abs\(/);
});

test('nothing is under the caption size, and small text uses it', () => {
  assert.match(css, /(^|\n)small \{ font-size: var\(--t-s\); \}/);
  assert.match(css, /--t-s: 12px/);
  assert.doesNotMatch(css, /--t-s: (\d|1[01])px/);
  for (const m of css.matchAll(/font-size: ([^;]+);/g)) assert.match(m[1], /var\(--t-[a-z]+\)/, m[0]);
});

test('every tab uses one panel width', () => {
  assert.doesNotMatch(css, /data-tab=[a-z]+\][^{]*\{[^}]*--panel-w/);
  assert.match(css, /--panel-w: 400px/);
});

test('a harmless 404 is neutral, not an error', () => {
  const html = fs.readFileSync(path.join(__dirname, 'static/404.html'), 'utf8');
  assert.doesNotMatch(html, /state error|role="alert"/);
});

test('status tiles stay on one line', () => {
  assert.match(css, /\.stat span \{[^}]*white-space: nowrap/);
});

test('Retry goes back to loading, then runs the retry', async () => {
  const { showState } = await import('./static/states.js');
  let button = null, calls = 0;
  const el = { innerHTML: '', querySelector: () => button };
  button = {};
  showState(el, { kind: 'error', title: 'Bad', retry: () => { calls++; assert.match(el.innerHTML, /state loading/); } });
  assert.match(el.innerHTML, /state error/);
  await button.onclick();
  assert.equal(calls, 1);
});

test('map labels never pile up', async () => {
  const { createOverlay } = await import('./static/overlay.js');
  const nodes = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: 'node-name-' + i, plan: 0, x: 10, y: 10, z: 0 }));
  const S = { geo: { pixels: { count: 0 }, controllers: [], mappings: [], zones: [], edges: [], runs: [], nodes }, plan: 0, hover: -1, pinned: -1, view: { toScreen: (x, y) => [x, y] } };
  const overlay = createOverlay(S);
  overlay.st.nodes = overlay.st.labels = true;
  const at = [];
  overlay.draw({ fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, closePath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, strokeText() {}, fillText(t, x, y) { at.push([x, y]); }, measureText: (t) => ({ width: t.length * 6 }) });
  assert.ok(at.length >= 1 && at.length <= 5, `${at.length} labels`);
  assert.equal(new Set(at.map(([, y]) => y)).size, at.length, 'two labels on the same line');
});
