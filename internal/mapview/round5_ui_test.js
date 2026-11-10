// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for series 2 round 5 of the UI review: its bugs (B147 to B149), the
// refinements, the phone-native shell (H) and working without a pointer (G).
// Run with: node --test internal/mapview/round5_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (f) => fs.readFileSync(path.join(__dirname, 'static', f), 'utf8');
const css = () => read('ui.css');
const design = () => fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'design.md'), 'utf8');

test('B147: the breadcrumb folds older ancestors into one crumb instead of scrolling', async () => {
  const { crumbPlans, reachTaps, fitCrumbs, crumbKind } = await import('./static/crumbs.js');
  // Everything > zone > area > run, with the run current.
  const plans = crumbPlans(4, 3);
  assert.deepEqual(plans[0], { show: [0, 1, 2, 3], menu: false, squeeze: '' }, 'the whole chain first');
  assert.deepEqual(plans[1], { show: [2, 3], menu: true, squeeze: '' }, 'then the parent and the target behind the fold');
  // Every plan draws the current target, and only the last lets it shorten.
  for (const [n, on] of [[4, 3], [4, 2], [4, 1], [4, 0], [3, 1], [2, 1], [1, 0]]) {
    const ps = crumbPlans(n, on);
    for (const [k, p] of ps.entries()) {
      assert.ok(p.show.includes(on), `${n}/${on}: plan ${k} shows the target`);
      assert.equal(p.squeeze === 'current', k === ps.length - 1 && ps.length > 1, `${n}/${on}: the target shortens only as the last resort`);
      assert.equal(p.menu, p.show.length < n, `${n}/${on}: the fold is there exactly when something is folded`);
      // Every crumb is one tap away when drawn, two through the menu.
      for (let i = 0; i < n; i++) assert.ok(reachTaps(p, i) <= 2);
    }
    // The parent stays a crumb until only the target fits.
    if (on > 0) assert.ok(ps[1].show.includes(on - 1), `${n}/${on}: the parent is kept first`);
  }
  // fitCrumbs takes the first plan that fits, and the last when none does.
  const box = { clientWidth: 374, scrollWidth: 0 };
  const widths = [96, 110, 150, 210]; // made-up crumb widths in px
  const draw = (plan) => { box.scrollWidth = (plan.menu ? 64 : 0) + plan.show.reduce((w, i) => w + (plan.squeeze === 'current' ? 0 : widths[i]) + 20, 0) + 48; };
  assert.deepEqual(fitCrumbs(box, 4, 3, draw).show, [3], 'a long run name keeps itself and the fold');
  assert.ok(box.scrollWidth <= box.clientWidth);
  box.clientWidth = 844;
  assert.deepEqual(fitCrumbs(box, 4, 3, draw), { show: [0, 1, 2, 3], menu: false, squeeze: '' }, 'a wide map is unchanged');
  box.clientWidth = 100;
  assert.equal(fitCrumbs(box, 4, 3, draw).squeeze, 'current');
  assert.equal(crumbKind({ members: [{ kind: 'area' }, { kind: 'all' }] }), '');
  assert.equal(crumbKind({ members: [{ kind: 'area' }, { kind: 'zone' }] }), 'zone');
  // The row no longer scrolls, and the fold is a menu with a name.
  assert.doesNotMatch(css(), /\.crumbs \{[^}]*overflow-x: auto/);
  assert.match(css(), /\.crumbs \{[^}]*flex-wrap: nowrap/);
  const app = read('app.js');
  assert.match(app, /class="fold" aria-haspopup="menu" aria-expanded="false" aria-label="Show the whole path"/);
  assert.match(app, /aria-label="\$\{esc\(name\)\}" title=/, 'a shortened crumb keeps its whole name');
  assert.match(read('index.html'), /id="crumbMenu" class="crumb-menu" role="menu"/);
});

test('B148: a tile whose value is words uses the label style, so it never outweighs the numbers', async () => {
  const { tileFacts, tileHTML } = await import('./static/panel/status.js');
  const base = { lit: 0, total: 0, health: { up: 8, n: 8, cls: 'ok', text: '' }, late: 0, fps: { measured: 30, target: 30 } };
  const gap = tileFacts({ ...base, power: { anyKnown: false, overall: '', limiting: '' } })[3];
  assert.equal(gap.words, true);
  // The label has the figure's line, the words follow, and the tile is still the link to Power.
  const html = tileHTML(gap);
  assert.match(html, /^<button type="button" id="stPowerTile" class="stat wordy link"/);
  assert.match(html, /<b class="words">power estimate<\/b><span>Not configured<svg/);
  // With LED current configured the tile shows its number in the figure's style.
  const known = tileFacts({ ...base, power: { anyKnown: true, overall: '3.20 A', limiting: 'Off' } })[3];
  assert.ok(!known.words);
  assert.match(tileHTML(known), /class="stat link"[^>]*><b>3\.20 A<\/b><span>power estimate/);
  // Numeric tiles are unchanged, and none of them is wordy.
  for (const f of tileFacts({ ...base, power: null }).slice(0, 3)) assert.match(tileHTML(f), /^<div class="stat[^"]*" title="[^"]*"><b>[^<]+<\/b><span>/);
  // Both lines of a wordy tile are the label's size and weight; the figure's box keeps its height.
  const c = css();
  assert.match(c, /\.tiles \.stat b\.words \{ color: var\(--muted\); font-size: var\(--t-meta\); font-weight: 400; \}/);
  assert.match(c, /\.tiles \.stat\.wordy span \{ color: var\(--fg\); font-size: var\(--t-meta\); font-weight: 400; \}/);
  assert.match(c, /^\.stat span \{ display: block; color: var\(--muted\); font-size: var\(--t-meta\); \}/m);
  assert.match(read('panel/status.js'), /querySelectorAll\('b:not\(\.words\)'\)\) fitFigure/);
});

test('B149: Names names the runs in every "Color the map by" view, and the key counts what is hidden', async () => {
  const { namesDraw, overlayShown, MODES, placeLabels } = await import('./static/overlay.js');
  // The same rule in each view: runs with Names alone, points while Points is on, nothing when off.
  for (const [mode] of MODES) {
    assert.equal(namesDraw(overlayShown({ mode, labels: true, nodes: false }, { tab: 'setup' })), 'runs', mode);
    assert.equal(namesDraw(overlayShown({ mode, labels: true, nodes: true }, { tab: 'setup' })), 'points', mode);
    assert.equal(namesDraw(overlayShown({ mode, labels: false, nodes: true }, { tab: 'setup' })), '', mode);
  }
  // Setup's names are Setup's: another tab's map has none. Calibration names its points.
  assert.equal(namesDraw(overlayShown({ mode: 'areas', labels: true, nodes: false }, { tab: 'looks' })), '');
  assert.equal(namesDraw(overlayShown({ mode: 'areas', labels: true, nodes: false }, { calibrating: true })), 'points');
  // The drawing asks for one name per run, as a budget label the placer may hide and count.
  const overlay = read('overlay.js');
  assert.match(overlay, /if \(o\.nodes\) nodes\(\);\s*else if \(namesDraw\(o\) === 'runs'\) runNames\(\);/);
  assert.match(overlay, /label\(runName\(g, r\.id\), q\[0\] \+ 8, q\[1\] - 6, '#e5e7eb', 1\.1, true\);\s*\}\);\s*\}/);
  // With room for one name of three, one is placed and two are counted for the key.
  const names = ['Shed eave', 'Fence north', 'Gate arch'].map((text, i) => ({ text, x: 40 + i, y: 60, color: '#e5e7eb', rank: 1.1, budget: true }));
  const placed = placeLabels(names, { width: 100, height: 300, measure: (l) => l.text.length * 6 });
  assert.equal(placed.length, 1);
  assert.equal(placed.hidden, 2);
  // The key shows the count in every view, with or without another legend.
  const setup = read('panel/setup.js');
  assert.match(setup, /const n = ov\.hiddenLabels\(\);\s*const note = n \? `<div class="muted label-note">/);
  assert.match(setup, /key\.hidden = !\(legendHTML \+ states \+ note\);/);
  assert.match(setup, /title="Names on the runs, or on points and gaps while Points is on, and descriptions on controllers">Names</);
});
