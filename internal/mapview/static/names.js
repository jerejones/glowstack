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

// allNames is [id, name] for every id a server message can mention, the
// longest id first so that "shed-eave-mid" wins over "shed-eave".
function allNames(g) {
  const pairs = [...(g.runs || []), ...(g.nodes || []), ...(g.controllers || [])].filter((x) => x.name).map((x) => [x.id, x.name]);
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

// warningSummary turns one layout warning into plain words. text is the
// server's "file:line: message". summary is what to read, detail the
// original for the disclosure, fix is {label, tab} or {label, run}, or null.
export function warningSummary(g, text) {
  const m = /^(\S+?:\d+): ([\s\S]*)$/.exec(text);
  const body = m ? m[2] : text;
  const run = /^run ([^\s:]+):/.exec(body)?.[1] || (/^(?:scene \S+: )?run "([^"]+)"/.exec(body)?.[1]) || null;
  const known = run && (g.runs || []).some((r) => r.id === run);
  const fix = known ? { label: 'Calibrate this run', run } : { label: 'Open Setup', tab: 'setup' };
  let summary;
  const density = /^run \S+: (\S+)–(\S+) has (\d+) pixels where its drawn length implies about (\d+)/.exec(body);
  if (density) summary = `Between ${nodeDisplay(g, density[1])} and ${nodeDisplay(g, density[2])} on ${runName(g, run)}, the lights are spaced ${+density[3] > +density[4] ? 'tighter' : 'looser'} than drawn.`;
  else if (/^run \S+: drawing (starts|ends) at/.test(body)) summary = `The drawing of ${runName(g, run)} doesn't match where its lights ${/starts/.test(body) ? 'start' : 'end'}.`;
  else if (/measurements? in anchors\.yaml w/.test(body)) summary = `Some saved measurements ${known ? `on ${runName(g, run)} ` : ''}no longer match the layout and need measuring again.`;
  else if (/pixels .* are in no run/.test(body)) summary = `Some lights on ${controllerName(g, /^controller (\S+):/.exec(body)?.[1] || '')} aren't part of any run.`;
  else if (/^scene \S+: run "[^"]+" isn't used/.test(body)) return { summary: `The model draws ${humanize(run)}, but no run uses it.`, detail: text, fix: { label: 'Open Setup', tab: 'setup' } };
  else summary = humanText(g, body.replace(/^flow \S+: /, '')).replace(/^./, (c) => c.toUpperCase());
  return { summary, detail: text, fix };
}
