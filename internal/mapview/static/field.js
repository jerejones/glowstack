// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared text input: a field with its label above and its error
// directly below, so every form looks and fails the same way.
import { esc } from './util.js';

// textField is the markup for a labeled input; ariaLabel stands in when
// there's no visible label. Its error box is <id>Err.
export function textField({ label = '', ariaLabel = '', id, type = 'text', placeholder = '', maxlength, required = false }) {
  const attrs = `id="${esc(id)}" type="${esc(type)}" autocomplete="off"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${maxlength ? ` maxlength="${maxlength}"` : ''}${required ? ' required' : ''}${ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : ''}`;
  const err = `<span class="field-err" id="${esc(id)}Err" role="alert"></span>`;
  return label ? `<label class="field">${esc(label)}<input ${attrs}>${err}</label>` : `<div class="field"><input ${attrs}>${err}</div>`;
}

// setFieldError shows message under input's field, or clears it with ''.
export function setFieldError(input, message) {
  input.closest('.field, .f').querySelector('.field-err').textContent = message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}
