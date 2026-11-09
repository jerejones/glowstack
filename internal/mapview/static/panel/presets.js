// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { api, patch, del, esc, failure } from '../util.js';
import { createForm, lookStrip, presetName } from '../form.js';
import { createPicker } from '../picker.js';
import { effectKind } from './looks.js';
import { showState, stateHTML } from '../states.js';
import { confirmDialog } from '../dialog.js';
import { icon } from '../icons.js';

export function presetSlug(name, presets) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  let id = base, n = 2;
  while (presets.some((p) => p.id === id)) id = `${base}-${n++}`;
  return id;
}

export function createPresets(S, root) {
  let draft = null, dirty = false, busy = false, form;
  root.innerHTML = `
    <div class="row library-heading"><h1 class="title">Presets</h1><button type="button" id="prNew">New preset</button></div>
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
    S.library.presets = 'ready';
    S.emit('presets');
  };
  const discard = async () => !dirty || confirmDialog({ title: 'Discard your changes?', body: 'Your unsaved edits to this preset will be lost.', confirm: 'Discard', cancel: 'Keep editing', danger: true });
  const setBusy = (value) => {
    busy = value;
    for (const b of root.querySelectorAll('button, input, select, textarea')) b.disabled = value;
    if (!value && S.library.catalog === 'failed') $('#prNew').disabled = true;
  };
  const endpoint = (id) => '/api/v1/presets/' + encodeURIComponent(id);

  function renderList() {
    if (S.library.presets === 'failed') {
      $('#prNew').disabled = true;
      showState($('#prList'), { kind: 'error', title: 'Could not load your presets', detail: 'They are safe; Glowstack just could not read them.', retry: S.retryLibrary });
      return;
    }
    $('#prNew').disabled = busy || S.library.catalog === 'failed';
    const query = $('#prSearch').value.toLowerCase().trim();
    const list = S.presets.filter((p) => `${presetName(p)} ${p.id} ${p.effect}`.toLowerCase().includes(query));
    const box = $('#prList'); box.replaceChildren();
    for (const p of list) {
      const row = document.createElement('article'); row.className = 'preset-entry';
      const effect = (S.catalog.effects || []).find((e) => e.id === p.effect);
      row.innerHTML = `<span class="strip"></span><div class="preset-title"><b>${esc(presetName(p))}</b><span class="muted small">${esc(effect ? `${effect.name || effect.id} · ${effectKind(effect)}` : p.effect)}</span></div><div class="preset-actions">
        <button type="button" data-act="pin" aria-pressed="${!!p.pinned}" aria-label="${esc((p.pinned ? 'Unpin ' : 'Pin ') + presetName(p))}"><span class="pin">${icon(p.pinned ? 'presetsFilled' : 'presets')}${p.pinned ? 'Pinned' : 'Pin'}</span></button>
        <button type="button" data-act="edit">Edit</button><button type="button" data-act="copy">Duplicate</button><button type="button" data-act="delete" class="danger">Delete</button></div>`;
      row.querySelector('.strip').style.background = lookStrip(S, p.effect, p.params);
      row.querySelector('[data-act=edit]').onclick = () => openEditor(p);
      row.querySelector('[data-act=copy]').onclick = () => openEditor({ ...p, id: '', name: `${presetName(p)} copy`, pinned: false });
      row.querySelector('[data-act=pin]').onclick = async () => {
        if (busy) return;
        setBusy(true);
        try {
          await patch(endpoint(p.id) + '/pin', { pinned: !p.pinned });
          if (draft?.id === p.id) { draft.pinned = !p.pinned; const checkbox = $('#prPinned'); if (checkbox) checkbox.checked = draft.pinned; }
          await S.refreshPresets();
          say(p.pinned ? 'Unpinned from Looks.' : 'Pinned to Looks.');
        } catch (e) { say(failure('pin the preset', e)); } finally { setBusy(false); }
      };
      row.querySelector('[data-act=delete]').onclick = async () => {
        if (busy || !(await confirmDialog({ title: `Delete “${presetName(p)}”?`, body: 'Running lights will keep their current look.', confirm: 'Delete', danger: true }))) return;
        if (draft?.id === p.id && !(await discard())) return;
        setBusy(true);
        try {
          await del(endpoint(p.id) + '?library=true');
          if (draft?.id === p.id) closeEditor();
          await S.refreshPresets(); await S.refresh();
          say('Preset deleted. Running lights are unchanged.');
        } catch (e) { say(failure('delete the preset', e)); } finally { setBusy(false); }
      };
      box.append(row);
    }
    if (!list.length) box.innerHTML = stateHTML({ kind: 'empty', title: S.presets.length ? 'No matching presets' : 'No presets yet', detail: S.presets.length ? 'Try a different search.' : 'Create one to get started.' });
    if (busy) setBusy(true);
  }
  const markName = (bad) => { if (bad) $('#prName').setAttribute('aria-invalid', 'true'); else $('#prName').removeAttribute('aria-invalid'); };
  function closeEditor() { draft = null; dirty = false; $('#prEditor').hidden = true; $('#prEditor').replaceChildren(); }
  async function openEditor(p) {
    if (busy || !(await discard())) return;
    draft = structuredClone(p || { id: '', name: '', effect: S.catalog.effects?.[0]?.id || '', params: {}, pinned: false });
    dirty = false;
    const box = $('#prEditor'); box.hidden = false;
    box.innerHTML = `<h3>${draft.id ? 'Edit preset' : 'New preset'}</h3>
      <label>Name<input id="prName" type="text" maxlength="120" required autocomplete="off"></label>
      <div class="field-label"><span id="prEffectLabel">Effect</span><div id="prEffectSlot"></div></div>
      <label class="check"><input type="checkbox" id="prPinned"> Pin to Looks</label>
      <p class="muted small">Changes stay here until you save. Saving does not change running lights.</p>
      <div id="prParams"></div><div class="err" id="prError" role="alert"></div>
      <div class="row"><button type="button" id="prSave" class="go">Save preset</button><button type="button" id="prCancel">Cancel</button></div>`;
    $('#prName').value = draft.id ? presetName(draft) : draft.name;
    $('#prPinned').checked = !!draft.pinned;
    $('#prName').oninput = () => { draft.name = $('#prName').value; dirty = true; markName(false); };
    $('#prPinned').onchange = () => { draft.pinned = $('#prPinned').checked; dirty = true; };
    const select = createPicker((S.catalog.effects || []).map((e) => ({ value: e.id, label: e.name || e.id })), { label: 'Effect', id: 'prEffect' });
    $('#prEffectSlot').replaceWith(select);
    select.value = draft.effect;
    select.onchange = async () => {
      if (Object.keys(draft.params || {}).length && !(await confirmDialog({ title: 'Change the effect?', body: "This preset's settings will reset.", confirm: 'Change effect' }))) { select.value = draft.effect; return; }
      draft.effect = select.value; draft.params = {}; dirty = true; renderForm();
    };
    $('#prCancel').onclick = async () => { if (await discard()) closeEditor(); };
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
    if (!name) { $('#prError').textContent = 'Give the preset a name.'; markName(true); $('#prName').focus(); return; }
    if ($('#prParams .bad')) { $('#prError').textContent = 'Check the highlighted settings before saving.'; return; }
    if (!$('#prEffect').value) { $('#prError').textContent = 'Choose an effect.'; return; }
    const id = draft.id || presetSlug(name, S.presets);
    const body = { name, effect: draft.effect, params: draft.params || {}, pinned: !!draft.pinned };
    setBusy(true);
    try {
      await api(endpoint(id) + '?library=true', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeEditor(); await S.refreshPresets(); await S.refresh();
      say(`Saved “${name}”.${body.pinned ? ' Pinned to Looks.' : ''}`);
    } catch (e) { const message = failure('save the preset', e); if ($('#prError')) $('#prError').textContent = message; else say(message); }
    finally { setBusy(false); }
  }
  $('#prNew').onclick = () => openEditor();
  $('#prSearch').oninput = renderList;
  S.on('presets', renderList);
  S.on('tab', (name) => { if (name === 'presets' || name === 'looks') S.refreshPresets().catch((e) => say(failure('refresh the presets', e))); });
  addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  renderList();
  return { openEditor };
}
