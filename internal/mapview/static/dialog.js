// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// confirmDialog asks a yes-or-no question in the page's own style. It
// resolves true if the action was confirmed. The focus opens on Cancel, the
// safe answer, unless focus is 'confirm': for a question the keyboard itself
// asked (Escape during a calibration), where Enter must mean yes. keys shows
// each button's key beside its word (Esc, Enter).
import { esc } from './util.js';

export function confirmHTML({ title, body = '', confirm = 'OK', cancel = 'Cancel', danger = false, focus = 'cancel', keys = false }) {
  const key = (k) => (keys ? `<kbd>${k}</kbd>` : '');
  return `<form method="dialog"><h3>${esc(title)}</h3>${body ? `<p class="muted">${esc(body)}</p>` : ''}<div class="row end"><button value="no"${focus === 'confirm' ? '' : ' autofocus'}>${esc(cancel)}${key('Esc')}</button><button value="yes" class="${danger ? 'danger' : 'go'}"${focus === 'confirm' ? ' autofocus' : ''}>${esc(confirm)}${key('Enter')}</button></div></form>`;
}

export function confirmDialog(opts) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm';
    d.innerHTML = confirmHTML(opts);
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    document.body.append(d);
    d.showModal();
  });
}
