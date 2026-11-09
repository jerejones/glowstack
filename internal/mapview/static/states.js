// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared loading, error and empty states, so that a panel still
// loading never looks like an empty one, and one that failed always
// offers Retry. stateHTML is the markup, showState fills an element.
import { esc } from './util.js';

export function stateHTML({ kind = 'empty', title, detail = '', retry = false }) {
  const live = kind === 'error' ? 'alert' : 'status';
  return `<div class="state ${esc(kind)}" role="${live}">${kind === 'loading' ? '<span class="spinner" aria-hidden="true"></span>' : ''}<div class="state-text"><b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}</div>${retry ? '<button type="button" data-retry>Retry</button>' : ''}</div>`;
}

// showState puts a state in el; opts.retry is what Retry does.
export function showState(el, opts) {
  el.innerHTML = stateHTML({ ...opts, retry: !!opts.retry });
  const b = el.querySelector('[data-retry]');
  if (b) b.onclick = opts.retry;
}

// bootFailure says in plain words why the page could not start. It never
// carries a stack trace; the console has that.
export function bootFailure(step, e) {
  const noServer = !!(e && e.network);
  return {
    kind: 'error',
    title: `Glowstack could not ${step}`,
    detail: noServer
      ? "Glowstack isn't responding. Check that it is running, then try again."
      : 'Something went wrong while starting up. Try again; if it keeps happening, check the Glowstack log.',
  };
}
