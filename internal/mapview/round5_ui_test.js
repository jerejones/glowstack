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
  assert.match(c, /\.tiles \.stat b\.words \{ color: var\(--muted\); font-size: var\(--t-sub\); font-weight: 400; \}/);
  assert.match(c, /\.tiles \.stat\.wordy span \{ color: var\(--fg\); font-size: var\(--t-sub\); font-weight: 400; \}/);
  assert.match(c, /^\.stat span \{ display: block; color: var\(--muted\); font-size: var\(--t-sub\); \}/m);
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
  assert.doesNotMatch(css(), /\.stage-undo\.held/, 'B151: no room is kept for the hidden link');
  // The phone's confirmation is the sentence without what it replaced, on one line with Undo.
  assert.equal(compactToast('The look is on the lights, in place of Amber wash.'), 'The look is on the lights.');
  assert.equal(compactToast('2 looks are on the lights.'), '2 looks are on the lights.');
  assert.match(looks, /S\.panel\.layout\(\) === 'sheet' \? compactToast\(r\.text\) : r\.text/);
  const phone = css().slice(css().indexOf('.toast.has-action { align-items: center;'));
  assert.match(phone, /^\.toast\.has-action \{ align-items: center; padding: 1px 2px 1px 10px; gap: 6px; \}/);
  assert.match(phone, /\.toast\.has-action\.two-acts \{ flex-wrap: wrap;/, 'a fix and Undo together still take their own line');
  assert.match(read('app.js'), /if \(actions\.length > 1\) el\.classList\.add\('two-acts'\);/);
});

test('Refinement 6: the phone preview card and an apply button that never wraps', async () => {
  const { applyPlan, applyLabel } = await import('./static/panel/looks.js');
  const c = css();
  // No "Looks" heading on a phone's sheet at any detent: the state card leads.
  assert.doesNotMatch(c, /body\[data-detent=full\] \.tab \.looks-head/);
  assert.match(c, /^  \.tab \.looks-head \{ display: none; \}/m);
  // A folded row always has the name on its own line, the place and level beneath.
  assert.match(read('panel/looks.js'), /if \(!el\.classList\.contains\('open'\)\) \{ el\.classList\.add\('two-line'\); return; \}/);
  assert.match(c, /\.layer\.two-line \.line-place \{ grid-column: 2; grid-row: 2;/);
  // Every state of the bar has a full sentence and a shorter complete form.
  const states = [
    applyPlan({ n: 1, updates: false, house: 0, hidden: [], mode: 'replace' }),
    applyPlan({ n: 2, updates: false, house: 0, hidden: [], mode: 'replace' }),
    applyPlan({ n: 1, updates: true, house: 1, hidden: [], mode: 'replace' }),
    applyPlan({ n: 1, updates: false, house: 1, hidden: [], mode: 'replace' }),
    applyPlan({ n: 1, updates: false, house: 2, hidden: ['Amber wash'], mode: 'add' }),
    applyPlan({ n: 1, updates: false, house: 1, hidden: ['Amber wash'], mode: 'replace' }),
    applyPlan({ n: 2, updates: false, house: 2, hidden: ['Amber wash', 'Slow drift'], mode: 'replace' }),
  ];
  assert.deepEqual(states.map((p) => p.label), ['Put 1 look on the lights', 'Put 2 looks on the lights', 'Update 1 look on the lights', 'Add 1 look on top', 'Add 1 look on top', "Replace what's on the lights with 1 look", "Replace what's on the lights with 2 looks"]);
  assert.deepEqual(states.map((p) => p.short), ['Put 1 look on', 'Put 2 looks on', 'Update 1 look', 'Add 1 look', 'Add 1 look', 'Replace with 1 look', 'Replace with 2 looks']);
  for (const p of states) {
    assert.ok(p.short.length < p.label.length);
    assert.match(p.short, /^(Put|Update|Add|Replace) /, 'a verb first, a complete form');
    assert.doesNotMatch(p.short, /…|\.\.\./);
    // The fitting rule: the sentence where it fits, the shorter form where it does not.
    assert.equal(applyLabel(p, () => true), p.label);
    assert.equal(applyLabel(p, (t) => t.length <= 22), p.label.length <= 22 ? p.label : p.short);
  }
  // A phone's bar beside "Add instead" has about 22 characters of room: Replace takes its short form there.
  assert.equal(applyLabel(states[5], (t) => t.length <= 22), 'Replace with 1 look');
  assert.equal(applyLabel(states[0], (t) => t.length <= 30), 'Put 1 look on the lights');
  // The button is one line by rule, and keeps the whole sentence as its accessible name.
  assert.match(c, /^\.bar-main \.go \{[^}]*white-space: nowrap; overflow: hidden; \}/m);
  assert.doesNotMatch(c, /\.bar-main \.go \{[^}]*text-wrap: balance/);
  assert.match(read('panel/looks.js'), /go\.setAttribute\('aria-label', plan\.label\);/);
});

test('Refinement 7: late frames say their window and have a threshold; healthy controllers are one line', async () => {
  const { lateFacts, LATE_SHARE, LATE_LABEL, LATE_NOTE, tileFacts, statusIssues, headline, controllersSummary } = await import('./static/panel/status.js');
  // The window is what the server counts: since start, never reset (internal/clock Ticker.Late).
  const clock = fs.readFileSync(path.join(__dirname, '..', 'clock', 'clock.go'), 'utf8');
  assert.match(clock, /func \(t \*Ticker\) Late\(\) uint64 \{ return t\.late\.Load\(\) \}/);
  assert.doesNotMatch(clock, /late\.Store\(0\)/, 'the count is never reset, so the window is since start');
  assert.equal(LATE_LABEL, 'late since start');
  assert.equal(LATE_SHARE, 0.01);
  assert.match(LATE_NOTE, /Counted since start; amber above 1% of frames\.$/);
  // At or below the threshold: neutral, no warning.
  const few = lateFacts({ late: 3, frames: 144000, uptime: '1 hour' });
  assert.equal(few.over, false);
  assert.equal(few.issue, null);
  assert.equal(few.title, '3 frames of 144,000 were late since Glowstack started 1 hour ago (< 0.1%). Amber above 1%.');
  assert.equal(lateFacts({ late: 1, frames: 100 }).over, false, 'exactly 1% is not over it');
  assert.equal(lateFacts({ late: 0, frames: 0 }).over, false);
  assert.equal(lateFacts({ late: 0, frames: 500, uptime: '12 s' }).title, 'No frame has been late since Glowstack started 12 s ago.');
  // Above it: amber, and a warning that explains it and leads to Diagnostics.
  const many = lateFacts({ late: 5000, frames: 144000, uptime: '1 hour' });
  assert.equal(many.over, true);
  assert.match(many.issue.summary, /^Frames are late: 3\.5% of them since Glowstack started 1 hour ago, over the 1% line\. Effects may stutter\.$/);
  assert.deepEqual(many.issue.fix, { label: 'Open Diagnostics', diag: true });
  assert.equal(many.issue.plain, LATE_NOTE);
  const base = { lit: 0, total: 0, health: { up: 2, n: 2, cls: 'ok', text: '' }, fps: { measured: 40, target: 40 }, power: null };
  assert.equal(tileFacts({ ...base, late: 3, frames: 144000 })[2].cls, '');
  assert.equal(tileFacts({ ...base, late: 5000, frames: 144000 })[2].cls, 'warn');
  // The warnings summary counts it only above the threshold.
  const lit = { cls: '', text: 'Nothing is lit: no looks are on the lights' };
  assert.equal(statusIssues('', [], few.issue).length, 0);
  assert.equal(headline(lit, '', statusIssues('', [], few.issue).length).cls, '');
  assert.equal(statusIssues('', [], many.issue).length, 1);
  assert.equal(headline(lit, '', statusIssues('', [], many.issue).length).text, '1 warning to check below');
  const status = read('panel/status.js');
  assert.match(status, /fix\.diag \? openDiagnostics\(\)/);
  // Controllers: one line when every one is reachable, open with the failing first otherwise.
  assert.deepEqual(controllersSummary({ n: 8, reachable: 8, down: 0, shared: 'Sending' }), { open: false, text: '8 controllers, all sending' });
  assert.deepEqual(controllersSummary({ n: 8, reachable: 7, down: 1, shared: '' }), { open: true, text: '8 controllers, 1 unreachable' });
  assert.deepEqual(controllersSummary({ n: 8, reachable: 5, down: 0 }), { open: true, text: '8 controllers' }, 'not yet known is not healthy');
  assert.equal(controllersSummary({ n: 1, reachable: 1, down: 0, shared: 'Sending' }).text, '1 controller, all sending');
  assert.match(status, /<details id="stCtlMore"><summary><\/summary><ul class="list-rows" id="stCtl"><\/ul><\/details>/);
  assert.match(status, /const byFault = \[\.\.\.g\.controllers\]\.sort\(/, 'failing ones first');
  assert.match(status, /if \(sum\.open !== ctlDefault\) \{ ctlDefault = sum\.open; ctlChoice = null; \}/, 'a fault opens it again whatever was chosen');
});

test('Refinement 8: Calibrate keeps the panel\'s one width', () => {
  const c = css();
  // One width beside the map from 1280 px up, with no override for the mode.
  assert.match(c, /@media \(min-width: 1280px\) \{\s*:root \{ --panel-w: 580px; \}\s*\}/);
  assert.doesNotMatch(c, /body\.calibrating \{ --panel-w:/);
  // The Calibrate panel and the tabs' panel are both that wide, and the map gives the same room to each.
  assert.match(c, /\.panel \{[^}]*width: var\(--panel-w\);/);
  assert.match(c, /\.calibrate \{[^}]*width: var\(--panel-w\);/);
  assert.match(c, /^body\.calibrating \{ --panel-space: var\(--panel-w\); \}/m);
  assert.match(design(), /The panel is one width on every tab and in Calibrate/);
});

test('H: the phone shell has its tabs in a bottom bar and a sheet that follows the finger', async () => {
  const { DETENTS, DETENT_WORDS, detentStep, settle, dragsSheet } = await import('./static/sheet.js');
  const c = css(), phone = c.slice(c.indexOf('/* bottom sheet */')), sheet = read('sheet.js'), html = read('index.html');
  // The bar: fixed to the bottom of the screen, opaque, padded by the safe area, 44 px targets, hidden while calibrating.
  assert.match(phone, /\.tabs \{\s*position: fixed; z-index: 6; left: 0; right: 0; bottom: 0; height: calc\(var\(--tabbar\) \+ var\(--safe-b\)\);\s*padding: 2px 10px calc\(2px \+ var\(--safe-b\)\);/);
  assert.match(phone, /\.handle, \.tabs \{ background: var\(--panel-bg\); \}/);
  assert.match(phone, /\.tabs button \{ height: var\(--tap\); \}/);
  assert.match(phone, /body\.calibrating \.tabs \{ display: none; \}/);
  assert.match(c, /--tabbar: 48px;/);
  // It leaves the sheet: sheet.js moves it after the panel on a phone (last on screen, last in the Tab order) and back elsewhere.
  assert.match(sheet, /const home = layout === 'sheet' \? document\.body : panel;/);
  assert.match(sheet, /if \(home === panel\) panel\.insertBefore\(tabBar, \$\('content'\)\); else panel\.after\(tabBar\);/);
  // The sheet sits above the bar: its foot is padded by the bar, and its content ends there.
  assert.match(phone, /padding-bottom: calc\(var\(--tabbar\) \+ var\(--safe-b\)\);/);
  assert.match(phone, /\.content \{ flex: none; height: calc\(var\(--sheet-visible\) - var\(--handle\) - var\(--tabbar\) - var\(--safe-b\)\);/);
  // No Expand button anywhere on a phone; the handle is a named control with its state.
  assert.match(phone, /\.tabs \.rail-toggle \{ display: none; \}/);
  assert.doesNotMatch(sheet + html, /Expand/);
  assert.match(html, /<div id="handle" class="handle" role="slider" tabindex="0" aria-label="Panel height" title="[^"]+" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="2" aria-valuenow="0" aria-valuetext="[^"]+"><i><\/i><\/div>/);
  assert.match(sheet, /handle\.setAttribute\('aria-valuenow', DETENTS\.indexOf\(d\)\);\s*handle\.setAttribute\('aria-valuetext', DETENT_WORDS\[d\]\);/);
  assert.deepEqual(DETENTS, ['peek', 'half', 'full']);
  assert.deepEqual(Object.keys(DETENT_WORDS), DETENTS);
  // Up and Down step the detents; Home and End go to the ends; at an end a key does nothing.
  assert.equal(detentStep('peek', 'ArrowUp'), 'half');
  assert.equal(detentStep('half', 'ArrowUp'), 'full');
  assert.equal(detentStep('full', 'ArrowUp'), '');
  assert.equal(detentStep('full', 'ArrowDown'), 'half');
  assert.equal(detentStep('peek', 'ArrowDown'), '');
  assert.equal(detentStep('half', 'Home'), 'peek');
  assert.equal(detentStep('half', 'End'), 'full');
  assert.equal(detentStep('half', 'a'), '');
  // A release settles on the nearest detent; a flick decides by velocity.
  const h = { peek: 100, half: 540, full: 644 };
  assert.equal(settle(h, 360), 'half');
  assert.equal(settle(h, 250), 'peek');
  assert.equal(settle(h, 620), 'full');
  assert.equal(settle(h, 500, 0.9), 'peek', 'a flick down from near half goes on to the peek');
  assert.equal(settle(h, 200, -0.9), 'half', 'a flick up from near the peek goes to half');
  assert.equal(settle(h, 560, -0.9), 'full');
  assert.equal(settle(h, 360, 0.2), 'half', 'a slow drag is not a flick');
  // Content scrolls; only at its top, going down, does the touch move the sheet.
  assert.equal(dragsSheet({ scrollTop: 0, dx: 0, dy: 20 }), true);
  assert.equal(dragsSheet({ scrollTop: 40, dx: 0, dy: 20 }), false, 'scrolled content scrolls');
  assert.equal(dragsSheet({ scrollTop: 0, dx: 0, dy: -20 }), false, 'upward is a scroll');
  assert.equal(dragsSheet({ scrollTop: 0, dx: 30, dy: 20 }), false, 'sideways is a slider or a swipe');
  assert.equal(dragsSheet({ scrollTop: 0, dx: 0, dy: 4 }), false, 'inside the slop');
  // No transition longer than 250 ms, and none under reduced motion.
  const ms = /transition: transform (0?\.\d+)s/.exec(phone)[1];
  assert.ok(parseFloat(ms) <= 0.25, `the sheet settles in ${ms}s`);
  assert.match(phone, /@media \(prefers-reduced-motion: reduce\) \{ \.panel \{ transition: none; \} \}/);
  // The heights: the peek is the handle and one line (plus the apply bar while previewing) over the bar; half and full keep the map's band.
  assert.match(sheet, /return \{ peek: PEEK \+ sb \+ peekExtra, half: Math\.max\(HALF_MIN \+ sb, Math\.round\(h \* HALF\)\), full: h - STRIP \};/);
  assert.match(sheet, /const PEEK = 48;/);
  // The handle and the tab bar together take what the old handle and tab strip took, so the half sheet's content keeps its height and its floors.
  const px = (name) => parseFloat(new RegExp(`--${name}: (\\d+)px;`).exec(c)[1]);
  assert.equal(px('handle') + px('tabbar'), 68);
  assert.match(read('panel/looks.js'), /S\.panel\.setPeekExtra\?\.\(shown \? bar\.offsetHeight : 0\);/);
  // Beside the map nothing changes: the handle and the peek's line are the phone's, and are not drawn there.
  assert.match(c.slice(0, c.indexOf('/* bottom sheet */')), /^\.handle, \.peek-line \{ display: none; \}/m);
  assert.match(design(), /a fixed bar at the bottom of the\s+screen/);
});

test('H: the peek says the current tab\'s state in one line', async () => {
  const { peekLine } = await import('./static/peek.js');
  // Looks: nothing, a preview, what is on the lights.
  assert.equal(peekLine({ tab: 'looks', looks: [] }), 'Nothing on the lights');
  assert.equal(peekLine({ tab: 'looks', previewing: 2, looks: ['Amber wash'] }), 'Previewing 2 looks');
  assert.equal(peekLine({ tab: 'looks', previewing: 1 }), 'Previewing 1 look');
  assert.equal(peekLine({ tab: 'looks', looks: ['Amber wash'] }), 'Amber wash on the lights');
  assert.equal(peekLine({ tab: 'looks', looks: ['Amber wash', 'Slow drift'] }), '2 looks on the lights');
  assert.equal(peekLine({ tab: 'looks', looks: null }), 'Checking the lights…');
  // Status: the warning count, a fault in words, or all good.
  assert.equal(peekLine({ tab: 'status', status: { fault: '', issues: 0 } }), 'All good');
  assert.equal(peekLine({ tab: 'status', status: { fault: '', issues: 2 } }), '2 warnings to check');
  assert.equal(peekLine({ tab: 'status', status: { fault: '1 controller unreachable: Shed', issues: 1 } }), '1 controller unreachable: Shed');
  assert.equal(peekLine({ tab: 'status' }), 'Checking…');
  // Setup: calibration progress. Presets: the count.
  assert.equal(peekLine({ tab: 'setup', cal: { done: 33, total: 84 } }), 'Calibration: 33 of 84 steps');
  assert.equal(peekLine({ tab: 'setup', cal: { done: 84, total: 84 } }), 'Calibrated: 84 of 84');
  assert.equal(peekLine({ tab: 'setup' }), 'Set up the map');
  assert.equal(peekLine({ tab: 'presets', presets: { n: 11, pinned: 6 } }), '11 presets, 6 pinned');
  assert.equal(peekLine({ tab: 'presets', presets: { n: 1, pinned: 0 } }), '1 preset');
  // It is in the sheet, under the handle, only at the peek; a tap or a drag on it moves the sheet.
  assert.match(read('index.html'), /<p id="peekLine" class="peek-line" role="status"><\/p>/);
  assert.match(css(), /body\[data-detent=peek\] \.peek-line \{ display: block; \}/);
  assert.match(read('sheet.js'), /for \(const el of \[handle, peekLine\]\) \{/);
  assert.match(read('app.js'), /for \(const ev of \['tab', 'preview', 'house', 'status', 'statusSummary', 'calprogress', 'presets', 'layout'\]\) S\.on\(ev, showPeek\);/);
});

// ---------- G: everything works without a pointer ----------

test('G: roving focus moves by the arrow keys inside a group, and a group is one Tab stop', async () => {
  const { roveTo, currentItem, GROUPS } = await import('./static/a11y.js');
  const box = (left, top, w = 100, h = 40) => ({ left, top, right: left + w, bottom: top + h });
  // A segmented bar: one row. Left and Right step, Up and Down step too, the ends stop.
  const seg = [box(0, 0), box(100, 0), box(200, 0)];
  assert.equal(roveTo(seg, 0, 'ArrowRight'), 1);
  assert.equal(roveTo(seg, 1, 'ArrowLeft'), 0);
  assert.equal(roveTo(seg, 1, 'ArrowDown'), 2);
  assert.equal(roveTo(seg, 2, 'ArrowRight'), -1, 'the end does not wrap');
  assert.equal(roveTo(seg, 0, 'ArrowLeft'), -1);
  assert.equal(roveTo(seg, 2, 'Home'), 0);
  assert.equal(roveTo(seg, 0, 'End'), 2);
  assert.equal(roveTo(seg, 0, 'Home'), -1);
  // The library grid: three across, two rows, the second one short.
  const grid = [box(0, 0), box(110, 0), box(220, 0), box(0, 50), box(110, 50)];
  assert.equal(roveTo(grid, 1, 'ArrowDown'), 4);
  assert.equal(roveTo(grid, 2, 'ArrowDown'), 4, 'the nearest card in the row below');
  assert.equal(roveTo(grid, 4, 'ArrowUp'), 1);
  assert.equal(roveTo(grid, 3, 'ArrowDown'), -1);
  assert.equal(roveTo(grid, 2, 'ArrowRight'), 3, 'Right goes on to the next row');
  assert.equal(roveTo(grid, 0, 'End'), 4);
  // A list (the preset rows, Calibrate's progress): one column, Up and Down step.
  const list = [box(0, 0, 300), box(0, 50, 300), box(0, 100, 300)];
  assert.equal(roveTo(list, 0, 'ArrowDown'), 1);
  assert.equal(roveTo(list, 2, 'ArrowUp'), 1);
  assert.equal(roveTo(list, 1, 'ArrowRight'), 2);
  // A preset row's actions under each other's rows: Down keeps the column.
  const rows = [box(200, 0, 60), box(270, 0, 60), box(340, 0, 40), box(200, 50, 60), box(270, 50, 60), box(340, 50, 40)];
  assert.equal(roveTo(rows, 1, 'ArrowDown'), 4);
  assert.equal(roveTo(rows, 5, 'ArrowUp'), 2);
  assert.equal(roveTo(rows, 0, 'a'), -1);
  assert.equal(roveTo([], 0, 'ArrowDown'), -1);
  // The one Tab stop: the focused item, else the chosen one, else the first.
  assert.equal(currentItem([{ focused: false, chosen: false }, { focused: false, chosen: true }, { focused: true, chosen: false }]), 2);
  assert.equal(currentItem([{ focused: false, chosen: false }, { focused: false, chosen: true }]), 1);
  assert.equal(currentItem([{ focused: false, chosen: false }, { focused: false, chosen: false }]), 0);
  // Each group the plan names is a roving group: the library grid, the preset list, segmented controls, the target menu's chips, Calibrate's progress list, and the tabs.
  const groups = GROUPS.map(([g]) => g);
  for (const g of ['.cards', '.preset-library', '.seg', '.target-list', '.cal-prog', '[role=tablist]']) assert.ok(groups.includes(g), g);
  // Their markup is there for them to find.
  assert.match(read('index.html'), /<div class="tabs"><div class="tablist" role="tablist" aria-label="Sections">/);
  assert.match(read('panel/looks.js'), /<div class="target-list" id="lkTargetList"><\/div>/);
  assert.match(read('panel/presets.js'), /<div id="prList" class="preset-library"><\/div>/);
  assert.match(read('panel/calibrate.js'), /<h3 id="caProgress">Progress<\/h3><div class="cal-prog">/);
  assert.match(read('app.js'), /installRoving\(document, \{ onMove: \(item, group\) => \{ if \(group\.matches\('\[role=tablist\]'\)\) S\.panel\.arrowTo\(item\); \} \}\);/);
  // Typing in a field is never taken, and an arrow in a group does not scroll the panel.
  const a11y = read('a11y.js');
  assert.match(a11y, /t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA' \|\| t\.tagName === 'SELECT' \|\| t\.isContentEditable\) return;/);
  assert.match(a11y, /e\.preventDefault\(\); \/\/ an arrow in a group never scrolls the panel from under it/);
});

test('G: one live region says what changed', async () => {
  const { selectionWords, previewWords, mapWords, announce } = await import('./static/a11y.js');
  assert.equal(selectionWords('Shed eave', 'Shed'), 'Selected Shed eave, in Shed');
  assert.equal(selectionWords('Porch', 'Porch'), 'Selected Porch');
  assert.equal(selectionWords('Porch'), 'Selected Porch');
  assert.match(selectionWords(''), /^Selection cleared/);
  // The preview: a look added, one removed, all cleared, nothing changed.
  assert.equal(previewWords([], ['Amber wash'], 'Shed eave'), 'Previewing Amber wash on Shed eave');
  assert.equal(previewWords(['Amber wash'], ['Slow drift', 'Amber wash'], 'Everything'), 'Previewing Slow drift on Everything: 2 looks in the preview');
  assert.equal(previewWords(['Amber wash'], []), 'Preview cleared');
  assert.equal(previewWords(['A', 'B'], ['B']), 'Removed from the preview: 1 look left');
  assert.equal(previewWords(['A'], ['A']), '');
  // The map's description says what is selected and how to choose without a pointer.
  assert.match(mapWords({ selected: 'Shed eave', zone: 'Shed', showing: 'Showing your preview' }), /^Selected: Shed eave, in Shed\. Showing your preview\. To choose a run, an area or a zone without a pointer, use the Next look control on Looks\.$/);
  assert.match(mapWords({}), /^Nothing selected: the next look goes on everything\./);
  // announce is safe without a page (these tests), and the page has the two regions: polite, and assertive for errors.
  announce('nothing to say to');
  const html = read('index.html');
  assert.match(html, /<div id="live" class="sr-only" role="status" aria-live="polite"><\/div>/);
  assert.match(html, /<div id="liveAlert" class="sr-only" role="alert" aria-live="assertive"><\/div>/);
  // One region: the toast boxes are not live regions of their own, and every toast goes through announce.
  assert.doesNotMatch(html, /class="toasts[^"]*" aria-live/);
  assert.match(read('app.js'), /announce\(\[text, \.\.\.details\]\.join\('\. '\), \{ assertive: !!\(err \|\| opts\.error\) \}\);/);
  assert.match(read('app.js'), /announce\(selectionWords\(at\?\.name \|\| '', at\?\.zone \|\| ''\)\);/);
  assert.match(read('panel/looks.js'), /const words = previewWords\(saidPreview, names,/);
  // Calibration: a step change is said, and a confirmation leads it.
  const { stepWords } = await import('./static/panel/calibrate.js');
  assert.equal(stepWords('', { title: 'Line up Shed eave 2', on: 'on Shed eave' }), 'Line up Shed eave 2, on Shed eave');
  assert.equal(stepWords('Line up Shed eave 2|on Shed eave', { title: 'Line up Shed eave 3', on: 'on Shed eave' }, true), 'Confirmed. Line up Shed eave 3, on Shed eave');
  assert.equal(stepWords('A|b', { title: 'A', on: 'b' }), '');
  assert.equal(stepWords('A|b', { title: 'A', on: 'b' }, true), 'Confirmed: A.');
  // The map itself: a named image with a description.
  assert.match(html, /<canvas id="map" role="img" aria-label="Map of the lights" aria-describedby="mapDesc"><\/canvas>/);
});

test('G: the accessible-name audit: no interactive element in the page\'s markup is left without a name', () => {
  const files = ['index.html', '404.html', 'app.js', 'form.js', 'field.js', 'picker.js', 'states.js', 'dialog.js', 'panel/looks.js', 'panel/presets.js', 'panel/setup.js', 'panel/status.js', 'panel/calibrate.js'];
  const nameless = [];
  const named = (attrs) => /aria-label(ledby)?=|\$\{attrs\}/.test(attrs);
  for (const f of files) {
    const src = read(f);
    // Fields: a label of their own, or one wrapped around them.
    for (const m of src.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      if (/type="hidden"/.test(m[2]) || named(m[2])) continue;
      const before = src.slice(Math.max(0, m.index - 200), m.index);
      const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
      if (!wrapped && m[1] !== 'select' || (m[1] === 'select' && !wrapped && !/\/\/[^\n]*<select>/.test(src.slice(src.lastIndexOf('\n', m.index), m.index + 9)))) nameless.push(`${f}: <${m[1]}${m[2].slice(0, 60)}>`);
    }
    // Buttons: words inside, or a name when the inside is only an icon.
    for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      if (named(m[1])) continue;
      const words = m[2].replace(/\$\{icon\([^)]*\)\}/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
      if (!words) nameless.push(`${f}: <button${m[1].slice(0, 70)}>`);
    }
    // Every icon-only control with a name also has a tooltip.
    for (const m of src.matchAll(/<button\b([^>]*)>\s*\$\{icon\([^)]*\)\}\s*<\/button>/g)) {
      if (!/title=/.test(m[1])) nameless.push(`${f}: icon-only button without a title <button${m[1].slice(0, 70)}>`);
    }
  }
  // Buttons whose words are filled in by script are named there: these are the ones this audit cannot read, each checked by hand.
  const filledByScript = ['id="lkPushAll"', 'id="lkSwap"', 'id="suCal"', 'data-act="try"', 'class="picker-btn"', 'id="lkTarget"'];
  assert.match(read('picker.js'), /if \(label\) \{ btn\.setAttribute\('aria-label', label\);/);
  assert.match(read('panel/looks.js'), /targetBtn\.setAttribute\('aria-label', ctl\.aria\);/);
  const left = nameless.filter((n) => !filledByScript.some((k) => n.includes(k)));
  assert.deepEqual(left, [], 'interactive elements with no accessible name');
  assert.match(read('panel/looks.js'), /go\.setAttribute\('aria-label', plan\.label\);/);
  // The ones the plan names: the More glyph, the clear x, the brightness icon, Hide key, the sheet handle.
  assert.match(read('panel/presets.js'), /data-act="more" class="icon-btn" aria-haspopup="menu" aria-expanded="false" aria-label="\$\{esc\(`More for \$\{presetName\(p\)\}`\)\}" title="More: edit, duplicate or delete"/);
  assert.match(read('app.js'), /class="x" aria-label="Clear the selection" title="Clear the selection"/);
  assert.match(read('panel/looks.js'), /class="bri-label" title="How bright this look is"/);
  assert.match(read('panel/setup.js'), /textContent: folded \? 'Show key' : 'Hide key'/);
  assert.match(read('index.html'), /id="handle" class="handle" role="slider" tabindex="0" aria-label="Panel height" title="/);
  // Form rows name every control in them, and an error is tied to its field.
  assert.match(read('form.js'), /r\.setAttribute\('aria-label', c\.querySelector\('input\[type=range\]'\) && r\.type !== 'checkbox' \? `\$\{label\}, typed` : label\);/);
  assert.match(read('field.js'), /input\.setAttribute\('aria-describedby', err\.id\);/);
});

test('G: focus is kept, handed on and given back', async () => {
  const { keyboardClick } = await import('./static/sheet.js');
  assert.equal(keyboardClick({ detail: 0 }), true);
  assert.equal(keyboardClick({ detail: 1 }), false, 'a mouse click');
  assert.equal(keyboardClick({ detail: 0, pointerType: 'touch' }), false);
  const sheet = read('sheet.js'), looks = read('panel/looks.js'), presets = read('panel/presets.js'), status = read('panel/status.js');
  // The tabs: an arrow selects and stays; Enter or Space goes on into the panel's heading.
  assert.match(sheet, /if \(keyboardClick\(e\) && !arrowing\) enterTab\(b\.dataset\.tab\);/);
  assert.match(sheet, /b\.tabIndex = on \? 0 : -1;/);
  for (const t of ['looks', 'presets', 'setup', 'status']) assert.match(read('index.html'), new RegExp(`role="tab" id="tabbtn-${t}" aria-controls="tab-${t}" data-tab="${t}"`));
  // Choosing a place from the list selects it on the map, and focus goes back to the control.
  assert.match(looks, /if \(nd\) \{ if \(!S\.sel \|\| S\.sel\.node !== nd\) S\.select\(nd\); else fillTargets\(\); \}/);
  assert.match(looks, /openPicker\(false\);\s*targetBtn\.focus\(\{ preventScroll: true \}\);\s*if \(nd\)/);
  // Applying leaves the focus on the state card; clearing hands it to the library; Escape in the library clears a preview.
  assert.match(looks, /if \(fromBar && \$\$\('#lkBar'\)\.hidden\) \{ const t = \$\$\('#lkStageTitle'\); t\.tabIndex = -1; t\.focus\(\{ preventScroll: true \}\); \}/);
  assert.match(looks, /if \(fromBar\) focusLibrary\(\);/);
  assert.match(looks, /if \(e\.key !== 'Escape' \|\| !picker\.hidden \|\| !S\.preview\?\.layers\?\.length\) return;/);
  // A redraw does not drop the keyboard: the preset rows and the Status tiles give the focus back.
  assert.match(presets, /row\.dataset\.preset = p\.id;/);
  assert.match(presets, /\.querySelector\(`\[data-act="\$\{at\.act\}"\]`\)\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(status, /if \(held\) box\.querySelector\('#' \+ held\)\?\.focus\(\{ preventScroll: true \}\);/);
  // Menus give the focus back to their opener on Escape; dialogs are the browser's own modal.
  assert.match(presets, /escapeCloses\(row\.querySelector\('\.menu-wrap'\), \(\) => !menu\.hidden, \(\) => \{ close\(\); more\.focus\(\); \}\);/);
  assert.match(read('app.js'), /escapeCloses\(menu, \(\) => !menu\.hidden, \(\) => \{ close\(\); fold\.focus\(\); \}\);/);
  assert.match(read('dialog.js'), /d\.showModal\(\);/);
});

test('G: reduced motion, the focus ring, and the documented keys', () => {
  const c = css();
  // Under reduced motion no transition or animation runs longer than 1 ms.
  const rm = /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{([^}]*)\}/.exec(c)[1];
  assert.match(rm, /transition-duration: 0\.01ms !important;/);
  assert.match(rm, /animation-duration: 0\.01ms !important;/);
  // One focus ring, offset, on everything.
  assert.match(c, /^:focus-visible \{ outline: 2px solid #f8fafc; outline-offset: 2px; \}/m);
  // No visible chrome was added for any of this: the live region and the map's description are for a screen reader only.
  assert.match(c, /^\.sr-only \{ position: absolute; width: 1px; height: 1px;/m);
  // The keys are written down.
  const d = design();
  assert.match(d, /### Keyboard and assistive technology/);
  for (const k of ['Tab', 'Arrow keys', 'Home', 'End', 'Enter', 'Space', 'Escape']) assert.ok(d.slice(d.indexOf('### Keyboard and assistive technology')).includes(k), k);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8'), /scripts\/keyboard-check\.js/);
});
