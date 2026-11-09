// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared text input: a field with its label above and its error
// directly below, so every form looks and fails the same way.
import { esc } from './util.js';

// textField is the markup for a labeled input; ariaLabel stands in when
// there's no visible label. Its error box is <id>Err.
export function textField({ label = '', ariaLabel = '', id, type = 'text', placeholder = '', maxlength, required = false, clearable = false }) {
  const attrs = `id="${esc(id)}" type="${esc(type)}" autocomplete="off"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${maxlength ? ` maxlength="${maxlength}"` : ''}${required ? ' required' : ''}${ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : ''}`;
  const err = `<span class="field-err" id="${esc(id)}Err" role="alert"></span>`;
  // A clearable field has a × at its end while it holds a query (wireClear).
  const clear = clearable ? `<button type="button" class="field-clear" id="${esc(id)}Clear" aria-label="Clear ${esc(label || ariaLabel || 'the field')}" hidden>×</button>` : '';
  // The label's words are their own span, so a layout can fold them away
  // (the phone's half sheet, where the placeholder says it) and keep the input.
  return label ? `<label class="field${clearable ? ' clearable' : ''}"><span class="lbl">${esc(label)}</span><input ${attrs}>${clear}${err}</label>` : `<div class="field${clearable ? ' clearable' : ''}"><input ${attrs}>${clear}${err}</div>`;
}

// searching says whether a search field is in use: focused, or holding a
// query. A field in use takes the whole row on a phone's half sheet.
export const searching = (focused, value) => focused || !!value.trim();

// placeholderFor is the placeholder a field shows: the first candidate whose
// width fits the room the input has for text, else the last (the shortest:
// "Search"). A placeholder is never shown cut. width(text) measures a
// candidate in the input's font; room is the input's width for text, in px.
export function placeholderFor(candidates, room, width) {
  return candidates.find((c) => width(c) <= room) ?? candidates[candidates.length - 1];
}

// fitPlaceholder sets input's placeholder to the longest of candidates that
// fits it now, and keeps it fitted as the field changes width (it grows on
// focus on a phone's sheet). Without a canvas to measure with, the shortest.
export function fitPlaceholder(input, candidates, doc = globalThis.document) {
  let ctx = null;
  try { ctx = doc.createElement('canvas').getContext('2d'); } catch { /* no canvas: the shortest is safe */ }
  const fit = () => {
    if (!ctx || !input.clientWidth) { input.placeholder = candidates[candidates.length - 1]; return; }
    const cs = getComputedStyle(input);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const room = input.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    input.placeholder = placeholderFor(candidates, room - 1, (t) => ctx.measureText(t).width);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(input);
  input.addEventListener('focus', fit);
  input.addEventListener('blur', fit);
  fit();
  return fit;
}

// wireClear runs a clearable field: the × shows while there is a query, and
// clearing puts the panel's scroll back where it was before the query began,
// so the list the person left is the list they come back to. onChange runs
// after a clear as after typing.
export function wireClear(input, onChange, scroller) {
  const clear = input.parentElement.querySelector('.field-clear');
  let before = null; // the scroll position when the query began
  const update = () => {
    clear.hidden = !input.value;
    input.parentElement.classList.toggle('searching', searching(document.activeElement === input, input.value));
  };
  input.addEventListener('input', () => {
    if (input.value && before === null && scroller) before = scroller.scrollTop;
    if (!input.value) before = null;
    update(); onChange();
  });
  input.addEventListener('focus', update);
  input.addEventListener('blur', update);
  clear.onclick = () => {
    input.value = '';
    update(); onChange();
    if (scroller && before !== null) scroller.scrollTop = before;
    before = null;
  };
  update();
}

// setFieldError shows message under input's field, or clears it with ''.
export function setFieldError(input, message) {
  input.closest('.field, .f').querySelector('.field-err').textContent = message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}
