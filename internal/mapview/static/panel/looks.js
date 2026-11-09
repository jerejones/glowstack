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
import { post, del, esc, save, load, parseQty, press, covers, sameSet, humanize } from '../util.js';
import { nodeName, nodeTarget, targetName, targetGroups, targetRanges } from '../select.js';
import { houseStatusMessage, darkZones, darkMessage } from '../house-status.js';
import { createForm, patcher, effectFor, valuesFor, layerName, lookStrip, presetName } from '../form.js';
import { showState } from '../states.js';
import { icon } from '../icons.js';
import { escapeCloses } from '../picker.js';

const COPIES = 'glowstack.copies'; // preview copy id → the lights layer it stands in for
const CLOCK = 'glowstack.clock.open';
const TARGET = 'glowstack.looks.target';
const PEEK_CHROME = 56; // the sheet's handle and tabs, above .content

// effectKind says what an effect takes its colors from, for its card.
export function effectKind(e) {
  const has = (type) => e.params.some((p) => p.type === type);
  if (e.params.some((p) => p.name.includes('.'))) return 'Layered look';
  if (e.params.some((p) => p.name === 'bands')) return 'Color bands';
  if (has('palette')) return 'Palette colors';
  if (has('colors')) return 'Several colors';
  if (has('color')) return 'One color';
  return 'Effect';
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
  if (preview) return preview.layers.length ? null : { kind: 'empty', title: 'Nothing in preview', detail: `${word} a look to try it on the map; the lights don't change.` };
  return status === 'failed' ? { kind: 'error', title: 'Could not load the preview', detail: "Glowstack didn't answer. The lights are not affected." } : { kind: 'loading', title: 'Loading the preview…' };
}

// houseState is the Lights lane's state beside (or instead of) its layers.
export function houseState(status, count) {
  const title = houseStatusMessage(status, count);
  if (!title) return null;
  if (status === 'unavailable') return { kind: 'error', title, detail: "Glowstack didn't answer. The lights are not affected." };
  return { kind: status === 'available' ? 'empty' : 'loading', title };
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

export function createLooks(S, root) {
  const g = S.geo;
  let copies = load(COPIES, {}) || {};
  let target = load(TARGET, '');      // chosen when nothing is selected
  const cards = new Map(); // lane:id → card
  const word = S.coarse ? 'Tap' : 'Click';
  root.innerHTML = `
    <div class="looks-head">
      <h1 class="title">Looks</h1>
      <button type="button" class="target-btn icon-btn" id="lkTarget" aria-expanded="false" aria-controls="lkPicker" title="Choose where looks go"><span class="muted">Show on</span><b id="lkTargetName"></b>${icon('chevronDown')}</button>
    </div>
    <div class="target-picker" id="lkPicker" hidden>
      <input type="search" id="lkTargetSearch" placeholder="Find a place" autocomplete="off" aria-label="Find a place">
      <div class="muted small">${word} the map to pick a run; ${word.toLowerCase()} again for the area around it.</div>
      <div class="target-list" id="lkTargetList"></div>
    </div>
    <button type="button" class="now quiet" id="lkNow" hidden><span class="strip" id="lkNowStrip"></span><span class="what"><b id="lkNowMain"></b><small id="lkNowSub"></small></span></button>
    <div class="cards" id="lkPresets"></div>
    <details id="lkOtherPresets"><summary>More presets <span class="muted"></span></summary><div class="cards"></div></details>
    <details id="lkEffects"><summary>Effects <span class="muted"></span></summary><div class="cards"></div></details>
    <div class="lane" id="lkPreview">
      <div class="row"><h2>Preview <small>on the map only</small></h2></div>
      <div class="list"></div>
    </div>
    <div class="lane" id="lkHouse">
      <div class="row"><h2>On the lights <small id="lkHouseN"></small></h2></div>
      <div class="list"></div>
    </div>
    <div class="clock" id="lkClock">
      <button type="button" id="lkPlay" class="icon-btn" title="Pause or resume the preview clock (space)" aria-label="Pause the preview clock"></button>
      <span class="t" id="lkClockText"></span>
      <button type="button" class="quiet icon-btn" id="lkClockMore" aria-expanded="false" title="Clock controls" aria-label="Clock controls"></button>
    </div>
    <div class="clock-more" id="lkClockPanel" hidden>
      <div class="step-pair" role="group" aria-label="Step one frame">
        <button type="button" id="lkBack" class="icon-btn" title="Step back one frame" aria-label="Step back one frame">${icon('stepBack')}</button>
        <button type="button" id="lkFwd" class="icon-btn" title="Step forward one frame" aria-label="Step forward one frame">${icon('stepForward')}</button>
        <span class="muted">Step one frame</span>
      </div>
      <span>Speed</span><input type="range" id="lkSpeed" min="-1" max="1" step="0.01" value="0"><output id="lkSpeedOut">1×</output>
      <span>Scrub</span><input type="range" id="lkScrub" min="-30" max="30" step="0.02" value="0"><span class="muted small">±30 s</span>
      <span></span><button type="button" id="lkLive" title="Back in step with the lights">Now</button><span></span>
    </div>
    <div class="look-bar" id="lkBar" hidden>
      <span class="strip" id="lkBarStrip"></span>
      <div class="what"><b id="lkBarName"></b><span id="lkBarSub"></span></div>
      <div class="look-acts">
        <button type="button" id="lkClear" title="Remove every look from the preview; the lights don't change">Clear preview</button>
        <button type="button" id="lkAdd" hidden title="Put this on the lights above what's already there">Add on top</button>
        <button type="button" class="go" id="lkPushAll">Apply to lights</button>
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
  const picker = $$('#lkPicker'), targetBtn = $$('#lkTarget'), search = $$('#lkTargetSearch');
  const targetKey = (t) => JSON.stringify(targetRanges(g, S.tree, t));
  const sameTarget = (a, b) => a === b || targetKey(a) === targetKey(b);
  function fillTargets() {
    const t = currentTarget();
    $$('#lkTargetName').textContent = S.sel ? nodeName(S.sel.node) : targetName(g, t);
    if (picker.hidden) return;
    const groups = targetGroups(S.tree, { query: search.value, visibleRuns: S.visibility.runs });
    $$('#lkTargetList').replaceChildren(...groups.flatMap((grp) => {
      const head = document.createElement('h3');
      head.textContent = grp.label;
      const box = document.createElement('div');
      box.className = 'chips';
      box.append(...grp.items.map((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.label;
        press(b, sameTarget(it.value, t));
        b.onclick = () => choose(it.value);
        return b;
      }));
      return [head, box];
    }));
    if (!groups.length) showState($$('#lkTargetList'), { kind: 'empty', title: 'No place by that name' });
  }
  const outside = (e) => { if (!picker.contains(e.target) && !targetBtn.contains(e.target)) openPicker(false); };
  function openPicker(on) {
    picker.hidden = !on;
    targetBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    document[on ? 'addEventListener' : 'removeEventListener']('pointerdown', outside, true);
    if (on) { search.value = ''; fillTargets(); if (!S.coarse) search.focus(); }
  }
  for (const el of [targetBtn, picker]) escapeCloses(el, () => !picker.hidden, () => { openPicker(false); targetBtn.focus(); });
  function choose(value) {
    target = value;
    save(TARGET, target);
    openPicker(false);
    targetBtn.focus({ preventScroll: true });
    if (S.sel && value !== nodeTarget(S.sel.node)) S.select(null);
    else { fillTargets(); markPreviewed(); }
  }
  targetBtn.onclick = () => openPicker(picker.hidden);
  search.oninput = fillTargets;
  S.on('runVisibility', fillTargets);
  S.on('select', () => { fillTargets(); renderLanes(); });

  // ---------- presets and effects ----------

  function card(name, sub, strip, look, onclick, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.title = title || '';
    b.innerHTML = `<span class="strip" style="background:${esc(strip)}"></span><span class="name">${esc(name)}</span><span class="sub">${esc(sub)}</span><span class="in-badge">${icon('check')}In preview</span>`;
    b.dataset.look = look;
    b.onclick = onclick;
    return b;
  }
  function renderCatalog() {
    const pres = $$('#lkPresets');
    const presetCard = (p) => { const e = effectFor(S, { preset: p.id }); return card(presetName(p), e ? effectKind(e) : humanize(p.effect),
      lookStrip(S, p.effect, p.params), 'preset:' + p.id, () => push({ preset: p.id }), `Preview ${presetName(p)} here`); };
    $$('#lkEffects summary span').textContent = `(${(S.catalog.effects || []).length})`;
    if (S.library.presets === 'failed' || S.library.catalog === 'failed') {
      // Failing is not the same as having nothing: say so, with Retry.
      $$('#lkOtherPresets').hidden = $$('#lkEffects').hidden = true;
      pres.classList.remove('cards');
      showState(pres, { kind: 'error', title: S.library.presets === 'failed' ? 'Could not load your looks' : 'Could not load the effects', detail: 'Glowstack did not return them. The lights are not affected.', retry: S.retryLibrary });
      return;
    }
    pres.classList.add('cards');
    $$('#lkEffects').hidden = false;
    // Looks are presets first: with nothing pinned, every preset leads.
    const pinned = S.presets.filter((p) => p.pinned);
    pres.replaceChildren(...(pinned.length ? pinned : S.presets).map(presetCard));
    if (!pres.childElementCount) {
      const hint = document.createElement('button');
      hint.type = 'button'; hint.className = 'quiet';
      hint.textContent = 'Create your first preset';
      hint.onclick = () => S.panel.openTab('presets');
      pres.append(hint);
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
      b.querySelector('.in-badge').lastChild.textContent = other ? 'In preview elsewhere' : 'In preview';
      b.setAttribute('aria-pressed', inPreview ? 'true' : 'false');
    }
  }

  // focusLayer brings a preview layer's card into view and marks it.
  function focusLayer(id) {
    const c = cards.get('preview:' + id);
    if (!c) return;
    c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    c.el.classList.add('sel');
    setTimeout(() => c.el.classList.remove('sel'), 1200);
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
      if (added && !S.panel.collapsed()) cards.get('preview:' + added.id)?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    } catch (e) { S.fail('remove the layer', e); }
  }

  function makeCard(lane, l) {
    const el = document.createElement('div');
    el.className = 'layer';
    el.innerHTML = `
      <div class="top"><div class="what"><b></b><span></span></div>
        <button type="button" class="tweak" aria-expanded="false">Tweak</button></div>
      <div class="strip"></div>
      <div class="bri"><span title="Layer brightness">${icon('sun')}</span><input type="range" min="0" max="1" step="0.01" aria-label="Layer brightness"><output></output></div>
      <div class="acts"></div>
      <div class="note"></div>
      <div class="slot"></div>`;
    const c = { lane, id: l.id, el, layer: l, form: null };
    const base = lane === 'preview' ? '/api/v1/preview/layers/' : '/api/v1/layers/';
    c.patch = patcher(() => base + encodeURIComponent(c.id), 80, (nl) => { c.layer = { ...c.layer, ...nl }; }, (e) => S.fail('change the layer', e));
    const bri = el.querySelector('.bri input'), out = el.querySelector('.bri output');
    bri.oninput = () => { out.textContent = Math.round(bri.value * 100) + '%'; c.patch.set({ brightness: +bri.value }); };
    el.querySelector('.tweak').onclick = () => tweak(c);
    const acts = el.querySelector('.acts');
    if (lane === 'preview') {
      acts.innerHTML = `<button type="button" data-a="apply" hidden title="Put only this look on the lights">Apply only this</button><button type="button" data-a="remove">Remove</button>`;
      acts.querySelector('[data-a=apply]').onclick = () => apply([c.id]);
      acts.querySelector('[data-a=remove]').onclick = () => remove(c, '/api/map/preview/layers');
    } else {
      acts.innerHTML = `<button type="button" data-a="remove">Remove</button>`;
      acts.querySelector('[data-a=remove]').onclick = () => remove(c, '/api/v1/layers');
    }
    return c;
  }

  function updateCard(c, l) {
    c.layer = l;
    const el = c.el;
    el.style.setProperty('--acc', c.lane === 'preview' ? 'var(--preview)' : 'var(--house)');
    el.querySelector('.what b').textContent = layerName(S, l);
    const bits = ['on ' + (l.target === 'all' ? 'everything' : targetName(g, l.target))];
    if (l.owner && l.owner !== 'api' && l.owner !== 'live-map') bits.push(l.owner);
    if (l.expires) bits.push('until ' + new Date(l.expires).toLocaleTimeString());
    el.querySelector('.what span').textContent = bits.join(' · ');
    const eff = effectFor(S, l);
    el.querySelector('.strip').style.background = lookStrip(S, eff ? eff.id : l.effect, valuesFor(S, l));
    const bri = el.querySelector('.bri input');
    if (document.activeElement !== bri && !c.patch.busy()) {
      bri.value = briOf(l);
      el.querySelector('.bri output').textContent = Math.round(briOf(l) * 100) + '%';
    }
    const note = el.querySelector('.note');
    const orig = c.lane === 'preview' ? copies[l.id] : '';
    const dark = c.lane === 'house' ? darkMessage(darkZones(g, S.statusData?.brightness, targetRanges(g, S.tree, l.target))) : '';
    note.className = orig ? 'note copy-note' : dark ? 'note dark-note' : 'note';
    note.textContent = orig ? `Editing a preview of ${layerName(S, l)}. Apply to update the lights.` : dark;
    const part = removeScope(l), rm = el.querySelector('[data-a=remove]');
    rm.textContent = part ? `Remove from ${nodeName(S.sel.node)}` : 'Remove';
    rm.title = part ? `Turn off ${targetName(g, part)} with a black layer on top; the rest of this layer stays` : (c.lane === 'preview' ? 'Remove from the preview' : 'Take this layer off the lights');
    if (c.form && !c.patch.busy()) c.form.update(l);
  }

  function renderLane(box, lane, layers) {
    const keep = new Set();
    let prev = null;
    for (const l of layers) {
      const key = lane + ':' + l.id;
      keep.add(key);
      let c = cards.get(key);
      if (!c) { c = makeCard(lane, l); cards.set(key, c); }
      updateCard(c, l);
      const next = prev ? prev.nextSibling : box.firstChild;
      if (c.el !== next) box.insertBefore(c.el, next);
      prev = c.el;
    }
    for (const [key, c] of cards) if (c.lane === lane && !keep.has(key)) { c.el.remove(); cards.delete(key); }
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

  function renderLanes() {
    const prev = S.preview ? S.preview.layers : [];
    const pbox = $$('#lkPreview .list');
    renderLane(pbox, 'preview', prev);
    const previewNote = previewState(S.preview, S.previewStatus, word);
    laneState(pbox, previewNote);
    // An empty lane says nothing the current-state line doesn't.
    $$('#lkPreview').hidden = !prev.length && (!previewNote || previewNote.kind === 'empty');
    for (const c of cards.values()) {
      if (c.lane === 'preview') c.el.querySelector('[data-a=apply]').hidden = prev.length < 2;
    }
    renderBar(prev);
    markPreviewed();

    const house = S.house.filter((l) => !l.ephemeral);
    const hbox = $$('#lkHouse .list');
    renderLane(hbox, 'house', house);
    const houseNote = houseState(S.houseStatus, S.house.length);
    laneState(hbox, houseNote);
    $$('#lkHouse').hidden = !S.house.length && (!houseNote || houseNote.kind === 'empty');
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
    const known = S.houseStatus === 'available';
    const lights = house.length ? `On the lights: ${names(house)}` : known ? 'Nothing on the lights' : '';
    const now = $$('#lkNow');
    now.hidden = !prev.length && !lights;
    if (now.hidden) return;
    const l = prev[0] || house[0];
    const strip = $$('#lkNowStrip');
    strip.hidden = !l;
    if (l) { const eff = effectFor(S, l); strip.style.background = lookStrip(S, eff ? eff.id : l.effect, valuesFor(S, l)); }
    $$('#lkNowMain').textContent = prev.length ? `In preview: ${names(prev)}` : lights;
    $$('#lkNowSub').textContent = prev.length ? lights : `${word} a look to try it on the map; the lights don't change.`;
    // With nothing listed below there's nowhere for it to go.
    const idle = !prev.length && !house.length;
    now.classList.toggle('idle', idle);
    now.tabIndex = idle ? -1 : 0;
    now.onclick = () => $$(prev.length ? '#lkPreview' : '#lkHouse').scrollIntoView({ block: 'start', behavior: 'smooth' });
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
  let prevBar = false;
  function renderBar(prev) {
    const bar = $$('#lkBar');
    bar.hidden = !prev.length;
    syncBarInset();
    if (bar.hidden !== !prevBar) { prevBar = !bar.hidden; S.panel.refit(); }
    if (!prev.length) return;
    const l = prev[0];
    const eff = effectFor(S, l);
    $$('#lkBarStrip').style.background = lookStrip(S, eff ? eff.id : l.effect, valuesFor(S, l));
    $$('#lkBarName').textContent = prev.length === 1 ? layerName(S, l) : `${prev.length} looks in preview`;
    $$('#lkBarSub').textContent = prev.length === 1 ? 'in preview' : prev.map((x) => layerName(S, x)).join(', ');
    const updates = prev.some((x) => copies[x.id]);
    const n = prev.length === 1 ? '' : prev.length + ' ';
    hidden = updates ? [] : replacedBy(S.house.filter((x) => !x.ephemeral), prev, (t) => targetRanges(g, S.tree, t), new Set(Object.values(copies)));
    $$('#lkAdd').hidden = !hidden.length;
    $$('#lkPushAll').textContent = updates ? 'Update lights' : hidden.length ? 'Replace lights' : `Apply ${n}to lights`;
    $$('#lkPushAll').title = updates ? 'Put your changes on the lights in place of the original'
      : hidden.length ? `Takes off ${hidden.map((x) => layerName(S, x)).join(', ')}, which this would cover, and puts this on the lights`
        : "Adds this to the lights; whatever is on them stays underneath";
  }
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
      } catch (e) { S.fail('copy the layer for editing', e); return; }
      const pc = cards.get('preview:' + id);
      if (pc && !pc.form) tweak(pc);
      else if (pc) pc.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      S.toast(`Editing a preview of ${layerName(S, c.layer)}. Apply to update the lights.`);
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
    // The form can open below the sticky bar, where a tap seems to do nothing.
    form.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // apply promotes preview layers (all with ids empty) onto the lights,
  // then removes the lights layers the promoted copies stand in for.
  async function apply(ids, replace = []) {
    const list = ids.length ? ids : (S.preview ? S.preview.layers.map((l) => l.id) : []);
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
    const orig = replaced.length === 1 ? 'the original' : replaced.length + ' originals';
    S.toast(`Applied ${list.length === 1 ? 'the look' : list.length + ' looks'} to the lights${replaced.length ? ', in place of ' + orig : ''}.`);
    await S.refresh();
    // The status poll's brightness can be seconds old: read it now.
    await S.status?.poll();
    const dark = darkMessage([...new Set(S.house.flatMap((l) => darkZones(g, S.statusData?.brightness, targetRanges(g, S.tree, l.target))))]);
    if (dark) S.toast(dark, { ms: 9000, warn: true });
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
  const more = $$('#lkClockMore'), panel = $$('#lkClockPanel');
  const openClock = (on) => { panel.hidden = !on; more.innerHTML = icon(on ? 'chevronUp' : 'chevronDown'); more.setAttribute('aria-expanded', on); save(CLOCK, on); };
  more.onclick = () => {
    openClock(panel.hidden);
    if (!panel.hidden) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  openClock(!!load(CLOCK, false));

  function renderClock() {
    const st = S.preview;
    if (!st) return;
    const play = $$('#lkPlay');
    const verb = st.paused ? 'Resume' : 'Pause';
    play.innerHTML = `${icon(st.paused ? 'play' : 'pause')}<span>${verb}</span>`;
    play.setAttribute('aria-label', `${verb} the preview clock`);
    press(play, st.paused);
    press($$('#lkLive'), st.following);
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
  S.on('tab', () => { syncBarInset(); });
  S.on('status', renderLanes); // a zone's brightness changed the notes
  $$('#lkPlay').innerHTML = `${icon('pause')}<span>Pause</span>`;
  fillTargets();
  renderCatalog();
  S.on('ready', () => S.panel.refit());

  return {
    push,
    // inPreview says a preset is in the preview on the current target.
    inPreview: (preset) => (S.preview ? S.preview.layers : []).some((l) => l.preset === preset && sameTarget(l.target, currentTarget())),
    togglePause: () => control({ action: S.preview && S.preview.paused ? 'resume' : 'pause' }),
    fmtClock: () => $$('#lkClockText').textContent,
  };
}

