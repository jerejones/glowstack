// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Looks tab: one stage and one library. The stage is the single home for
// layers: what is being previewed and what is on the lights, in one list, top
// in front. Clicking a card in the library adds a preview row; the action bar,
// there only while a preview exists, puts it on the lights. Each row has a
// brightness slider (sent as you drag) and Tweak. Tweaking a look on the
// lights edits a preview copy; applying the copy promotes it and then removes
// the original, in that order, so the lights are never without the look. The
// preview clock is a line below the library that opens to its controls.
import { api, post, del, patch, esc, save, load, parseQty, press, covers, sameSet, humanize, noOrphan } from '../util.js';
import { nodeName, nodeTarget, targetName, targetGroups, targetRanges } from '../select.js';
import { houseStatusMessage, lightOutcome, turnOnLabel, turnOnZones, zoneWarning, BRIGHTNESS_RULE } from '../house-status.js';
import { createForm, patcher, effectFor, valuesFor, layerName, lookStrip, presetName } from '../form.js';
import { showState, stateHTML } from '../states.js';
import { icon } from '../icons.js';
import { textField } from '../field.js';
import { escapeCloses } from '../picker.js';

const COPIES = 'glowstack.copies'; // preview copy id → the lights layer it stands in for
const CLOCK = 'glowstack.clock.open';
const TARGET = 'glowstack.looks.target';
const FILTER = 'glowstack.looks.filter';

// effectKind says what an effect takes its colors from, for its card.
export function effectKind(e) {
  const has = (type) => e.params.some((p) => p.type === type);
  if (e.params.some((p) => p.name.includes('.'))) return 'Layered effects';
  if (e.params.some((p) => p.name === 'bands')) return 'Color bands';
  if (has('palette')) return 'Blended colors';
  if (has('colors')) return 'Several colors';
  if (has('color')) return 'Single color';
  return 'Animated effect';
}

// effectSummary names an effect with what it takes its colors from,
// without saying the same word twice.
export function effectSummary(e) {
  const name = e.name || e.id, kind = effectKind(e);
  return kind.toLowerCase().includes(String(name).toLowerCase()) ? kind : `${name} · ${kind}`;
}

// cardSummary is a preset card's second line, short enough for the grid: the
// effect's name, or what it takes its colors from when the name says the same.
export function cardSummary(name, e) {
  const [effect, kind] = effectSummary(e).split(' · ');
  return kind && effect.toLowerCase() === String(name).toLowerCase() ? kind : effect;
}

const speedLabel = (s) => (s >= 1 ? s.toFixed(s >= 10 ? 0 : 1) : s.toFixed(2)) + '×';

// clockText is the preview clock's line, in plain words. Hours and minutes
// are all anyone reads, but scrubbing needs to see each frame go by.
export function clockText(st, scrubbing = false) {
  const time = new Date(st.t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(scrubbing ? { second: '2-digit', fractionalSecondDigits: 3 } : {}) });
  const where = !st.following ? `${Math.abs(st.offset).toFixed(2)} s ${st.offset >= 0 ? 'ahead of' : 'behind'} the lights`
    : st.speed !== 1 ? `${speedLabel(st.speed)} speed` : 'in step with the lights';
  return `${st.paused ? 'Paused · ' : ''}${time} · ${where}`;
}

// previewState is the stage's state for a preview it can't list yet.
export function previewState(preview, status) {
  if (preview) return null;
  return status === 'failed' ? { kind: 'error', title: 'Could not load the preview', detail: "Glowstack didn't answer. The lights are not affected." } : { kind: 'loading', title: 'Loading the preview…' };
}

// houseState is the stage's state for the lights when it has no rows to show.
export function houseState(status, count) {
  const title = houseStatusMessage(status, count);
  if (!title) return null;
  if (status === 'unavailable') return { kind: 'error', title, detail: "Glowstack didn't answer. The lights are not affected." };
  return { kind: status === 'available' ? 'empty' : 'loading', title };
}

// stageTitle names the stage by what it holds. live and preview count rows;
// read says the lights have been read at least once.
export function stageTitle({ live, preview, read = true, status = 'available' }) {
  if (preview && live) return "Previewing over what's on the lights";
  if (preview) return 'Previewing';
  if (live) return 'On the lights';
  if (!read) return status === 'unavailable' ? "Couldn't read the lights" : 'Checking the lights…';
  return 'Nothing on the lights';
}

// stageSub is the stage's one line under its title. A failed refresh keeps
// the last state and says so.
export function stageSub({ rows, stale, word }) {
  if (stale) return "Couldn't refresh. This is the last known state.";
  return rows ? '' : `${word} a look below to preview it on the map; the lights don't change.`;
}

const FILTER_WORDS = { pinned: 'Pinned', presets: 'All presets', effects: 'Effects' };
const FILTER_NOUNS = { pinned: 'pinned presets', presets: 'presets', effects: 'effects' };

// noMatch is the library's empty state for a search: what didn't match, and
// the lists that aren't selected, by the names on their buttons.
export function noMatch(which, q) {
  const others = Object.keys(FILTER_WORDS).filter((k) => k !== which).map((k) => FILTER_WORDS[k]);
  return { kind: 'empty', title: `No ${FILTER_NOUNS[which]} match “${q}”`, detail: `Try ${others.join(' or ')}.` };
}

// lookKey says which look a layer (or a card's look) is.
export const lookKey = (l) => (l.preset ? 'preset:' + l.preset : 'effect:' + l.effect);

// lookAction is what tapping a look does, given the preview's layers: add
// it, or, when the target already has it, take it back off. A layer that
// has been tweaked isn't thrown away by a tap: it is focused instead.
// sameTarget says two targets are the same lights.
export function lookAction(layers, target, look, copies = {}, sameTarget = (a, b) => a === b) {
  const key = lookKey(look);
  const same = layers.find((l) => sameTarget(l.target, target) && lookKey(l) === key);
  if (!same) return { add: true };
  return copies[same.id] || Object.keys(same.params || {}).length ? { focus: same.id } : { remove: same.id };
}

// replacedBy lists the lights' layers the preview would hide completely:
// every one of their pixels is under a preview layer. rangesOf gives a
// target's pixels as [first, last] pairs; originals are layers the preview
// already stands in for, which Apply removes anyway.
export function replacedBy(house, preview, rangesOf, originals = new Set()) {
  const covers = (ranges, [a, b]) => {
    let next = a;
    for (const [x, y] of [...ranges].sort((p, q) => p[0] - q[0])) {
      if (x > next) return false;
      next = Math.max(next, y + 1);
      if (next > b) return true;
    }
    return false;
  };
  const over = preview.flatMap((l) => rangesOf(l.target) || []);
  return house.filter((l) => {
    if (originals.has(l.id)) return false;
    const rs = rangesOf(l.target);
    return rs && rs.length && rs.every((r) => covers(over, r));
  });
}

// replaceNote is the bar's one line on what Replace takes off. A long
// list is a count, so the line never wraps.
export function replaceNote(names) {
  if (!names.length) return '';
  const list = names.join(' and ');
  return `Replaces ${names.length < 3 && list.length <= 40 ? list : `${names.length} ${names.length === 1 ? 'look' : 'looks'}`}`;
}

// applyPlan is the action bar in words: the primary button's label, whether
// Add or Replace is a choice here, and the one line saying what happens.
// hidden names the looks on the lights the preview would cover completely;
// house counts what's on the lights; updates says a tweak of a live look is
// in the preview, which always goes in place of the original.
export function applyPlan({ n, updates, house, hidden, mode }) {
  const looks = `${n} ${n === 1 ? 'look' : 'looks'}`;
  if (updates) return { label: `Update ${looks} on the lights`, choice: false, replace: false, note: 'Your changes go on the lights in place of the original.' };
  if (!house) return { label: `Put ${looks} on the lights`, choice: false, replace: false, note: '' };
  if (!hidden.length) return { label: `Add ${looks} on top`, choice: false, replace: false, note: "What's on the lights stays underneath." };
  if (mode === 'add') return { label: `Add ${looks} on top`, choice: true, replace: false, note: "Goes on top; what's there stays underneath." };
  const stay = house - hidden.length;
  return { label: `Replace what's on the lights with ${looks}`, choice: true, replace: true, note: replaceNote(hidden) + (stay ? ` · ${stay} more ${stay === 1 ? 'stays' : 'stay'}` : '') };
}

// applyResult is what Apply reports: plain success only when the look can
// be seen. outcome is lightOutcome for the applied looks.
export function applyResult(what, outcome, cardShown = false) {
  if (!outcome.dark) return { text: `Applied ${what}.`, warn: false };
  // The banner on screen says why, once: this only confirms, in a neutral color.
  if (cardShown) return { text: `Applied ${what}.`, warn: false, neutral: true };
  const lead = outcome.dark === 'none' ? `Applied ${what}, but they stay dark.` : `Applied ${what}, but part of it stays dark.`;
  return { text: `${lead} ${outcome.message}`, warn: true };
}
const applyToast = (S, what, outcome, cardShown) => {
  const r = applyResult(what, outcome, cardShown);
  return S.toast(r.text, r.warn ? { ms: 9000, warn: true } : r.neutral ? { neutral: true } : {});
};

// underBar says a card is cut by the sticky bar's top edge.
export const underBar = (rect, barTop) => rect.top < barTop && rect.bottom > barTop;

// revealDelta is how far to scroll to open a form in view: its first control
// above the sticky bar, then as much of the rest as fits, never at the cost
// of the top. Rects are {top, bottom}; viewTop and viewBottom bound what shows.
export function revealDelta({ top, bottom }, viewTop, viewBottom) {
  if (top < viewTop) return top - viewTop;
  return Math.min(Math.max(0, bottom - viewBottom), top - viewTop);
}

// laneAim is what revealing a card has to show. A lane's first card brings
// the lane's heading with it, so the heading is never left clipped at the top.
export function laneAim(card, headTop, first) { return first ? { top: headTop, bottom: card.bottom } : card; }

export function createLooks(S, root) {
  const g = S.geo;
  let copies = load(COPIES, {}) || {};
  let target = load(TARGET, '');      // chosen when nothing is selected
  let filter = load(FILTER, '');      // the library's list; '' follows the pins
  let mode = 'replace';               // Replace or Add, while a preview can do either
  const cards = new Map(); // lane:id → row
  const word = S.coarse ? 'Tap' : 'Click';
  root.innerHTML = `
    <div class="looks-head"><h1 class="title">Looks</h1></div>
    <section class="stage" id="lkStage" aria-labelledby="lkStageTitle">
      <div class="stage-head"><h2 id="lkStageTitle"></h2><small id="lkStageSub"></small></div>
      <p class="muted small stage-note" id="lkMapNote" hidden>The map is showing the lights, not this preview. <button type="button" id="lkShowPreview">Show preview</button></p>
      <div class="stage-warn" id="lkDark" data-dark hidden></div>
      <div class="list" id="lkRows"></div>
      <div id="lkStageState"></div>
    </section>
    <section class="library" aria-label="Presets and effects">
      <div class="catalog-head" id="lkCatalogHead">
        <h2 class="group-head">Library</h2>
        <button type="button" class="target-btn icon-btn" id="lkTarget" aria-expanded="false" aria-controls="lkPicker" title="Where the next preset or effect you pick goes. Looks already added keep their own place, on their rows." aria-haspopup="dialog"><span class="muted">New previews go on</span><b id="lkTargetName"></b>${icon('chevronDown')}</button>
        <div class="target-picker" id="lkPicker" role="dialog" aria-label="Where the next look goes" hidden>
          <div class="pick-head"><h2 id="lkPickTitle"></h2><button type="button" class="icon-btn" id="lkPickClose" aria-label="Close" title="Close">${icon('close')}</button></div>
          ${textField({ ariaLabel: 'Find a place', id: 'lkTargetSearch', type: 'search', placeholder: 'Find a place' })}
          <div class="muted small" id="lkPickHint">${word} the map to pick a run; ${word.toLowerCase()} again for the area around it.</div>
          <div class="target-list" id="lkTargetList"></div>
        </div>
      </div>
      <div class="lib-filters">
        <div class="seg" id="lkFilter" role="group" aria-label="Which looks to list"><button type="button" data-filter="pinned">Pinned</button><button type="button" data-filter="presets">All presets</button><button type="button" data-filter="effects">Effects</button></div>
        ${textField({ ariaLabel: 'Find a look', id: 'lkFind', type: 'search', placeholder: 'Find a look' })}
      </div>
      <div class="cards" id="lkPresets"></div>
      <details class="words" id="lkWords"><summary>What these words mean</summary><p class="muted small">A look is what the lights show: a saved preset, or an effect with your own settings. It goes on a zone (what Home Assistant controls), an area (part of a zone) or a run (one strip of lights).</p><p class="muted small">${BRIGHTNESS_RULE}</p></details>
    </section>
    <details class="clock-box" id="lkClockBox" hidden><summary>Preview clock <span class="clock-hint muted">Pause or scrub the preview</span><span class="t" id="lkClockText"></span></summary>
    <div class="muted small">Pause, slow or scrub the preview to look at one moment. The lights keep running.</div>
    <div class="clock" id="lkClock">
      <button type="button" id="lkPlay" class="icon-btn" title="Pause or resume the preview clock (space)" aria-label="Pause the preview clock"></button>
    </div>
    <div class="clock-more" id="lkClockPanel">
      <div class="step-pair" role="group" aria-label="Step one frame">
        <button type="button" id="lkBack" class="icon-btn" title="Step back one frame" aria-label="Step back one frame">${icon('stepBack')}</button>
        <button type="button" id="lkFwd" class="icon-btn" title="Step forward one frame" aria-label="Step forward one frame">${icon('stepForward')}</button>
        <span class="muted">Step one frame</span>
      </div>
      <span>Speed</span><input type="range" id="lkSpeed" min="-1" max="1" step="0.01" value="0"><output id="lkSpeedOut">1×</output>
      <span>Scrub</span><input type="range" id="lkScrub" min="-30" max="30" step="0.02" value="0"><span class="muted small">±30 s</span>
      <span></span><button type="button" id="lkLive" title="Back in step with the lights">Now</button><span></span>
    </div>
    </details>
    <div class="look-bar" id="lkBar" hidden>
      <div class="bar-main">
        <div class="seg" id="lkMode" role="group" aria-label="What happens to what's on the lights" hidden><button type="button" data-mode="replace">Replace</button><button type="button" data-mode="add">Add</button></div>
        <button type="button" class="go icon-btn" id="lkPushAll"></button>
      </div>
      <div class="bar-line"><p class="bar-note" id="lkBarNote"></p><button type="button" id="lkClear" class="quiet icon-btn" title="Take everything off the preview; the lights don't change">${icon('close')}Clear preview</button></div>
    </div>`;
  const $$ = (sel) => root.querySelector(sel);

  // ---------- target ----------

  // currentTarget is where a look goes: the map's selection, else the
  // place chosen here while the geometry still has it, else everything.
  function currentTarget() {
    if (S.sel) return nodeTarget(S.sel.node);
    return target && targetRanges(g, S.tree, target) ? target : 'all';
  }
  const picker = $$('#lkPicker'), pickList = $$('#lkTargetList'), targetBtn = $$('#lkTarget'), search = $$('#lkTargetSearch'), head = $$('#lkCatalogHead');
  // The one list of places serves the Goes on button, and, inside a preview
  // card, that layer's own place. pickFor is the card it is open for.
  let pickFor = null, opener = targetBtn;
  const targetKey = (t) => JSON.stringify(targetRanges(g, S.tree, t));
  const sameTarget = (a, b) => a === b || targetKey(a) === targetKey(b);
  function fillTargets() {
    const t = currentTarget();
    $$('#lkTargetName').textContent = S.sel ? nodeName(S.sel.node) : targetName(g, t);
    if (picker.hidden) return;
    const value = pickFor ? pickFor.layer.target : t;
    const groups = targetGroups(S.tree, { query: search.value, visibleRuns: S.visibility.runs });
    pickList.replaceChildren(...groups.map((grp) => {
      const group = document.createElement('section');
      group.className = 'target-group';
      const head = document.createElement('h3');
      head.textContent = grp.label;
      const box = document.createElement('div');
      box.className = 'chips';
      box.append(...grp.items.map((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.label;
        press(b, sameTarget(it.value, value));
        b.onclick = () => choose(it.value);
        return b;
      }));
      if (grp.kind === 'all') { group.append(box); return group; } // its chip says Everything already
      group.append(head, box);
      if (grp.kind === 'run') {
        const hint = document.createElement('div');
        hint.className = 'muted small';
        hint.textContent = 'A run that is a whole area or zone is listed there instead.';
        group.append(hint);
      }
      return group;
    }));
    if (!groups.length) showState(pickList, { kind: 'empty', title: 'No place by that name' });
  }
  const outside = (e) => { if (!picker.contains(e.target) && !opener.contains(e.target)) openPicker(false); };
  // openPicker opens the list for the next look, or for card c's own place.
  // On a phone it is its own full sheet, and the sheet goes back after.
  let detentBefore = '';
  function openPicker(on, c = null) {
    opener.setAttribute('aria-expanded', 'false');
    picker.hidden = !on;
    pickFor = on ? c : null;
    opener = pickFor ? pickFor.el.querySelector('.place') : targetBtn;
    opener.setAttribute('aria-expanded', on ? 'true' : 'false');
    const asSheet = on && S.panel.layout() === 'sheet';
    picker.classList.toggle('as-sheet', asSheet);
    (asSheet ? document.getElementById('panel') : pickFor ? pickFor.el.querySelector('.place-row') : head).append(picker);
    if (asSheet && S.panel.detent() !== 'full') { detentBefore = S.panel.detent(); S.panel.setDetent('full'); }
    else if (!on && detentBefore) { S.panel.setDetent(detentBefore); detentBefore = ''; }
    const title = pickFor ? 'Where this look goes' : 'Where the next look goes';
    picker.setAttribute('aria-label', title);
    picker.querySelector('#lkPickTitle').textContent = title;
    picker.querySelector('#lkPickHint').hidden = !!pickFor;
    document[on ? 'addEventListener' : 'removeEventListener']('pointerdown', outside, true);
    if (on) { search.value = ''; fillTargets(); fitPicker(); if (!S.coarse) search.focus(); }
  }
  // fitPicker keeps the floating list inside the panel, above the Apply bar;
  // a sheet with too little room rises first.
  function fitPicker() {
    const list = pickList, content = root.parentElement, bar = $$('#lkBar');
    picker.style.top = '';
    if (picker.classList.contains('as-sheet')) { list.style.maxHeight = ''; picker.classList.remove('up'); return; }
    const room = () => content.getBoundingClientRect().bottom - list.getBoundingClientRect().top - (bar.hidden ? 0 : bar.offsetHeight) - 12;
    // A card low in the list has its room above it: bring the card up first.
    picker.classList.remove('up');
    // Right under its own button, not under a Tweak form that is open below it.
    if (pickFor) picker.style.top = pickFor.el.querySelector('.place-row').getBoundingClientRect().bottom - pickFor.el.getBoundingClientRect().top + 4 + 'px';
    // Its least height first: the room is what's left with that much open.
    list.style.maxHeight = '220px';
    if (pickFor) pickFor.el.querySelector('.place-row').scrollIntoView({ block: 'start' });
    // At the end of the list there's no scrolling further: it opens upward.
    if (pickFor && room() < 220) {
      const row = pickFor.el.querySelector('.place-row').getBoundingClientRect().top - content.getBoundingClientRect().top;
      picker.classList.add('up');
      picker.style.top = '';
      list.style.maxHeight = Math.max(120, row - (picker.offsetHeight - list.offsetHeight) - 16) + 'px';
    } else list.style.maxHeight = Math.max(120, room()) + 'px';
    picker.scrollIntoView({ block: 'nearest' });
  }
  for (const el of [targetBtn, picker]) escapeCloses(el, () => !picker.hidden, () => { const back = opener; openPicker(false); back.focus(); });
  // moveLayer gives one preview layer a new place. Where the next look goes
  // doesn't change: that is the Goes on button's.
  async function moveLayer(c, value) {
    const back = opener;
    openPicker(false);
    back.focus({ preventScroll: true });
    if (sameTarget(c.layer.target, value)) return;
    try {
      await patch('/api/v1/preview/layers/' + encodeURIComponent(c.id), { target: value });
      await S.refresh();
    } catch (e) { S.fail('move the look', e); }
  }
  function choose(value) {
    if (pickFor) { moveLayer(pickFor, value); return; }
    target = value;
    save(TARGET, target);
    openPicker(false);
    targetBtn.focus({ preventScroll: true });
    if (S.sel && value !== nodeTarget(S.sel.node)) S.select(null);
    else { fillTargets(); markPreviewed(); }
  }
  targetBtn.onclick = () => openPicker(picker.hidden);
  picker.querySelector('#lkPickClose').onclick = () => { const back = opener; openPicker(false); back.focus({ preventScroll: true }); };
  S.on('layout', () => { if (!picker.hidden) openPicker(false); });
  search.oninput = fillTargets;
  S.on('runVisibility', fillTargets);
  S.on('select', () => { fillTargets(); renderStage(); });

  // ---------- presets and effects ----------

  function card(name, sub, strip, look, onclick, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.title = title || name;
    b.innerHTML = `<span class="strip" style="background:${esc(strip)}"></span><span class="name">${esc(noOrphan(name))}</span><span class="sub">${esc(sub)}</span><span class="in-badge">${icon('eye')}<span>Previewing</span></span>`;
    b.dataset.look = look;
    b.onclick = onclick;
    return b;
  }
  // activeFilter is the library's list: the choice made here, else the pins
  // while there are any.
  const activeFilter = () => filter || (S.presets.some((p) => p.pinned) ? 'pinned' : 'presets');
  const lookCards = {
    presets: (list) => list.map((p) => {
      const name = presetName(p), e = effectFor(S, { preset: p.id });
      return card(name, e ? cardSummary(name, e) : humanize(p.effect), lookStrip(S, p.effect, p.params), 'preset:' + p.id, () => push({ preset: p.id }), `Preview ${name} here`);
    }),
    effects: (list) => list.map((e) => card(e.name || e.id, effectKind(e), lookStrip(S, e.id, {}), 'effect:' + e.id, () => push({ effect: e.id }))),
  };
  function renderCatalog() {
    const grid = $$('#lkPresets');
    if (S.library.presets === 'failed' || S.library.catalog === 'failed') {
      // Failing is not the same as having nothing: say so, with Retry.
      grid.classList.remove('cards');
      showState(grid, { kind: 'error', title: S.library.presets === 'failed' ? 'Could not load your presets' : 'Could not load the effects', detail: 'Glowstack did not return them. The lights are not affected.', retry: S.retryLibrary });
      return;
    }
    grid.classList.add('cards');
    const which = activeFilter();
    for (const b of $$('#lkFilter').children) press(b, b.dataset.filter === which);
    const q = $$('#lkFind').value.trim().toLowerCase();
    const list = which === 'effects' ? S.catalog.effects || [] : which === 'pinned' ? S.presets.filter((p) => p.pinned) : S.presets;
    const named = q ? list.filter((x) => (which === 'effects' ? x.name || x.id : presetName(x)).toLowerCase().includes(q)) : list;
    grid.replaceChildren(...lookCards[which === 'effects' ? 'effects' : 'presets'](named));
    if (!grid.childElementCount) {
      grid.classList.remove('cards');
      if (q) showState(grid, noMatch(which, $$('#lkFind').value.trim()));
      else if (which === 'pinned') showState(grid, { kind: 'empty', title: 'Nothing pinned yet', detail: 'Pin a preset on the Presets tab to keep it here.' });
      else if (which === 'effects') showState(grid, { kind: 'empty', title: 'No effects to show' });
      else {
        grid.innerHTML = stateHTML({ kind: 'empty', title: 'No presets yet', detail: 'Save a look as a preset and it appears here.', action: { id: 'lkEmptyNew', label: 'New preset' } });
        grid.querySelector('#lkEmptyNew').onclick = () => { S.panel.openTab('presets'); S.presetLibrary.openEditor(); };
      }
    }
    markPreviewed();
  }
  for (const b of $$('#lkFilter').children) b.onclick = () => { filter = b.dataset.filter; save(FILTER, filter); renderCatalog(); };
  $$('#lkFind').oninput = renderCatalog;

  // markPreviewed shows which cards are in the preview on the current
  // target: the same look on somewhere else isn't this one.
  function markPreviewed() {
    const t = currentTarget();
    const layers = S.preview ? S.preview.layers : [];
    const on = new Set(layers.filter((l) => sameTarget(l.target, t)).map(lookKey));
    const elsewhere = new Set(layers.filter((l) => !sameTarget(l.target, t)).map(lookKey));
    for (const b of root.querySelectorAll('.preset')) {
      const inPreview = on.has(b.dataset.look), other = !inPreview && elsewhere.has(b.dataset.look);
      b.classList.toggle('in-preview', inPreview);
      b.classList.toggle('elsewhere', other);
      b.querySelector('.in-badge').lastChild.textContent = other ? 'Elsewhere' : 'Previewing';
      b.querySelector('.in-badge').title = other ? 'Previewing elsewhere' : 'Previewing here';
      b.setAttribute('aria-pressed', inPreview ? 'true' : 'false');
    }
  }

  const flash = (el) => { el.classList.add('sel'); setTimeout(() => el.classList.remove('sel'), 1200); };

  // focusLayer brings a preview layer's card into view and marks it.
  function focusLayer(id) {
    const c = cards.get('preview:' + id);
    if (!c) return;
    reveal(c.el, true);
    flash(c.el);
  }

  // push toggles a look on the current target. One tap at a time per
  // look, so a double tap can't add it twice.
  const tapping = new Set();
  async function push(look) {
    const t = currentTarget();
    const key = t + '|' + lookKey(look);
    if (!t || tapping.has(key)) return;
    tapping.add(key);
    let added = null;
    try {
      const act = lookAction(S.preview ? S.preview.layers : [], t, look, copies, sameTarget);
      if (act.focus) { focusLayer(act.focus); return; }
      if (act.remove) await del('/api/map/preview/layers/' + encodeURIComponent(act.remove));
      else {
        added = await post('/api/map/preview/layers', { target: t, ...look });
        if (S.show === 'house') { S.setShow(''); S.toast('Showing your preview on the map.'); }
      }
      await S.refresh();
      // On a phone the sheet rises for the new row and shows it. Beside the
      // map the stage is at the top, and the grid stays under the pointer.
      if (added && S.panel.layout() === 'sheet' && S.panel.tab() === 'looks' && !S.panel.collapsed()) {
        S.panel.setDetent('full');
        if (cards.has('preview:' + added.id)) reveal(cards.get('preview:' + added.id).el, true);
      }
    } catch (e) { S.fail('preview the look', e); } finally { tapping.delete(key); }
  }

  // ---------- the stage ----------

  // pitch is the meters per pixel of the target's first run, for px.
  function pitchFor(t) {
    const rs = targetRanges(g, S.tree, t);
    if (rs && rs.length) {
      const ri = g.pixels.run[rs[0][0]];
      if (ri >= 0 && g.runs[ri].pitch > 0) return g.runs[ri].pitch;
    }
    return 1 / 60;
  }
  const briOf = (l) => { const v = parseQty('fraction', valuesFor(S, l).brightness ?? 1); return Number.isFinite(v) ? v : 1; };

  // removeScope says what Remove does to layer l given the selection:
  // '' removes the whole layer; a target id means the selection is a
  // proper part of the layer's target, so Remove covers just that part
  // with black (the stack's way to turn off part of a layer; the rest
  // of the layer stays).
  function removeScope(l) {
    if (!S.sel) return '';
    const sel = S.sel.node.ranges, all = targetRanges(g, S.tree, l.target);
    if (!all || !sel.length || sameSet(sel, all) || !covers(all, sel)) return '';
    return nodeTarget(S.sel.node);
  }
  // remove takes layer l (at base) off, or just the selected part of it.
  async function remove(c, base) {
    const part = removeScope(c.layer);
    try {
      if (part) await post(base, { target: part, effect: 'solid', params: { color: '#000000' } });
      else { await del(base + '/' + encodeURIComponent(c.id)); if (c.lane === 'preview') forget(c.id); }
      await S.refresh();
    } catch (e) { S.fail('remove the look', e); }
  }

  // makeCard builds one row: the name on its own line, so no control can
  // crowd it, then its controls. A row keeps its shape whether it is a preview
  // or on the lights, so Apply turns one into the other in place.
  function makeCard(lane, l) {
    const el = document.createElement('div');
    el.className = `layer ${lane}`;
    el.innerHTML = `
      <div class="name-line"><span class="strip"></span><b></b><small class="kind"></small></div>
      <div class="controls">
        <div class="place-row"></div>
        <div class="bri"><span class="bri-label" title="How bright this look is">${icon('sun')}<span class="bri-word">Brightness</span></span><input type="range" min="0" max="1" step="0.01" aria-label="Brightness of this look"><output></output></div>
        <button type="button" class="tweak icon-btn" aria-expanded="false">${icon('tweak')}Tweak</button><button type="button" class="icon-btn" data-a="remove">${icon('trash')}<span>Remove</span></button>
      </div>
      <div class="note"></div>
      <div class="slot"></div>`;
    const c = { lane, id: l.id, el, layer: l, form: null };
    const base = lane === 'preview' ? '/api/v1/preview/layers/' : '/api/v1/layers/';
    c.patch = patcher(() => base + encodeURIComponent(c.id), 80, (nl) => { c.layer = { ...c.layer, ...nl }; }, (e) => S.fail('change the look', e));
    const bri = el.querySelector('.bri input'), out = el.querySelector('.bri output');
    bri.oninput = () => { out.textContent = Math.round(bri.value * 100) + '%'; c.patch.set({ brightness: +bri.value }); };
    el.querySelector('.tweak').onclick = () => tweak(c);
    el.querySelector('[data-a=remove]').onclick = () => remove(c, lane === 'preview' ? '/api/map/preview/layers' : '/api/v1/layers');
    if (lane === 'preview') {
      const place = Object.assign(document.createElement('button'), { type: 'button', className: 'place icon-btn', title: 'Move this look somewhere else' });
      place.setAttribute('aria-haspopup', 'dialog');
      place.setAttribute('aria-expanded', 'false');
      place.onclick = () => (pickFor === c ? openPicker(false) : openPicker(true, c));
      escapeCloses(place, () => pickFor === c, () => { openPicker(false); place.focus(); });
      el.querySelector('.place-row').append(place);
    } else el.querySelector('.place-row').append(Object.assign(document.createElement('span'), { className: 'meta' }));
    return c;
  }

  function updateCard(c, l, front = false) {
    c.layer = l;
    const el = c.el;
    el.style.setProperty('--acc', c.lane === 'preview' ? 'var(--preview)' : 'var(--house)');
    el.querySelector('.name-line b').textContent = noOrphan(layerName(S, l));
    el.querySelector('.kind').textContent = `${c.lane === 'preview' ? 'Preview' : 'Live'}${front ? ' · in front' : ''}`;
    // A preview layer's place is a control; on the lights it's a fact.
    const placeName = targetName(g, l.target), placeBtn = el.querySelector('.place');
    if (placeBtn) {
      placeBtn.innerHTML = `<span class="muted">Goes on</span><b>${esc(placeName)}</b>${icon('chevronDown')}`;
      placeBtn.title = `Move this look somewhere else. It goes on ${placeName}.`;
    } else {
      const bits = [`On ${placeName}`];
      if (l.owner && l.owner !== 'api' && l.owner !== 'live-map') bits.push(l.owner);
      if (l.expires) bits.push('until ' + new Date(l.expires).toLocaleTimeString());
      const meta = el.querySelector('.meta');
      meta.textContent = bits.join(' · ');
      meta.title = meta.textContent;
    }
    const eff = effectFor(S, l);
    el.querySelector('.strip').style.background = lookStrip(S, eff ? eff.id : l.effect, valuesFor(S, l));
    const bri = el.querySelector('.bri input');
    if (document.activeElement !== bri && !c.patch.busy()) {
      bri.value = briOf(l);
      el.querySelector('.bri output').textContent = Math.round(briOf(l) * 100) + '%';
    }
    const note = el.querySelector('.note');
    const orig = c.lane === 'preview' ? copies[l.id] : '';
    note.className = orig ? 'note copy-note' : 'note';
    note.textContent = orig ? `Editing a preview of ${layerName(S, l)}. Apply to update the lights.` : '';
    const part = removeScope(l), rm = el.querySelector('[data-a=remove]');
    rm.querySelector('span').textContent = part ? 'Remove here' : 'Remove';
    rm.classList.toggle('worded', !!part);
    rm.setAttribute('aria-label', part ? 'Remove here' : 'Remove');
    rm.title = part ? `Remove from ${nodeName(S.sel.node)}: turn off ${targetName(g, part)} and leave the rest of this look on` : (c.lane === 'preview' ? 'Remove from the preview' : 'Take this look off the lights');
    if (c.form && !c.patch.busy()) c.form.update(l);
    if (c.only) c.only.hidden = (S.preview?.layers.length || 0) < 2;
  }

  // renderRows keeps the stage's list in order: the preview's rows, then the
  // lights', each already top first, so the top of the list is what's in front.
  function renderRows(prev, house) {
    const box = $$('#lkRows'), rows = [...prev.map((l) => ['preview', l]), ...house.map((l) => ['house', l])];
    const keep = new Set();
    let last = null;
    for (const [lane, l] of rows) {
      const key = lane + ':' + l.id, front = rows.length > 1 && l === rows[0][1];
      keep.add(key);
      let c = cards.get(key);
      if (!c) { c = makeCard(lane, l); cards.set(key, c); }
      updateCard(c, l, front);
      const next = last ? last.nextSibling : box.firstChild;
      if (c.el !== next) box.insertBefore(c.el, next);
      last = c.el;
    }
    for (const [key, c] of cards) {
      if (keep.has(key)) continue;
      if (pickFor === c) openPicker(false); // the list lives in this row while open
      c.el.remove();
      cards.delete(key);
    }
  }

  // stageState shows the stage's loading or failed state after its rows. It's
  // redrawn only when it changes: the stage repaints every poll, and a Retry
  // mid-tap has to stay put.
  function stageState(opts) {
    const box = $$('#lkStageState');
    const key = opts ? opts.kind + opts.title : '';
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    if (!opts) { box.replaceChildren(); return; }
    showState(box, opts.kind === 'error' ? { ...opts, retry: () => { box.dataset.key = ''; return S.refresh(); } } : opts);
  }

  // Apply renders only once it's all done: promoting empties the preview a
  // moment before the lights' list has the new rows, and in between the rows
  // would vanish and the panel's scroll with them.
  let applying = false;
  function renderStage() {
    if (applying) return;
    const prev = S.preview ? S.preview.layers : [];
    const house = S.house.filter((l) => !l.ephemeral);
    renderRows(prev, house);
    const stale = S.houseStatus !== 'available' && S.houseRead;
    $$('#lkStageTitle').textContent = stageTitle({ live: house.length, preview: prev.length, read: S.houseRead, status: S.houseStatus });
    $$('#lkStageSub').textContent = stageSub({ rows: prev.length + house.length, stale, word });
    $$('#lkStage').classList.toggle('stale', stale);
    const notRead = S.houseStatus === 'available' || S.houseRead ? null : houseState(S.houseStatus, S.house.length);
    stageState(previewState(S.preview, S.previewStatus) || notRead);
    // The toggle can be on Lights with a preview open: the stage says so.
    $$('#lkMapNote').hidden = !(prev.length && S.show === 'house');
    const lit = lightOutcome(g, S.statusData?.brightness, house.map((l) => targetRanges(g, S.tree, l.target)));
    const landing = lightOutcome(g, S.statusData?.brightness, prev.map((x) => targetRanges(g, S.tree, x.target)));
    renderDark(zoneWarning(lit, landing, { previewing: prev.length > 0 }));
    renderBar(prev);
    markPreviewed();
    S.refreshBadge?.();
    $$('#lkClockBox').hidden = !prev.length;
    // A copy whose preview layer is gone is forgotten.
    const ids = new Set(prev.map((l) => l.id));
    if (Object.keys(copies).some((k) => !ids.has(k)) && S.preview) {
      copies = Object.fromEntries(Object.entries(copies).filter(([k]) => ids.has(k)));
      save(COPIES, copies);
    }
  }
  // renderDark is the one 0% line, inside the stage. Drawn only on a change: a
  // poll mustn't replace the button under a press.
  let shownDark = '';
  function renderDark(w) {
    const box = $$('#lkDark'), key = w ? `${w.text}|${w.names}` : '';
    box.hidden = !w;
    if (key === shownDark) return;
    shownDark = key;
    box.title = w?.detail || '';
    box.innerHTML = w ? `${icon('alert')}<span class="warn-text">${esc(w.text)}</span>${w.ids.length ? `<button type="button" class="icon-btn" id="lkDarkOn">${icon('sun')}${esc(turnOnLabel(w.names))}</button>` : ''}` : '';
    const on = $$('#lkDarkOn');
    if (on) on.onclick = () => turnOnZones(S, api, w.ids, w.names);
  }
  $$('#lkShowPreview').onclick = () => S.setShow('');
  // reveal brings a card into view, below the tabs and above the Apply bar.
  function reveal(el, smooth = false) {
    const content = root.parentElement, bar = $$('#lkBar'), view = content.getBoundingClientRect();
    const heading = el.closest('.stage').querySelector('.stage-head').getBoundingClientRect().top;
    const aim = laneAim(el.getBoundingClientRect(), heading, !el.previousElementSibling);
    const top = content.scrollTop + revealDelta(aim, view.top + 8, view.bottom - (bar.hidden ? 0 : bar.offsetHeight) - 8);
    content.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }
  // renderBar is the one primary action here, in view however far the
  // library scrolls. Its button says the result; Add or Replace, when it is a
  // choice, sits beside it.
  let hidden = [], plan = null; // what Replace would take off; what the bar says now
  // syncBarInset keeps scrolling into view short of the bar, whatever its
  // height, while the bar is what's at the panel's bottom edge.
  function syncBarInset() {
    const bar = $$('#lkBar'), content = root.parentElement;
    queueMicrotask(() => {
      if (bar.hidden || S.panel.tab() !== 'looks') content.style.removeProperty('--look-bar');
      else content.style.setProperty('--look-bar', bar.offsetHeight + 'px');
    });
  }
  function renderBar(prev) {
    const bar = $$('#lkBar');
    bar.hidden = !prev.length;
    syncBarInset();
    if (!prev.length) { mode = 'replace'; plan = null; return; }
    const house = S.house.filter((x) => !x.ephemeral);
    const updates = prev.some((x) => copies[x.id]);
    hidden = updates ? [] : replacedBy(house, prev, (t) => targetRanges(g, S.tree, t), new Set(Object.values(copies)));
    plan = applyPlan({ n: prev.length, updates, house: house.length, hidden: hidden.map((x) => layerName(S, x)), mode });
    $$('#lkMode').hidden = !plan.choice;
    for (const b of $$('#lkMode').children) press(b, b.dataset.mode === mode);
    const go = $$('#lkPushAll'), html = `${icon('apply')}<span>${esc(plan.label)}</span>`;
    if (go.dataset.html !== html) { go.dataset.html = html; go.innerHTML = html; }
    go.title = plan.note || plan.label;
    $$('#lkBarNote').textContent = plan.note;
  }
  for (const b of $$('#lkMode').children) b.onclick = () => { mode = b.dataset.mode; renderStage(); };
  let revealing = false; // opening a form places it: nothing else scrolls then
  let darkToast = null;
  S.on('tab', () => { darkToast?.remove(); darkToast = null; });
  const forget = (id) => { if (copies[id]) { delete copies[id]; save(COPIES, copies); } };

  // tweak opens the form. On the lights it first copies the layer to the
  // preview and edits the copy.
  async function tweak(c) {
    if (c.form) {
      c.form.el.remove();
      c.form = null;
      c.el.querySelector('.tweak').setAttribute('aria-expanded', 'false');
      c.el.querySelector('.tweak').classList.remove('on');
      return;
    }
    if (c.lane === 'house') {
      const l = c.layer;
      const existing = Object.entries(copies).find(([, o]) => o === l.id);
      let id = existing && existing[0];
      try {
        if (!id || !(S.preview && S.preview.layers.some((x) => x.id === id))) {
          // No seed: a uint64 loses its low bits as a JS number, so the
          // copy draws its own rather than a near miss of the original's.
          const copy = await post('/api/map/preview/layers', { target: l.target, effect: l.effect || undefined, preset: l.preset || undefined, params: l.params });
          id = copy.id;
          copies[id] = l.id;
          save(COPIES, copies);
        }
        if (S.show === 'house') S.setShow('');
        await S.refresh();
      } catch (e) { S.fail('copy the look for editing', e); return; }
      const pc = cards.get('preview:' + id);
      if (pc && !pc.form) tweak(pc);
      else if (pc) reveal(pc.el, true);
      return;
    }
    const form = createForm({
      S, layer: c.layer, pitch: pitchFor(c.layer.target), outside: ['brightness'], // on the card
      send: (params) => c.patch.set(params),
      replace: (params) => c.patch.replace(params),
    });
    c.form = form;
    c.el.querySelector('.slot').append(form.el);
    c.el.querySelector('.tweak').setAttribute('aria-expanded', 'true');
    c.el.querySelector('.tweak').classList.add('on');
    // Editing needs the room: the sheet rises, whatever the form's height.
    if (S.panel.layout() === 'sheet' && S.panel.detent() !== 'full') {
      revealing = true;
      S.panel.setDetent('full');
      revealing = false;
    }
    // With two or more previews, the form is where this one can go on alone.
    if (c.lane === 'preview') {
      c.only = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn apply-one', title: 'Put only this look on the lights', innerHTML: `${icon('apply')}Apply only this` });
      c.only.hidden = (S.preview?.layers.length || 0) < 2;
      c.only.onclick = () => apply([c.id]);
      form.el.prepend(c.only);
    }
    // The form can open below the sticky bar, where a tap seems to do nothing.
    // Measured and immediate: a smooth scroll is still on its way, and can be
    // interrupted, while the sheet rises. Rects are relative, so its motion
    // doesn't matter.
    // The whole card is the aim, so its name and Tweak stay in view.
    reveal(c.el);
  }

  // apply promotes preview layers (all with ids empty) onto the lights,
  // then removes the lights layers the promoted copies stand in for.
  async function apply(ids, replace = []) {
    const list = ids.length ? ids : (S.preview ? S.preview.layers.map((l) => l.id) : []);
    // Read before promoting: a poll can empty the preview at any moment after.
    const applied = (S.preview ? S.preview.layers : []).filter((l) => list.includes(l.id)).map((l) => targetRanges(g, S.tree, l.target));
    applying = true;
    try {
      await post('/api/map/preview/promote', ids.length ? { ids } : {});
    } catch (e) { applying = false; S.fail('apply the look', e); await S.refresh(); return; }
    openPicker(false); // the result, not the list of places, is what to see
    const replaced = [], replaceIds = replace.map((l) => l.id);
    for (const id of list) {
      const orig = copies[id];
      forget(id);
      if (orig) replaceIds.push(orig);
    }
    for (const orig of replaceIds) {
      try { await del('/api/v1/layers/' + encodeURIComponent(orig)); replaced.push(orig); } catch (e) { if (e.status !== 404) S.fail('remove the look it replaces', e); }
    }
    await S.refresh();
    // The status poll's brightness can be seconds old: read it now, so the
    // result can say what really happened.
    await S.status?.poll();
    applying = false;
    renderStage();
    // The result is at the top: the panel's heading and the new rows in view.
    root.parentElement.scrollTop = 0;
    const orig = replaced.length === 1 ? 'the original' : replaced.length + ' originals';
    const what = `${list.length === 1 ? 'the look' : list.length + ' looks'} to the lights${replaced.length ? ', in place of ' + orig : ''}`;
    const outcome = lightOutcome(g, S.statusData?.brightness, applied);
    darkToast = applyToast(S, what, outcome, !$$('#lkDark').hidden && !S.panel.collapsed());
  }
  $$('#lkPushAll').onclick = () => apply([], plan?.replace ? hidden : []);
  $$('#lkClear').onclick = async () => {
    try { await del('/api/map/preview/layers'); copies = {}; save(COPIES, copies); await S.refresh(); } catch (e) { S.fail('clear the preview', e); }
  };

  // ---------- the clock ----------

  const control = async (body) => {
    try { S.preview = await post('/api/map/preview', body); renderClock(); S.emit('preview', S.preview); } catch (e) { S.fail('change the preview clock', e); }
  };
  const fps = g.house_fps || 40;
  $$('#lkPlay').onclick = () => control({ action: S.preview && S.preview.paused ? 'resume' : 'pause' });
  $$('#lkBack').onclick = () => control({ action: 'step', seconds: -1 / fps });
  $$('#lkFwd').onclick = () => control({ action: 'step', seconds: 1 / fps });
  $$('#lkLive').onclick = () => control({ action: 'live' });
  const speed = $$('#lkSpeed');
  speed.oninput = () => { $$('#lkSpeedOut').textContent = speedLabel(10 ** +speed.value); };
  speed.onchange = () => control({ action: 'speed', speed: 10 ** +speed.value });
  // Scrubbing pauses, then seeks relative to where the drag started;
  // one seek in flight at a time.
  const scrub = $$('#lkScrub');
  let scrubBase = null, seeking = false, want = null;
  const seek = async () => {
    if (seeking) return;
    seeking = true;
    while (want !== null) { const t = want; want = null; await control({ action: 'seek', t }); }
    seeking = false;
  };
  scrub.oninput = async () => {
    if (scrubBase === null) {
      scrubBase = NaN;
      try { const st = await post('/api/map/preview', { action: 'pause' }); scrubBase = st.t; S.preview = st; } catch (e) { scrubBase = null; S.fail('pause the preview clock', e); return; }
    }
    if (Number.isNaN(scrubBase)) return;
    want = scrubBase + +scrub.value;
    seek();
  };
  scrub.onchange = () => { scrubBase = null; scrub.value = 0; renderClock(); };
  const clockBox = $$('#lkClockBox');
  clockBox.open = !!load(CLOCK, false);
  clockBox.addEventListener('toggle', () => save(CLOCK, clockBox.open));

  function renderClock() {
    const st = S.preview;
    if (!st) return;
    const play = $$('#lkPlay');
    const verb = st.paused ? 'Resume' : 'Pause';
    play.innerHTML = `${icon(st.paused ? 'play' : 'pause')}<span>${verb}</span>`;
    play.setAttribute('aria-label', `${verb} the preview clock`);
    press(play, st.paused);
    $$('#lkLive').disabled = st.following; // one-shot, and already there
    if (document.activeElement !== speed) {
      speed.value = Math.log10(st.speed);
      $$('#lkSpeedOut').textContent = speedLabel(st.speed);
    }
    $$('#lkClockText').textContent = clockText(st, scrubBase !== null);
    $$('#lkClock').title = S.show === 'house' ? 'The preview clock; the map is showing the lights' : 'The preview clock';
  }

  // ---------- wiring ----------

  S.on('presets', () => { renderCatalog(); renderStage(); });
  S.on('preview', () => { renderStage(); renderClock(); });
  S.on('house', renderStage);
  S.on('show', renderStage);
  // Rising to full can leave a card half under the bar: nothing just shown
  // is left cut by it.
  function clearBar() {
    const bar = $$('#lkBar');
    if (revealing || S.panel.tab() !== 'looks' || S.panel.collapsed() || bar.hidden) return;
    const barTop = bar.getBoundingClientRect().top;
    const cut = [...$$('#lkRows').children].find((el) => underBar(el.getBoundingClientRect(), barTop));
    if (cut) reveal(cut, true);
  }
  S.on('detent', clearBar);
  S.on('tab', () => { syncBarInset(); });
  S.on('status', renderStage); // a zone's brightness changed the warning
  $$('#lkPlay').innerHTML = `${icon('pause')}<span>Pause</span>`;
  fillTargets();
  renderCatalog();
  S.on('ready', clearBar);

  return {
    push,
    // inPreview says a preset is in the preview on the current target.
    inPreview: (preset) => (S.preview ? S.preview.layers : []).some((l) => l.preset === preset && sameTarget(l.target, currentTarget())),
    togglePause: () => control({ action: S.preview && S.preview.paused ? 'resume' : 'pause' }),
    fmtClock: () => $$('#lkClockText').textContent,
  };
}

