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
