// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const KEEP_CLEAR = 24; // px between a docked card and the pixel it shows
const AIM_HOLD = 600;  // ms the card waits for a pointer on its way to it

// rectGap is how far (x, y) is outside rect r: 0 inside it.
export function rectGap(r, x, y) {
  return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
}

// createAim watches the pointer's gap to the card. step(gap, now) is true
// while the pointer keeps closing in, for up to hold ms: long enough to
// reach the card, short enough that sweeping across the map carries on
// inspecting.
export function createAim(hold = AIM_HOLD) {
  let last = Infinity, since = -1;
  return {
    step(gap, now) {
      const closer = gap < last;
      last = gap;
      if (!closer) { since = -1; return false; }
      if (since < 0) since = now;
      return now - since <= hold;
    },
    reset() { last = Infinity; since = -1; },
  };
}

// cardCorner picks where the inspect card goes: the corner of the map
// farthest from the inspected pixel. The bottom-left corner holds the
// map toggle, so it isn't offered. top is how far down the chip bar and
// crumbs reach; pixel is the pixel's [x, y], or null if it is off screen.
// prev is the corner the card is in: it stays there unless the pixel comes
// up against it, so the card doesn't run from a pointer heading for it.
export function cardCorner({ w, h, cw, ch, top, pixel, prev = null }) {
  const y0 = Math.min(top + 8, Math.max(8, h - ch - 8));
  const corners = [[w - cw - 8, y0], [w - cw - 8, Math.max(y0, h - ch - 8)], [8, y0]];
  const here = prev && corners.find(([x, y]) => x === prev[0] && y === prev[1]);
  if (here && (!pixel || rectGap({ left: here[0], top: here[1], right: here[0] + cw, bottom: here[1] + ch }, pixel[0], pixel[1]) > KEEP_CLEAR)) return here;
  if (!pixel) return corners[0];
  const distance = ([x, y]) => Math.hypot(x + cw / 2 - pixel[0], y + ch / 2 - pixel[1]);
  return corners.reduce((a, b) => (distance(b) > distance(a) ? b : a));
}

// labelSpot is where the hover label goes: beside the pointer, never over
// the run it names. w and h are the label's size, W and H the map's; points
// are the run's pixels on screen ([x, y] pairs). It tries spots around the
// pointer, nearest first (the four corners, then above, below and the
// sides, then the same again farther out), and takes the first that stays
// on the map and covers none of the run's pixels, with `clear` px to spare.
// A run that leaves no such spot (it fills the map) gets the spot covering
// fewest.
export function labelSpot({ x, y, w, h, W, H, points = [], gap = 14, clear = 6 }) {
  const spots = [];
  for (const d of [gap, gap + 28, gap + 64, gap + 110]) {
    spots.push([x + d, y - d - h], [x - d - w, y - d - h], [x + d, y + d], [x - d - w, y + d],
      [x - w / 2, y - d - h], [x - w / 2, y + d], [x + d, y - h / 2], [x - d - w, y - h / 2]);
  }
  const onMap = ([l, t]) => l >= 4 && t >= 4 && l + w <= W - 4 && t + h <= H - 4;
  const covered = ([l, t]) => points.filter(([px, py]) => px >= l - clear && px <= l + w + clear && py >= t - clear && py <= t + h + clear).length;
  let best = null, least = Infinity;
  for (const s of spots.filter(onMap)) {
    const n = covered(s);
    if (!n) return s;
    if (n < least) { best = s; least = n; }
  }
  return best || [Math.max(4, Math.min(x + gap, W - w - 4)), Math.max(4, Math.min(y - gap - h, H - h - 4))];
}
