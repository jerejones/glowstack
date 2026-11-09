// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { api, patch, del, esc } from '../util.js';
import { createForm, lookStrip } from '../form.js';

export function presetSlug(name, presets) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  let id = base, n = 2;
  while (presets.some((p) => p.id === id)) id = `${base}-${n++}`;
  return id;
}

export function createPresets(S, root) {
  let draft = null, dirty = false, busy = false, form;
  root.innerHTML = `
    <div class="row library-heading"><h2>Presets</h2><button type="button" class="go" id="prNew">New preset</button></div>
    <p class="muted small">Save looks for later. Pin favorites to keep them visible on Looks.</p>
    <div id="prMessage" role="status" class="small"></div>
    <div id="prEditor" class="preset-editor" hidden></div>
    <label class="preset-search">Find a preset<input type="search" id="prSearch" placeholder="Search presets" autocomplete="off"></label>
    <div id="prList" class="preset-library"></div>`;
  const $ = (s) => root.querySelector(s);
  const say = (s) => { $('#prMessage').textContent = s; };
  let refreshSequence = 0;
  S.refreshPresets = async () => {
    const seq = ++refreshSequence;
    const response = await api('/api/v1/presets');
    if (!Array.isArray(response?.presets)) throw Error('Preset library unavailable.');
    if (seq !== refreshSequence) return;
    S.presets = response.presets;
    S.emit('presets');
  };
  const discard = () => !dirty || confirm('Discard your unsaved preset changes?');
  const setBusy = (value) => {
    busy = value;
    for (const b of root.querySelectorAll('button, input, select, textarea')) b.disabled = value;
  };
  const endpoint = (id) => '/api/v1/presets/' + encodeURIComponent(id);

  function renderList() {
    const query = $('#prSearch').value.toLowerCase().trim();
    const list = S.presets.filter((p) => `${p.name || p.id} ${p.effect}`.toLowerCase().includes(query));
    const box = $('#prList'); box.replaceChildren();
    for (const p of list) {
      const row = document.createElement('article'); row.className = 'preset-entry';
      const effect = (S.catalog.effects || []).find((e) => e.id === p.effect);
      row.innerHTML = `<span class="strip"></span><div class="preset-title"><b>${esc(p.name || p.id)}</b><span class="muted small">${esc(effect?.name || p.effect)}</span></div><div class="preset-actions">
        <button type="button" data-act="pin" aria-pressed="${!!p.pinned}" aria-label="${esc((p.pinned ? 'Unpin ' : 'Pin ') + (p.name || p.id))}">${p.pinned ? '★ Pinned' : '☆ Pin'}</button>
        <button type="button" data-act="edit">Edit</button><button type="button" data-act="copy">Duplicate</button><button type="button" data-act="delete" class="danger">Delete</button></div>`;
      row.querySelector('.strip').style.background = lookStrip(S, p.effect, p.params);
      row.querySelector('[data-act=edit]').onclick = () => openEditor(p);
      row.querySelector('[data-act=copy]').onclick = () => openEditor({ ...p, id: '', name: `${p.name || p.id} copy`, pinned: false });
      row.querySelector('[data-act=pin]').onclick = async () => {
        if (busy) return;
        setBusy(true);
        try {
          await patch(endpoint(p.id) + '/pin', { pinned: !p.pinned });
          if (draft?.id === p.id) { draft.pinned = !p.pinned; const checkbox = $('#prPinned'); if (checkbox) checkbox.checked = draft.pinned; }
          await S.refreshPresets();
          say(p.pinned ? 'Unpinned from Looks.' : 'Pinned to Looks.');
        } catch (e) { say(e.message); } finally { setBusy(false); }
      };
      row.querySelector('[data-act=delete]').onclick = async () => {
        if (busy || !confirm(`Delete “${p.name || p.id}”? Running lights will keep their current look.`)) return;
        if (draft?.id === p.id && !discard()) return;
        setBusy(true);
        try {
          await del(endpoint(p.id) + '?library=true');
          if (draft?.id === p.id) closeEditor();
          await S.refreshPresets(); await S.refresh();
          say('Preset deleted. Running lights are unchanged.');
        } catch (e) { say(e.message); } finally { setBusy(false); }
      };
      box.append(row);
    }
    if (!list.length) { const msg = document.createElement('p'); msg.className = 'muted'; msg.textContent = S.presets.length ? 'No matching presets.' : 'No presets yet. Create one to get started.'; box.append(msg); }
    if (busy) setBusy(true);
  }
  function closeEditor() { draft = null; dirty = false; $('#prEditor').hidden = true; $('#prEditor').replaceChildren(); }
  function openEditor(p) {
    if (busy || !discard()) return;
    draft = structuredClone(p || { id: '', name: '', effect: S.catalog.effects?.[0]?.id || '', params: {}, pinned: false });
    dirty = false;
    const box = $('#prEditor'); box.hidden = false;
    box.innerHTML = `<h3>${draft.id ? 'Edit preset' : 'New preset'}</h3>
      <label>Name<input id="prName" type="text" maxlength="120" required autocomplete="off"></label>
      <label>Effect<select id="prEffect"></select></label>
      <label class="check"><input type="checkbox" id="prPinned"> Pin to Looks</label>
      <p class="muted small">Changes stay here until you save. Saving does not change running lights.</p>
      <div id="prParams"></div><div class="err" id="prError" role="alert"></div>
      <div class="row"><button type="button" id="prSave" class="go">Save preset</button><button type="button" id="prCancel">Cancel</button></div>`;
    $('#prName').value = draft.name || draft.id;
    $('#prPinned').checked = !!draft.pinned;
    $('#prName').oninput = () => { draft.name = $('#prName').value; dirty = true; };
    $('#prPinned').onchange = () => { draft.pinned = $('#prPinned').checked; dirty = true; };
    const select = $('#prEffect');
    for (const e of S.catalog.effects || []) select.add(new Option(e.name || e.id, e.id));
    select.value = draft.effect;
    select.onchange = () => {
      if (Object.keys(draft.params || {}).length && !confirm('Change effect and reset its settings?')) { select.value = draft.effect; return; }
      draft.effect = select.value; draft.params = {}; dirty = true; renderForm();
    };
    $('#prCancel').onclick = () => { if (discard()) closeEditor(); };
    $('#prSave').onclick = saveDraft;
    renderForm();
    $('#prName').focus();
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function renderForm() {
    const layer = () => ({ effect: draft.effect, params: draft.params || {} });
    form = createForm({ S, layer: layer(), pitch: S.geo.pitch || 1 / 60,
      send(changes) {
        draft.params = { ...draft.params, ...changes };
        for (const [key, value] of Object.entries(draft.params)) if (value === null) delete draft.params[key];
        dirty = true; form.update(layer());
      },
      replace(params) { draft.params = structuredClone(params); dirty = true; form.update(layer()); },
    });
    $('#prParams').replaceChildren(form.el);
  }
  async function saveDraft() {
    if (busy || !draft) return;
    const name = $('#prName').value.trim();
    if (!name) { $('#prError').textContent = 'Give the preset a name.'; $('#prName').focus(); return; }
    if ($('#prParams .bad')) { $('#prError').textContent = 'Check the highlighted settings before saving.'; return; }
    if (!$('#prEffect').value) { $('#prError').textContent = 'Choose an effect.'; return; }
    const id = draft.id || presetSlug(name, S.presets);
    const body = { name, effect: draft.effect, params: draft.params || {}, pinned: !!draft.pinned };
    setBusy(true);
    try {
      await api(endpoint(id) + '?library=true', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeEditor(); await S.refreshPresets(); await S.refresh();
      say(`Saved “${name}”.${body.pinned ? ' Pinned to Looks.' : ''}`);
    } catch (e) { if ($('#prError')) $('#prError').textContent = e.message; else say(e.message); }
    finally { setBusy(false); }
  }
  $('#prNew').onclick = () => openEditor();
  $('#prSearch').oninput = renderList;
  S.on('presets', renderList);
  S.on('tab', (name) => { if (name === 'presets' || name === 'looks') S.refreshPresets().catch((e) => say(e.message)); });
  addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  renderList();
  return { openEditor };
}
