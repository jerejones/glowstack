#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// keyboard-check drives the live map with the keyboard only, against a
// running Glowstack, and checks that everything works without a pointer:
//
//   - the walkthroughs: preview a look on a chosen run and put it on the
//     lights; undo; pin and unpin a preset; create a preset; start a
//     calibration step, nudge, confirm, go back;
//   - the Tab order of each tab, listed, with one stop per group;
//   - every focused control shows a focus ring;
//   - no interactive element is left without an accessible name;
//   - optionally an axe-core scan of each tab (--axe path/to/axe.min.js).
//
// It changes what is on the lights, the presets and the calibration of the
// instance it is pointed at, and puts them back. Point it only at an
// instance running an example config against fake controllers (README,
// "Checking the keyboard"). Never at a real installation.
//
//   node scripts/keyboard-check.js --url http://127.0.0.1:5199 [--phone] [--axe axe.min.js] [--chrome /usr/bin/google-chrome]
//
// Playwright is not a dependency of this repo: the script loads it from
// PLAYWRIGHT (a path to the package) or from wherever `playwright` resolves.
'use strict';
const fs = require('node:fs');

const arg = (name, fallback = '') => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const URL0 = String(arg('url', 'http://127.0.0.1:5199')).replace(/\/$/, '');
const PHONE = !!arg('phone', false);
const AXE = arg('axe', '');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, method = 'GET', body) => {
  const r = await fetch(URL0 + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

// In the page: what has the focus, in words.
const focused = () => {
  const e = document.activeElement;
  if (!e || e === document.body) return null;
  const text = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const cs = getComputedStyle(e), ring = e.matches('.handle') ? getComputedStyle(e.querySelector('i')) : cs;
  const outlined = (ring.outlineStyle !== 'none' && parseFloat(ring.outlineWidth) > 0) || /rgb/.test(cs.boxShadow) && cs.boxShadow !== 'none';
  return { tag: e.tagName.toLowerCase(), id: e.id, role: e.getAttribute('role') || '', text, ring: outlined, group: e.closest('[role=tablist], .seg, .chips.toggles, .cards, .target-list, .preset-library, .cal-prog')?.className?.split(' ')[0] || '' };
};

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: arg('chrome', undefined) === true ? undefined : arg('chrome', undefined) || undefined, args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: PHONE });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('glowstack.hint.tap', 'true'); localStorage.setItem('glowstack.sheet.detent', '"full"'); });
  const open = async (tab) => {
    await page.goto(`${URL0}/map/${tab}${PHONE ? '?pointer=coarse' : ''}`);
    await page.waitForFunction(() => window.glowstack?.view && !document.getElementById('bootLoading'), null, { timeout: 30000 });
    await wait(1200);
  };
  const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await wait(60); } };
  // tabTo presses Tab until the focus is on something matching sel.
  const tabTo = async (sel, { back = false, max = 120 } = {}) => {
    for (let i = 0; i < max; i++) {
      if (await page.evaluate((s) => !!document.activeElement?.matches?.(s), sel)) return true;
      await key(back ? 'Shift+Tab' : 'Tab');
    }
    return page.evaluate((s) => !!document.activeElement?.matches?.(s), sel);
  };
  const S = (fn, a) => page.evaluate(fn, a);
  const live = () => S(() => [document.getElementById('live')?.textContent.trim(), document.getElementById('liveAlert')?.textContent.trim()]);

  // ----- clean start -----
  await api('/api/map/preview/layers', 'DELETE');
  for (const l of (await api('/api/v1/layers')).layers || []) await api('/api/v1/layers/' + l.id, 'DELETE');
  await api('/api/v1/calibration/end', 'POST');

  // ----- 1. preview a look on a chosen run and put it on the lights -----
  await open('looks');
  const run = await S(() => { const g = window.glowstack.geo; const r = g.runs.find((x) => x.plan >= 0); return { id: r.id, name: r.name || r.id }; });
  check('the Next look control is reachable by Tab', await tabTo('#lkTarget'));
  await key('Enter'); await wait(300);
  await page.keyboard.type(run.name.slice(0, 6)); await wait(300);
  check('typing searches the list of places', await S(() => document.activeElement?.id === 'lkTargetSearch'));
  await tabTo('.target-list button');
  // Arrow to the run's own chip, then choose it.
  for (let i = 0; i < 40 && !(await S((n) => document.activeElement?.textContent.trim() === n, run.name)); i++) await key('ArrowRight');
  await key('Enter'); await wait(400);
  const sel = await S(() => { const s = window.glowstack.sel; return s ? { crumbs: !document.getElementById('crumbs').hidden, on: document.querySelector('#crumbs .on')?.textContent, focus: document.activeElement?.id } : null; });
  check('choosing a run from the keyboard selects it on the map, breadcrumb included', sel && sel.crumbs && sel.on === run.name, sel ? `breadcrumb "${sel.on}"` : 'no selection');
  check('focus returns to the control that opened the menu', sel && sel.focus === 'lkTarget');
  check('the selection is announced', /^Selected /.test((await live())[0] || ''), (await live())[0]);
  check('the map has a name and says what is selected', await S((n) => document.getElementById('map').getAttribute('role') === 'img' && !!document.getElementById('map').getAttribute('aria-label') && document.getElementById('mapDesc').textContent.includes(n), run.name));
  check('the library grid is reachable by Tab', await tabTo('.cards .preset'));
  const first = await S(() => document.activeElement.textContent.trim().slice(0, 30));
  await key('ArrowRight');
  const second = await S(() => document.activeElement.textContent.trim().slice(0, 30));
  check('arrow keys move within the library grid', first !== second && await S(() => document.activeElement.matches('.cards .preset')), `${first} -> ${second}`);
  await key('End'); await key('Home');
  check('Home returns to the first card', (await S(() => document.activeElement.textContent.trim().slice(0, 30))) === first);
  await key('Enter'); await wait(1500);
  let prev = (await api('/api/map/preview')).layers || [];
  check('Enter previews the look on the chosen run', prev.length === 1 && prev[0].target === 'run:' + run.id, prev.map((l) => l.target).join());
  check('the preview is announced', /^Previewing /.test((await live())[0] || ''), (await live())[0]);
  await key('Escape'); await wait(1200);
  prev = (await api('/api/map/preview')).layers || [];
  check('Escape in the library clears the preview', prev.length === 0);
  check('and the clearing is announced', /Preview cleared/.test((await live())[0] || ''), (await live())[0]);
  await tabTo('.cards .preset'); await key('Enter'); await wait(1500);
  check('the apply button is reachable by Tab', await tabTo('#lkPushAll'));
  await key('Enter'); await wait(1800);
  let house = ((await api('/api/v1/layers')).layers || []).filter((l) => !l.ephemeral);
  check('Enter puts the look on the lights', house.length === 1 && house[0].target === 'run:' + run.id);
  check('focus is left on the state card, not lost', await S(() => document.activeElement?.id === 'lkStageTitle'), JSON.stringify(await S(focused)));
  check('putting it on the lights is announced', /on the lights/.test((await live())[0] || ''), (await live())[0]);

  // ----- 2. undo -----
  const undoShown = await S(() => [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && /^Undo/.test(b.textContent.trim())).length);
  check('one Undo is offered', undoShown === 1, `${undoShown} visible`);
  check('Undo is reachable by Tab', await tabTo('[data-act=undo], #lkUndo'));
  await key('Enter'); await wait(1500);
  house = ((await api('/api/v1/layers')).layers || []).filter((l) => !l.ephemeral);
  check('Enter on Undo takes the look back off the lights', house.length === 0);
  check('the undo is announced', /Undone/.test((await live())[0] || ''), (await live())[0]);
  await S(() => window.glowstack.select(null));

  // ----- 3. the tabs; pin and unpin a preset -----
  await open('looks');
  check('the tabs are one Tab stop', await tabTo('[role=tab]') && await S(() => document.querySelectorAll('[role=tab][tabindex="0"]').length === 1 && document.activeElement.getAttribute('aria-selected') === 'true'));
  await key('ArrowRight'); await wait(500);
  check('an arrow key moves to the next tab and selects it', await S(() => document.activeElement?.dataset.tab === 'presets' && document.activeElement.getAttribute('aria-selected') === 'true' && !document.getElementById('tab-presets').hidden));
  await key('Enter'); await wait(300);
  check('Enter on a tab moves the focus into its panel', await S(() => document.getElementById('tab-presets').contains(document.activeElement) || document.activeElement?.id === 'tab-presets'), JSON.stringify(await S(focused)));
  check('a pin button is reachable by Tab', await tabTo('.preset-actions button'));
  for (let i = 0; i < 6 && !(await S(() => document.activeElement?.dataset.act === 'pin')); i++) await key('ArrowRight');
  const pinId = await S(() => document.activeElement.getAttribute('aria-label'));
  const was = await S(() => document.activeElement.getAttribute('aria-pressed'));
  await key('Enter'); await wait(900);
  const now = await S((label) => { const name = label.replace(/^(Unpin|Pin) /, ''); const b = [...document.querySelectorAll('.preset-actions [data-act=pin]')].find((x) => x.getAttribute('aria-label').endsWith(name)); return b?.getAttribute('aria-pressed'); }, pinId);
  check('Enter toggles the pin, and its pressed state says so', was !== now && ['true', 'false'].includes(now), `${was} -> ${now}`);
  check('the focus stays on the pin through the redraw', await S(() => document.activeElement?.dataset.act === 'pin'), JSON.stringify(await S(focused)));
  await key('Enter'); await wait(900);
  const back = await S((label) => { const name = label.replace(/^(Unpin|Pin) /, ''); const b = [...document.querySelectorAll('.preset-actions [data-act=pin]')].find((x) => x.getAttribute('aria-label').endsWith(name)); return b?.getAttribute('aria-pressed'); }, pinId);
  check('and Enter again puts it back', back === was, `${now} -> ${back}`);
  // The row's menu: Enter opens it, Escape closes it and focus returns to its button.
  for (let i = 0; i < 6 && !(await S(() => document.activeElement?.dataset.act === 'more')); i++) await key('ArrowRight');
  await key('Enter'); await wait(300);
  const menuOpen = await S(() => !!document.activeElement?.closest('[role=menu]'));
  await key('Escape'); await wait(200);
  check('a menu takes the focus when opened and gives it back on Escape', menuOpen && await S(() => document.activeElement?.dataset.act === 'more'));

  // ----- 4. create a preset -----
  const made = 'Keyboard check ' + Date.now().toString(36);
  check('New preset is reachable by Tab', await tabTo('#prNew', { back: true }) || await tabTo('#prNew'));
  await key('Enter'); await wait(900);
  check('the editor opens with the focus in it', await S(() => !!document.activeElement?.closest('#tab-presets') && !!document.getElementById('prName')));
  await tabTo('#prName'); await page.keyboard.type(made);
  await tabTo('#prSave'); await key('Enter'); await wait(400);
  const needsEffect = await S(() => document.getElementById('prEffectErr')?.textContent || '');
  if (needsEffect) {
    check('a missing field says so, tied to the field', /effect/i.test(needsEffect), needsEffect);
    await tabTo('#prEffect, #prEffect button, [id^=prEffect]', { back: true }); await key('Enter'); await wait(300); await key('ArrowDown'); await key('Enter'); await wait(400);
    await tabTo('#prSave'); await key('Enter');
  }
  await wait(1500);
  const list = (await api('/api/v1/presets')).presets || [];
  const mine = list.find((p) => (p.name || '') === made);
  check('Enter on Save creates the preset', !!mine, mine ? mine.id : 'not found');
  if (mine) await api('/api/v1/presets/' + encodeURIComponent(mine.id), 'DELETE');

  // ----- icon-only controls say their name in the page's tooltip, at once, when the keyboard reaches them -----
  await open('looks');
  const tipText = () => S(() => { const t = document.getElementById('tip'); return t && !t.hidden ? t.textContent : ''; });
  const tipClear = () => S(() => { const t = document.getElementById('tip'), a = document.activeElement; if (!t || t.hidden || !a) return false; const r = t.getBoundingClientRect(), q = a.closest('[data-tip]').getBoundingClientRect(); return r.bottom <= q.top || r.top >= q.bottom; });
  // With a place selected, the clear beside "Next look" and the breadcrumb's clear are in the page.
  await S(() => { const G = window.glowstack; G.select(G.tree.runNode(G.geo.runs.findIndex((r, i) => G.tree.runSets[i]?.length))); }); await wait(700);
  await S(() => document.activeElement?.blur());
  check('the clear beside Next look shows its tooltip on focus', await tabTo('#lkTargetClear') && (await tipText()) === 'Back to Everything' && await tipClear(), await tipText());
  check("the breadcrumb's clear shows its tooltip on focus", await tabTo('#crumbs .x', { back: true }) && (await tipText()) === 'Clear the selection' && await tipClear(), await tipText());
  check('a control with words shows none', await tabTo('#showSeg button') && (await tipText()) === '', await tipText());
  await S(() => window.glowstack.select(null)); await wait(400);
  await open('presets');
  // A preset row's actions are one Tab stop: the arrows reach More.
  let onMore = await tabTo('#prList .preset-entry button');
  for (let i = 0; onMore && i < 4 && !(await S(() => document.activeElement?.matches('[data-act=more]'))); i++) await key('ArrowRight');
  onMore = onMore && await S(() => !!document.activeElement?.matches('[data-act=more]'));
  check('the More glyph shows its tooltip on focus', onMore && /^More: /.test(await tipText()) && await tipClear(), await tipText());
  await S(() => document.activeElement?.blur());
  if (PHONE) {
    await S(() => document.activeElement?.blur());
    check("the sheet's handle shows its tooltip on focus", await tabTo('#handle') ? (await tipText()).length > 0 && await tipClear() : false, await tipText());
  }

  // ----- Reset view: absent at the default view, reached by Tab after the camera moves, gone after one press -----
  await open('looks');
  // Over a phone's full sheet the strip of map is framed on the selection and has no such button: the walk is at half height.
  if (PHONE) { await S(() => window.glowstack.panel.setDetent('half')); await wait(700); }
  const resetShown = () => S(() => { const b = document.getElementById('resetView'); return !!b && !b.hidden && b.getBoundingClientRect().width > 0; });
  check('no Reset view button at the default view', !(await resetShown()));
  // Moving the camera needs a pointer (the map has no key for it): the one wheel turn here.
  await page.mouse.move(PHONE ? 195 : 430, PHONE ? 190 : 470); await page.mouse.wheel(0, -400); await wait(900);
  check('Reset view appears once the camera has moved', await resetShown());
  await S(() => document.activeElement?.blur());
  check('Reset view is reachable by Tab, with a name', await tabTo('#resetView') && (await S(focused))?.text === 'Reset view', JSON.stringify(await S(focused)));
  await key('Enter'); await wait(900);
  check('Enter goes back to the default framing and the button goes', !(await resetShown()) && await S(() => window.glowstack.view.cameraState().auto));
  check('the focus is handed on, not dropped', await S(() => !!document.activeElement && document.activeElement !== document.body), JSON.stringify(await S(focused)));
  await S(() => window.glowstack.view.forget());
  if (PHONE) { await S(() => window.glowstack.panel.setDetent('full')); await wait(700); }

  // ----- 5. calibration: start a step, nudge, confirm, go back -----
  await open('setup');
  const before = await api('/api/v1/calibration');
  check('Calibrate is reachable by Tab', await tabTo('#suCal'));
  await key('Enter'); await wait(1500);
  check('the Calibrate panel takes the focus', await S(() => !!document.activeElement?.closest('#calibrate') || document.body.classList.contains('calibrating')));
  check('its progress list is one Tab stop with arrow keys', await tabTo('.cal-prog summary, .cal-prog button') && await (async () => { const a = await S(() => document.activeElement.textContent.trim().slice(0, 24)); await key('ArrowDown'); const b = await S(() => document.activeElement.textContent.trim().slice(0, 24)); return a !== b && await S(() => !!document.activeElement.closest('.cal-prog')); })());
  check('Start is reachable by Tab', await tabTo('#calibrate button.go', { back: true }) || await tabTo('#calibrate button.go'));
  await key('Enter'); await wait(1800);
  let st = await api('/api/v1/calibration');
  check('Enter starts a calibration step', st.active && !!st.target, st.target ? `${st.target.kind} ${st.target.run || ''} ${st.target.node || ''}` : '');
  check('the step is announced', /\S/.test((await live())[0] || ''), (await live())[0]);
  const at0 = st.cursors?.[st.side]?.index;
  await S(() => document.activeElement?.blur()); await key('+'); await wait(700);
  st = await api('/api/v1/calibration');
  check('+ nudges the pixel by one', st.cursors?.[st.side]?.index === at0 + 1, `${at0} -> ${st.cursors?.[st.side]?.index}`);
  const target = st.target, doneBefore = st.progress.filter((i) => i.done).length;
  await key('Enter'); await wait(2500);
  await page.waitForFunction(() => window.glowstack?.view && !document.getElementById('bootLoading'), null, { timeout: 30000 }); await wait(1500);
  st = await api('/api/v1/calibration');
  check('Enter confirms the point', st.progress.filter((i) => i.done).length === doneBefore + 1, `${doneBefore} -> ${st.progress.filter((i) => i.done).length} steps done`);
  check('Back to the previous point is reachable by Tab', await tabTo('#caBack'));
  await key('Enter'); await wait(1200);
  st = await api('/api/v1/calibration');
  check('Enter on it reopens the point just confirmed', JSON.stringify(st.target) === JSON.stringify(target));
  // Escape asks before stopping, in a dialog that takes the focus, keeps it, and gives it back.
  await tabTo('#caConfirm');
  await key('Escape'); await wait(500);
  const dialog = await S(() => { const d = document.querySelector('dialog[open]'); return d ? { in: d.contains(document.activeElement) } : null; });
  check('Escape asks before stopping, in a dialog that takes the focus', dialog && dialog.in);
  if (dialog) {
    // A modal dialog's Tab cycle is its own controls and the browser's chrome (the page reports that as
    // the body): never a control of the page behind it. Every stop is checked, not only the last.
    const stops = [];
    for (let i = 0; i < 6; i++) { await key('Tab'); stops.push(await S(() => { const a = document.activeElement, d = document.querySelector('dialog[open]'); return d && d.contains(a) ? 'dialog' : !a || a === document.body ? 'browser' : `page: ${a.tagName.toLowerCase()}#${a.id}`; })); }
    check('the dialog keeps the focus inside it', stops.every((x) => x === 'dialog' || x === 'browser') && stops.includes('dialog'), stops.join(' '));
    for (let i = 0; i < 3 && !(await S(() => !!document.querySelector('dialog[open]')?.contains(document.activeElement))); i++) await key('Tab');
    await key('Escape'); await wait(400);
    check('Escape closes the dialog and the focus goes back where it was', await S(() => !document.querySelector('dialog[open]') && document.activeElement?.id === 'caConfirm'), JSON.stringify(await S(focused)));
  }
  // Put the measurement back as it was (the map reloads when the layout changes).
  await api('/api/v1/calibration/forget', 'POST', {});
  await wait(2500);
  await page.waitForFunction(() => window.glowstack?.view && !document.getElementById('bootLoading'), null, { timeout: 30000 }); await wait(1500);
  // Escape reaches the question from every focus position, with the focus on Stop (B152).
  // The map has no Tab stop: a click on an empty corner of it is the one pointer press here.
  const places = {
    'the body, nothing focused': () => S(() => document.activeElement?.blur()),
    'the map': async () => { await S(() => document.activeElement?.blur()); await page.mouse.click(6, PHONE ? 70 : 120); },
    'a nudge button in the dock': () => S(() => document.querySelector('#calibrate [data-by="1"]').focus()),
    "the dock's checkbox": () => S(() => document.getElementById('caNext').focus()),
    'the progress list': () => S(() => document.querySelector('.cal-prog summary, .cal-prog button').focus()),
  };
  for (const [name, go] of Object.entries(places)) {
    await go(); await wait(200);
    await key('Escape'); await wait(450);
    const asked = await S(() => { const d = document.querySelector('dialog[open]'); return d ? { title: d.querySelector('h3')?.textContent || '', on: document.activeElement?.value || '' } : null; });
    check(`Escape from ${name} asks "Stop calibrating?" with the focus on Stop`, asked && /Stop calibrating/.test(asked.title) && asked.on === 'yes', JSON.stringify(asked));
    if (asked) { await key('Escape'); await wait(350); }
  }
  check('Escape twice keeps calibrating', (await api('/api/v1/calibration')).active === true);
  // Stop the way the Stop button's hint says: Escape, then Enter.
  await S(() => document.activeElement?.blur());
  await key('Escape'); await wait(450);
  await key('Enter'); await wait(1800);
  st = await api('/api/v1/calibration');
  check('Escape then Enter stops the session', !st.active && await S(() => !document.querySelector('dialog[open]') && !document.body.classList.contains('calibrating')));
  await api('/api/v1/calibration/end', 'POST');
  st = await api('/api/v1/calibration');
  check('the calibration is left as it was found', st.progress.filter((i) => i.done).length === before.progress.filter((i) => i.done).length && !st.active);

  // ----- the Tab order of each tab, a focus ring on every stop, names for everything -----
  for (const tab of ['looks', 'presets', 'setup', 'status']) {
    await open(tab);
    if (tab === 'status') await wait(2200);
    const order = [];
    let noRing = 0;
    for (let i = 0; i < 90; i++) {
      await key('Tab');
      const f = await S(focused);
      if (!f) break;
      const sig = `${f.tag}#${f.id}|${f.text}`;
      if (order.length && order[0].sig === sig) break;
      order.push({ ...f, sig });
      if (!f.ring) noRing++;
    }
    const groups = order.filter((f) => f.group).map((f) => f.group);
    const twice = groups.filter((g, i) => g !== 'seg' && g !== 'chips' && g !== 'cards' && groups.indexOf(g) !== i);
    console.log(`Tab order, ${tab} (${order.length} stops): ` + order.map((f) => `${f.text || f.id || f.tag}${f.group ? ` [${f.group}]` : ''}`).join(' › '));
    check(`${tab}: every Tab stop shows a focus ring`, noRing === 0, `${noRing} without`);
    check(`${tab}: the tabs and each list are one Tab stop`, twice.length === 0, twice.join());
    const nameless = await S(() => {
      const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[inert]') && !e.closest('[aria-hidden=true]');
      const text = (e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
      const nameOf = (e) => e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => text(document.getElementById(id) || document.createElement('i'))).join(' ').trim() || (e.id && text(document.querySelector(`label[for="${CSS.escape(e.id)}"]`) || document.createElement('i'))) || (e.closest('label') && text(e.closest('label'))) || (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) ? e.getAttribute('title') || '' : text(e) || e.getAttribute('title') || '');
      return [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=slider], [role=menuitem], [tabindex]:not([tabindex="-1"])')].filter(vis).filter((e) => !nameOf(e)).map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + e.className);
    });
    check(`${tab}: every interactive element has an accessible name`, nameless.length === 0, nameless.slice(0, 5).join(', '));
    if (AXE && AXE !== true) {
      await page.evaluate(fs.readFileSync(AXE, 'utf8'));
      const bad = await S(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id} x${v.nodes.length}`));
      check(`${tab}: axe finds nothing serious or critical`, bad.length === 0, bad.join(', '));
    }
  }
  check('no script error on any page', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ----- leave it as it was -----
  await api('/api/map/preview/layers', 'DELETE');
  for (const l of (await api('/api/v1/layers')).layers || []) await api('/api/v1/layers/' + l.id, 'DELETE');
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? ': ' + failed.map((r) => r.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
