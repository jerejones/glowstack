// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What can be selected on the map and how it nests: runs, areas and
// zones as pixel sets. Sets with the same pixels are one node (a run that
// is also an area); a node's parent is the smallest node holding all its
// pixels, or an area that includes it by name when the geometry says so
// (areas[].includes). Above everything is All, every pixel on a run.
// Tapping a run again climbs: run → area → larger area → zone → All →
// back to the run. Also: the pixel set of a layer target.
import { normRanges, countRanges, covers, humanize } from './util.js';

const RANK = { run: 0, area: 1, zone: 2, all: 3 };

// ALL is the layer target for every pixel on a run (layout.AreaAll).
export const ALL = 'all';

// buildTree indexes the geometry's runs, areas and zones.
export function buildTree(geo) {
  const px = geo.pixels, n = px.count;
  const runSets = geo.runs.map(() => []);
  let cur = -1, start = 0;
  for (let p = 0; p <= n; p++) {
    const r = p < n ? px.run[p] : -2;
    if (r === cur) continue;
    if (cur >= 0) runSets[cur].push([start, p - 1]);
    cur = r; start = p;
  }
  const areaById = new Map(geo.areas.map((a) => [a.id, a]));
  const items = [];
  geo.runs.forEach((r, i) => items.push({ kind: 'run', id: r.id, name: r.name, index: i, ranges: normRanges(runSets[i]) }));
  for (const a of geo.areas) items.push({ kind: 'area', id: a.id, name: a.name, internal: a.internal, ranges: normRanges(a.ranges) });
  for (const z of geo.zones) {
    const a = areaById.get(z.area);
    if (a) items.push({ kind: 'zone', id: z.id, area: z.area, name: z.name, ranges: normRanges(a.ranges) });
  }
  const allRanges = normRanges(runSets.flat());
  items.push({ kind: 'all', id: ALL, name: 'All', ranges: allRanges });

  const byKey = new Map();
  for (const it of items) {
    const count = countRanges(it.ranges);
    if (!count) continue;
    const key = JSON.stringify(it.ranges);
    if (!byKey.has(key)) byKey.set(key, { ranges: it.ranges, count, members: [], parent: null });
    byKey.get(key).members.push(it);
  }
  const nodes = [...byKey.values()];
  for (const nd of nodes) nd.members.sort((a, b) => RANK[a.kind] - RANK[b.kind]);

  const nodeOf = new Map(); // "kind:id" → node
  for (const nd of nodes) for (const m of nd.members) nodeOf.set(m.kind + ':' + m.id, nd);
  for (const nd of nodes) {
    let best = null;
    for (const o of nodes) {
      if (o === nd || o.count <= nd.count || (best && o.count >= best.count)) continue;
      if (covers(o.ranges, nd.ranges)) best = o;
    }
    nd.parent = best;
  }
  // An area that names another in its includes is a parent too, when
  // it is smaller than the one found by containment (or there was none).
  for (const a of geo.areas) {
    if (!Array.isArray(a.includes)) continue;
    const parent = nodeOf.get('area:' + a.id);
    for (const child of a.includes) {
      const nd = nodeOf.get('area:' + child);
      if (!nd || !parent || nd === parent || isAncestor(nd, parent)) continue;
      if (!nd.parent || parent.count < nd.parent.count) nd.parent = parent;
    }
  }

  // Every top node climbs to All (unless it is All: an area covering
  // every run shares All's node).
  const all = nodeOf.get('all:' + ALL) || null;
  for (const nd of nodes) if (nd !== all && !nd.parent && all) nd.parent = all;

  const runNode = geo.runs.map((r) => nodeOf.get('run:' + r.id) || null);
  return {
    nodes,
    runSets: runSets.map(normRanges),
    node: (kind, id) => nodeOf.get(kind + ':' + id) || null,
    runNode: (ri) => runNode[ri] || null,
    // chain is a node's ancestors and itself, top first.
    chain(nd) {
      const out = [];
      for (let x = nd; x; x = x.parent) out.unshift(x);
      return out;
    },
    // climb is what a tap on run ri selects when sel is selected: the
    // run, or the next node up when sel is the run or one of its
    // ancestors; past the top it starts over at the run.
    climb(ri, sel) {
      const base = runNode[ri];
      if (!base) return null;
      if (!sel) return base;
      for (let x = base; x; x = x.parent) if (x === sel) return sel.parent || base;
      return base;
    },
  };
}

function isAncestor(a, b) {
  for (let x = b; x; x = x.parent) if (x === a) return true;
  return false;
}

// name is how a node reads: its biggest member, with the others after.
export function nodeName(nd) {
  const top = nd.members[nd.members.length - 1];
  if (top.kind === 'all') return 'Everything'; // one word for it, wherever it's said
  return top.name || humanize(top.id);
}

// targetName says a layer target in words: the zone's name for its area,
// otherwise the id made readable.
export function targetName(geo, target) {
  if (target === ALL) return 'Everything';
  const i = target.indexOf(':');
  if (i > 0) {
    const kind = target.slice(0, i), id = target.slice(i + 1);
    const list = kind === 'run' ? geo.runs : kind === 'controller' ? geo.controllers : [];
    return list.find((x) => x.id === id)?.name || humanize(id);
  }
  const zone = geo.zones.find((z) => z.area === target);
  if (zone) return zone.name || humanize(zone.id);
  return geo.areas.find((a) => a.id === target)?.name || humanize(target);
}

// targetGroups is the list of places a look can go, by kind and by name.
// Runs, areas and zones with the same pixels are one row, under the
// biggest kind. query matches any of a row's ids and names; visibleRuns
// (a run index → shown array) drops runs the map isn't showing.
export function targetGroups(tree, { query = '', visibleRuns = null } = {}) {
  const want = query.trim().toLowerCase();
  const groups = [['all', 'Everything'], ['zone', 'Zones'], ['area', 'Areas'], ['run', 'Runs']].map(([kind, label]) => ({ kind, label, items: [] }));
  for (const nd of tree.nodes) {
    const top = nd.members[nd.members.length - 1];
    if (top.kind === 'run' && visibleRuns && !visibleRuns[top.index]) continue;
    if (nd.members.every((m) => m.internal)) continue;
    const label = nodeName(nd);
    const terms = [label, ...nd.members.flatMap((m) => [m.id, m.name || ''])].join(' ').toLowerCase();
    if (want && !terms.includes(want)) continue;
    groups.find((g) => g.kind === top.kind).items.push({ value: nodeTarget(nd), label });
  }
  for (const g of groups) g.items.sort((a, b) => a.label.localeCompare(b.label));
  return groups.filter((g) => g.items.length);
}
export function nodeKinds(nd) {
  return [...new Set(nd.members.map((m) => m.kind))].join(' · ');
}

// nodeTarget is the layer target that covers a node's pixels: an area,
// the zone's area, or the run as run:<id>.
export function nodeTarget(nd) {
  const area = nd.members.find((m) => m.kind === 'area');
  if (area) return area.id;
  const zone = nd.members.find((m) => m.kind === 'zone');
  if (zone) return zone.area;
  if (nd.members.some((m) => m.kind === 'all')) return ALL;
  return 'run:' + nd.members[0].id;
}

// targetRanges is the pixel set of a layer target: an area id,
// run:<id>, controller:<id> or all. null if the geometry doesn't know it.
export function targetRanges(geo, tree, target) {
  const i = target.indexOf(':');
  if (i > 0) {
    const kind = target.slice(0, i), id = target.slice(i + 1);
    if (kind === 'run') {
      const ri = geo.runs.findIndex((r) => r.id === id);
      return ri >= 0 ? tree.runSets[ri] : null;
    }
    if (kind === 'controller') {
      const c = geo.controllers.find((c) => c.id === id);
      return c && c.pixels ? [[c.base, c.base + c.pixels - 1]] : null;
    }
  }
  const a = geo.areas.find((a) => a.id === target);
  if (a) return normRanges(a.ranges);
  if (target === ALL) return tree.node('all', ALL)?.ranges || null; // an areas.yaml "all" wins, as in core
  return null;
}
