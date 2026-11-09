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
import { api, post, del, esc, accentFor, save, load, parseQty, press, covers, sameSet } from '../util.js';
import { nodeName, nodeTarget, targetRanges } from '../select.js';
import { houseStatusMessage } from '../house-status.js';
import { createForm, patcher, effectFor, valuesFor, layerName, lookStrip } from '../form.js';
import { showState } from '../states.js';
import { icon } from '../icons.js';

const COPIES = 'glowstack.copies'; // preview copy id → the lights layer it stands in for
const CLOCK = 'glowstack.clock.open';
const TARGET = 'glowstack.looks.target';

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

// lookKey says which look a layer (or a card's look) is.
export const lookKey = (l) => (l.preset ? 'preset:' + l.preset : 'effect:' + l.effect);

// lookAction is what tapping a look does, given the preview's layers: add
// it, or, when the target already has it, take it back off. A layer that
// has been tweaked isn't thrown away by a tap: it is focused instead.
export function lookAction(layers, target, look, copies = {}) {
  const key = lookKey(look);
  const same = layers.find((l) => l.target === target && lookKey(l) === key);
  if (!same) return { add: true };
  return copies[same.id] || Object.keys(same.params || {}).length ? { focus: same.id } : { remove: same.id };
}

export function createLooks(S, root) {
  const g = S.geo;
  let copies = load(COPIES, {}) || {};
  let target = load(TARGET, '');      // chosen when nothing is selected
  const cards = new Map(); // lane:id → card
  root.innerHTML = `
    <div class="target"><span class="muted">Looks go on</span><select id="lkTarget" aria-label="Where looks go"></select></div>
    <div class="chips quick-targets" id="lkQuick"></div>
    <div id="lkSel" class="muted small"></div>
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
      <button type="button" id="lkBack" class="icon-btn" title="Step back one frame" aria-label="Step back one frame">${icon('stepBack')}</button>
      <span class="muted">Step one frame</span>
      <button type="button" id="lkFwd" class="icon-btn" title="Step forward one frame" aria-label="Step forward one frame">${icon('stepForward')}</button>
      <span>Speed</span><input type="range" id="lkSpeed" min="-1" max="1" step="0.01" value="0"><output id="lkSpeedOut">1×</output>
      <span>Scrub</span><input type="range" id="lkScrub" min="-30" max="30" step="0.02" value="0"><span class="muted small">±30 s</span>
      <span></span><button type="button" id="lkNow" title="Back to the house clock">Now</button><span></span>
    </div>
    <div class="look-bar" id="lkBar" hidden>
      <span class="strip" id="lkBarStrip"></span>
      <div class="what"><b id="lkBarName"></b><span id="lkBarSub"></span></div>
      <button type="button" id="lkClear" title="Remove every look from the preview">Clear</button>
      <button type="button" class="go" id="lkPushAll" title="Move what's in preview onto the lights">Apply to lights</button>
    </div>`;
  const $$ = (sel) => root.querySelector(sel);

  // ---------- target ----------

  const targetSel = $$('#lkTarget');
  function fillTargets() {
    const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
    const sel = S.sel ? nodeTarget(S.sel.node) : '';
    targetSel.innerHTML =
      (sel ? `<optgroup label="Selected">${opt(sel, nodeName(S.sel.node))}</optgroup>` : '') +
      `<optgroup label="Everything">${opt('all', 'All')}</optgroup>` +
      `<optgroup label="Zones">${g.zones.map((z) => opt(z.area, z.name || z.id)).join('')}</optgroup>` +
      `<optgroup label="Areas">${g.areas.map((a) => opt(a.id, a.id)).join('')}</optgroup>` +
      `<optgroup label="Runs">${g.runs.map((r) => opt('run:' + r.id, r.id)).join('')}</optgroup>`;
    if (sel) targetSel.value = sel;
    else if (target) targetSel.value = target;
    if (!targetSel.value && targetSel.options.length) targetSel.selectedIndex = 0;
    $$('#lkSel').textContent = S.sel ? '' : 'Tap the map to pick a run; tap again for the area around it.';
    // The common places stay one tap away.
    const quick = [['all', 'All'], ...g.zones.slice(0, 4).map((z) => [z.area, z.name || z.id])];
    $$('#lkQuick').replaceChildren(...quick.map(([v, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      press(b, targetSel.value === v);
      b.onclick = () => { targetSel.value = v; targetSel.onchange(); fillTargets(); };
      return b;
    }));
  }
  targetSel.onchange = () => {
    target = targetSel.value;
    save(TARGET, target);
    if (S.sel && targetSel.value !== nodeTarget(S.sel.node)) S.select(null);
    markPreviewed();
  };
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
    const presetCard = (p) => card(p.name || p.id, (effectFor(S, { preset: p.id }) || {}).name || p.effect,
      lookStrip(S, p.effect, p.params), 'preset:' + p.id, () => push({ preset: p.id }), `Preview ${p.name || p.id} here`);
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
    pres.replaceChildren(...S.presets.filter((p) => p.pinned).map(presetCard));
    if (!pres.childElementCount) {
      const hint = document.createElement('button');
      hint.type = 'button'; hint.className = 'quiet';
      hint.textContent = S.presets.length ? 'Pin favorites in Presets to show them here' : 'Create your first preset';
      hint.onclick = () => S.panel.openTab('presets');
      pres.append(hint);
    }
    const other = S.presets.filter((p) => !p.pinned);
    $$('#lkOtherPresets').hidden = !other.length;
    $$('#lkOtherPresets summary span').textContent = `(${other.length})`;
    $$('#lkOtherPresets .cards').replaceChildren(...other.map(presetCard));
    $$('#lkEffects .cards').replaceChildren(...(S.catalog.effects || []).map((e) => card(e.name || e.id, effectKind(e), lookStrip(S, e.id, {}), 'effect:' + e.id, () => push({ effect: e.id }))));
    markPreviewed();
  }

  // markPreviewed shows which cards are in the preview on the current
  // target: the same look on somewhere else isn't this one.
  function markPreviewed() {
    const t = targetSel.value;
    const on = new Set((S.preview ? S.preview.layers : []).filter((l) => l.target === t).map(lookKey));
    for (const b of root.querySelectorAll('.preset')) {
      const inPreview = on.has(b.dataset.look);
      b.classList.toggle('in-preview', inPreview);
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
    const t = targetSel.value;
    const key = t + '|' + lookKey(look);
    if (!t || tapping.has(key)) return;
    tapping.add(key);
    try {
      const act = lookAction(S.preview ? S.preview.layers : [], t, look, copies);
      if (act.focus) { focusLayer(act.focus); return; }
      if (act.remove) await del('/api/map/preview/layers/' + encodeURIComponent(act.remove));
      else {
        await post('/api/map/preview/layers', { target: t, ...look });
        if (S.show === 'house') { S.setShow(''); S.toast('Showing your preview on the map.'); }
      }
      await S.refresh();
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
      acts.innerHTML = `<button type="button" class="danger" data-a="remove">Remove</button>`;
      acts.querySelector('[data-a=remove]').onclick = () => remove(c, '/api/v1/layers');
    }
    return c;
  }

  function updateCard(c, l) {
    c.layer = l;
    const el = c.el;
    const acc = accentFor(l.id);
    el.style.setProperty('--acc', `rgb(${acc})`);
    el.querySelector('.what b').textContent = layerName(S, l);
    const bits = ['on ' + (l.target === 'all' ? 'everything' : l.target.replace(/^run:/, ''))];
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
    note.className = orig ? 'note copy-note' : 'note';
    note.textContent = orig ? `Editing a preview of ${layerName(S, l)}. Apply to update the lights.` : '';
    const part = removeScope(l), rm = el.querySelector('[data-a=remove]');
    rm.textContent = part ? `Remove from ${nodeName(S.sel.node)}` : 'Remove';
    rm.title = part ? `Turn off ${part} with a black layer on top; the rest of this layer stays` : (c.lane === 'preview' ? 'Remove from the preview' : 'Take this layer off the lights');
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

  function renderLanes() {
    const prev = S.preview ? S.preview.layers : [];
    const pbox = $$('#lkPreview .list');
    renderLane(pbox, 'preview', prev);
    let empty = pbox.querySelector('.empty');
    const previewNote = !S.preview ? 'Loading the preview…' : prev.length ? '' : 'Nothing in preview. Tap a look to try it on the map; the lights don\'t change.';
    if (previewNote) {
      if (!empty) { empty = document.createElement('div'); empty.className = 'empty'; pbox.append(empty); }
      empty.textContent = previewNote;
    } else if (empty) empty.remove();
    for (const c of cards.values()) {
      if (c.lane === 'preview') c.el.querySelector('[data-a=apply]').hidden = prev.length < 2;
    }
    renderBar(prev);
    markPreviewed();

    const house = S.house.filter((l) => !l.ephemeral);
    const hbox = $$('#lkHouse .list');
    renderLane(hbox, 'house', house);
    empty = hbox.querySelector('.empty');
    const message = houseStatusMessage(S.houseStatus, S.house.length);
    if (message) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'empty';
        empty.setAttribute('role', 'status');
        hbox.appendChild(empty);
      }
      empty.textContent = message;
    } else if (empty) empty.remove();
    const eph = S.house.length - house.length;
    $$('#lkHouseN').textContent = eph ? `+ ${eph} calibration` : '';
    // A copy whose preview layer is gone is forgotten.
    const ids = new Set(prev.map((l) => l.id));
    if (Object.keys(copies).some((k) => !ids.has(k)) && S.preview) {
      copies = Object.fromEntries(Object.entries(copies).filter(([k]) => ids.has(k)));
      save(COPIES, copies);
    }
  }
  // renderBar keeps what's in preview, and the way to apply it, in view
  // however far the lists scroll. It is the one primary action here.
  function renderBar(prev) {
    $$('#lkBar').hidden = !prev.length;
    if (!prev.length) return;
    const l = prev[0];
    const eff = effectFor(S, l);
    $$('#lkBarStrip').style.background = lookStrip(S, eff ? eff.id : l.effect, valuesFor(S, l));
    $$('#lkBarName').textContent = prev.length === 1 ? layerName(S, l) : `${prev.length} looks in preview`;
    $$('#lkBarSub').textContent = prev.length === 1 ? 'in preview' : prev.map((x) => layerName(S, x)).join(', ');
    const updates = prev.some((x) => copies[x.id]);
    $$('#lkPushAll').textContent = updates ? 'Update lights' : prev.length === 1 ? 'Apply to lights' : `Apply all ${prev.length}`;
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
      if (pc) pc.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      S.toast(`Editing a preview of ${layerName(S, c.layer)}. Apply to update the lights.`);
      return;
    }
    const form = createForm({
      S, layer: c.layer, pitch: pitchFor(c.layer.target),
      send: (params) => c.patch.set(params),
      replace: (params) => c.patch.replace(params),
    });
    c.form = form;
    c.el.querySelector('.slot').append(form.el);
    c.el.querySelector('.tweak').setAttribute('aria-expanded', 'true');
    c.el.querySelector('.tweak').classList.add('on');
  }

  // apply promotes preview layers (all with ids empty) onto the lights,
  // then removes the lights layers the promoted copies stand in for.
  async function apply(ids) {
    const list = ids.length ? ids : (S.preview ? S.preview.layers.map((l) => l.id) : []);
    try {
      await post('/api/map/preview/promote', ids.length ? { ids } : {});
    } catch (e) { S.fail('apply the look', e); await S.refresh(); return; }
    const replaced = [];
    for (const id of list) {
      const orig = copies[id];
      forget(id);
      if (!orig) continue;
      try { await del('/api/v1/layers/' + encodeURIComponent(orig)); replaced.push(orig); } catch (e) { if (e.status !== 404) S.fail('remove the look it replaces', e); }
    }
    const orig = replaced.length === 1 ? 'the original' : replaced.length + ' originals';
    S.toast(`Applied ${list.length === 1 ? 'the look' : list.length + ' looks'} to the lights${replaced.length ? ', in place of ' + orig : ''}.`);
    await S.refresh();
  }
  $$('#lkPushAll').onclick = () => apply([]);
  $$('#lkClear').onclick = async () => {
    try { await del('/api/map/preview/layers'); copies = {}; save(COPIES, copies); await S.refresh(); } catch (e) { S.fail('clear the preview', e); }
  };

  // ---------- the clock ----------

  const speedLabel = (s) => (s >= 1 ? s.toFixed(s >= 10 ? 0 : 1) : s.toFixed(2)) + '×';
  const control = async (body) => {
    try { S.preview = await post('/api/map/preview', body); renderClock(); S.emit('preview', S.preview); } catch (e) { S.fail('change the preview clock', e); }
  };
  const fps = g.house_fps || 40;
  $$('#lkPlay').onclick = () => control({ action: S.preview && S.preview.paused ? 'resume' : 'pause' });
  $$('#lkBack').onclick = () => control({ action: 'step', seconds: -1 / fps });
  $$('#lkFwd').onclick = () => control({ action: 'step', seconds: 1 / fps });
  $$('#lkNow').onclick = () => control({ action: 'live' });
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
  scrub.onchange = () => { scrubBase = null; scrub.value = 0; };
  const more = $$('#lkClockMore'), panel = $$('#lkClockPanel');
  const openClock = (on) => { panel.hidden = !on; more.innerHTML = icon(on ? 'chevronUp' : 'chevronDown'); more.setAttribute('aria-expanded', on); save(CLOCK, on); };
  more.onclick = () => openClock(panel.hidden);
  openClock(!!load(CLOCK, false));

  function renderClock() {
    const st = S.preview;
    if (!st) return;
    const play = $$('#lkPlay');
    const verb = st.paused ? 'Resume' : 'Pause';
    play.innerHTML = `${icon(st.paused ? 'play' : 'pause')}<span class="touch-label">${verb}</span>`;
    play.setAttribute('aria-label', `${verb} the preview clock`);
    press(play, st.paused);
    press($$('#lkNow'), st.following);
    if (document.activeElement !== speed) {
      speed.value = Math.log10(st.speed);
      $$('#lkSpeedOut').textContent = speedLabel(st.speed);
    }
    const d = new Date(st.t * 1000);
    const off = st.offset;
    $$('#lkClockText').textContent = `${st.paused ? 'paused · ' : ''}${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}` +
      (st.following ? (st.speed !== 1 ? ` · ${speedLabel(st.speed)}` : ' · following the house') : ` · ${off >= 0 ? '+' : '−'}${Math.abs(off).toFixed(2)} s vs house`);
    $$('#lkClock').title = S.show === 'house' ? 'The preview clock; the map shows the lights, which follow the house clock' : 'The preview clock';
  }

  // ---------- wiring ----------

  S.on('presets', () => { renderCatalog(); renderLanes(); });
  S.on('preview', () => { renderLanes(); renderClock(); });
  S.on('house', renderLanes);
  S.on('show', renderLanes);
  $$('#lkPlay').innerHTML = `${icon('pause')}<span class="touch-label">Pause</span>`;
  fillTargets();
  renderCatalog();

  return {
    togglePause: () => control({ action: S.preview && S.preview.paused ? 'resume' : 'pause' }),
    fmtClock: () => $$('#lkClockText').textContent,
  };
}

