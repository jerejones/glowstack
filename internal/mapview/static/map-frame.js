// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// How much of the map's top and bottom edges framing has to keep clear.
// Which controls cover the top depends on the layout: the map toggle sits
// at the top of the map only while calibrating on a phone. Everywhere else
// it is at the bottom, and counting it at the top leaves nothing to frame.

// toastHome is where messages go: over the map, or while calibrating in the
// calibration panel, since the map is then the target being lined up.
// On a phone whose sheet is up (sheet: the half or full detent) they go in
// the sheet, above its sticky bar, so a message never covers the map's lit
// area (move E).
export const toastHome = (calibrating, panelReady, sheet = false) => (calibrating && panelReady ? 'caToasts' : sheet ? 'panelToasts' : 'toasts');

// sheetToastTop is where the sheet's toasts end, in px from the sheet's top
// edge: above its sticky bar (bar is the bar's height, 0 with none) and the
// safe area, with a gap. visible is how much of the sheet shows.
export const sheetToastTop = ({ visible, bar = 0, safe = 0 }) => Math.max(0, visible - bar - safe - 8);

// toastBottom is how far above the stage's bottom toasts sit: over the
// toggle, the legend and the sheet.
export const toastBottom = ({ floats }) => (floats ?? 0) + 8;

// frameInsets takes the page's measurements, in px from the stage's top:
// height (the stage's), chips and crumbs (their bottoms; crumbs is null
// when hidden), controls (the toggle's bottom), layout, covered (the sheet's
// height over the map),
// calibrating, calTop (the calibration sheet's top) and floats (the height
// the side layout's toggle and legend take from the map's bottom edge).
export function frameInsets({ height, chips, crumbs, controls, layout, covered, calibrating, calTop, floats }) {
  // On a phone the chip, the toggle and the crumbs are all at the top.
  let top = layout === 'sheet' && !calibrating ? Math.max(chips, controls, crumbs ?? 0) : chips;
  // On a phone the color key sits above the sheet: floats counts it.
  let bottom = layout === 'sheet' ? Math.max(covered, floats ?? 0) : covered;
  if (calibrating) {
    if (layout === 'sheet') {
      top = Math.max(top, controls);
      bottom = Math.max(height - calTop, floats ?? 0); // the key sits above the calibration sheet
    } else bottom = floats;
  }
  // Leave the framing some room, whatever covers the map.
  top = Math.max(0, Math.min(top, height - bottom - 52));
  return { top: top + 6, bottom: bottom + 6 };
}

// framePad is how far inside the free rectangle the lights are framed, in
// px: side from its left and right edges, edge from its top and bottom
// (frameInsets has already taken 6 px of each of those). The margin scales
// with the pane (B145): at least FRAME_MARGIN (4%) of the free rectangle's
// width at each side, a little more on a wide pane, and the same share of
// its height above and below. A wide desktop pane frames the house with air
// around it; a phone's short band keeps almost all of its width, and never
// less than its 12 px at the sides and 8 px above and below, with a pixel to
// spare (B141). Where markers are drawn on the lights (calibration points,
// Wiring's output rings) their ring is part of what has to clear, not only
// the dot under it. width and height are the free rectangle's.
export const FRAME_MARGIN = 0.04;
export const MARKER_RING = 12; // px: the widest resting marker's radius and stroke
// frameMargin is that margin for one dimension of the free rectangle, in px.
export const frameMargin = (size) => Math.max(size * FRAME_MARGIN, size * 0.05 - 6);
export function framePad({ width = 0, height = 0, markers = false } = {}) {
  const ring = markers ? MARKER_RING : 0, r1 = (v) => Math.round(v * 10) / 10;
  return { side: r1(Math.max(13, frameMargin(width)) + ring), edge: r1(Math.max(3, frameMargin(height) - 6) + ring) };
}

// DOT is the drawn dot's radius in px per px of projected pitch, and its
// least radius: scene.js draws a pixel 1.35 pitches wide, never under 3 px.
const DOT = 1.35 / 2, DOT_MIN = 1.5;

// fitDepth is the least depth (distance along the view) at which a point
// `off` meters from the view's center line, drawn as a dot for a pixel of
// pitch `dl` meters, stays `pad` px inside a half-extent of `half` px. k is
// the px one unit of tangent spans. The dot's edge, not its center, is what
// has to clear: a dot grows as the camera nears, so its radius is part of
// the fit, and its least radius is the floor.
export function fitDepth(off, dl, k, half, pad) {
  const room = Math.max(half - pad, 1), x = Math.abs(off);
  return Math.max(k * (x + DOT * dl) / room, k * x / Math.max(room - DOT_MIN, 1));
}

// centerShift is how far to move the look-at point, along the camera's right
// and up, so that points fill the view evenly: the middle of what they span
// on screen, at the look-at depth. points are [right, up, z] relative to it,
// z toward the camera; dist is the camera's distance from it.
export function centerShift(points, dist) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [r, u, z] of points) {
    const d = Math.max(dist - z, dist * 0.05);
    x0 = Math.min(x0, r / d); x1 = Math.max(x1, r / d);
    y0 = Math.min(y0, u / d); y1 = Math.max(y1, u / d);
  }
  if (!isFinite(x0)) return [0, 0];
  return [(x0 + x1) / 2 * dist, (y0 + y1) / 2 * dist];
}
