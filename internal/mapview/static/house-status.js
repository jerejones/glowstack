// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
