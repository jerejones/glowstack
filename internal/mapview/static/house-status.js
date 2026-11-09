// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { normRanges, covers } from './util.js';

const overlaps = (a, b) => normRanges(a).some(([lo, hi]) => normRanges(b).some(([x, y]) => lo <= y && x <= hi));

// blockingZones lists the zones at 0 brightness that keep a layer on ranges
// from showing.
function blockingZones(geo, brightness, ranges) {
  if (!brightness || !ranges) return [];
  const areas = new Map(geo.areas.map((a) => [a.id, a]));
  return geo.zones.filter((z) => brightness.zones?.[z.id] === 0 && areas.has(z.area) && overlaps(areas.get(z.area).ranges, ranges));
}

// darkZones is blockingZones by name.
export function darkZones(geo, brightness, ranges) { return blockingZones(geo, brightness, ranges).map((z) => z.name || z.id); }

// joined reads a list of names as a sentence: "A, B and C".
export const joined = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// darkMessage says why looks aren't showing. '' when nothing is dark.
export function darkMessage(names) {
  if (!names.length) return '';
  return `${joined(names)} ${names.length === 1 ? 'is' : 'are'} at 0% brightness, so nothing shows there.`;
}

// BRIGHTNESS_RULE says how the two brightnesses combine, as render.Compositor does.
export const BRIGHTNESS_RULE = "A look's brightness is multiplied by its zone's, so a look at 100% in a zone at 0% stays dark.";

// lightOutcome says whether looks on the given pixel ranges can be seen.
// layers holds one list of ranges per look. dark is 'none' (nothing shows),
// 'part' (some of it can't) or '' (all fine); zones names what's at 0%, and
// ids are those same zones.
// read says the lights' looks were read, so no layers means nothing is on them.
export function lightOutcome(geo, brightness, layers, read = false) {
  if (read && !layers.length) return { dark: 'none', zones: [], ids: [], message: 'No looks are on the lights.', empty: true };
  if (!brightness || !layers.length) return { dark: '', zones: [], ids: [], message: '' };
  if (brightness.master === 0) return { dark: 'none', zones: [], ids: [], message: 'Brightness is at 0%, so nothing shows. Raise it in Home Assistant.' };
  const blocking = [...new Set(layers.flatMap((r) => blockingZones(geo, brightness, r || [])))];
  const zones = blocking.map((z) => z.name || z.id), ids = blocking.map((z) => z.id);
  if (!zones.length) return { dark: '', zones, ids, message: '' };
  const off = normRanges(geo.zones.filter((z) => brightness.zones?.[z.id] === 0).flatMap((z) => geo.areas.find((a) => a.id === z.area)?.ranges || []));
  const none = layers.every((r) => r && covers(off, normRanges(r)));
  return { dark: none ? 'none' : 'part', zones, ids, message: darkMessage(zones) };
}

// turnOnLabel is the one-press fix's button: the zone, or how many.
export const turnOnLabel = (names) => (names.length === 1 ? `Turn on ${names[0]}` : `Turn on all ${names.length}`);

// onLevels is what turning on zones ids sends: only those still at 0, each to
// its remembered level. A level of 0 is never sent: this can only raise a zone.
export function onLevels(zones, ids) {
  return Object.fromEntries(zones.filter((z) => ids.includes(z.id) && z.brightness === 0 && z.on_level > 0).map((z) => [z.id, z.on_level]));
}

// turnOnZones raises zones ids and rereads the lights' state.
export async function turnOnZones(S, api, ids, names) {
  try {
    const { zones } = await api('/api/v1/zones');
    const levels = onLevels(zones, ids);
    if (Object.keys(levels).length) await api('/api/v1/brightness', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zones: levels }) });
    await S.status?.poll();
    await S.refresh();
    S.toast(`Turned on ${joined(names)}.`);
  } catch (e) { S.fail(names.length === 1 ? `turn on ${names[0]}` : 'turn on those zones', e); }
}

// zoneWarning says where the one 0% message on Looks goes and what it says,
// given lightOutcome for the lights and for the preview. On a phone with a
// preview the banner would be scrolled away, so it's the Apply bar's.
export function zoneWarning(lit, landing, { previewing, sheet }) {
  const dark = [lit, previewing ? landing : null].filter((o) => o?.dark);
  if (!dark.length) return null;
  const pairs = [...new Map(dark.flatMap((o) => o.ids.map((id, i) => [id, o.zones[i]])))];
  const ids = pairs.map((p) => p[0]), names = pairs.map((p) => p[1]);
  const message = names.length ? darkMessage(names) : dark[0].message;
  if (!previewing || (lit.dark && !sheet)) return { where: 'banner', ids, names, text: message };
  const how = names.length ? `${names.length === 1 ? 'zone' : 'zones'} at 0%` : 'brightness at 0%';
  return { where: 'bar', ids, names, text: `${landing.dark === 'part' ? 'Part of this stays' : 'This stays'} dark: ${how}` };
}

// Keep an unsuccessful read distinct from a confirmed empty live stack.
export function houseStatusMessage(status, count) {
  if (status === 'unavailable') return count
    ? 'Light status unavailable. Showing the last known looks.'
    : 'Light status unavailable.';
  if (status !== 'available') return 'Loading light status…';
  return count ? '' : 'Nothing on the lights.';
}

export function createHousePoll(S, api) {
  let generation = 0, settled = 0;
  return async function pollHouse() {
    const current = ++generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await api('/api/v1/layers', { signal: controller.signal });
      if (!Array.isArray(response?.layers)) throw new Error('Invalid light status');
      if (current < settled) return;
      settled = current;
      const { layers } = response;
      const changed = S.houseStatus !== 'available' || JSON.stringify(layers) !== JSON.stringify(S.house);
      S.house = layers;
      S.houseRead = true; // a reading exists, so a failed refresh has a last state to show
      S.houseStatus = 'available';
      if (changed) S.emit('house', layers);
    } catch (e) {
      if (current < settled) return;
      settled = current;
      S.houseStatus = 'unavailable';
      S.emit('house', S.house);
    } finally {
      clearTimeout(timeout);
    }
  };
}
