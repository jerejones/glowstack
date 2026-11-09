// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The map as a control, in words and small rules (move C). Tapping a run
// has always selected it, and the selection has always been where the next
// look goes; these are what make that found: the one line that teaches the
// tap, shown once per device; the name a run shows under the pointer; and
// the pixels the panel points at when a card or a row is hovered.
import { load, save, humanize } from './util.js';

const HINT_SEEN = 'glowstack.hint.tap';

// tapHint is the one line that teaches the tap. word is Tap or Click.
export const tapHint = (word = 'Tap') => `${word} a run on the map to light just that part.`;

// showTapHint says whether the map's caption shows: on a device that has
// never made a selection, while nothing is selected and the map is free
// for it (not calibrating, not failed).
export function showTapHint({ seen, selected, calibrating = false, failed = false }) {
  return !seen && !selected && !calibrating && !failed;
}

// hintSeen reads, and markHintSeen records, that this device has made a
// selection: the caption never shows again after the first one.
export const hintSeen = () => load(HINT_SEEN, false) === true;
export const markHintSeen = () => save(HINT_SEEN, true);

// runAt names what is under the pointer: pixel p's run and the zone it is
// in, from the geometry alone, so the label needs no request and shows at
// once. null when the pixel is on no run.
export function runAt(geo, tree, p) {
  const ri = geo.pixels.run[p];
  if (!(ri >= 0) || !geo.runs[ri]) return null;
  const run = geo.runs[ri];
  let zone = '';
  for (let nd = tree.runNode(ri); nd && !zone; nd = nd.parent) {
    const z = nd.members.find((m) => m.kind === 'zone');
    if (z) zone = z.name || humanize(z.id);
  }
  return { index: ri, run: run.name || humanize(run.id), zone };
}

// runTitle is that name on one line: the run, then its zone.
export const runTitle = (at) => (at ? (at.zone && at.zone !== at.run ? `${at.run} · ${at.zone}` : at.run) : '');

// controllerRanges is a controller's pixels, for the halo: every pixel it
// drives, as [first, last] pairs. [] when the geometry does not say.
export function controllerRanges(geo, id) {
  const c = (geo.controllers || []).find((x) => x.id === id);
  return c && c.pixels ? [[c.base, c.base + c.pixels - 1]] : [];
}

// restPoint says whether the phone shows the target's halo with nothing
// hovered: there is no hover on touch, so the Looks sheet at its half detent
// with nothing previewing shows where the next look would go.
export function restPoint({ coarse, layout, detent, tab, previewing, calibrating = false }) {
  return !!coarse && layout === 'sheet' && detent === 'half' && tab === 'looks' && !previewing && !calibrating;
}
