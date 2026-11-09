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
// preview runs in step with the lights, with no time controls of its own.
import { api, post, del, patch, esc, save, load, parseQty, press, covers, sameSet, humanize, noOrphan } from '../util.js';
import { nodeName, nodeTarget, targetName, targetGroups, targetRanges } from '../select.js';
import { houseStatusMessage, lightOutcome, joined, turnOnLabel, turnOnZones, zoneWarning, BRIGHTNESS_RULE } from '../house-status.js';
import { createForm, patcher, effectFor, valuesFor, layerName, lookStrip, presetName } from '../form.js';
import { showState, stateHTML } from '../states.js';
import { icon } from '../icons.js';
import { textField, wireClear } from '../field.js';
import { escapeCloses } from '../picker.js';
import { effectMotion, spriteURL, spriteStyle, guardSprite } from '../tiles.js';
import { tapHint } from '../map-control.js';
import { createUndo, mark, undoResult, TOAST_MS } from '../undo.js';

const COPIES = 'glowstack.copies'; // preview copy id → the lights layer it stands in for
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

// compactStage is the stage header for the phone's half sheet: the state,
// then the sub after a dot in lower case while it fits on the state's line
// ("Previewing · replaces Porch glitter"); when it doesn't, ui.css puts it
// on the line below, whole, with its first letter back in upper case
// (fitStageHead decides). The long title gives way to the rows, which say
// what is live.
export function compactStage({ title, sub, preview, live }) {
  const t = preview && live ? 'Previewing' : title;
  return { title: t, sub: sub ? sub[0].toLowerCase() + sub.slice(1) : sub };
}

// subBelow says the compact header's sub must take its own line: it has
// text and does not fit whole in the room left beside the state.
export const subBelow = (text, scrollWidth, clientWidth) => !!text && scrollWidth > clientWidth + 1;

// stageSub is the stage's one line under its title. A failed refresh keeps
// the last state and says so. compact is the phone's half sheet, whose
// hint is short and complete: it has to fit the header, never be cut.
export function stageSub({ rows, stale, word, read = true, status = 'available', compact = false }) {
  if (stale) return "Couldn't refresh. This is the last known state.";
  if (!read && !rows && status === 'unavailable') return "Glowstack didn't answer, so what's on the lights isn't known.";
  if (rows) return '';
  return compact ? `${word} a look to preview it. The lights change only when you apply.` : `${word} a look below to preview it on the map; the lights don't change.`;
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

// liveLine is a library card's line for a look on the lights: Live where new
// previews would go, else where it is on. '' when it isn't on the lights.
export function liveLine(house, key, target, sameTarget, nameOf) {
  const on = house.filter((l) => lookKey(l) === key);
  if (!on.length) return '';
  return on.some((l) => sameTarget(l.target, target)) ? 'Live' : `Live on ${nameOf(on[0].target)}`;
}

// previewLine is a library card's line for a look in the preview: Previewing
// where new previews go, else on the place it's on. '' when it isn't.
export function previewLine(layers, key, target, sameTarget, nameOf) {
  const on = layers.filter((l) => lookKey(l) === key);
  if (!on.length) return '';
  return on.some((l) => sameTarget(l.target, target)) ? 'Previewing' : `Previewing on ${nameOf(on[0].target)}`;
}

// layerLine is a layer's one line on a phone, collapsed: where it goes and how
// bright, with the words a screen reader hears for the chevron.
export function layerLine(kind, name, place, brightness) {
  const bri = Math.round(brightness * 100) + '%';
  return { place, bri, label: `${kind}: ${String(name).replace(/\u00a0/g, ' ')} on ${place} at ${bri}. Show its controls` };
}

// liveSummary is the folded live rows' whole sentence, the button's
// accessible name: how many looks are on the lights and their names, in
// order, front first.
export function liveSummary(house, nameOf) {
  const n = house.length;
  if (!n) return '';
  return `${n} look${n === 1 ? '' : 's'} on the lights · ${house.map((l) => String(nameOf(l)).replace(/\u00a0/g, ' ')).join(', ')}`;
}

// liveNames is the words shown on that line, which has about 214 px beside
// the Live badge and the chevron at 390 px: the count, then up to `shown`
// names and "+N more"; with none shown, the count and the state word. The
// renderer tries two names, one, then none, and keeps the first that fits
// (fitText), so the line is never cut mid-name.
export function liveNames(house, nameOf, shown = 2) {
  const n = house.length;
  if (!n) return '';
  const count = `${n} look${n === 1 ? '' : 's'}`;
  if (!shown) return `${count} on the lights`;
  const names = house.slice(0, shown).map((l) => String(nameOf(l)).replace(/\u00a0/g, ' '));
  return `${count}: ${names.join(', ')}${n > shown ? `, +${n - shown} more` : ''}`;
}

// fitText sets el's text to the first candidate that fits its box whole,
// or the last one. A hidden element (no box) takes the first.
export function fitText(el, candidates) {
  for (const text of candidates) {
    el.textContent = text;
    if (el.scrollWidth <= el.clientWidth) return text;
  }
  return el.textContent;
}

// liveFold says whether the live rows fold behind their summary: on the half
// sheet, while a preview is present and the fold has not been opened. The
// summary shows whenever the fold applies, open or closed; the full sheet
// shows every row.
export function liveFold({ compact, preview, live, open }) {
  const summary = compact && preview > 0 && live > 0;
  return { summary, folded: summary && !open };
}

// targetControl is the one control that sets where the next preview goes,
// in words: its label, the place it shows, its accessible name, and whether
// it carries a clear (x) back to Everything. where is the current place's
// name; everything says the place is every light.
export function targetControl(where, everything) {
  return { label: 'Preview on', text: where, aria: `Preview on ${where}. Change where the next look goes`, clear: !everything };
}

// placeControl is a preview row's own place in the same style and the same
// word, labeled for what it changes: that layer, not the next one.
export function placeControl(where) {
  return { label: 'On:', text: where, title: `This look is on ${where}. Move it somewhere else.` };
}

// previewFold is the same fold for the preview's own rows (B143): on the
// half sheet the Previewing card shows at most one layer row in full, so two
// or more previews fold behind one summary line whose chevron opens them in
// place. One preview is its row, as it always was; the full sheet shows
// every row.
export function previewFold({ compact, preview, open }) {
  const summary = compact && preview > 1;
  return { summary, folded: summary && !open };
}

// previewSummary is the folded preview rows' whole sentence, the button's
// accessible name: how many previews and their names, front first.
export function previewSummary(prev, nameOf) {
  const n = prev.length;
  if (!n) return '';
  return `${n} preview${n === 1 ? '' : 's'} · ${prev.map((l) => String(nameOf(l)).replace(/\u00a0/g, ' ')).join(', ')}`;
}

// previewNames is the words shown on that line, fitted like liveNames: the
// count, then up to `shown` names and "+N more"; with none, the count.
export function previewNames(prev, nameOf, shown = 2) {
  const n = prev.length;
  if (!n) return '';
  const count = `${n} preview${n === 1 ? '' : 's'}`;
  if (!shown) return count;
  const names = prev.slice(0, shown).map((l) => String(nameOf(l)).replace(/\u00a0/g, ' '));
  return `${count}: ${names.join(', ')}${n > shown ? `, +${n - shown} more` : ''}`;
}

// warnTexts is the 0% line's words for the half sheet, longest first: the
// line never wraps and is never cut, so it takes the first that fits beside
// its button (fitText). The last is short enough for any phone.
export function warnTexts(w) {
  const state = w.text.split(':')[0];
  const n = w.names.length;
  return [...new Set([w.text, n ? `${state}: ${n} zone${n === 1 ? '' : 's'} at 0%` : w.text, n ? `${state} at 0%` : 'At 0%'])];
}

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

// swapLabel is the phone bar's link to the other mode: the one the button
// doesn't say.
export const swapLabel = (mode) => (mode === 'add' ? 'Replace instead' : 'Add on top instead');

// applyTitle is the Apply button's tooltip; a failed status read says so
// there, and Apply still works.
export function applyTitle(plan, unknown) {
  const base = plan.note || plan.label;
  return unknown ? `${base.replace(/\.?$/, '.')} The lights' current state is unknown.` : base;
}

// applyResult is what Apply reports: plain success only when the look can
// be seen. outcome is lightOutcome for the applied looks; name is the look,
// or how many, for the sentence that has to name the zones. The toast stands
// alone: it says what stayed dark and carries the fix.
export function applyResult(what, outcome, name = what) {
  if (!outcome.dark) return { text: `Applied ${what}.`, warn: false };
  if (!outcome.zones?.length) return { text: `Applied ${name}. ${outcome.message}`, warn: true };
  const zones = outcome.zones, list = joined(zones);
  const who = zones.length < 3 && list.length <= 40 ? list : `${zones.length} zones`;
  return { text: `Applied ${name}. ${who} ${zones.length === 1 ? 'is' : 'are'} at 0%, so ${zones.length === 1 ? 'it stays' : 'they stay'} dark.`, warn: true, zones: { ids: outcome.ids, names: zones } };
}
// The confirmation carries Undo for TOAST_MS (undo: {label, run}, or null
// when the change could not be marked), beside the dark toast's Turn on.
const applyToast = (S, what, outcome, name, undo) => {
  const r = applyResult(what, outcome, name);
  const actions = undo ? [{ ...undo, id: 'undo', quiet: r.warn }] : [];
  if (!r.warn) return S.toast(r.text, { ms: TOAST_MS, actions });
  return S.toast(r.text, { ms: TOAST_MS, warn: true, action: r.zones && { label: turnOnLabel(r.zones.names), run: () => turnOnZones(S, api, r.zones.ids, r.zones.names) }, actions });
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

// pickerPlace is where a row's list of places opens, so the row's first line
// stays in view. Positions are px down the viewport: nameTop is the row's
// first line, rowTop and rowBottom the row and its place button's bottom,
// viewTop and viewBottom what shows; chrome is the picker around its list,
// natural the list's full height, maxScroll how far the panel can still go.
// scroll is how far to scroll, list the list's height. It scrolls only as far
// as the list needs and never past the name; with too little room below, the
// side with more room takes it, and the list scrolls inside that height.
export function pickerPlace({ nameTop, rowTop, rowBottom, viewTop, viewBottom, chrome, natural, maxScroll, want = 220, floor = 120 }) {
  const gap = 4, need = Math.min(natural, want), min = Math.min(natural, floor);
  const base = Math.min(0, nameTop - viewTop); // a name already above the view comes back first
  const below = (by) => viewBottom - (rowBottom - by) - gap - chrome;
  const most = Math.max(base, Math.min(maxScroll, nameTop - viewTop));
  const scroll = Math.min(most, Math.max(base, need - below(0)));
  if (below(scroll) >= min) return { up: false, scroll, list: Math.min(natural, Math.floor(below(scroll))) };
  const above = rowTop - base - viewTop - gap - chrome;
  if (above > below(scroll)) return { up: true, scroll: base, list: Math.min(natural, Math.max(80, Math.floor(above))) };
  return { up: false, scroll, list: Math.min(natural, Math.max(80, Math.floor(below(scroll)))) };
}

// laneAim is what revealing a card has to show. A lane's first card brings
// the lane's heading with it, so the heading is never left clipped at the top.
export function laneAim(card, headTop, first) { return first ? { top: headTop, bottom: card.bottom } : card; }

// pointOn makes the rows of a list point at the map: while the pointer is
// over, or the focus is on, an element matching sel inside box, the map
// draws the halo along rangesFor(that element); it clears on leaving. One
// listener per list, so rows redrawn by a poll keep pointing.
export function pointOn(box, sel, rangesFor, S) {
  const row = (e) => e.target.closest?.(sel);
  const on = (e) => { const el = row(e); if (el && box.contains(el)) S.pointAt?.(rangesFor(el)); };
  const off = (e) => { const el = row(e); if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) S.pointAt?.(null); };
  if (!S.coarse) { box.addEventListener('pointerover', on); box.addEventListener('pointerout', off); }
  box.addEventListener('focusin', (e) => { if (e.target.matches?.(':focus-visible')) on(e); });
  box.addEventListener('focusout', off);
}

export function createLooks(S, root) {
  const g = S.geo;
  let copies = load(COPIES, {}) || {};
  let target = load(TARGET, '');      // chosen when nothing is selected
  let filter = load(FILTER, '');      // the library's list; '' follows the pins
  let mode = 'replace';               // Replace or Add, while a preview can do either
  const cards = new Map(); // lane:id → row
  const compact = () => S.panel.layout() === 'sheet' && S.panel.detent() === 'half';
  const word = S.coarse ? 'Tap' : 'Click';
  root.innerHTML = `
    <div class="looks-head"><h1 class="title">Looks</h1></div>
    <section class="stage" id="lkStage" aria-labelledby="lkStageTitle">
      <div class="stage-head"><h2 id="lkStageTitle"></h2><small id="lkStageSub"></small></div>
      <p class="muted small stage-tip" id="lkTip" hidden>${tapHint(word)}</p>
      <p class="muted small stage-note" id="lkMapNote" hidden>The map is showing the lights, not this preview. <button type="button" id="lkShowPreview">Show preview</button></p>
      <div class="stage-warn" id="lkDark" data-dark hidden></div>
      <div class="list" id="lkRows"><button type="button" class="live-sum prev-sum" id="lkPrevSum" aria-expanded="false" hidden><small class="kind">Preview</small><span class="text"></span>${icon('chevronDown')}</button><button type="button" class="live-sum" id="lkLiveSum" aria-expanded="false" hidden><small class="kind">Live</small><span class="text"></span>${icon('chevronDown')}</button></div>
      <div id="lkStageState"></div>
      <p class="stage-undo" id="lkUndoLine" hidden><button type="button" class="target-btn" id="lkUndo" title="Put the lights back as they were before the last change made here">Undo last change</button></p>
    </section>
    <section class="library" aria-label="Presets and effects">
      <div class="catalog-head" id="lkCatalogHead">
        <h2 class="group-head">Library</h2>
        <div class="target-ctl"><span class="muted" id="lkTargetLabel">Preview on</span><button type="button" class="target-select" id="lkTarget" aria-expanded="false" aria-controls="lkPicker" title="Where the next preset or effect you pick goes. Looks already added keep their own place, on their rows." aria-haspopup="dialog"><b id="lkTargetName"></b>${icon('chevronDown')}</button><button type="button" class="icon-btn target-clear" id="lkTargetClear" aria-label="Preview on Everything again" title="Back to Everything" hidden>${icon('close')}</button></div>
        <div class="target-picker" id="lkPicker" role="dialog" aria-label="Where the next look goes" hidden>
          <div class="pick-head"><h2 id="lkPickTitle"></h2><button type="button" class="icon-btn" id="lkPickClose" aria-label="Close" title="Close">${icon('close')}</button></div>
          ${textField({ ariaLabel: 'Find a place', id: 'lkTargetSearch', type: 'search', placeholder: 'Find a place' })}
          <div class="muted small" id="lkPickHint">${tapHint(word)} ${word} it again for the area around it.</div>
          <div class="target-list" id="lkTargetList"></div>
        </div>
      </div>
      <div class="lib-filters">
        <div class="seg" id="lkFilter" role="group" aria-label="Which looks to list"><button type="button" data-filter="pinned">${icon('pin')}<span>Pinned</span></button><button type="button" data-filter="presets">${icon('presets')}<span>All presets</span></button><button type="button" data-filter="effects">${icon('looks')}<span>Effects</span></button></div>
        ${textField({ label: 'Find a look', id: 'lkFind', type: 'search', placeholder: 'Search looks', clearable: true })}
      </div>
      <div class="cards" id="lkPresets"></div>
      <details class="words" id="lkWords"><summary>What these words mean</summary><p class="muted small">A look is what the lights show: a saved preset, or an effect with your own settings. It goes on a zone (what Home Assistant controls), an area (part of a zone) or a run (one strip of lights).</p><p class="muted small">${BRIGHTNESS_RULE}</p></details>
    </section>
    <div class="look-bar" id="lkBar" hidden>
      <div class="bar-main">
        <div class="seg" id="lkMode" role="group" aria-label="What happens to what's on the lights" hidden><button type="button" data-mode="replace">Replace</button><button type="button" data-mode="add">Add</button></div>
        <button type="button" class="go icon-btn" id="lkPushAll"></button>
        <button type="button" class="target-btn swap" id="lkSwap" hidden></button>
      </div>
      <div class="bar-line"><p class="bar-note" id="lkBarNote"></p><button type="button" id="lkClear" class="quiet icon-btn" title="Remove everything from the preview; the lights don't change">${icon('close')}Clear preview</button></div>
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
  // The one list of places serves the Preview on control, and, inside a preview
  // card, that layer's own place. pickFor is the card it is open for.
  let pickFor = null, opener = targetBtn;
  const targetKey = (t) => JSON.stringify(targetRanges(g, S.tree, t));
  const sameTarget = (a, b) => a === b || targetKey(a) === targetKey(b);
  function fillTargets() {
    const t = currentTarget();
    const where = S.sel ? nodeName(S.sel.node) : targetName(g, t);
    const ctl = targetControl(where, t === 'all');
    $$('#lkTargetName').textContent = ctl.text;
    targetBtn.setAttribute('aria-label', ctl.aria);
    $$('#lkTargetClear').hidden = !ctl.clear;
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
    picker.querySelector('#lkPickHint').hidden = !!pickFor || !!S.sel;
    document[on ? 'addEventListener' : 'removeEventListener']('pointerdown', outside, true);
    if (on) { search.value = ''; fillTargets(); fitPicker(); if (!S.coarse) search.focus({ preventScroll: true }); }
  }
  // fitPicker keeps the floating list inside the panel, above the Apply bar;
  // a sheet with too little room rises first.
  function fitPicker() {
    const list = pickList, content = root.parentElement, bar = $$('#lkBar');
    picker.style.top = '';
    if (picker.classList.contains('as-sheet')) { list.style.maxHeight = ''; picker.classList.remove('up'); return; }
    picker.classList.remove('up');
    if (pickFor) { fitRowPicker(); return; }
    const room = () => content.getBoundingClientRect().bottom - list.getBoundingClientRect().top - (bar.hidden ? 0 : bar.offsetHeight) - 12;
    list.style.maxHeight = '220px'; // its least height first: the room is what's left with that much open
    list.style.maxHeight = Math.max(120, room()) + 'px';
    picker.scrollIntoView({ block: 'nearest' });
  }
  // fitRowPicker opens the list right under a row's place button, not under a
  // Tweak form open below it, with the row's name left in view.
  function fitRowPicker() {
    const list = pickList, content = root.parentElement, bar = $$('#lkBar'), row = pickFor.el, place = row.querySelector('.place-row').getBoundingClientRect();
    list.style.maxHeight = '0px'; // the list's own height can't count as room to scroll into
    const view = content.getBoundingClientRect();
    const at = pickerPlace({
      nameTop: row.querySelector('.name-line').getBoundingClientRect().top,
      rowTop: row.getBoundingClientRect().top,
      rowBottom: place.bottom,
      viewTop: view.top + 8,
      viewBottom: (bar.hidden ? view.bottom : bar.getBoundingClientRect().top) - 8,
      chrome: picker.offsetHeight,
      natural: list.scrollHeight,
      maxScroll: content.scrollHeight - content.clientHeight - content.scrollTop,
    });
    picker.classList.toggle('up', at.up);
    picker.style.top = at.up ? '' : place.bottom - row.getBoundingClientRect().top + 4 + 'px';
    list.style.maxHeight = at.list + 'px';
    content.scrollTop += at.scroll;
  }
  for (const el of [targetBtn, picker]) escapeCloses(el, () => !picker.hidden, () => { const back = opener; openPicker(false); back.focus(); });
  // moveLayer gives one preview layer a new place. Where the next look goes
  // doesn't change: that is the Preview on control's.
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
    else { fillTargets(); markPreviewed(); S.applyPoint?.(); }
  }
  targetBtn.onclick = () => openPicker(picker.hidden);
  // The clear (x): back to Everything, whether the place came from the map or the list.
  $$('#lkTargetClear').onclick = () => {
    target = ''; save(TARGET, target);
    if (S.sel) S.select(null); else { fillTargets(); markPreviewed(); S.applyPoint?.(); }
    targetBtn.focus({ preventScroll: true });
  };
  picker.querySelector('#lkPickClose').onclick = () => { const back = opener; openPicker(false); back.focus({ preventScroll: true }); };
  S.on('layout', () => { if (!picker.hidden) openPicker(false); });
  search.oninput = fillTargets;
  S.on('runVisibility', fillTargets);
  S.on('select', () => { fillTargets(); renderStage(); });

  // ---------- presets and effects ----------

  // card is a library tile: its swatch shows the look as a moving trail
  // (tiles.js), over the drawn strip while the sprite loads. The swatch and
  // the segment say what kind of look it is, so the sub line is all the
  // look's own: a preset's effect, an effect's motion in words.
  function card(name, sub, strip, look, onclick, title, sprite) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.title = title || name;
    b.innerHTML = `<span class="swatch" style="${esc(spriteStyle(sprite, strip))}"></span><span class="name">${esc(noOrphan(name))}</span><span class="sub">${esc(sub)}</span><span class="live-badge"><span></span></span><span class="in-badge">${icon('eye')}<span>Previewing</span></span>`;
    guardSprite(b.querySelector('.swatch'), sprite, strip);
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
      return card(name, e ? cardSummary(name, e) : humanize(p.effect), lookStrip(S, p.effect, p.params), 'preset:' + p.id, () => push({ preset: p.id }), `Preview ${name} here`, spriteURL('preset', p.id, p.params, e));
    }),
    effects: (list) => list.map((e) => card(e.name || e.id, effectMotion(e, effectKind), lookStrip(S, e.id, {}), 'effect:' + e.id, () => push({ effect: e.id }), undefined, spriteURL('effect', e.id, null, e))),
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
        grid.innerHTML = stateHTML({ kind: 'empty', title: 'No presets yet', detail: 'Save a look as a preset and it appears here.', action: { id: 'lkEmptyNew', label: 'Create a preset' } });
        grid.querySelector('#lkEmptyNew').onclick = () => { S.panel.openTab('presets'); S.presetLibrary.openEditor(); };
      }
    }
    markPreviewed();
  }
  for (const b of $$('#lkFilter').children) b.onclick = () => { filter = b.dataset.filter; save(FILTER, filter); renderCatalog(); };
  // The panel points at the map: hovering or focusing a card shows, with the
  // soft halo, the pixels it would go on. Touch has no hover; app.js shows
  // the same halo at rest on a phone's half sheet (restPoint).
  const here = () => targetRanges(g, S.tree, currentTarget());
  pointOn($$('#lkPresets'), '.preset', here, S);
  // The search grows to the row while in use on the half sheet (field.js
  // marks it); clearing puts the library back where it was scrolled to.
  wireClear($$('#lkFind'), renderCatalog, document.getElementById('content'));

  // markPreviewed shows which cards are in the preview on the current
  // target: the same look on somewhere else isn't this one.
  function markPreviewed() {
    const t = currentTarget();
    const layers = S.preview ? S.preview.layers : [];
    const on = new Set(layers.filter((l) => sameTarget(l.target, t)).map(lookKey));
    const elsewhere = new Set(layers.filter((l) => !sameTarget(l.target, t)).map(lookKey));
    const house = S.house.filter((l) => !l.ephemeral);
    for (const b of root.querySelectorAll('.preset')) {
      const live = liveLine(house, b.dataset.look, t, sameTarget, (x) => targetName(g, x));
      b.classList.toggle('live', !!live);
      b.querySelector('.live-badge').lastChild.textContent = live;
      b.querySelector('.live-badge').title = live ? 'On the lights now' : '';
      const inPreview = on.has(b.dataset.look), other = !inPreview && elsewhere.has(b.dataset.look);
      b.classList.toggle('in-preview', inPreview);
      b.classList.toggle('elsewhere', other);
      const line = previewLine(layers, b.dataset.look, t, sameTarget, (x) => targetName(g, x)) || 'Previewing';
      b.querySelector('.in-badge').lastChild.textContent = line;
      b.querySelector('.in-badge').title = line;
      b.setAttribute('aria-pressed', inPreview ? 'true' : 'false');
    }
  }

  const flash = (el) => { el.classList.add('sel'); setTimeout(() => el.classList.remove('sel'), 1200); };

  // focusLayer brings a preview layer's card into view and marks it.
  function focusLayer(id) {
    const c = cards.get('preview:' + id);
    if (!c) return;
    if (!c.el.offsetParent && !prevOpen) { prevOpen = true; renderStage(); } // folded: its row opens in place
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
      // On a phone the new row is shown; the sheet stays where it was put.
      if (added && S.panel.layout() === 'sheet' && S.panel.tab() === 'looks' && !S.panel.collapsed() && cards.has('preview:' + added.id)) {
        const row = cards.get('preview:' + added.id).el;
        reveal(row.offsetParent ? row : $$('#lkPrevSum'), true); // folded: its summary line is what shows it
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
    const part = removeScope(c.layer), live = c.lane === 'house', name = layerName(S, c.layer);
    // Removing a look from the lights changes them: it can be taken back.
    const point = live ? await mark(api) : '';
    try {
      if (part) await post(base, { target: part, effect: 'solid', params: { color: '#000000' } });
      else { await del(base + '/' + encodeURIComponent(c.id)); if (c.lane === 'preview') forget(c.id); }
      await S.refresh();
    } catch (e) { S.fail('remove the look', e); return; }
    if (!live) return;
    offerUndo(point, `removed ${name}`);
    S.toast(`Removed ${String(name).replace(/\u00a0/g, ' ')} from ${part ? targetName(g, part) : 'the lights'}.`, { ms: TOAST_MS, actions: undoAction() });
  }

  // ---------- undo ----------

  // undo is the one change this page can take back. offerUndo records the
  // point marked before a change (none if the mark failed) and keeps the
  // card's link for its five minutes; undoAction is the toast's button.
  const undo = createUndo();
  let undoTimer = 0;
  function offerUndo(id, what) {
    undo.set(id, what);
    clearTimeout(undoTimer);
    if (undo.link()) undoTimer = setTimeout(renderUndo, undo.linkLeft() + 50);
    renderUndo();
  }
  const undoAction = () => (undo.point() ? [{ id: 'undo', label: 'Undo', run: undoLast }] : []);
  function renderUndo() {
    const p = undo.link() ? undo.point() : null;
    $$('#lkUndoLine').hidden = !p;
    if (p) $$('#lkUndo').setAttribute('aria-label', `Undo last change: ${p.what}`);
  }
  // undoLast puts the lights' stack back as it was before the last change.
  // It restores looks only: no power command, no zone brightness.
  let undoing = false;
  async function undoLast() {
    const p = undo.point();
    if (!p || undoing) return;
    undoing = true;
    let failure = null;
    try { await post('/api/v1/undo', { id: p.id }); } catch (e) { failure = e; }
    undoing = false;
    const r = undoResult(failure);
    if (r.gone) { undo.clear(); clearTimeout(undoTimer); }
    renderUndo();
    await S.refresh();
    S.toast(r.text, r.warn ? { warn: true } : {});
  }

  // makeCard builds one row: the name on its own line, so no control can
  // crowd it, then its controls. A row keeps its shape whether it is a preview
  // or on the lights, so Apply turns one into the other in place.
  function makeCard(lane, l) {
    const el = document.createElement('div');
    el.className = `layer ${lane}`;
    el.innerHTML = `
      <div class="name-line"><small class="kind"></small><span class="strip"></span><b></b><small class="front"></small><span class="line-place"></span><span class="line-level"></span><button type="button" class="icon-btn row-expand" aria-expanded="false">${icon('chevronDown')}</button></div>
      <div class="controls">
        <div class="place-row"></div>
        <div class="bri"><span class="bri-label" title="How bright this look is">${icon('sun')}<span class="bri-word">Brightness</span></span><input type="range" min="0" max="1" step="0.01" aria-label="Brightness of this look"><output></output></div>
        <button type="button" class="tweak icon-btn" aria-expanded="false">${icon('tweak')}Tweak</button><button type="button" class="icon-btn" data-a="remove">${icon('close')}<span>Remove</span></button>
      </div>
      <div class="note"></div>
      <div class="slot"></div>`;
    const c = { lane, id: l.id, el, layer: l, form: null };
    const base = lane === 'preview' ? '/api/v1/preview/layers/' : '/api/v1/layers/';
    c.patch = patcher(() => base + encodeURIComponent(c.id), 80, (nl) => { c.layer = { ...c.layer, ...nl }; }, (e) => S.fail('change the look', e));
    const bri = el.querySelector('.bri input'), out = el.querySelector('.bri output');
    bri.oninput = () => { out.textContent = Math.round(bri.value * 100) + '%'; el.querySelector('.line-level').textContent = out.textContent; c.patch.set({ brightness: +bri.value }); };
    el.querySelector('.row-expand').onclick = () => openRow(c, !c.el.classList.contains('open'));
    el.querySelector('.tweak').onclick = () => tweak(c);
    el.querySelector('[data-a=remove]').onclick = () => remove(c, lane === 'preview' ? '/api/map/preview/layers' : '/api/v1/layers');
    if (lane === 'preview') {
      const place = Object.assign(document.createElement('button'), { type: 'button', className: 'place target-select', title: 'Move this look somewhere else' });
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
    el.querySelector('.kind').textContent = c.lane === 'preview' ? 'Preview' : 'Live';
    el.querySelector('.front').textContent = front ? 'In front' : '';
    el.querySelector('.front').title = front ? 'Shown over the layers below it' : '';
    // A preview layer's place is a control; on the lights it's a fact.
    const placeName = targetName(g, l.target), placeBtn = el.querySelector('.place');
    if (placeBtn) {
      const pc = placeControl(placeName);
      placeBtn.innerHTML = `<span class="muted">${pc.label}</span><b>${esc(pc.text)}</b>${icon('chevronDown')}`;
      placeBtn.title = pc.title;
    } else {
      const bits = [`On ${placeName}`];
      if (l.owner && l.owner !== 'api' && l.owner !== 'live-map') bits.push(l.owner);
      if (l.expires) bits.push('until ' + new Date(l.expires).toLocaleTimeString());
      const meta = el.querySelector('.meta');
      meta.textContent = bits.join(' · ');
      meta.title = meta.textContent;
    }
    const line = layerLine(c.lane === 'preview' ? 'Preview' : 'Live', layerName(S, l), placeName, briOf(l));
    el.querySelector('.line-place').textContent = line.place;
    if (!c.patch.busy()) el.querySelector('.line-level').textContent = line.bri;
    el.querySelector('.row-expand').setAttribute('aria-label', line.label);
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
    rm.title = part ? `Remove from ${nodeName(S.sel.node)}: turn off ${targetName(g, part)} and leave the rest of this look on` : (c.lane === 'preview' ? 'Remove from the preview' : 'Remove from the lights');
    if (c.form && !c.patch.busy()) c.form.update(l);
    if (c.only) c.only.hidden = (S.preview?.layers.length || 0) < 2;
    fitControls(c);
  }

  // fitControls keeps a row's words whole on a narrow sheet. Collapsed, when
  // the look's name cannot share its line with the place and level, those
  // two take a second line beneath it. Open, when the place and a worded
  // Remove cannot share the line, Remove drops its word (its aria-label and
  // title still say it) rather than the name losing letters.
  function fitControls(c) {
    const el = c.el, name = el.querySelector('.name-line b'), box = el.querySelector('.controls');
    el.classList.remove('tight', 'two-line');
    if (!name.offsetParent || S.panel.layout() !== 'sheet') return;
    if (!el.classList.contains('open')) {
      if (name.scrollWidth > name.clientWidth + 1) el.classList.add('two-line');
      return;
    }
    if (box.scrollWidth > box.clientWidth + 1) el.classList.add('tight');
  }

  // openRow shows or hides a phone row's full controls.
  function openRow(c, on) {
    c.el.classList.toggle('open', on);
    c.el.querySelector('.row-expand').setAttribute('aria-expanded', on ? 'true' : 'false');
    fitControls(c);
  }

  // renderRows keeps the stage's list in order: the preview's rows, then the
  // lights', each already top first, so the top of the list is what's in front.
  // liveOpen is whether the half sheet's folded live rows are shown, and
  // prevOpen the same for its folded preview rows (B143).
  let liveOpen = false, prevOpen = false;
  function renderRows(prev, house) {
    const box = $$('#lkRows'), rows = [...prev.map((l) => ['preview', l]), ...house.map((l) => ['house', l])];
    const keep = new Set();
    // On the half sheet a preview folds the live rows into one line (A2), so
    // the Library's first row stays on screen; the chevron opens them in place.
    const sum = $$('#lkLiveSum'), fold = liveFold({ compact: compact(), preview: prev.length, live: house.length, open: liveOpen });
    sum.hidden = !fold.summary;
    sum.setAttribute('aria-expanded', liveOpen ? 'true' : 'false');
    const nameOf = (l) => layerName(S, l);
    sum.setAttribute('aria-label', liveSummary(house, nameOf));
    fitText(sum.querySelector('.text'), [2, 1, 0].map((shown) => liveNames(house, nameOf, shown)));
    box.classList.toggle('live-folded', fold.folded);
    // Two or more previews fold the same way, so the card shows at most one
    // layer row in full at the half detent.
    if (prev.length < 2) prevOpen = false;
    const psum = $$('#lkPrevSum'), pfold = previewFold({ compact: compact(), preview: prev.length, open: prevOpen });
    psum.hidden = !pfold.summary;
    psum.setAttribute('aria-expanded', prevOpen ? 'true' : 'false');
    psum.setAttribute('aria-label', previewSummary(prev, nameOf));
    fitText(psum.querySelector('.text'), [2, 1, 0].map((shown) => previewNames(prev, nameOf, shown)));
    box.classList.toggle('prev-folded', pfold.folded);
    if (pfold.folded && pickFor && pickFor.lane === 'preview') openPicker(false); // its row is folded away
    if (psum !== box.firstChild) box.insertBefore(psum, box.firstChild);
    let last = psum, placed = false; // placed: the summary sits before the first live row
    for (const [lane, l] of rows) {
      const key = lane + ':' + l.id, front = rows.length > 1 && l === rows[0][1];
      keep.add(key);
      let c = cards.get(key);
      if (!c) { c = makeCard(lane, l); cards.set(key, c); }
      updateCard(c, l, front);
      if (lane === 'house' && !placed) {
        if (sum.previousSibling !== last) box.insertBefore(sum, last.nextSibling);
        last = sum; placed = true;
      }
      const next = last.nextSibling;
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
  $$('#lkLiveSum').onclick = () => { liveOpen = !liveOpen; renderStage(); };
  $$('#lkPrevSum').onclick = () => { prevOpen = !prevOpen; renderStage(); };

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
    let head = { title: stageTitle({ live: house.length, preview: prev.length, read: !!S.houseRead, status: S.houseStatus }), sub: stageSub({ rows: prev.length + house.length, stale, word, read: !!S.houseRead, status: S.houseStatus, compact: compact() }) };
    if (compact()) head = compactStage({ ...head, preview: prev.length, live: house.length });
    $$('#lkStageTitle').textContent = head.title;
    $$('#lkStageSub').textContent = head.sub;
    $$('#lkStage').classList.toggle('stale', stale);
    // The empty state carries the one line that teaches the tap, until something is selected.
    $$('#lkTip').hidden = !!(prev.length + house.length) || !!S.sel || !S.houseRead;
    const notRead = S.houseStatus === 'available' || S.houseRead ? null : houseState(S.houseStatus, S.house.length);
    stageState(previewState(S.preview, S.previewStatus) || notRead);
    // The toggle can be on Lights with a preview open: the stage says so.
    $$('#lkMapNote').hidden = !(prev.length && S.show === 'house');
    const lit = lightOutcome(g, S.statusData?.brightness, house.map((l) => targetRanges(g, S.tree, l.target)));
    const landing = lightOutcome(g, S.statusData?.brightness, prev.map((x) => targetRanges(g, S.tree, x.target)));
    renderDark(zoneWarning(lit, landing, { previewing: prev.length > 0 }));
    renderBar(prev);
    fitStageHead();
    fitDark();
    markPreviewed();
    S.refreshBadge?.();
    // A copy whose preview layer is gone is forgotten.
    const ids = new Set(prev.map((l) => l.id));
    if (Object.keys(copies).some((k) => !ids.has(k)) && S.preview) {
      copies = Object.fromEntries(Object.entries(copies).filter(([k]) => ids.has(k)));
      save(COPIES, copies);
    }
  }
  // fitStageHead keeps the compact header's words whole: the sub shares the
  // state's line while it fits there, and takes the line below when it
  // doesn't (B138: the first-use hint and the replaced-look list were cut).
  function fitStageHead() {
    const head = $$('.stage-head'), sub = $$('#lkStageSub');
    head.classList.remove('sub-below');
    if (!compact() || !sub.offsetParent) return;
    // Cut where it is, or already wrapped under the state by the header's
    // other items: either way it takes its own whole line.
    if (subBelow(sub.textContent, sub.scrollWidth, sub.clientWidth) || (sub.textContent && sub.offsetTop > $$('#lkStageTitle').offsetTop + 4)) head.classList.add('sub-below');
  }
  // renderDark is the one 0% line, inside the stage. Drawn only on a change: a
  // poll mustn't replace the button under a press.
  let shownDark = '';
  function renderDark(w) {
    const box = $$('#lkDark'), key = w ? `${w.text}|${w.names}` : '';
    box.hidden = !w;
    S.dimZones = w ? w.ids.length : 0; // the map pill says these are drawn dim
    if (key === shownDark) return;
    shownDark = key;
    box.title = w?.detail || '';
    box.innerHTML = w ? `${icon('alert')}<span class="warn-text">${esc(w.text)}</span>${w.ids.length ? `<button type="button" class="icon-btn" id="lkDarkOn" title="${esc(turnOnLabel(w.names))}" aria-label="${esc(turnOnLabel(w.names))}">${icon('check')}<span>${esc(turnOnLabel(w.names))}</span></button>` : ''}` : '';
    const on = $$('#lkDarkOn');
    if (on) on.onclick = () => turnOnZones(S, api, w.ids, w.names);
    shownWarn = w;
    fitDark();
  }
  // fitDark keeps the 0% line to one line, whole: the words take the first
  // form that fits beside the button, and a long zone name on the button
  // gives way to "Turn on" (its title and aria-label still name the zone)
  // before any word is cut.
  let shownWarn = null;
  function fitDark() {
    const box = $$('#lkDark'), text = box.querySelector('.warn-text'), w = shownWarn;
    if (!w || !text || !text.offsetParent) return;
    const word = box.querySelector('#lkDarkOn span');
    if (word) word.textContent = turnOnLabel(w.names);
    const texts = warnTexts(w);
    fitText(text, texts);
    if (word && text.scrollWidth > text.clientWidth) { word.textContent = 'Turn on'; fitText(text, texts); }
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
    $$('#lkClear').hidden = !prev.length;
    syncBarInset();
    if (!prev.length) { mode = 'replace'; plan = null; return; }
    const house = S.house.filter((x) => !x.ephemeral);
    const updates = prev.some((x) => copies[x.id]);
    hidden = updates ? [] : replacedBy(house, prev, (t) => targetRanges(g, S.tree, t), new Set(Object.values(copies)));
    plan = applyPlan({ n: prev.length, updates, house: house.length, hidden: hidden.map((x) => layerName(S, x)), mode });
    $$('#lkMode').hidden = !plan.choice;
    for (const b of $$('#lkMode').children) press(b, b.dataset.mode === mode);
    // A phone's bar says the mode once, on the button; the link under it is
    // the other way, so "Replace" is never on two controls at once.
    $$('#lkSwap').hidden = !plan.choice;
    $$('#lkSwap').textContent = swapLabel(mode);
    const go = $$('#lkPushAll'), html = `${icon('apply')}<span>${esc(plan.label)}</span>`;
    if (go.dataset.html !== html) { go.dataset.html = html; go.innerHTML = html; }
    go.title = applyTitle(plan, S.houseStatus === 'unavailable' || !!S.statusFailed);
    $$('#lkBarNote').textContent = plan.note;
    // A phone's bar is one row: what Replace does is the stage's line instead.
    if (S.panel.layout() === 'sheet' && plan.note && !$$('#lkStageSub').textContent) $$('#lkStageSub').textContent = compact() ? compactStage({ sub: plan.note }).sub : plan.note;
    fitNote();
  }
  // fitNote gives the note its own full-width line when it can't share one,
  // so it is never cut off.
  function fitNote() {
    const bar = $$('#lkBar'), note = $$('#lkBarNote');
    bar.classList.remove('note-below');
    if (note.scrollWidth > note.clientWidth + 1) bar.classList.add('note-below');
  }
  for (const b of $$('#lkMode').children) b.onclick = () => { mode = b.dataset.mode; renderStage(); };
  $$('#lkSwap').onclick = () => { mode = mode === 'add' ? 'replace' : 'add'; renderStage(); };
  // placeClear keeps Clear in the bar beside the map, and in the stage's
  // header on a phone, whose bar is one row.
  const clearHome = $$('#lkClear').parentElement;
  function placeClear() { (S.panel.layout() === 'sheet' ? $$('.stage-head') : clearHome).append($$('#lkClear')); }
  placeClear();
  S.on('layout', () => { placeClear(); renderStage(); });
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
    openRow(c, true); // a form opens in a row that shows it
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
    const going = (S.preview ? S.preview.layers : []).filter((l) => list.includes(l.id));
    const applied = going.map((l) => targetRanges(g, S.tree, l.target)), names = going.map((l) => layerName(S, l));
    applying = true;
    // The lights are about to change: mark how they are, so it can be undone.
    const point = await mark(api);
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
    offerUndo(point, `applied ${list.length === 1 ? names[0] || 'the look' : list.length + ' looks'}`);
    darkToast = applyToast(S, what, outcome, names.length === 1 ? names[0] : `${names.length} looks`, undoAction()[0] || null);
  }
  $$('#lkUndo').onclick = undoLast;
  $$('#lkPushAll').onclick = () => apply([], plan?.replace ? hidden : []);
  $$('#lkClear').onclick = async () => {
    try { await del('/api/map/preview/layers'); copies = {}; save(COPIES, copies); await S.refresh(); } catch (e) { S.fail('clear the preview', e); }
  };

  // ---------- wiring ----------

  S.on('presets', () => { renderCatalog(); renderStage(); });
  S.on('preview', renderStage);
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
  S.on('detent', renderStage); // the half sheet's stage is the compact one
  S.on('tab', () => { syncBarInset(); fitNote(); });
  S.on('layout', fitNote);
  S.on('status', renderStage); // a zone's brightness changed the warning
  S.on('statusRead', renderStage); // a status read failed, or recovered: the Apply title says
  fillTargets();
  renderCatalog();
  S.on('ready', clearBar);
  S.tiles?.watch($$('#lkPresets'));
  // The rows' words are fitted to the width they have, so refit on a resize.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { for (const c of cards.values()) fitControls(c); fitStageHead(); fitDark(); }).observe($$('#lkRows'));

  return {
    push,
    // targetRanges is the pixels the next look would go on, for the map's halo.
    targetRanges: here,
    // inPreview says a preset is in the preview on the current target.
    inPreview: (preset) => (S.preview ? S.preview.layers : []).some((l) => l.preset === preset && sameTarget(l.target, currentTarget())),
  };
}

