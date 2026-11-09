// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// cardCorner picks where the inspect card goes: the corner of the map
// farthest from the inspected pixel. The bottom-left corner holds the
// map toggle, so it isn't offered. top is how far down the chip bar and
// crumbs reach; pixel is the pixel's [x, y], or null if it is off screen.
export function cardCorner({ w, h, cw, ch, top, pixel }) {
  const y0 = Math.min(top + 8, Math.max(8, h - ch - 8));
  const corners = [[w - cw - 8, y0], [w - cw - 8, Math.max(y0, h - ch - 8)], [8, y0]];
  if (!pixel) return corners[0];
  const distance = ([x, y]) => Math.hypot(x + cw / 2 - pixel[0], y + ch / 2 - pixel[1]);
  return corners.reduce((a, b) => (distance(b) > distance(a) ? b : a));
}
