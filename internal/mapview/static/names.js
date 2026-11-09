// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Names as the server sends them with the geometry, for everything a
// person reads. Raw ids stay in Details. humanText rewrites ids inside the
// server's free-text messages; it only ever changes what is displayed.
import { humanize } from './util.js';

const byId = (list, id) => (list || []).find((x) => x.id === id);

export const runName = (g, id) => byId(g.runs, id)?.name || humanize(id);
export const nodeDisplay = (g, id) => byId(g.nodes, id)?.name || humanize(id);
export const controllerName = (g, id) => byId(g.controllers, id)?.name || humanize(id);
export const areaName = (g, id) => byId(g.areas, id)?.name || humanize(id);
export const zoneName = (g, id) => byId(g.zones, id)?.name || humanize(id);

// controllerLabel is what a controller's map label reads: its name, then
// its location with whatever the name already says left out. A location
// listing several things loses the whole phrase, not a word out of it, so
// what's left never ends mid-phrase or on a comma.
export function controllerLabel(name, location) {
  const bare = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const said = new Set(String(name).split(/\s+/).map(bare));
  const phrases = String(location || '').split(/\s*[,;]\s*/).filter(Boolean);
  const rest = phrases.flatMap((p) => {
    const words = p.split(/\s+/).filter(Boolean), kept = words.filter((w) => !said.has(bare(w)));
    if (kept.length === words.length) return [p];
    return phrases.length > 1 || !kept.length ? [] : [kept.join(' ')];
  });
  return rest.length ? `${name} · ${rest.join(', ')}` : name;
}

// The model's layer names that say nothing on their own.
const PART_WORDS = { detail: 'Fine detail', site: 'Site' };

// modelPartLabel is how a part of the 3-D model reads: "walls-lines" of
// kind lines is "Walls outline", not its two internal words.
export function modelPartLabel(name, kind) {
  const part = String(name).replace(/[-_. ]+(lines|faces)$/i, '');
  const base = PART_WORDS[part.toLowerCase()] || humanize(part);
  return kind === 'lines' ? `${base} outline` : kind === 'faces' ? `${base} surfaces` : base;
}

// allNames is [id, name] for every id a server message can mention, the
// longest id first so that "shed-eave-mid" wins over "shed-eave". An id with
// no name of its own still reads as words.
function allNames(g) {
  const pairs = [...(g.runs || []), ...(g.nodes || []), ...(g.controllers || [])].map((x) => [x.id, x.name || humanize(x.id)]);
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// humanText puts names in place of whole ids in text from the server.
export function humanText(g, text) {
  let out = String(text ?? '');
  for (const [id, name] of allNames(g)) {
    out = out.replace(new RegExp(`(^|[^\\w-])"?${quote(id)}"?(?![\\w-])`, 'g'), (m, lead) => lead + name);
  }
  return out;
}

// Where a warning came from, for someone who has never opened these files.
const FILES = {
  'anchors.yaml': 'The saved measurements', 'layout.yaml': 'The layout', 'areas.yaml': 'The areas', 'controllers.yaml': 'The controller list',
  'mappings.yaml': 'The wiring', 'palettes.yaml': 'The palettes', 'presets.yaml': 'The presets', 'glowstack.yaml': 'The settings',
};

// plainWhere reads "anchors.yaml:22" as words.
function plainWhere(at) {
  const [file, line] = at.split(':');
  return `${FILES[file.split('/').pop()] || 'The configuration'}, line ${line}`;
}

const RETRY = { label: 'Retry', retry: true };

// warningSummary turns one layout warning into plain words. text is the
// server's "file:line: message". summary is what to read, plain the disclosure
// in words, detail the original behind it, fix is {label, tab} or {label, run}, or null.
export function warningSummary(g, text) {
  const m = /^(\S+?:\d+): ([\s\S]*)$/.exec(text);
  const body = m ? m[2] : text;
  const run = /^run ([^\s:]+):/.exec(body)?.[1] || (/^(?:scene \S+: )?run "([^"]+)"/.exec(body)?.[1]) || null;
  const known = run && (g.runs || []).some((r) => r.id === run);
  const plain = `${m ? `${plainWhere(m[1])}: ` : ''}${humanText(g, body)}`;
  // Without the map, Setup and calibration can't work: the way on is the map.
  const fix = g.mapless ? RETRY : known ? { label: 'Calibrate this run', run } : { label: 'Open Setup', tab: 'setup' };
  let summary;
  const density = /^run \S+: (\S+)–(\S+) has (\d+) pixels where its drawn length implies about (\d+)/.exec(body);
  if (density) summary = `${runName(g, run)}: the lights are spaced ${+density[3] > +density[4] ? 'tighter' : 'looser'} than drawn.`; // the points are in Details
  else if (/^run \S+: drawing (starts|ends) at/.test(body)) summary = `${runName(g, run)}: the drawing doesn't match where its lights ${/starts/.test(body) ? 'start' : 'end'}.`;
  else if (/measurements? in anchors\.yaml w/.test(body)) summary = known ? `${runName(g, run)}: some saved measurements no longer match the layout and need measuring again.` : 'Some saved measurements no longer match the layout and need measuring again.';
  else if (/pixels .* are in no run/.test(body)) summary = `Some lights on ${controllerName(g, /^controller (\S+):/.exec(body)?.[1] || '')} aren't part of any run.`;
  else if (/^scene \S+: run "[^"]+" isn't used/.test(body)) return { summary: `The model draws ${humanize(run)}, but no run uses it.`, plain, detail: text, fix: g.mapless ? RETRY : { label: 'Open Setup', tab: 'setup' } };
  else summary = humanText(g, body.replace(/^flow \S+: /, '').replace(/^run (\S+): /, (_, id) => `${runName(g, id)}: `)).replace(/^./, (c) => c.toUpperCase());
  return { summary, plain, detail: text, fix, kind: density ? 'spacing' : undefined };
}
