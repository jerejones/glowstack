// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What the inspect card says about a pixel beyond its summary: sentences
// a person can read, and the raw figures behind a labeled section.
import { joined } from './house-status.js';

const inPlaces = (kind, names) => `${names.length === 1 ? `the ${names[0]} ${kind}` : `the ${kind}s ${joined(names)}`}`;

// inspectSentences reads a pixel report d in words. names holds the display
// names: run, output { led, count, name } or null, areas and zones.
export function inspectSentences(d, { run = '', output = null, areas = [], zones = [] }) {
  const out = [];
  if (d.dead) out.push('This light is marked as dead, so it stays dark.');
  if (output) out.push(`It is LED ${output.led} of ${output.count} on ${output.name}.`);
  if (run) out.push(`It is on ${run}.`);
  if (areas.length) out.push(`It is in ${inPlaces('area', areas)}.`);
  if (zones.length) out.push(`It belongs to ${inPlaces('zone', zones)}.`);
  if (d.dl !== null && d.dl !== undefined) out.push(`Each light here takes up about ${(d.dl * 1000).toFixed(1)} mm of the strip.`);
  return out;
}

// inspectTechnical is the raw rows, ids and all, as [label, value] pairs.
export function inspectTechnical(d, { is3d, fmt }) {
  const at = d.x === null ? '—' : is3d ? `${fmt(d.x, 2)}, ${fmt(d.y, 2)}, ${fmt(d.z, 2)} m` : `${fmt(d.x, 2)}, ${fmt(d.y, 2)} m`;
  return [
    ['Controller pixel', `${d.controller}:${d.index}`],
    ...(d.run ? [['Run id', d.run], ['Pixel on run', String(d.run_pixel)]] : []),
    ['Segment', d.edge ? `${d.edge} · ${fmt(d.dist, 2)} m` : '—'],
    [is3d ? 'Position' : 'Plan position', at],
    ...d.mappings.map((m) => [m.id, `${fmt(m.u)}${m.kind === 'index' ? '' : ' m'}${m.stretch !== null && Math.abs(m.stretch - 1) > 1e-4 ? ` · ×${fmt(m.stretch)}` : ''}`]),
  ];
}

// DETAILS_OPEN is where this device remembers that the card's Details were
// opened: after one click the wiring detail stays one glance away.
export const DETAILS_OPEN = 'glowstack.inspect.details';

// inspectRows is the card at rest: at most three rows. The run and its zone,
// what is showing there (and whether it is a preview), and the place in the
// chain (the zone and areas the run is part of, biggest first). The pixel's
// number, its color, its output and GPIO are Details, not rows.
// chain is the names above the run, without Everything.
export function inspectRows({ run = '', zone = '', pixel, dead = false, showing = '', chain = [] }) {
  const rows = [{ kind: 'name', title: run || `Pixel ${pixel}${dead ? ' (dead)' : ''}`, sub: run && zone && zone !== run ? zone : '' }];
  rows.push({ kind: 'showing', label: 'Showing', value: showing || 'Nothing' });
  const above = chain.filter((n) => n && n !== run);
  if (above.length) rows.push({ kind: 'chain', label: 'Part of', value: above.join(' \u203a ') });
  return rows;
}

// cardDock is where the floating card sits: the bottom right corner of the
// map, for a hover and for a pinned card alike, so it never jumps between
// them. top is how far down the chips and crumbs reach. The one exception:
// a pixel that would be under the card there (pixel is its [x, y], within
// clear px of the box) sends the card to the top right, so the card never
// hides what it describes.
export function cardDock({ w, h, cw, ch, top = 0, gap = 8, pixel = null, clear = 24 }) {
  const x = Math.max(gap, w - cw - gap);
  const high = Math.min(top + gap, Math.max(gap, h - ch - gap)), low = Math.max(high, h - ch - gap);
  const under = pixel && pixel[0] >= x - clear && pixel[0] <= x + cw + clear && pixel[1] >= low - clear && pixel[1] <= low + ch + clear;
  return [x, under ? high : low];
}
