// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// confirmDialog asks a yes-or-no question in the page's own style. It
// resolves true if the action was confirmed.
import { esc } from './util.js';

export function confirmDialog({ title, body = '', confirm = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm';
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>${body ? `<p class="muted">${esc(body)}</p>` : ''}<div class="row end"><button value="no">${esc(cancel)}</button><button value="yes" class="${danger ? 'danger' : 'go'}">${esc(confirm)}</button></div></form>`;
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    document.body.append(d);
    d.showModal();
  });
}
