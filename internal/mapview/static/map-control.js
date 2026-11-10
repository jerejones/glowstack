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
// Tapping a run chooses where the next look goes; it changes no light, so
// the line never says "light" (those words are for the action that does).
export const tapHint = (word = 'Tap') => `${word} a run on the map to choose where the next look goes.`;

// showTapHint says whether the map's caption shows: on the Looks tab only,
// on a device that has never made a selection, while nothing is selected and
// the map is free for it (not calibrating, not failed). It is said once, in
// one place: no card, list or other tab repeats it.
export function showTapHint({ seen, selected, tab = 'looks', calibrating = false, failed = false }) {
  return tab === 'looks' && !seen && !selected && !calibrating && !failed;
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

// ---------- the state language for runs on the map ----------

// A run on the map is in one of these states, each drawn its own way
// (docs/design.md, "Selection"):
//   installed  a thin, dim, neutral line along every drawn run that is not
//              lit, so a run can be told from a roof edge and looks tappable
//   hovered    the line brightens and the run's name shows (mouse)
//   selected   the soft white halo, wider than any line, and the breadcrumb
//   previewed  the look's own colors
//   target     calibration's current point: the one cyan ring
//   warned     an amber outline, while a Status warning for the run is pointed at
// RUN_LINE is how the line states are stroked on the overlay canvas. The
// installed line is neutral gray: no hue a light could be showing, at least
// 3:1 against the map's background and another weight than the model's lines.
export const RUN_LINE = {
  installed: { color: 'rgb(122, 122, 122)', width: 2 },
  hovered: { color: 'rgb(241, 245, 249)', width: 3 },
  warned: { color: 'rgb(245, 158, 11)', width: 4 },
};
export const TARGET_COLOR = '#22d3ee'; // the one color reserved for "current"

// OUTLINE is the thin line drawn around a run's path, clear of the run by a
// small gap, so whatever the run shows inside it is untouched: the page's
// interaction blue, width px thick, gap px from the widest thing the run
// draws (a lit pixel). What the panel points at has it at `pointed` of its
// strength. It replaced a 15 px translucent halo, which over a whole house
// read as every run being a thick gray tube (B150).
export const OUTLINE = { color: '#7cc4ff', width: 1.5, gap: 2, pointed: 0.5, fade: 120 };

// outlineWidths is the outline for a run drawn d px wide: `inner` is the
// width left clear along the path, `outer` the stroke that leaves the
// outline's two edges around it.
export const outlineWidths = (d) => ({ inner: d + 2 * OUTLINE.gap, outer: d + 2 * (OUTLINE.gap + OUTLINE.width) });

// outlineChunks cuts polylines of [x, y, d] (d: how wide the run draws at
// that point, px) into pieces of one whole-pixel width each, as a map from
// that width to its pieces. Neighboring pieces share a point, so their round
// ends meet and the outline follows a run that shrinks with distance.
export function outlineChunks(parts) {
  const out = new Map();
  const add = (d, piece) => { if (!out.has(d)) out.set(d, []); out.get(d).push(piece); };
  for (const part of parts) {
    if (!part.length) continue;
    let d = Math.round(part[0][2] || 0), piece = [part[0]];
    for (let i = 1; i < part.length; i++) {
      piece.push(part[i]);
      const next = Math.round(part[i][2] || 0);
      if (next !== d) { add(d, piece); d = next; piece = [part[i]]; }
    }
    if (piece.length > 1 || part.length === 1) add(d, piece);
  }
  return out;
}

// strokeOutline draws the outline of parts on ctx, which must be a layer of
// its own: the outer stroke first, then the inside cut back out of it, so
// two runs that meet share one outline and nothing is left over the lights.
// The caller composites the layer at the state's strength.
export function strokeOutline(ctx, parts, color = OUTLINE.color) {
  const chunks = outlineChunks(parts);
  const pass = (width) => {
    for (const [d, pieces] of chunks) {
      ctx.lineWidth = width(outlineWidths(d));
      ctx.beginPath();
      for (const piece of pieces) {
        ctx.moveTo(piece[0][0], piece[0][1]);
        if (piece.length === 1) ctx.lineTo(piece[0][0] + 0.01, piece[0][1]); // one pixel: a dot of the outline's width
        for (let i = 1; i < piece.length; i++) ctx.lineTo(piece[i][0], piece[i][1]);
      }
      ctx.stroke();
    }
  };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = color;
  pass((w) => w.outer);
  ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000';
  pass((w) => w.inner);
  ctx.globalCompositeOperation = 'source-over';
}

// runLit says any pixel of a run (ranges of [first, last]) is lit in rgb.
export function runLit(rgb, ranges) {
  for (const [a, b] of ranges) for (let i = 3 * a, end = 3 * b + 3; i < end; i++) if (rgb[i] > 8) return true;
  return false;
}

// LINGER is how long a run that was lit keeps its line hidden once it goes
// dark, so a look that breathes to black does not flash the line in.
export const LINGER = 2000; // ms
// unlitRuns picks the runs that draw the installed line: lit[i] says run i
// is lit now, seen[i] is when it last was (updated here), now the time.
export function unlitRuns(lit, seen, now) {
  const out = [];
  lit.forEach((on, i) => {
    if (on) seen[i] = now;
    else if (!(now - (seen[i] ?? -Infinity) < LINGER)) out.push(i);
  });
  return out;
}

// STATE_KEY is the key's entry for each state: a swatch class and the words.
export const STATE_KEY = [
  ['installed', 'line', 'Not lit'],
  ['hovered', 'line bright', 'Pointed at'],
  ['selected', 'halo', 'Selected'],
  ['previewed', 'look', 'Previewing'],
  ['target', 'ring', 'Calibrating this point'],
  ['warned', 'line amber', 'Needs calibrating'],
];
// statesShown is the states on screen now, in the key's order: the key lists
// a state only while it is there.
export function statesShown(on) {
  return STATE_KEY.filter(([id]) => on[id]).map(([id]) => id);
}
// stateKeyHTML is those states as one line of the key ('' with none).
export function stateKeyHTML(ids) {
  if (!ids.length) return '';
  return `<div class="key states">${STATE_KEY.filter(([id]) => ids.includes(id)).map(([id, cls, words]) => `<span data-state="${id}"><i class="sw rs ${cls}"></i>${words}</span>`).join('')}</div>`;
}
