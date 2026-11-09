// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared loading, error and empty states, so that a panel still
// loading never looks like an empty one, and one that failed always
// offers Retry. stateHTML is the markup, showState fills an element.
import { esc } from './util.js';
import { icon } from './icons.js';

export function stateHTML({ kind = 'empty', title, detail = '', retry = false, action = null }) {
  const live = kind === 'error' ? 'alert' : 'status';
  return `<div class="state ${esc(kind)}" role="${live}">${kind === 'loading' ? '<span class="spinner" aria-hidden="true"></span>' : icon(kind === 'error' ? 'alert' : 'info')}<div class="state-text"><b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}</div>${action ? `<button type="button" class="go" id="${esc(action.id)}">${esc(action.label)}</button>` : ''}${retry ? '<button type="button" data-retry>Retry</button>' : ''}</div>`;
}

// skeletonHTML is a tab's loading state: gray shapes where its content will
// be, in the content's own classes, so the widths and columns follow the
// same rules and the real content takes the same places. index.html carries
// the Looks one verbatim so it paints before any script runs; keep the two
// the same (a test does). No animation: a still shape is calmer, and it
// needs no reduced-motion exception.
export function skeletonHTML(tab) {
  const bar = (cls = '') => `<span class="skel ${cls}"></span>`;
  const card = () => `<div class="preset skel-card">${bar('skel-strip')}${bar('skel-name')}${bar('skel-sub')}</div>`;
  const label = { looks: 'Loading Looks…', presets: 'Loading presets…', setup: 'Loading Setup…', status: 'Loading Status…' }[tab];
  const body = tab === 'looks' ? `<div class="looks-head">${bar('skel-title')}</div><div class="stage skel-stage">${bar('skel-line')}${bar('skel-row')}${bar('skel-row')}</div><div class="lib-filters">${bar('skel-seg')}${bar('skel-seg')}${bar('skel-seg')}</div><div class="cards">${card()}${card()}${card()}${card()}${card()}${card()}</div>`
    : tab === 'presets' ? `<div class="library-heading">${bar('skel-title')}</div>${bar('skel-line')}${bar('skel-field')}${['', '', '', ''].map(() => `<div class="preset-entry skel-card">${bar('skel-strip')}${bar('skel-name')}${bar('skel-sub')}</div>`).join('')}`
    : tab === 'status' ? `<div class="looks-head">${bar('skel-title')}</div><div class="tiles">${bar('skel-tile')}${bar('skel-tile')}${bar('skel-tile')}${bar('skel-tile')}</div>${bar('skel-line')}${bar('skel-row')}${bar('skel-row')}`
    : `<div class="looks-head">${bar('skel-title')}</div>${bar('skel-line')}${bar('skel-row')}${bar('skel-line')}${bar('skel-row')}`;
  return `<div class="skeleton" role="status" aria-busy="true" aria-label="${label}">${body}</div>`;
}

// warningHTML is the one way a panel warns: the same card as Status's list.
export const warningBody = (text) => `<div class="issue-text">${icon('alert')}<span>${esc(text)}</span></div>`;
export const warningHTML = (text) => `<div class="issue solo">${warningBody(text)}</div>`;

// showState puts a state in el; opts.retry is what Retry does. Retry goes
// back to loading first, so every retry reads the same; whoever retries
// draws the result.
export function showState(el, opts) {
  el.innerHTML = stateHTML({ ...opts, retry: !!opts.retry });
  const b = el.querySelector('[data-retry]');
  if (b) b.onclick = () => {
    el.innerHTML = stateHTML({ kind: 'loading', title: 'Trying again…' });
    return opts.retry();
  };
}

// bootFailure says in plain words why the page could not start. It never
// carries a stack trace; the console has that.
// serverUp says another call just worked, so the fault is this one's and
// "isn't responding" would be untrue.
export function bootFailure(step, e, serverUp = false) {
  const noServer = !!(e && e.network);
  return {
    kind: 'error',
    title: `Glowstack could not ${step}`,
    detail: serverUp
      ? "Glowstack is running, but the map data didn't load. Try again; if it keeps happening, check the Glowstack log."
      : noServer
      ? "Glowstack isn't responding. Check that it is running, then try again."
      : 'Something went wrong while starting up. Try again; if it keeps happening, check the Glowstack log.',
  };
}
