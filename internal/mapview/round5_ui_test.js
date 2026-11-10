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

test('Refinement 1: a one-line state is a one-line pill, with no empty line kept in it', async () => {
  const { badgeHTML, stackedLines, mapStatus } = await import('./static/map-status.js');
  const count = (html) => (html.match(/<span(?: class="detail")?>[^<]*<\/span>/g) || []).length;
  const base = { connected: true, show: '', preview: null };
  const states = [
    mapStatus({ ...base, lit: { dark: 'none', empty: true, zones: [], message: '' } }),
    mapStatus(base),
    mapStatus({ ...base, looks: ['Amber wash'], levels: [1, 1] }),
    mapStatus({ ...base, preview: { previewing: true } }),
    mapStatus({ ...base, preview: { previewing: true }, dimZones: 2 }),
    mapStatus({ ...base, mode: 'outputs' }),
    mapStatus({ ...base, target: true }),
    mapStatus({ ...base, connected: false }),
  ];
  for (const m of states) {
    const html = badgeHTML(m, true);
    assert.equal(count(html), stackedLines(m), m.text);
    assert.doesNotMatch(html, /&nbsp;|reserved|<span[^>]*>\s*<\/span>/, `${m.text}: no empty line`);
  }
  // The states with nothing more to say are one line.
  for (const i of [2, 3, 5, 6, 7]) assert.equal(stackedLines(states[i]), 1, states[i].text);
  for (const i of [0, 1, 4]) assert.equal(stackedLines(states[i]), 2, states[i].text);
  // The pill centers what it has and is never shorter than the logo button beside it.
  const c = css();
  assert.match(c, /^\.badge \{\s*display: inline-flex; align-items: center; min-height: var\(--tap\);/m);
  assert.match(c, /^\.brand \{\s*display: inline-flex; align-items: center; gap: 7px; min-height: var\(--tap\);/m);
  assert.match(c, /body\.calibrating \.badge \.detail \{ display: none; \}/);
  assert.doesNotMatch(c, /\.badge \.detail \{ visibility: hidden/);
});

test('Refinement 2: the Tweak form uses the row\'s width, and unused colors are disabled rows', async () => {
  const c = css();
  // No gutter and no card of its own inside a layer row: labels start at the row's content edge.
  assert.match(c, /^\.layer \.slot > \.form \{ background: transparent; padding: 0; border-radius: 0; \}/m);
  assert.doesNotMatch(c, /--name-in/);
  // The form itself still has no border (round 4's two-surface limit).
  assert.match(c, /^\.form \{ background: var\(--card2\); border: 0;/m);
  // A color the palette ignores: the row stays, inert and dimmed, with one hint.
  const form = read('form.js');
  assert.match(form, /part\.inert = on; if \(on\) part\.setAttribute\('aria-disabled', 'true'\); else part\.removeAttribute\('aria-disabled'\);/);
  assert.match(form, /c\.hint\.hidden = !last;/);
  assert.doesNotMatch(form, /unused-note/);
  assert.match(c, /\.form \.f\.unused > label, \.form \.f\.unused > \.ctl \{ opacity: 0\.45; \}/);
  // On a phone a disabled row is one line, name then swatch.
  assert.match(c, /\.form \.f\.unused, \.form details > \.f\.unused \{ grid-template-columns: minmax\(0, 1fr\) auto; \}/);
  const { unusedHint } = await import('./static/form.js');
  assert.match(unusedHint(''), /^Not used: /);
});

test('Refinement 3: the inspect card is name first, three rows at most, in one place', async () => {
  const { inspectRows, cardDock, DETAILS_OPEN } = await import('./static/inspect.js');
  const rows = inspectRows({ run: 'Porch rail', zone: 'Porch', pixel: 412, showing: 'Amber wash (preview) on everything', chain: ['Porch', 'Porch rails'] });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { kind: 'name', title: 'Porch rail', sub: 'Porch' });
  assert.deepEqual(rows[1], { kind: 'showing', label: 'Showing', value: 'Amber wash (preview) on everything' });
  assert.deepEqual(rows[2], { kind: 'chain', label: 'Part of', value: 'Porch \u203a Porch rails' });
  // Never more than three, and no pixel number, color or output among them.
  for (const r of rows) assert.doesNotMatch(JSON.stringify(r), /412|#[0-9a-f]{6}|GPIO|output/i);
  assert.equal(inspectRows({ run: 'Shed eave', zone: 'Shed eave', pixel: 3 }).length, 2, 'a run that is its own zone has no chain row');
  assert.equal(inspectRows({ pixel: 9, dead: true })[0].title, 'Pixel 9 (dead)', 'a pixel on no run is named by its number');
  // One dock for hover and for pinned: the bottom right, whatever the pixel, unless it is under the card.
  const base = { w: 860, h: 900, cw: 280, ch: 120, top: 80 };
  assert.deepEqual(cardDock({ ...base, pixel: [200, 300] }), [572, 772]);
  assert.deepEqual(cardDock({ ...base, pixel: [40, 860] }), [572, 772]);
  assert.deepEqual(cardDock({ ...base, pixel: [700, 800] }), [572, 88]);
  // Details hold the wiring facts, and their open state is remembered per device.
  const app = read('app.js');
  assert.equal(DETAILS_OPEN, 'glowstack.inspect.details');
  assert.match(app, /inspectMore = load\(DETAILS_OPEN, false\) === true/);
  assert.match(app, /inspectMore = e\.target\.open; save\(DETAILS_OPEN, inspectMore\);/);
  const details = app.slice(app.indexOf('<summary>Details</summary>'), app.indexOf('<summary>Technical details</summary>'));
  for (const k of ["r('Pixel'", "r('Color'", "r('Output'"]) assert.ok(details.includes(k), k);
  const rest = app.slice(app.indexOf('<table class="rows">'), app.indexOf('<summary>Details</summary>'));
  assert.doesNotMatch(rest, /Color|Output|Pixel/);
  assert.doesNotMatch(app, /cardCorner/);
});

test('Refinement 4: this look and the next look in words; one word per action; the chip says where', async () => {
  const { THIS_LOOK, NEXT_LOOK, placeControl, targetControl, removeWords, fitLine, stateLines } = await import('./static/panel/looks.js');
  assert.equal(placeControl('Everything').label, 'This look:');
  assert.equal(targetControl('Shed eave', false).label, 'Next look:');
  assert.notEqual(THIS_LOOK, NEXT_LOOK);
  // The string audit: each label is one control's, and no action has two names.
  const looks = read('panel/looks.js');
  assert.doesNotMatch(looks, /Remove here|'On:'|>Preview on<|Preview on Everything/);
  assert.equal(looks.match(/THIS_LOOK/g).length, 2, 'declared, and used by the row control only');
  assert.equal(looks.match(/NEXT_LOOK/g).length, 3, 'declared, and used by the Library header only');
  // Remove is always "Remove"; a partial scope is its name and tooltip.
  const whole = removeWords({ lane: 'preview' }), part = removeWords({ lane: 'house', part: 'Shed eave', rest: 'Shed eave' });
  assert.equal(whole.text, 'Remove');
  assert.equal(part.text, 'Remove');
  assert.equal(part.aria, 'Remove from Shed eave');
  assert.match(part.title, /^Remove from Shed eave: turn off Shed eave and leave the rest of this look on$/);
  assert.equal(removeWords({ lane: 'house' }).title, 'Remove from the lights');
  // A card's state line is whole or drops its place: never an ellipsis.
  assert.deepEqual(stateLines('Previewing on Everything'), ['Previewing on Everything', 'Previewing elsewhere', 'Previewing']);
  assert.deepEqual(stateLines('Live on Porch rail'), ['Live on Porch rail', 'Live elsewhere', 'Live']);
  assert.deepEqual(stateLines('Previewing'), ['Previewing']);
  const fits = (n) => (t) => t.length <= n;
  assert.equal(fitLine(stateLines('Previewing on Everything'), fits(30)), 'Previewing on Everything');
  assert.equal(fitLine(stateLines('Previewing on Everything'), fits(22)), 'Previewing elsewhere');
  assert.equal(fitLine(stateLines('Previewing on Everything'), fits(12)), 'Previewing');
  // The chip: a look on one run names it; several places read "part of the house"; no zone brightness as coverage.
  const { mapStatus, badgeHTML, lookScope, levelPhrase } = await import('./static/map-status.js');
  const name = (t) => ({ 'run:shed-eave': 'Shed eave', porch: 'Porch' }[t] || t);
  assert.deepEqual(lookScope([[[0, 99]]], ['all'], 100, name), { all: true, place: '' });
  assert.deepEqual(lookScope([[[10, 19]]], ['run:shed-eave'], 100, name), { all: false, place: 'Shed eave' });
  assert.deepEqual(lookScope([[[10, 19]], [[30, 39]]], ['run:shed-eave', 'porch'], 100, name), { all: false, place: '' });
  assert.deepEqual(lookScope([[[0, 49]], [[50, 99]]], ['a', 'b'], 100, name), { all: true, place: '' }, 'two halves cover the house');
  const base = { connected: true, show: '', preview: null, looks: ['Amber wash'], levels: [1, 1, 1, 1] };
  const one = mapStatus({ ...base, scope: { all: false, place: 'Shed eave' } });
  assert.equal(one.text, 'Amber wash on Shed eave');
  assert.doesNotMatch(one.text + one.detail, /zones? at/);
  assert.equal(badgeHTML(one), '<span><b>Amber wash</b> on Shed eave<span class="detail"></span></span>');
  assert.equal(badgeHTML(one, true), '<span class="stack"><span>1 look on the lights</span><span class="detail">on Shed eave only</span></span>');
  assert.equal(mapStatus({ ...base, looks: ['A', 'B'], scope: { all: false, place: '' } }).text, 'A, B on part of the house');
  assert.equal(mapStatus({ ...base, scope: { all: true, place: '' } }).text, 'Amber wash on the lights');
  assert.equal(mapStatus({ ...base, levels: [0.4, 1], scope: { all: true, place: '' } }).detail, ' · brightness 40–100%');
  assert.equal(levelPhrase([1, 1, 1]), '');
  // A hidden preview is said in the dark state too, on any tab.
  const dark = mapStatus({ connected: true, show: 'house', preview: { previewing: true }, lit: { dark: 'none', empty: true, zones: [], message: 'Nothing is lit.' } });
  assert.equal(dark.text + dark.detail, 'Lights: nothing lit · preview hidden');
  assert.match(read('app.js'), /scope: houseScope\(\),/);
});

test('Refinement 5: one Undo at a time, and a compact toast on the phone', async () => {
  const { cardLink, compactToast, createUndo, TOAST_MS, LINK_MS } = await import('./static/undo.js');
  // The card's link shows only when no toast carries Undo, for as long as the link lives.
  assert.equal(cardLink({ link: true, toastShowing: true }), false);
  assert.equal(cardLink({ link: true, toastShowing: false }), true);
  assert.equal(cardLink({ link: false, toastShowing: false }), false);
  // Over time: toast for ten seconds, then the link until five minutes, never both.
  let t = 0;
  const undo = createUndo(() => t);
  undo.set('u1', 'put the look on the lights');
  for (const at of [0, 5000, TOAST_MS - 1, TOAST_MS, 60000, LINK_MS - 1, LINK_MS]) {
    t = at;
    const toast = undo.toast(), card = cardLink({ link: undo.link(), toastShowing: toast });
    assert.ok(!(toast && card), `two Undo controls at ${at} ms`);
    assert.equal(toast || card, at < LINK_MS, `an Undo is offered at ${at} ms`);
  }
  // A toast dismissed early hands over at once: the rule reads the page, not the clock.
  const looks = read('panel/looks.js');
  assert.match(looks, /const toastShowing = !!document\.querySelector\('\.toast \[data-act=undo\]'\);/);
  assert.match(looks, /new MutationObserver\(\(\) => renderUndo\(\)\)/);
  assert.match(css(), /\.stage-undo\.held \{ visibility: hidden; \}/);
  // The phone's confirmation is the sentence without what it replaced, on one line with Undo.
  assert.equal(compactToast('The look is on the lights, in place of Amber wash.'), 'The look is on the lights.');
  assert.equal(compactToast('2 looks are on the lights.'), '2 looks are on the lights.');
  assert.match(looks, /S\.panel\.layout\(\) === 'sheet' \? compactToast\(r\.text\) : r\.text/);
  const phone = css().slice(css().indexOf('.toast.has-action { align-items: center;'));
  assert.match(phone, /^\.toast\.has-action \{ align-items: center; padding: 1px 2px 1px 10px; gap: 6px; \}/);
  assert.match(phone, /\.toast\.has-action\.two-acts \{ flex-wrap: wrap;/, 'a fix and Undo together still take their own line');
  assert.match(read('app.js'), /if \(actions\.length > 1\) el\.classList\.add\('two-acts'\);/);
});
