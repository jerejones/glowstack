// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Looks tab: what to show where. Preset cards (and effects) push a
// look onto the preview stack for the selected area; the preview lane
// lists those layers with Apply to lights; the lights lane lists what
// the lights show. Each layer card has a brightness slider (sent as you
// drag) and Tweak. Tweaking a layer on the lights edits a preview copy;
// applying the copy promotes it and then removes the original, in that
// order, so the lights are never without the look. The preview clock
// is a line at the bottom that opens to its controls.
import { post, del, patch, esc, save, load, parseQty, press, covers, sameSet, humanize } from '../util.js';
import { nodeName, nodeTarget, targetName, targetGroups, targetRanges } from '../select.js';
import { houseStatusMessage, lightOutcome, BRIGHTNESS_RULE } from '../house-status.js';
import { createForm, patcher, effectFor, valuesFor, layerName, lookStrip, presetName } from '../form.js';
import { showState, stateHTML, warningHTML } from '../states.js';
import { icon } from '../icons.js';
import { textField } from '../field.js';
import { escapeCloses } from '../picker.js';

const COPIES = 'glowstack.copies'; // preview copy id → the lights layer it stands in for
const CLOCK = 'glowstack.clock.open';
const TARGET = 'glowstack.looks.target';
const PEEK_CHROME = 68; // the sheet's handle and tabs, above .content

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

// previewState is the Preview lane's state when it has no layers to list.
export function previewState(preview, status, word = 'Tap') {
  if (preview) return preview.layers.length ? null : { kind: 'empty', title: 'No preview yet', detail: `${word} a preset to preview it on the map; the lights don't change.` };
  return status === 'failed' ? { kind: 'error', title: 'Could not load the preview', detail: "Glowstack didn't answer. The lights are not affected." } : { kind: 'loading', title: 'Loading the preview…' };
}

// houseState is the Lights lane's state beside (or instead of) its layers.
export function houseState(status, count) {
  const title = houseStatusMessage(status, count);
  if (!title) return null;
  if (status === 'unavailable') return { kind: 'error', title, detail: "Glowstack didn't answer. The lights are not affected." };
  return { kind: status === 'available' ? 'empty' : 'loading', title };
}

// previewFirst says the preview's cards go ahead of the preset chooser.
export function previewFirst(layout, layers) { return layout === 'sheet' && layers > 0; }

// nowLine is the current-state line above the catalog, as words. house is
// the lights' layers, nameOf reads them, read says a reading ever came back;
// status is the latest. A failed refresh keeps the last state and says so.
// lit is the lights' lightOutcome: a look that can't be seen doesn't read
// as simply being on: the lane's card says why, once.
export function nowLine({ house, previewing, status, read, word, nameOf }) {
  if (status !== 'available' && !read) return null;
  const stale = status !== 'available';
  const main = house.length ? `On the lights: ${nameOf(house)}` : 'Nothing on the lights';
  const sub = stale ? "Couldn't refresh. This is the last known state." : previewing || house.length ? '' : `${word} a preset to preview it on the map; the lights don't change.`;
  return { main, sub, stale };
}

// nowTrails says the row is only a status line under the preview: with
// nothing on the lights, a preview is what the panel is about.
export const nowTrails = (house, previews) => !house && previews > 0;

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

// clearLabel is the footer's way out: it must not read like a card's Remove.
export const clearLabel = (n) => (n > 1 ? 'Clear all' : 'Clear preview');

// replaceNote explains the choice between Add on top and Replace lights.
export function replaceNote(names) {
  if (!names.length) return '';
  const list = names.length < 3 ? names.join(' and ') : `${names.length} looks`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} on these lights. Replace takes ${names.length === 1 ? 'it' : 'them'} off; Add on top keeps ${names.length === 1 ? 'it' : 'them'} underneath.`;
}

// applyResult is what Apply reports: plain success only when the look can
// be seen. outcome is lightOutcome for the applied looks.
export function applyResult(what, outcome, cardShown = false) {
  if (!outcome.dark) return { text: `Applied ${what}.`, warn: false };
  const lead = outcome.dark === 'none' ? `Applied ${what}, but they stay dark.` : `Applied ${what}, but part of it stays dark.`;
  // The warning on screen says why, once: this confirms, never as plain success.
  return cardShown ? { text: lead, warn: false, neutral: true } : { text: `${lead} ${outcome.message}`, warn: true };
}

// applyWarning is the Apply bar's word before it's pressed: the looks in
// preview would land in zones at 0%. '' when they would show.
export function applyWarning(outcome) {
  if (!outcome.dark) return '';
  return `${outcome.dark === 'none' ? 'This will stay dark' : 'Part of this will stay dark'} on the lights. ${outcome.message}`;
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
  const cards = new Map(); // lane:id → card
  const word = S.coarse ? 'Tap' : 'Click';
  root.innerHTML = `
    <div class="looks-head"><h1 class="title">Looks</h1></div>
    <div class="now" id="lkNow" hidden><span class="strip" id="lkNowStrip"></span><span class="what"><b id="lkNowMain"></b><small id="lkNowSub"></small></span><button type="button" class="now-go quiet icon-btn" id="lkNowGo" title="Go to what is on the lights, to tweak or remove it">${icon('eye')}View</button></div>
    <div id="lkDark" data-dark hidden></div>
    <details class="words" id="lkWords" hidden><summary>What these words mean</summary><p class="muted small">A look is what the lights show: a saved preset, or an effect with your own settings. It goes on a zone (what Home Assistant controls), an area (part of a zone) or a run (one strip of lights).</p></details>
    <div class="catalog-head" id="lkCatalogHead">
      <h2 class="group-head" id="lkPresetsHead">Presets</h2>
      <button type="button" class="target-btn icon-btn" id="lkTarget" aria-expanded="false" aria-controls="lkPicker" title="Where the next preset or effect you pick goes. Looks already added keep their own place, on their cards." aria-haspopup="dialog"><span class="muted">New previews go on</span><b id="lkTargetName"></b>${icon('chevronDown')}</button>
      <div class="target-picker" id="lkPicker" role="dialog" aria-label="Where the next look goes" hidden>
        <div class="pick-head"><h2 id="lkPickTitle"></h2><button type="button" class="icon-btn" id="lkPickClose" aria-label="Close" title="Close">${icon('close')}</button></div>
        ${textField({ ariaLabel: 'Find a place', id: 'lkTargetSearch', type: 'search', placeholder: 'Find a place' })}
        <div class="muted small" id="lkPickHint">${word} the map to pick a run; ${word.toLowerCase()} again for the area around it.</div>
        <div class="target-list" id="lkTargetList"></div>
      </div>
    </div>
    <div class="cards" id="lkPresets"></div>
    <details id="lkOtherPresets"><summary>More presets <span class="muted"></span></summary><div class="cards"></div></details>
    <details id="lkEffects"><summary>Effects <span class="muted"></span></summary><div class="cards"></div></details>
    <div class="lane" id="lkPreview">
      <div class="row"><h2>Preview <small>on the map only</small></h2></div>
      <p class="muted small lane-note" id="lkMapNote" hidden>The map is showing the lights, not this preview. <button type="button" id="lkShowPreview">Show preview</button></p>
      <p class="muted small stack-note" id="lkStack" hidden>Looks stack. The top one in this list is in front wherever they overlap.</p>
      <div class="list"></div>
    </div>
    <div class="lane" id="lkHouse">
      <div class="row"><h2>On the lights <small id="lkHouseN"></small></h2></div>
      <div class="list"></div>
    </div>
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
      <p class="bar-note" id="lkBarNote" hidden></p>
      <div class="look-acts">
        <button type="button" id="lkClear" class="quiet icon-btn" title="Take everything off the preview; the lights don't change"></button>
        <button type="button" id="lkAdd" class="quiet icon-btn" hidden title="Put this on the lights above what's already there">${icon('plus')}Add on top</button>
        <button type="button" class="go icon-btn" id="lkPushAll">${icon('check')}Apply to lights</button>
      </div>
    </div>`;
  const $$ = (sel) => root.querySelector(sel);

  // ---------- target ----------

  // currentTarget is where a look goes: the map's selection, else the
  // place chosen here while the geometry still has it, else everything.
  function currentTarget() {
    if (S.sel) return nodeTarget(S.sel.node);
    return target && targetRanges(g, S.tree, target) ? target : 'all';
  }
  let shownDark = '';
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
    if (picker.classList.contains('as-sheet')) { list.style.maxHeight = ''; picker.classList.remove('up'); return; }
    const room = () => content.getBoundingClientRect().bottom - list.getBoundingClientRect().top - (bar.hidden ? 0 : bar.offsetHeight) - 12;
    // A card low in the list has its room above it: bring the card up first.
    picker.classList.remove('up');
    // Its least height first: the room is what's left with that much open.
    list.style.maxHeight = '220px';
    if (pickFor) pickFor.el.querySelector('.place-row').scrollIntoView({ block: 'start' });
    // At the end of the list there's no scrolling further: it opens upward.
    if (pickFor && room() < 220) {
      const row = pickFor.el.querySelector('.place-row').getBoundingClientRect().top - content.getBoundingClientRect().top;
      picker.classList.add('up');
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
  S.on('select', () => { fillTargets(); renderLanes(); });

  // ---------- presets and effects ----------

  function card(name, sub, strip, look, onclick, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.title = title || name;
    b.innerHTML = `<span class="strip" style="background:${esc(strip)}"></span><span class="name">${esc(name)}</span><span class="sub">${esc(sub)}</span><span class="in-badge">${icon('check')}<span>Previewing</span></span>`;
    b.dataset.look = look;
    b.onclick = onclick;
    return b;
  }
  function renderCatalog() {
    const pres = $$('#lkPresets');
    const presetCard = (p) => { const e = effectFor(S, { preset: p.id }); return card(presetName(p), e ? cardSummary(presetName(p), e) : humanize(p.effect),
      lookStrip(S, p.effect, p.params), 'preset:' + p.id, () => push({ preset: p.id }), `Preview ${presetName(p)} here`); };
    $$('#lkEffects summary span').textContent = `(${(S.catalog.effects || []).length})`;
    if (S.library.presets === 'failed' || S.library.catalog === 'failed') {
      // Failing is not the same as having nothing: say so, with Retry.
      $$('#lkOtherPresets').hidden = $$('#lkEffects').hidden = true;
      pres.classList.remove('cards');
      showState(pres, { kind: 'error', title: S.library.presets === 'failed' ? 'Could not load your presets' : 'Could not load the effects', detail: 'Glowstack did not return them. The lights are not affected.', retry: S.retryLibrary });
      return;
    }
    pres.classList.add('cards');
    $$('#lkEffects').hidden = false;
    // Looks are presets first: with nothing pinned, every preset leads.
    const pinned = S.presets.filter((p) => p.pinned);
    $$('#lkPresetsHead').textContent = pinned.length ? 'Pinned presets' : 'Presets';
    pres.replaceChildren(...(pinned.length ? pinned : S.presets).map(presetCard));
    if (!pres.childElementCount) {
      pres.classList.remove('cards');
      pres.innerHTML = stateHTML({ kind: 'empty', title: 'No presets yet', detail: 'Save a look as a preset and it appears here.', action: { id: 'lkEmptyNew', label: 'New preset' } });
      pres.querySelector('#lkEmptyNew').onclick = () => { S.panel.openTab('presets'); S.presetLibrary.openEditor(); };
    }
    const other = pinned.length ? S.presets.filter((p) => !p.pinned) : [];
    $$('#lkOtherPresets').hidden = !other.length;
    $$('#lkOtherPresets summary span').textContent = `(${other.length})`;
    $$('#lkOtherPresets .cards').replaceChildren(...other.map(presetCard));
    $$('#lkEffects .cards').replaceChildren(...(S.catalog.effects || []).map((e) => card(e.name || e.id, effectKind(e), lookStrip(S, e.id, {}), 'effect:' + e.id, () => push({ effect: e.id }))));
    markPreviewed();
  }

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
      b.querySelector('.in-badge').lastChild.textContent = other ? 'Previewing elsewhere' : 'Previewing';
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
      // The new layer's card, where it can be seen: not under the bar.
      if (added && !S.panel.collapsed() && cards.has('preview:' + added.id)) reveal(cards.get('preview:' + added.id).el, true);
    } catch (e) { S.fail('preview the look', e); } finally { tapping.delete(key); }
  }

  // ---------- lanes ----------

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
  // remove takes layer l (lane base) off, or just the selected part of it.
  async function remove(c, base) {
    const part = removeScope(c.layer);
    try {
      if (part) await post(base, { target: part, effect: 'solid', params: { color: '#000000' } });
      else { await del(base + '/' + encodeURIComponent(c.id)); if (c.lane === 'preview') forget(c.id); }
      await S.refresh();
    } catch (e) { S.fail('remove the look', e); }
  }

  function makeCard(lane, l) {
    const el = document.createElement('div');
    el.className = 'layer';
    el.innerHTML = `
      <div class="top"><div class="what"><b></b></div>
        <button type="button" class="tweak icon-btn" aria-expanded="false">${icon('setup')}Tweak</button><button type="button" class="icon-btn" data-a="remove">${icon('trash')}<span>Remove</span></button></div>
      <div class="place-row"><span class="meta"></span></div>
      <div class="strip"></div>
      <div class="bri"><span class="bri-label" title="How bright this look is">${icon('sun')}Brightness</span><input type="range" min="0" max="1" step="0.01" aria-label="Brightness of this look"><output></output></div>
      <div class="acts"></div>
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
      el.querySelector('.place-row').prepend(place);
      const acts = el.querySelector('.acts');
      acts.innerHTML = `<button type="button" class="icon-btn" data-a="apply" hidden title="Put only this look on the lights">${icon('check')}Apply only this</button>`;
      acts.querySelector('[data-a=apply]').onclick = () => apply([c.id]);
    }
    return c;
  }

  function updateCard(c, l, onTop = false) {
    c.layer = l;
    const el = c.el;
    el.style.setProperty('--acc', c.lane === 'preview' ? 'var(--preview)' : 'var(--house)');
    el.querySelector('.what b').textContent = layerName(S, l);
    // A preview layer's place is a control; on the lights it's a fact.
    const placeName = targetName(g, l.target), placeBtn = el.querySelector('.place');
    if (placeBtn) placeBtn.innerHTML = `<span class="muted">Goes on</span><b>${esc(placeName)}</b>${icon('chevronDown')}`;
    const bits = placeBtn ? [] : [`On ${placeName}`];
    if (l.owner && l.owner !== 'api' && l.owner !== 'live-map') bits.push(l.owner);
    if (l.expires) bits.push('until ' + new Date(l.expires).toLocaleTimeString());
    if (onTop) bits.push('on top');
    el.querySelector('.meta').textContent = bits.join(' · ');
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
    rm.title = part ? `Remove from ${nodeName(S.sel.node)}: turn off ${targetName(g, part)} and leave the rest of this look on` : (c.lane === 'preview' ? 'Remove from the preview' : 'Take this look off the lights');
    if (c.form && !c.patch.busy()) c.form.update(l);
  }

  function renderLane(box, lane, layers) {
    const keep = new Set();
    let prev = null;
    for (const l of layers) {
      const key = lane + ':' + l.id;
      const onTop = layers.length > 1 && l === layers[0]; // the server lists them top first
      keep.add(key);
      let c = cards.get(key);
      if (!c) { c = makeCard(lane, l); cards.set(key, c); }
      updateCard(c, l, onTop);
      const next = prev ? prev.nextSibling : box.firstChild;
      if (c.el !== next) box.insertBefore(c.el, next);
      prev = c.el;
    }
    for (const [key, c] of cards) {
      if (c.lane !== lane || keep.has(key)) continue;
      if (pickFor === c) openPicker(false); // the list lives in this card while open
      c.el.remove();
      cards.delete(key);
    }
    return layers.length;
  }

  // laneState shows a lane's loading, failed or empty state after its
  // layers. It's redrawn only when it changes: the lanes repaint every
  // poll, and a Retry mid-tap has to stay put.
  function laneState(box, opts) {
    let el = box.querySelector('.lane-state');
    if (!opts) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'lane-state'; box.append(el); }
    const key = opts.kind + opts.title;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    showState(el, opts.kind === 'error' ? { ...opts, retry: () => { el.dataset.key = ''; return S.refresh(); } } : opts);
  }

  // On a phone the preview being worked on comes before the chooser; with
  // none, or beside the map on a desktop, presets stay first.
  function orderPreview() {
    const lane = $$('#lkPreview');
    const next = previewFirst(S.panel.layout?.(), S.preview?.layers?.length ?? 0) ? head : $$('#lkHouse');
    const after = lane.nextElementSibling === $$('#lkNow') ? $$('#lkNow').nextElementSibling : lane.nextElementSibling;
    if (after !== next) next.before(lane);
  }

  function renderLanes() {
    const prev = S.preview ? S.preview.layers : [];
    const pbox = $$('#lkPreview .list');
    renderLane(pbox, 'preview', prev);
    const previewNote = previewState(S.preview, S.previewStatus, word);
    laneState(pbox, previewNote);
    orderPreview();
    // An empty lane says nothing the current-state line doesn't.
    $$('#lkPreview').hidden = !prev.length && (!previewNote || previewNote.kind === 'empty');
    $$('#lkStack').hidden = prev.length < 2;
    $$('#lkWords').hidden = !!prev.length || S.house.some((l) => !l.ephemeral);
    // The toggle can be on Lights with a preview open: this section says so.
    $$('#lkMapNote').hidden = !(prev.length && S.show === 'house');
    // Once something is previewing it's the thing being worked on: the long
    // grids fold away so its card sits close to the heading.
    if (prev.length && !hadPreview) $$('#lkEffects').open = $$('#lkOtherPresets').open = false;
    hadPreview = prev.length > 0;
    for (const c of cards.values()) {
      if (c.lane !== 'preview') continue;
      c.el.querySelector('[data-a=apply]').hidden = prev.length < 2;
      // With one look, Clear preview in the footer is this same action.
      c.el.querySelector('[data-a=remove]').hidden = prev.length < 2 && !removeScope(c.layer);
    }
    const house = S.house.filter((l) => !l.ephemeral);
    const lit = lightOutcome(g, S.statusData?.brightness, house.map((l) => targetRanges(g, S.tree, l.target)));
    renderBar(prev, !!lit.dark);
    markPreviewed();

    const hbox = $$('#lkHouse .list');
    renderLane(hbox, 'house', house);
    // A failed refresh with a last reading: the line above says it, once.
    const houseNote = S.houseStatus === 'unavailable' && S.houseRead ? null : houseState(S.houseStatus, S.house.length);
    laneState(hbox, houseNote);
    $$('#lkHouse').hidden = !S.house.length && (!houseNote || houseNote.kind === 'empty');
    // The zones at 0% once on this screen, here: not on the chip, the row
    // above the catalog or every card.
    const dark = lit.dark ? `${lit.message} ${BRIGHTNESS_RULE}` : '';
    $$('#lkDark').hidden = !dark;
    S.refreshBadge?.();
    if (dark !== shownDark) { shownDark = dark; $$('#lkDark').innerHTML = dark ? warningHTML(dark) : ''; }
    $$('#lkClockBox').hidden = !prev.length;
    const eph = S.house.length - house.length;
    $$('#lkHouseN').textContent = eph ? `+ ${eph} calibration` : '';
    renderNow(prev, house);
    // A copy whose preview layer is gone is forgotten.
    const ids = new Set(prev.map((l) => l.id));
    if (Object.keys(copies).some((k) => !ids.has(k)) && S.preview) {
      copies = Object.fromEntries(Object.entries(copies).filter(([k]) => ids.has(k)));
      save(COPIES, copies);
    }
  }
  // renderNow is the current state above the catalog: one tap from the
  // full layer card, and short enough to leave the looks in view.
  function renderNow(prev, house) {
    const names = (ls) => (ls.length > 1 ? `${layerName(S, ls[0])} and ${ls.length - 1} more` : layerName(S, ls[0]));
    const line = nowLine({ house, previewing: prev.length > 0, status: S.houseStatus, read: S.houseRead, word, nameOf: names });
    const now = $$('#lkNow'), trails = nowTrails(house.length, prev.length);
    const place = trails ? $$('#lkPreview') : $$('.looks-head');
    if (place.nextElementSibling !== now) place.after(now);
    // Why what's on the lights is dark, right under the line that names it.
    if (now.nextElementSibling !== $$('#lkDark')) now.after($$('#lkDark'));
    now.classList.toggle('plain', trails);
    // What's in preview says so on its bar, card and map: this line is the lights.
    now.hidden = !line;
    if (now.hidden) return;
    const l = house[0];
    const strip = $$('#lkNowStrip');
    strip.hidden = !l;
    if (l) { const eff = effectFor(S, l); strip.style.background = lookStrip(S, eff ? eff.id : l.effect, valuesFor(S, l)); }
    $$('#lkNowMain').textContent = line.main;
    $$('#lkNowSub').textContent = line.sub;
    now.classList.toggle('stale', line.stale);
    // With nothing listed below there's nowhere for it to go.
    now.classList.toggle('idle', !house.length);
    $$('#lkNowGo').hidden = !house.length;
  }
  // View goes to the cards on the lights, and marks them: already on
  // screen there is no scroll to see.
  $$('#lkShowPreview').onclick = () => S.setShow('');
  $$('#lkNowGo').onclick = () => {
    const list = $$('#lkHouse .list'), first = list.querySelector('.layer');
    if (!first) return;
    reveal(first, true);
    for (const el of list.querySelectorAll('.layer')) flash(el);
    first.querySelector('.tweak').focus({ preventScroll: true });
  };
  // reveal brings a card into view, below the tabs and above the Apply bar.
  function reveal(el, smooth = false) {
    const content = root.parentElement, bar = $$('#lkBar'), view = content.getBoundingClientRect();
    const heading = el.closest('.lane').querySelector('.row').getBoundingClientRect().top;
    const aim = laneAim(el.getBoundingClientRect(), heading, !el.previousElementSibling);
    const top = content.scrollTop + revealDelta(aim, view.top + 8, view.bottom - (bar.hidden ? 0 : bar.offsetHeight) - 8);
    content.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }
  // renderBar keeps what's in preview, and the way to apply it, in view
  // however far the lists scroll. It is the one primary action here.
  let hidden = []; // the lights' layers that Apply would replace
  // syncBarInset keeps scrolling into view short of the bar, whatever its
  // height, while the bar is what's at the panel's bottom edge.
  function syncBarInset() {
    const bar = $$('#lkBar'), content = root.parentElement;
    queueMicrotask(() => {
      if (bar.hidden || S.panel.tab() !== 'looks') content.style.removeProperty('--look-bar');
      else content.style.setProperty('--look-bar', bar.offsetHeight + 'px');
    });
  }
  let prevBar = false, hadPreview = false;
  function renderBar(prev, darkShown = false) {
    const bar = $$('#lkBar');
    bar.hidden = !prev.length;
    syncBarInset();
    if (bar.hidden !== !prevBar) { prevBar = !bar.hidden; S.panel.refit(); }
    if (!prev.length) return;
    const updates = prev.some((x) => copies[x.id]);
    const n = prev.length === 1 ? '' : prev.length + ' ';
    hidden = updates ? [] : replacedBy(S.house.filter((x) => !x.ephemeral), prev, (t) => targetRanges(g, S.tree, t), new Set(Object.values(copies)));
    $$('#lkAdd').hidden = !hidden.length;
    $$('#lkClear').innerHTML = `${icon('close')}${clearLabel(prev.length)}`;
    // One 0% message on the screen: the lights' own, if they already have one.
    const landing = darkShown ? '' : applyWarning(lightOutcome(g, S.statusData?.brightness, prev.map((x) => targetRanges(g, S.tree, x.target))));
    const note = [landing, replaceNote(hidden.map((x) => layerName(S, x)))].filter(Boolean).join(' ');
    $$('#lkBarNote').textContent = note;
    $$('#lkBarNote').hidden = !note;
    $$('#lkBarNote').classList.toggle('warn', !!landing);
    $$('#lkPushAll').innerHTML = `${icon('check')}${updates ? 'Update lights' : hidden.length ? 'Replace lights' : `Apply ${n}to lights`}`;
    $$('#lkPushAll').title = updates ? 'Put your changes on the lights in place of the original'
      : hidden.length ? `Takes off ${hidden.map((x) => layerName(S, x)).join(', ')}, which this would cover, and puts this on the lights`
        : "Adds this to the lights; whatever is on them stays underneath";
  }
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
    // Too tall for half a sheet: it needs the room, not half of itself.
    const content = root.parentElement, bar = $$('#lkBar');
    const barH = () => (bar.hidden ? 0 : bar.offsetHeight);
    if (S.panel.layout() === 'sheet' && S.panel.detent() === 'half' && form.el.offsetHeight > content.clientHeight - barH()) {
      revealing = true;
      S.panel.setDetent('full');
      revealing = false;
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
    try {
      await post('/api/map/preview/promote', ids.length ? { ids } : {});
    } catch (e) { S.fail('apply the look', e); await S.refresh(); return; }
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
    const orig = replaced.length === 1 ? 'the original' : replaced.length + ' originals';
    const what = `${list.length === 1 ? 'the look' : list.length + ' looks'} to the lights${replaced.length ? ', in place of ' + orig : ''}`;
    const outcome = lightOutcome(g, S.statusData?.brightness, applied);
    darkToast = applyToast(S, what, outcome, !$$('#lkDark').hidden && !S.panel.collapsed());
    if (outcome.dark && !S.panel.collapsed()) $$('#lkNow').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // the warning sits right under it
  }
  $$('#lkPushAll').onclick = () => apply([], hidden);
  $$('#lkAdd').onclick = () => apply([]);
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

  // At half, a card edge meets the Apply bar (or the sheet's edge): no row is
  // left half showing. From the first row that doesn't fit, by what it spills.
  S.panel.fitHalf = (base) => {
    if (S.panel.tab() === 'setup') return S.fitSetupHalf ? S.fitSetupHalf(base) : base;
    if (S.panel.tab() !== 'looks') return base;
    const content = root.parentElement, top = content.getBoundingClientRect().top - content.scrollTop;
    const shown = base;
    const room = shown - PEEK_CHROME - ($$('#lkBar').hidden ? 0 : $$('#lkBar').offsetHeight);
    let spill = 0;
    for (const c of $$('#lkPresets').children) {
      const r = c.getBoundingClientRect(), cTop = r.top - top, cBottom = r.bottom - top;
      if (cTop < room && cBottom > room) spill = Math.max(spill, cBottom - room);
    }
    return spill ? base + Math.ceil(spill) + 8 : base;
  };
  S.on('presets', () => { renderCatalog(); renderLanes(); });
  S.on('preview', () => { renderLanes(); renderClock(); });
  S.on('house', renderLanes);
  S.on('show', renderLanes);
  // Rising to full can leave a card half under the bar: nothing just shown
  // is left cut by it.
  function clearBar() {
    const bar = $$('#lkBar');
    if (revealing || S.panel.tab() !== 'looks' || S.panel.collapsed() || bar.hidden) return;
    const barTop = bar.getBoundingClientRect().top;
    const cut = [...$$('#lkPreview .list').children].find((el) => underBar(el.getBoundingClientRect(), barTop));
    if (cut) reveal(cut, true);
  }
  S.on('detent', clearBar);
  S.on('tab', () => { syncBarInset(); });
  S.on('status', renderLanes); // a zone's brightness changed the notes
  addEventListener('resize', orderPreview);
  $$('#lkPlay').innerHTML = `${icon('pause')}<span>Pause</span>`;
  fillTargets();
  renderCatalog();
  S.on('ready', () => { S.panel.refit(); clearBar(); });

  return {
    push,
    // inPreview says a preset is in the preview on the current target.
    inPreview: (preset) => (S.preview ? S.preview.layers : []).some((l) => l.preset === preset && sameTarget(l.target, currentTarget())),
    togglePause: () => control({ action: S.preview && S.preview.paused ? 'resume' : 'pause' }),
    fmtClock: () => $$('#lkClockText').textContent,
  };
}

