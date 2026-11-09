// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// How much of the map's top and bottom edges framing has to keep clear.
// Which controls cover the top depends on the layout: the map toggle sits
// at the top of the map only while calibrating on a phone. Everywhere else
// it is at the bottom, and counting it at the top leaves nothing to frame.

// toastHome is where messages go: over the map, or while calibrating in the
// calibration panel, since the map is then the target being lined up.
export const toastHome = (calibrating, panelReady) => (calibrating && panelReady ? 'caToasts' : 'toasts');

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
