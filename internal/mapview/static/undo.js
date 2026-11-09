// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Undo after apply (move E). Applying is the one step that changes the real
// lights, so each change to them (Put, Add, Update, Replace, and Remove on
// a live look) can be taken back once: the confirmation toast carries Undo
// for TOAST_MS, and the "On the lights" card keeps a quieter "Undo last
// change" link until the next change or for LINK_MS, whichever is first.
//
// The server holds the undo point (PUT /api/v1/undo marks the live stack
// just before the change; POST /api/v1/undo puts it back exactly). This
// module is the page's side: which point it may offer, and for how long.
// Undo restores a stack of looks. It is never a power command and never
// touches zone brightness; "Turn on" is not something it offers to undo.

export const TOAST_MS = 10000;         // Undo on the confirmation toast
export const LINK_MS = 5 * 60 * 1000;  // "Undo last change" on the card

// createUndo keeps the one undo point this page knows about. One level
// only: set replaces the last one. now is the clock, for tests.
export function createUndo(now = () => Date.now()) {
  let point = null; // { id, at, what }
  const age = () => (point ? now() - point.at : Infinity);
  return {
    // set records the point marked just before a change: id is the server's,
    // what says the change in words ("put 2 looks on the lights").
    set(id, what) { point = id ? { id, at: now(), what } : null; },
    clear() { point = null; },
    point: () => point,
    // toast and link say whether each place still offers this point.
    toast: () => age() < TOAST_MS,
    link: () => age() < LINK_MS,
    // linkLeft is how long the card's link has left, in ms: 0 when it has none.
    linkLeft: () => Math.max(0, point ? LINK_MS - age() : 0),
  };
}

// mark asks the server to remember the live stack as it is now, before a
// change. It returns the point's id, or '' when the server could not: the
// change still goes ahead, without an undo. send is util.js's api.
export async function mark(send) {
  try { return (await send('/api/v1/undo', { method: 'PUT' })).id || ''; } catch { return ''; }
}

// undoResult is what pressing Undo reports. e is the failure, if any: a 409
// or 404 means a later change took the point's place, anything else that
// the server did not answer.
export function undoResult(e) {
  if (!e) return { text: 'Undone. The lights are as they were before.', warn: false, gone: true };
  if (e.status === 409 || e.status === 404) return { text: 'That change can no longer be undone: the lights were changed again since.', warn: true, gone: true };
  return { text: "Couldn't undo. The lights are unchanged.", warn: true, gone: false };
}
