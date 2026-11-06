// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Strip condition is independent of controller power/reachability. Older
// models without status remain visible, preserving existing installations.
export function runVisibility(g, all = false) {
  const runs = g.runs.map((r) => all || !r.status || r.status === 'working');
  const pixels = new Uint8Array(g.pixels.count);
  for (let p = 0; p < pixels.length; p++) {
    const r = g.pixels.run[p];
    pixels[p] = all || (r >= 0 && runs[r]) ? 1 : 0;
  }
  const nodes = new Set(g.runs.flatMap((r, i) => runs[i] ? r.path : []));
  return { runs, pixels, nodes };
}
