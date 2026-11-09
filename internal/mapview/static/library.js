// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The effect catalog, the preset library and the palettes, loaded
// together so that every panel's first paint has all three. A failed
// load is recorded in S.library, apart from a library that is really
// empty; what was loaded earlier is kept.

const SOURCES = {
  catalog: ['/api/v1/effects', (r) => (Array.isArray(r?.effects) ? r : null)],
  presets: ['/api/v1/presets', (r) => (Array.isArray(r?.presets) ? r.presets : null)],
  palettes: ['/api/v1/palettes', (r) => (Array.isArray(r?.palettes) ? r.palettes : null)],
};

export function createLibrary(S, api) {
  S.catalog = S.catalog || { common: [], effects: [] };
  S.presets = S.presets || [];
  S.palettes = S.palettes || [];
  S.library = { catalog: 'loading', presets: 'loading', palettes: 'loading' };
  return async function loadLibrary() {
    await Promise.all(Object.entries(SOURCES).map(async ([key, [path, read]]) => {
      try {
        const value = read(await api(path));
        if (value === null) throw new Error('unexpected reply');
        S[key] = value;
        S.library[key] = 'ready';
      } catch (e) {
        if (S.library[key] !== 'ready') S.library[key] = 'failed';
      }
    }));
  };
}
