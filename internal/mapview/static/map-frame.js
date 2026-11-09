// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// How much of the map's top and bottom edges framing has to keep clear.
// Which controls cover the top depends on the layout: the map toggle sits
// at the top of the map only while calibrating on a phone. Everywhere else
// it is at the bottom, and counting it at the top leaves nothing to frame.

// toastBottom is how far above the stage's bottom toasts sit: over the
// toggle, the legend and the sheet, or on a phone that's calibrating, over
// the calibration sheet.
export function toastBottom({ height, layout, calibrating, calTop, floats }) {
  return (calibrating && layout === 'sheet' ? Math.max(height - calTop, floats ?? 0) : floats) + 8;
}

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
