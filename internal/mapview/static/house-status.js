// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { normRanges, covers } from './util.js';

const overlaps = (a, b) => normRanges(a).some(([lo, hi]) => normRanges(b).some(([x, y]) => lo <= y && x <= hi));

// darkZones lists the zones at 0 brightness that keep a layer on ranges
// from showing, by name.
export function darkZones(geo, brightness, ranges) {
  if (!brightness || !ranges) return [];
  const areas = new Map(geo.areas.map((a) => [a.id, a]));
  return geo.zones.filter((z) => brightness.zones?.[z.id] === 0 && areas.has(z.area) && overlaps(areas.get(z.area).ranges, ranges)).map((z) => z.name || z.id);
}

// joined reads a list of names as a sentence: "A, B and C".
export const joined = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// darkMessage says why applied looks aren't showing: a brightness of 0 is
// valid data (Home Assistant sets zone brightness), so it needs naming, not
// fixing here. '' when nothing is dark.
export function darkMessage(names) {
  if (!names.length) return '';
  return `${joined(names)} ${names.length === 1 ? 'is' : 'are'} at 0% brightness, so nothing shows there. Raise the brightness in Home Assistant.`;
}

// lightOutcome says whether looks on the given pixel ranges can be seen.
// layers holds one list of ranges per look. dark is 'none' (nothing shows),
// 'part' (some of it can't) or '' (all fine); zones names what's at 0%.
export function lightOutcome(geo, brightness, layers) {
  if (!brightness || !layers.length) return { dark: '', zones: [], message: '' };
  if (brightness.master === 0) return { dark: 'none', zones: [], message: 'Brightness is at 0%, so nothing shows. Raise it in Home Assistant.' };
  const zones = [...new Set(layers.flatMap((r) => darkZones(geo, brightness, r || [])))];
  if (!zones.length) return { dark: '', zones, message: '' };
  const off = normRanges(geo.zones.filter((z) => brightness.zones?.[z.id] === 0).flatMap((z) => geo.areas.find((a) => a.id === z.area)?.ranges || []));
  const none = layers.every((r) => r && covers(off, normRanges(r)));
  return { dark: none ? 'none' : 'part', zones, message: darkMessage(zones) };
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
