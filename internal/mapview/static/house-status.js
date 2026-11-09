// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { normRanges } from './util.js';

const overlaps = (a, b) => normRanges(a).some(([lo, hi]) => normRanges(b).some(([x, y]) => lo <= y && x <= hi));

// darkZones lists the zones at 0 brightness that keep a layer on ranges
// from showing, by name.
export function darkZones(geo, brightness, ranges) {
  if (!brightness || !ranges) return [];
  const areas = new Map(geo.areas.map((a) => [a.id, a]));
  return geo.zones.filter((z) => brightness.zones?.[z.id] === 0 && areas.has(z.area) && overlaps(areas.get(z.area).ranges, ranges)).map((z) => z.name || z.id);
}

// joined reads a list of names as a sentence: "A, B and C".
const joined = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// darkMessage says why applied looks aren't showing: a brightness of 0 is
// valid data (Home Assistant sets zone brightness), so it needs naming, not
// fixing here. '' when nothing is dark.
export function darkMessage(names) {
  if (!names.length) return '';
  return `${joined(names)} ${names.length === 1 ? 'is' : 'are'} at 0% brightness, so nothing shows there. Raise the brightness in Home Assistant.`;
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
