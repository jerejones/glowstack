// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Calibration's small rules, without the page (move F): which markers on
// the map are too close to tell apart and so draw as one, what a tap on the
// map reaches, how the current target is drawn against the others, the
// keys, what comes next, and how progress is grouped and counted.
import { esc, plural } from './util.js';

// ---------- markers that can be told apart ----------

// CLUSTER is how close two markers' centers may be, in px, before they are
// one cluster: a finger needs more room than a mouse.
export const CLUSTER = { coarse: 24, fine: 16 };
// MARKER is a resting calibration marker's ring: its radius and its stroke.
export const MARKER = { radius: 8, width: 2 };
// TARGET is the current target's ring: at least 1.5 times the radius of the
// others and at least 2 px thicker, in the one color kept for "current";
// OTHERS is what every other marker's opacity drops to while a step is on.
export const TARGET = { radius: 14, width: 4.5, color: '#22d3ee', halo: 'rgba(13, 14, 16, 0.85)' };
export const OTHERS = 0.4;

// A cluster's marker is a count, and is drawn as one: "×3" in a ring, in a
// smaller, quieter face than a point's name, so it is not read as "point 3".
// COUNT is that face; clusterCount the figure; clusterWords what the marker
// says for itself, as its tooltip and at the head of its list ("3 points
// here"); CLUSTER_KEY its line in the map's key.
export const COUNT = { font: '600 11px system-ui, sans-serif', color: '#cbd5e1', radius: 11, wide: 13 };
export const clusterCount = (n) => `\u00d7${n}`;
export const clusterWords = (n) => `${n} points here`;
export const CLUSTER_KEY = 'Points close together: tap to pick one';
// drawCluster draws a cluster's marker at (x, y) on ctx: the ring in the
// state's color (dashed when not every point is measured), a dark disc, and
// the count. The map and the key's swatch both draw with it. It returns the
// ring's radius: two digits take a wider ring.
export function drawCluster(ctx, x, y, n, { color = '#ffb347', dashed = true } = {}) {
  const r = n > 9 ? COUNT.wide : COUNT.radius;
  ctx.strokeStyle = color; ctx.lineWidth = MARKER.width;
  if (dashed && ctx.setLineDash) ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(13, 14, 16, 0.92)'; ctx.fill(); ctx.stroke();
  if (dashed && ctx.setLineDash) ctx.setLineDash([]);
  ctx.fillStyle = COUNT.color; ctx.font = COUNT.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(clusterCount(n), x, y + 0.5);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  return r;
}

// clusterPoints groups points ({x, y, ...}) into markers that can be told
// apart: while any two markers' centers are closer than radius, the closest
// two become one, drawn at the middle of its points. Each cluster is
// { x, y, points }, points in the order they came. Every two markers that
// come out are therefore at least radius apart, and a row of evenly spaced
// points pairs up instead of running together into one marker.
export function clusterPoints(points, radius) {
  const cs = points.map((p) => ({ x: p.x, y: p.y, points: [p], i: 0 }));
  cs.forEach((c, i) => { c.i = i; });
  for (;;) {
    let best = null, bd = radius;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const d = Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y);
        if (d < bd) { bd = d; best = [i, j]; }
      }
    }
    if (!best) break;
    const [i, j] = best, a = cs[i], b = cs[j], n = a.points.length + b.points.length;
    cs[i] = { x: (a.x * a.points.length + b.x * b.points.length) / n, y: (a.y * a.points.length + b.y * b.points.length) / n, points: [...a.points, ...b.points], i: Math.min(a.i, b.i) };
    cs.splice(j, 1);
  }
  const order = new Map(points.map((p, i) => [p, i]));
  return cs.sort((a, b) => a.i - b.i).map(({ x, y, points: ps }) => ({ x, y, points: ps.sort((p, q) => order.get(p) - order.get(q)) }));
}

// overlapShare is how much of one marker's disc another covers, 0 to 1, for
// two discs of radius r whose centers are d apart.
export function overlapShare(d, r) {
  if (d >= 2 * r) return 0;
  if (d <= 0) return 1;
  const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
  return lens / (Math.PI * r * r);
}

// clusterAt is the cluster a tap at (x, y) lands on: the nearest whose
// marker is within reach px, or null. A cluster's marker is drawn at its
// middle, so that is what is aimed at.
export function clusterAt(clusters, x, y, reach) {
  let best = null, bd = reach;
  for (const c of clusters) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d <= bd) { bd = d; best = c; }
  }
  return best;
}

// clusterTitle is the tooltip for the map at (x, y) while calibrating: a
// cluster's own words when the pointer is on one with several points, else ''.
export function clusterTitle(clusters, x, y, coarse = false) {
  const hit = clusterAt(clusters, x, y, coarse ? CLUSTER.coarse : CLUSTER.fine);
  return hit && hit.points.length > 1 ? `${clusterWords(hit.points.length)}: ${coarse ? 'tap' : 'click'} to pick one` : '';
}

// tapsToReach is how many taps it takes to reach a point: one when its
// marker stands alone, two through its cluster's list.
export const tapsToReach = (cluster) => (cluster.points.length > 1 ? 2 : 1);

// ---------- points in words ----------

// runPoints lists a run's calibration points in order: every anchor that is
// not a run end, as { run, node, pixel, measured, n, of } where n counts
// from 1. nodes is the geometry's node list (anchors hold indexes into it).
export function runPoints(run, nodes) {
  const own = (run.anchors || []).filter((a) => a.source !== 'end');
  return own.map((a, i) => ({ run: run.id, node: nodes[a.node]?.id, pixel: a.pixel, measured: a.source === 'measured', n: i + 1, of: own.length }));
}

// pointWords names a point for a list: its run, and which of the run's
// points it is ("Shed eave, point 2 of 3").
export const pointWords = (runName, n, of) => `${runName}, point ${n} of ${of}`;

// nextTarget is the step Confirm moves on to: the next anchor that is not
// done after the current one in the progress list's order, wrapping; with no
// current anchor, the first one. null when every anchor is done (or the
// only one left is the current one). It mirrors the server's own choice.
export function nextTarget(progress, current) {
  const anchors = (progress || []).filter((it) => it.target?.kind === 'anchor');
  const n = anchors.length;
  if (!n) return null;
  const cur = current?.kind === 'anchor' ? anchors.findIndex((it) => it.target.run === current.run && it.target.node === current.node) : -1;
  for (let k = 1; k <= n; k++) {
    const it = anchors[(((cur + k) % n) + n) % n];
    if (!it.done && !(cur >= 0 && it === anchors[cur])) return it.target;
  }
  return null;
}

// ---------- keys ----------

// calKey is what a key press means while a calibration step is on, or null
// when it is not ours: − and + move the test pixel by one (Shift: by ten),
// Enter confirms, Escape asks to stop. e is the key event's { code, key,
// shiftKey, ctrlKey, metaKey, altKey }; at says where the focus is: field
// (typing in an input or a select), button (a button that is not a nudge).
// Typing is never taken from a field, and Enter on a button presses that
// button.
export function calKey(e, at = {}) {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape') return at.field ? null : { stop: true };
  if (at.field) return null;
  const step = e.shiftKey ? 10 : 1;
  if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_') return { nudge: -step };
  if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+' || e.key === '=') return { nudge: step };
  if (e.key === 'Enter') return at.button ? null : { confirm: true };
  return null;
}

// NUDGE_KEYS is the key shown on each nudge button, on a fine pointer.
export const NUDGE_KEYS = { '-10': 'Shift −', '-1': '−', 1: '+', 10: 'Shift +' };

// ---------- progress ----------

// progressBar is a count as a bar: the fill's width is done / total. words
// is the sentence beside it ("40 of 109 steps").
export function progressBar(done, total, { label = 'Calibration progress' } = {}) {
  const share = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const pct = Math.round(share * 1000) / 10;
  return {
    share, pct,
    words: `${done} of ${plural(total, 'step')}`,
    html: `<div class="cal-bar" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${pct}%"></i></div>`,
  };
}

// progressGroups sorts the progress list for reading at a glance: the runs
// with something left to do first ("To do", open), then the runs that are
// finished ("Done", folded to one line). Each group is { key, items, done,
// total }; key is the run id, or between for links and gaps. The order
// within each part is the list's own.
export function progressGroups(progress, between = 'Between runs') {
  const groups = new Map();
  for (const it of progress || []) {
    const k = (it.target && it.target.run) || between;
    if (!groups.has(k)) groups.set(k, { key: k, items: [], done: 0, total: 0 });
    const g = groups.get(k);
    g.items.push(it); g.total++; if (it.done) g.done++;
  }
  const all = [...groups.values()];
  const todo = all.filter((g) => g.done < g.total), done = all.filter((g) => g.done === g.total);
  const count = (list) => list.reduce((a, g) => a + g.items.length, 0);
  return {
    todo, done,
    todoWords: `${plural(todo.reduce((a, g) => a + g.total - g.done, 0), 'step')} left in ${plural(todo.length, 'run')}`,
    doneWords: `${plural(count(done), 'step')} in ${plural(done.length, 'run')}`,
  };
}
