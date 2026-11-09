// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Toasts that arrive together read as one. On the phone sheet the map band
// is small, so there is one toast at a time: a newer one takes the line and
// the earlier text becomes its detail. Elsewhere messages within a few
// seconds of each other fold the same way. An error, or a toast carrying
// its own action, keeps its own card and never folds into another.

export const MERGE_WINDOW = 5000;

// foldable returns the toasts, of those showing, that fold into incoming.
// Each showing toast is {at, error, action}; incoming is {error, action}.
export function foldable(showing, incoming, layout, now) {
  if (incoming.error || incoming.action) return [];
  return showing.filter((t) => !t.error && !t.action && (layout === 'sheet' || now - t.at <= MERGE_WINDOW));
}

// merged gives the one toast's lines: the newest message first, then the
// earlier ones (and their own details), oldest last.
export function merged(message, details, folded) {
  const lines = [...details];
  for (const t of [...folded].reverse()) lines.push(t.text, ...t.details);
  return { text: message, details: lines };
}
