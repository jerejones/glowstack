// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { api, patch, del, esc, failure, humanize } from '../util.js';
import { createForm, lookStrip, presetName } from '../form.js';
import { spriteURL, spriteStyle, guardSprite } from '../tiles.js';
import { createPicker, escapeCloses } from '../picker.js';
import { effectKind, effectSummary } from './looks.js';
import { showState, stateHTML } from '../states.js';
import { confirmDialog } from '../dialog.js';
import { icon } from '../icons.js';
import { textField, setFieldError } from '../field.js';

export function presetSlug(name, presets) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  let id = base, n = 2;
  while (presets.some((p) => p.id === id)) id = `${base}-${n++}`;
  return id;
}

export function createPresets(S, root) {
  let draft = null, dirty = false, busy = false, form;
  let closeMenu = null; // closes the row menu that's open
  root.innerHTML = `
    <div class="row library-heading"><h1 class="title">Presets</h1><button type="button" id="prNew" class="icon-btn">${icon('plus')}New preset</button></div>
    <p class="muted small tab-intro">Save looks for later. Pin favorites to keep them visible on Looks.</p>
    <p class="muted small tab-intro-compact">Saved looks. Pin one to show it on Looks.</p>
    <div id="prMessage" role="status" class="small"></div>
    <div id="prEditor" class="preset-editor" hidden></div>
    ${textField({ label: 'Find a preset', id: 'prSearch', type: 'search', placeholder: 'Search presets' })}
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

  // wireMenu makes a row's More a real menu: one open at a time, closed by
  // Escape, a tap elsewhere or a choice, with the arrow keys moving through it.
  function wireMenu(row) {
    const more = row.querySelector('[data-act=more]'), menu = row.querySelector('.preset-menu');
    const items = [...menu.children];
    const outside = (e) => { if (!menu.contains(e.target) && !more.contains(e.target)) close(); };
    function close() {
      menu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      if (closeMenu === close) closeMenu = null;
    }
    more.onclick = () => {
      if (!menu.hidden) { close(); return; }
      closeMenu?.();
      menu.hidden = false;
      more.setAttribute('aria-expanded', 'true');
      closeMenu = close;
      document.addEventListener('pointerdown', outside, true);
      menu.scrollIntoView({ block: 'nearest' });
      items[0].focus({ preventScroll: true });
    };
    menu.addEventListener('click', close);
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    });
    escapeCloses(row.querySelector('.menu-wrap'), () => !menu.hidden, () => { close(); more.focus(); });
  }

  function renderList() {
    closeMenu?.();
    if (S.library.presets === 'failed') {
      $('#prNew').disabled = true;
      showState($('#prList'), { kind: 'error', title: 'Could not load your presets', detail: 'They are safe; Glowstack just could not read them.', retry: S.retryLibrary });
      return;
    }
    $('#prNew').disabled = busy || S.library.catalog === 'failed';
    const query = $('#prSearch').value.toLowerCase().trim();
    const list = S.presets.filter((p) => `${presetName(p)} ${p.id} ${p.effect}`.toLowerCase().includes(query));
    const box = $('#prList'); box.replaceChildren();
    S.tiles?.watch(box);
    for (const p of list) {
      const row = document.createElement('article'); row.className = 'preset-entry';
      const effect = (S.catalog.effects || []).find((e) => e.id === p.effect);
      row.innerHTML = `<div class="preset-body" title="Show this on the map; the lights don't change"><span class="strip sprite"></span><div class="preset-title"><b>${esc(presetName(p))}</b><span class="muted small">${esc(effect ? effectSummary(effect) : humanize(p.effect))}</span></div></div><div class="preset-actions">
        <button type="button" data-act="try" title="Show this on the map; the lights don't change"></button>
        <button type="button" data-act="pin" aria-pressed="${!!p.pinned}" aria-label="${esc((p.pinned ? 'Unpin ' : 'Pin ') + presetName(p))}"><span class="pin">${icon(p.pinned ? 'pinFilled' : 'pin')}${p.pinned ? 'Pinned' : 'Pin'}</span></button>
        <div class="menu-wrap"><button type="button" data-act="more" class="icon-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(`More for ${presetName(p)}`)}">${icon('more')}More</button>
          <div class="preset-menu" role="menu" hidden><button type="button" role="menuitem" data-act="edit">${icon('edit')}Edit</button><button type="button" role="menuitem" data-act="copy">${icon('copy')}Duplicate</button><button type="button" role="menuitem" data-act="delete" class="danger">${icon('trash')}Delete</button></div></div></div>`;
      const sprite = spriteURL('preset', p.id, p.params, effect), drawn = lookStrip(S, p.effect, p.params);
      row.querySelector('.strip').style.cssText = spriteStyle(sprite, drawn);
      guardSprite(row.querySelector('.strip'), sprite, drawn);
      wireMenu(row);
      row.querySelector('[data-act=try]').dataset.preset = p.id;
      // The card previews, as on Looks; the button is the same for a keyboard.
      row.querySelector('[data-act=try]').onclick = row.querySelector('.preset-body').onclick = () => S.looks.push({ preset: p.id });
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
    if (!list.length) box.innerHTML = stateHTML({ kind: 'empty', title: S.presets.length ? 'No matching presets' : 'No presets yet', detail: S.presets.length ? 'Try a different search.' : 'Create one to get started.', action: S.presets.length ? null : { id: 'prEmptyNew', label: 'New preset' } });
    box.querySelector('#prEmptyNew')?.addEventListener('click', () => openEditor());
    markTry();
    if (busy) setBusy(true);
  }
  const markName = (message) => {
    setFieldError($('#prName'), message);
  };
  function closeEditor() { draft = null; dirty = false; $('#prEditor').hidden = true; $('#prEditor').replaceChildren(); root.parentElement.style.removeProperty('--look-bar'); }
  async function openEditor(p) {
    if (busy || !(await discard())) return;
    draft = structuredClone(p || { id: '', name: '', effect: S.catalog.effects?.[0]?.id || '', params: {}, pinned: false });
    dirty = false;
    const box = $('#prEditor'); box.hidden = false;
    box.innerHTML = `<h3>${draft.id ? 'Edit preset' : 'New preset'}</h3>
      ${textField({ label: 'Name', id: 'prName', maxlength: 120, required: true })}
      <div class="field-label"><span id="prEffectLabel">Effect</span><div id="prEffectSlot"></div><span class="field-err" id="prEffectErr" role="alert"></span></div>
      <label class="check"><input type="checkbox" id="prPinned"> Pin to Looks</label>
      <p class="muted small">Changes stay here until you save. Saving does not change running lights.</p>
      <div id="prParams"></div><div class="err" id="prError" role="alert"></div>
      <div class="row editor-actions" id="prActions"><button type="button" id="prSave" class="go icon-btn">${icon('check')}Save preset</button><button type="button" id="prCancel">Cancel</button></div>`;
    $('#prName').value = draft.id ? presetName(draft) : draft.name;
    $('#prPinned').checked = !!draft.pinned;
    $('#prName').oninput = () => { draft.name = $('#prName').value; dirty = true; markName(''); };
    $('#prPinned').onchange = () => { draft.pinned = $('#prPinned').checked; dirty = true; };
    const select = createPicker((S.catalog.effects || []).map((e) => ({ value: e.id, label: e.name || e.id })), { label: 'Effect', id: 'prEffect' });
    $('#prEffectSlot').replaceWith(select);
    select.value = draft.effect;
    select.onchange = async () => {
      if (Object.keys(draft.params || {}).length && !(await confirmDialog({ title: 'Change the effect?', body: "This preset's settings will reset.", confirm: 'Change effect' }))) { select.value = draft.effect; return; }
      draft.effect = select.value; draft.params = {}; dirty = true; renderForm();
    };
    $('#prCancel').onclick = cancelEditor;
    $('#prSave').onclick = saveDraft;
    renderForm();
    placeEditor(box);
  }
  // placeEditor sets the form where it can be used: on a phone the sheet
  // rises and the card starts just under the tabs, whatever autofocus would
  // have scrolled, with Save pinned at the bottom.
  function placeEditor(box) {
    const sheet = S.panel.layout() === 'sheet';
    if (sheet) S.panel.setDetent('full');
    $('#prName').focus({ preventScroll: true });
    box.scrollIntoView(sheet ? { block: 'start' } : { block: 'nearest', behavior: 'smooth' });
    root.parentElement.style.setProperty('--look-bar', $('#prActions').offsetHeight + 'px');
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
    if (!name) { markName('Give the preset a name.'); $('#prName').focus(); return; }
    if ($('#prParams .bad')) { $('#prError').textContent = 'Check the highlighted settings before saving.'; return; }
    $('#prEffectErr').textContent = $('#prEffect').value ? '' : 'Choose an effect.';
    if (!$('#prEffect').value) return;
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
  // cancelEditor is Cancel's path: Escape does the same, asking first
  // about unsaved edits.
  async function cancelEditor() {
    if (!(await discard())) return;
    closeEditor();
    $('#prNew').focus();
  }
  escapeCloses($('#prEditor'), () => !!draft && !busy, cancelEditor);
  $('#prNew').onclick = () => openEditor();
  $('#prSearch').oninput = renderList;
  // markTry shows which presets are in the preview, as on Looks.
  function markTry() {
    for (const b of root.querySelectorAll('[data-act=try]')) {
      const on = !!S.looks?.inPreview(b.dataset.preset);
      b.innerHTML = `${icon('eye')}${on ? 'Previewing' : 'Preview'}`;
      b.closest('.preset-entry').classList.toggle('in-preview', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  S.on('preview', markTry);
  S.on('select', markTry);
  S.on('presets', renderList);
  // The sticky Save bar's height, again after Looks clears its own.
  S.on('tab', (name) => { if (name === 'presets' && draft) root.parentElement.style.setProperty('--look-bar', $('#prActions').offsetHeight + 'px'); });
  S.on('tab', (name) => { if (name === 'presets' || name === 'looks') S.refreshPresets().catch((e) => say(failure('refresh the presets', e))); });
  addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  renderList();
  return {
    openEditor,
    // closeEditor answers Escape with focus outside the editor: true if it
    // had an editor to close.
    closeEditor() { if (!draft || busy || S.panel.tab() !== 'presets') return false; cancelEditor(); return true; },
  };
}
