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
import { api, post, del, esc, accentFor, save, load, parseQty, press } from '../util.js';
import { nodeName, nodeTarget, targetRanges } from '../select.js';
import { createForm, patcher, effectFor, valuesFor, layerName, lookStrip } from '../form.js';

const COPIES = 'glowstack.copies'; // preview copy id → the lights layer it stands in for
const CLOCK = 'glowstack.clock.open';

export function createLooks(S, root) {
  const g = S.geo;
  let copies = load(COPIES, {}) || {};
  let target = '';      // chosen when nothing is selected
  const cards = new Map(); // lane:id → card
  root.innerHTML = `
    <div class="target"><span class="muted">Looks go on</span><select id="lkTarget" aria-label="Where looks go"></select></div>
    <div id="lkSel" class="muted small"></div>
    <div class="cards" id="lkPresets"></div>
    <details id="lkEffects"><summary>Effects <span class="muted">(${(S.catalog.effects || []).length})</span></summary><div class="cards"></div></details>
    <div class="lane" id="lkPreview">
      <div class="row"><h2>Preview <small>on the map only</small></h2><span class="row">
        <button type="button" class="go" id="lkPushAll" title="Move every preview layer onto the lights">Push all to lights</button>
        <button type="button" id="lkClear" title="Remove every preview layer">Clear</button></span></div>
      <div class="list"></div>
    </div>
    <div class="lane" id="lkHouse">
      <div class="row"><h2>On the lights <small id="lkHouseN"></small></h2></div>
      <div class="list"></div>
    </div>
    <div class="clock" id="lkClock">
      <button type="button" id="lkPlay" title="Pause or resume the preview clock (space)">⏸</button>
      <span class="t" id="lkClockText"></span>
      <button type="button" class="quiet" id="lkClockMore" aria-expanded="false" title="Clock controls">▾</button>
    </div>
    <div class="clock-more" id="lkClockPanel" hidden>
      <button type="button" id="lkBack" title="Step back one frame">⏮</button>
      <span class="muted">step</span>
      <button type="button" id="lkFwd" title="Step forward one frame">⏭</button>
      <span>Speed</span><input type="range" id="lkSpeed" min="-1" max="1" step="0.01" value="0"><output id="lkSpeedOut">1×</output>
      <span>Scrub</span><input type="range" id="lkScrub" min="-30" max="30" step="0.02" value="0"><span class="muted small">±30 s</span>
      <span></span><button type="button" id="lkNow" title="Back to the house clock">Now</button><span></span>
    </div>`;
  const $$ = (sel) => root.querySelector(sel);

  // ---------- target ----------

  const targetSel = $$('#lkTarget');
  function fillTargets() {
    const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
    const sel = S.sel ? nodeTarget(S.sel.node) : '';
    targetSel.innerHTML =
      (sel ? `<optgroup label="Selected">${opt(sel, nodeName(S.sel.node))}</optgroup>` : '') +
      `<optgroup label="Zones">${g.zones.map((z) => opt(z.area, z.name || z.id)).join('')}</optgroup>` +
      `<optgroup label="Areas">${g.areas.map((a) => opt(a.id, `${a.id} (${a.count})`)).join('')}</optgroup>` +
      `<optgroup label="Runs">${g.runs.map((r) => opt('run:' + r.id, r.id)).join('')}</optgroup>`;
    if (sel) targetSel.value = sel;
    else if (target) targetSel.value = target;
    if (!targetSel.value && targetSel.options.length) targetSel.selectedIndex = 0;
    $$('#lkSel').textContent = S.sel ? '' : 'Tap the map to pick a run; tap again for the area around it.';
  }
  targetSel.onchange = () => {
    target = targetSel.value;
    if (S.sel && targetSel.value !== nodeTarget(S.sel.node)) S.select(null);
  };
  S.on('select', fillTargets);

  // ---------- presets and effects ----------

  function card(name, sub, strip, onclick, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.title = title || '';
    b.innerHTML = `<span class="strip" style="background:${esc(strip)}"></span><span class="name">${esc(name)}</span><span class="sub">${esc(sub)}</span>`;
    b.onclick = onclick;
    return b;
  }
  function renderCatalog() {
    const pres = $$('#lkPresets');
    pres.replaceChildren(...S.presets.map((p) => card(p.name || p.id, (effectFor(S, { preset: p.id }) || {}).name || p.effect,
      lookStrip(S, p.effect, p.params), () => push({ preset: p.id }), `Preview ${p.name || p.id} here`)));
    if (!S.presets.length) pres.innerHTML = '<div class="empty">No presets yet. Save one with glowstack preset save, or add them to glowstack.yaml.</div>';
    $$('#lkEffects .cards').replaceChildren(...(S.catalog.effects || []).map((e) => card(e.name || e.id, 'effect', lookStrip(S, e.id, {}), () => push({ effect: e.id }))));
  }

  async function push(look) {
    const t = targetSel.value;
    if (!t) return;
    try {
      await post('/api/map/preview/layers', { target: t, ...look });
      if (S.show === 'house') { S.setShow(''); S.toast('Showing your preview on the map.'); }
      await S.refresh();
    } catch (e) { S.toast(e); }
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

  function makeCard(lane, l) {
    const el = document.createElement('div');
    el.className = 'layer';
    el.innerHTML = `
      <div class="top"><div class="what"><b></b><span></span></div>
        <button type="button" class="tweak" aria-expanded="false">Tweak</button></div>
      <div class="strip"></div>
      <div class="bri"><span title="Layer brightness">☀</span><input type="range" min="0" max="1" step="0.01" aria-label="Layer brightness"><output></output></div>
      <div class="acts"></div>
      <div class="note"></div>
      <div class="slot"></div>`;
    const c = { lane, id: l.id, el, layer: l, form: null };
    const base = lane === 'preview' ? '/api/v1/preview/layers/' : '/api/v1/layers/';
    c.patch = patcher(() => base + encodeURIComponent(c.id), 80, (nl) => { c.layer = { ...c.layer, ...nl }; }, (e) => S.toast(e));
    const bri = el.querySelector('.bri input'), out = el.querySelector('.bri output');
    bri.oninput = () => { out.textContent = Math.round(bri.value * 100) + '%'; c.patch.set({ brightness: +bri.value }); };
    el.querySelector('.tweak').onclick = () => tweak(c);
    const acts = el.querySelector('.acts');
    if (lane === 'preview') {
      acts.innerHTML = `<button type="button" class="go" data-a="apply">Apply to lights</button><button type="button" data-a="remove" title="Remove from the preview">Remove</button>`;
      acts.querySelector('[data-a=apply]').onclick = () => apply([c.id]);
      acts.querySelector('[data-a=remove]').onclick = async () => {
        try { await del('/api/map/preview/layers/' + encodeURIComponent(c.id)); forget(c.id); await S.refresh(); } catch (e) { S.toast(e); }
      };
    } else {
      acts.innerHTML = `<button type="button" class="danger" data-a="remove" title="Take this layer off the lights">Remove…</button>`;
      acts.querySelector('[data-a=remove]').onclick = async () => {
        if (!confirm(`Take “${layerName(S, c.layer)}” on ${c.layer.target} off the lights?`)) return;
        try { await del('/api/v1/layers/' + encodeURIComponent(c.id)); await S.refresh(); } catch (e) { S.toast(e); }
      };
    }
    return c;
  }

  function updateCard(c, l) {
    c.layer = l;
    const el = c.el;
    const acc = accentFor(l.id);
    el.style.setProperty('--acc', `rgb(${acc})`);
    el.classList.toggle('sel', S.focus === l.id);
    el.querySelector('.what b').textContent = layerName(S, l);
    const bits = ['on ' + l.target];
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
    note.className = orig ? 'copy-note' : 'note';
    note.textContent = orig ? `A copy of layer ${orig} on the lights: Apply to lights replaces it.` : '';
    if (c.lane === 'preview') el.querySelector('[data-a=apply]').textContent = orig ? 'Apply to lights (replace)' : 'Apply to lights';
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
    if (!prev.length && !empty) pbox.insertAdjacentHTML('beforeend', '<div class="empty">Nothing in preview. Tap a look to try it on the map; the lights don\'t change.</div>');
    else if (prev.length && empty) empty.remove();
    $$('#lkPushAll').disabled = !prev.length;
    $$('#lkClear').disabled = !prev.length;

    const house = S.house.filter((l) => !l.ephemeral);
    const hbox = $$('#lkHouse .list');
    renderLane(hbox, 'house', house);
    empty = hbox.querySelector('.empty');
    if (!house.length && !empty) hbox.insertAdjacentHTML('beforeend', '<div class="empty">Nothing on the lights.</div>');
    else if (house.length && empty) empty.remove();
    const eph = S.house.length - house.length;
    $$('#lkHouseN').textContent = eph ? `+ ${eph} calibration` : '';
    // A copy whose preview layer is gone is forgotten.
    const ids = new Set(prev.map((l) => l.id));
    if (Object.keys(copies).some((k) => !ids.has(k)) && S.preview) {
      copies = Object.fromEntries(Object.entries(copies).filter(([k]) => ids.has(k)));
      save(COPIES, copies);
    }
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
      } catch (e) { S.toast(e); return; }
      const pc = cards.get('preview:' + id);
      if (pc && !pc.form) tweak(pc);
      if (pc) pc.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      S.toast('Editing a preview copy. Apply to lights replaces the original.');
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
    } catch (e) { S.toast(e); await S.refresh(); return; }
    const replaced = [];
    for (const id of list) {
      const orig = copies[id];
      forget(id);
      if (!orig) continue;
      try { await del('/api/v1/layers/' + encodeURIComponent(orig)); replaced.push(orig); } catch (e) { if (e.status !== 404) S.toast(e); }
    }
    const orig = replaced.length === 1 ? 'the original' : replaced.length + ' originals';
    S.toast(`Applied ${list.length === 1 ? 'the layer' : list.length + ' layers'} to the lights${replaced.length ? ', in place of ' + orig : ''}.`);
    await S.refresh();
  }
  $$('#lkPushAll').onclick = () => apply([]);
  $$('#lkClear').onclick = async () => {
    try { await del('/api/map/preview/layers'); copies = {}; save(COPIES, copies); await S.refresh(); } catch (e) { S.toast(e); }
  };

  // ---------- the clock ----------

  const speedLabel = (s) => (s >= 1 ? s.toFixed(s >= 10 ? 0 : 1) : s.toFixed(2)) + '×';
  const control = async (body) => {
    try { S.preview = await post('/api/map/preview', body); renderClock(); S.emit('preview', S.preview); } catch (e) { S.toast(e); }
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
      try { const st = await post('/api/map/preview', { action: 'pause' }); scrubBase = st.t; S.preview = st; } catch (e) { scrubBase = null; S.toast(e); return; }
    }
    if (Number.isNaN(scrubBase)) return;
    want = scrubBase + +scrub.value;
    seek();
  };
  scrub.onchange = () => { scrubBase = null; scrub.value = 0; };
  const more = $$('#lkClockMore'), panel = $$('#lkClockPanel');
  const openClock = (on) => { panel.hidden = !on; more.textContent = on ? '▴' : '▾'; more.setAttribute('aria-expanded', on); save(CLOCK, on); };
  more.onclick = () => openClock(panel.hidden);
  openClock(!!load(CLOCK, false));

  function renderClock() {
    const st = S.preview;
    if (!st) return;
    const play = $$('#lkPlay');
    play.textContent = st.paused ? '▶' : '⏸';
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

  S.on('preview', () => { renderLanes(); renderClock(); });
  S.on('house', renderLanes);
  S.on('show', renderLanes);
  S.on('focus', (id) => {
    for (const c of cards.values()) c.el.classList.toggle('sel', c.id === id);
    const c = cards.get('preview:' + id) || cards.get('house:' + id);
    if (c) setTimeout(() => c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
  });
  api('/api/v1/palettes').then((r) => { S.palettes = r.palettes; renderCatalog(); renderLanes(); }).catch(() => {});
  S.palettes = S.palettes || [];
  fillTargets();
  renderCatalog();

  return {
    togglePause: () => control({ action: S.preview && S.preview.paused ? 'resume' : 'pause' }),
    fmtClock: () => $$('#lkClockText').textContent,
  };
}

