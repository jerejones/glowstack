// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The map as a control, in words and small rules (move C). Tapping a run
// has always selected it, and the selection has always been where the next
// look goes; these are what make that found: the one line that teaches the
// tap, shown once per device; the name a run shows under the pointer; and
// the pixels the panel points at when a card or a row is hovered.
import { load, save, humanize } from './util.js';
import { drawCluster, CLUSTER_KEY } from './cal-points.js';

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

// RESET_VIEW is the one camera control on the map: a button beside the
// Preview/Lights toggle that is there only while the camera is away from the
// default framing. One press eases back to that framing and the button goes.
// It is one button, not a toolbar: there are no view buttons.
export const RESET_VIEW = { label: 'Reset view', ease: 300 }; // the words are in index.html

// showResetView says whether the button is in the page: the camera has been
// moved (away) and the map is free for it. It is absent, not disabled, at
// the default view. Not while calibrating (the mode frames its own target),
// not over a phone's full sheet (its strip of map is framed on the selection
// on purpose, and comes back when the sheet lowers) and not when the map
// failed.
export function showResetView({ away, calibrating = false, failed = false, full = false }) {
  return !!away && !calibrating && !failed && !full;
}

// doubleTap says what the second of two quick taps in one place does: over
// a run it is one more tap on that run (it climbs the selection), anywhere
// else it fits the view. Calibrating, it always fits (the mode's framing).
export const doubleTap = ({ onRun, calibrating = false }) => (calibrating || !onRun ? 'fit' : 'tap');

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

// One rule (docs/design.md, "Run states on the map"): not lit is a line, lit
// is light, selected is an outline. A run on the map is in these states,
// each drawn its own way:
//   installed  not lit: a thin dashed line in a warm neutral. The dash is the
//              cue (the model's edges are solid), so it survives grayscale;
//              the warm tone sets it off the model's cool blue-gray
//   lit        the look's own colors at the lit width, and nothing else
//   previewed  the same, while the map shows a preview
//   selected   a thin outline in the interaction blue around the run's path,
//              clear of the run, so the colors inside are untouched
//   hovered    the same outline at half strength: under the pointer (with the
//              run's name beside it), or pointed at from the panel
//   target     calibration's current point: the one cyan ring
//   warned     an amber line, while a Status warning for the run is pointed at
// RUN_LINE is how the line states are stroked on the overlay canvas. The
// installed line is at least 3:1 against the map's background, 1 to 1.5 px
// wide, and dashed.
export const RUN_LINE = {
  installed: { color: 'rgb(140, 124, 102)', width: 1.25, dash: [4, 3] },
  warned: { color: 'rgb(245, 158, 11)', width: 4 },
};
export const TARGET_COLOR = '#22d3ee'; // the one color reserved for "current"
// LIT_WIDTH is the least width a lit run draws at, px (scene.js PIXEL_VS):
// the key's swatch for it, and what its outline clears.
export const LIT_WIDTH = 5;

// strokeLine strokes parts (polylines of [x, y]) in a RUN_LINE style, dashed
// when the style is. The map and the key's swatches both draw with it.
export function strokeLine(ctx, parts, style) {
  ctx.strokeStyle = style.color; ctx.lineWidth = style.width; ctx.lineJoin = 'round'; ctx.lineCap = style.dash ? 'butt' : 'round';
  if (style.dash && ctx.setLineDash) ctx.setLineDash(style.dash);
  ctx.beginPath();
  for (const part of parts) {
    ctx.moveTo(part[0][0], part[0][1]);
    // One pixel on screen still draws: a dot of the line's width.
    if (part.length === 1) ctx.lineTo(part[0][0] + (style.dash ? style.dash[0] : 0.01), part[0][1]);
    for (let i = 1; i < part.length; i++) ctx.lineTo(part[i][0], part[i][1]);
  }
  ctx.stroke();
  if (style.dash && ctx.setLineDash) ctx.setLineDash([]);
}

// OUTLINE is the thin line drawn around a run's path, clear of the run by a
// small gap, so whatever the run shows inside it is untouched: the page's
// interaction blue (ui.css --accent: not the preview's purple, the lights'
// green or a warning's amber), width px thick, gap px from the widest thing
// the run draws (a lit pixel). The selection has it at full strength; the run
// under the pointer and what the panel points at have it at `pointed` of
// that. It replaced a 15 px translucent halo, which over a whole house read
// as every run being a thick gray tube (B150) and grayed the colors under a
// selection.
export const OUTLINE = { color: 'rgb(124, 196, 255)', rgb: '124, 196, 255', width: 1.5, gap: 2, pointed: 0.5, fade: 120 };

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

// STATE_KEY is the key's entry for each state, in the key's order: the id
// and the words. Lit and Previewing are one state under two names (what the
// map shows decides which), so only one of them is ever listed.
export const STATE_KEY = [
  ['installed', 'Not lit'],
  ['lit', 'Lit'],
  ['previewed', 'Previewing'],
  ['selected', 'Selected'],
  ['hovered', 'Pointed at'],
  ['target', 'Calibrating this point'],
  ['cluster', CLUSTER_KEY],
  ['warned', 'Needs calibrating'],
];
// statesShown is the states on screen now, in the key's order: the key lists
// a state only while it is there.
export function statesShown(on) {
  return STATE_KEY.filter(([id]) => on[id] && !(id === 'lit' && on.previewed)).map(([id]) => id);
}
// SWATCH is a key swatch's size, px: wide enough for two dashes, tall enough for the outline.
export const SWATCH = { w: 26, h: 14, tall: 26 }; // tall: a cluster's ring is drawn at its own size
// stateKeyHTML is those states as one line of the key ('' with none). Each
// swatch is a small canvas that paintSwatches draws with the map's own
// strokes, so the key cannot drift from what it explains.
export function stateKeyHTML(ids) {
  if (!ids.length) return '';
  return `<div class="key states">${STATE_KEY.filter(([id]) => ids.includes(id)).map(([id, words]) => `<span data-state="${id}"><canvas class="sw rs${id === 'cluster' ? ' tall' : ''}" data-swatch="${id}" width="${SWATCH.w}" height="${id === 'cluster' ? SWATCH.tall : SWATCH.h}" aria-hidden="true"></canvas>${words}</span>`).join('')}</div>`;
}
// LOOK_COLORS stands for "a look's own colors" in a swatch.
const LOOK_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'];
// drawSwatch draws state id's swatch on ctx, w by h px, with the strokes the
// map uses for it at the weights the map uses: the dashed line, the lit
// width, the outline at its strength, the target's ring, the amber line.
export function drawSwatch(ctx, id, w = SWATCH.w, h = SWATCH.h) {
  const y = h / 2, line = [[[1, y], [w - 1, y]]], run = [[[4, y, LIT_WIDTH], [w - 4, y, LIT_WIDTH]]];
  if (id === 'installed') strokeLine(ctx, line, RUN_LINE.installed);
  else if (id === 'warned') strokeLine(ctx, [[[3, y], [w - 3, y]]], RUN_LINE.warned);
  else if (id === 'lit' || id === 'previewed') {
    const n = LOOK_COLORS.length, step = (w - 6) / n;
    LOOK_COLORS.forEach((color, i) => strokeLine(ctx, [[[3 + i * step, y], [3 + (i + 1) * step, y]]], { color, width: LIT_WIDTH, dash: [step, 0] }));
  } else if (id === 'selected' || id === 'hovered') {
    // Half strength is in the color, not the context: the cut of the inside must stay whole.
    strokeOutline(ctx, run, id === 'hovered' ? `rgba(${OUTLINE.rgb}, ${OUTLINE.pointed})` : OUTLINE.color);
  } else if (id === 'cluster') {
    drawCluster(ctx, w / 2, y, 3);
  } else if (id === 'target') {
    ctx.strokeStyle = TARGET_COLOR; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(w / 2, y, Math.min(w, h) / 2 - 2, 0, 2 * Math.PI); ctx.stroke();
  }
}
// paintSwatches draws every swatch canvas under root, at the screen's pixel ratio.
export function paintSwatches(root, ratio = globalThis.devicePixelRatio || 1) {
  for (const c of root.querySelectorAll('canvas[data-swatch]')) {
    const h = c.dataset.swatch === 'cluster' ? SWATCH.tall : SWATCH.h;
    c.width = Math.round(SWATCH.w * ratio); c.height = Math.round(h * ratio);
    const ctx = c.getContext('2d');
    if (!ctx) continue;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawSwatch(ctx, c.dataset.swatch, SWATCH.w, h);
  }
}
