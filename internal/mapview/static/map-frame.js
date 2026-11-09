// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// How much of the map's top and bottom edges framing has to keep clear.
// Which controls cover the top depends on the layout: the map toggle sits
// at the top of the map only while calibrating on a phone. Everywhere else
// it is at the bottom, and counting it at the top leaves nothing to frame.

// frameInsets takes the page's measurements, in px from the stage's top:
// height (the stage's), chips and crumbs (their bottoms; crumbs is null
// when hidden), controls (the toggle's bottom), layout, full (the sheet is
// at its full detent), covered (the sheet's height over the map),
// calibrating, calTop (the calibration sheet's top) and floats (the height
// the side layout's toggle and legend take from the map's bottom edge).
export function frameInsets({ height, chips, crumbs, controls, layout, full, covered, calibrating, calTop, floats }) {
  const atFull = full && !calibrating;
  let top = atFull ? 0 : chips;
  if (atFull && crumbs !== null) top = crumbs;
  let bottom = covered;
  if (calibrating) {
    if (layout === 'sheet') {
      top = Math.max(top, controls);
      bottom = height - calTop;
    } else bottom = floats;
  }
  // Leave the framing some room, whatever covers the map.
  top = Math.max(0, Math.min(top, height - bottom - 52));
  return { top: top + 6, bottom: bottom + 6 };
}
