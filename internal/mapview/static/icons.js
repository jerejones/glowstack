// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The page's one icon set, drawn by hand for this project: 16 px, inline
// SVG, one stroke weight. Icons take the text color. An icon-only control
// needs its own aria-label and title; the svg itself is hidden from
// screen readers.

const PATHS = {
  looks: 'M6.5 2l1.4 3.6L11.5 7 7.9 8.4 6.5 12 5.1 8.4 1.5 7l3.6-1.4zM12.5 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  presets: 'M4 2.5h8a.5.5 0 0 1 .5.5v10.5L8 11l-4.5 2.5V3a.5.5 0 0 1 .5-.5z',
  setup: 'M2 4.5h6.5M12 4.5h2M2 11.5h2M7.5 11.5H14M10.25 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5.75 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  status: 'M1.5 8.5h3l2-5 3 9 2-4h3',
  chevronUp: 'M3.5 10.5L8 6l4.5 4.5',
  chevronDown: 'M3.5 6L8 10.5 12.5 6',
  chevronLeft: 'M10.5 3.5L6 8l4.5 4.5',
  chevronRight: 'M6 3.5L10.5 8 6 12.5',
  close: 'M4 4l8 8M12 4l-8 8',
  play: 'M5 3l8 5-8 5z',
  pause: 'M5.5 3v10M10.5 3v10',
  stepBack: 'M12.5 3L6.5 8l6 5zM3.5 3v10',
  stepForward: 'M3.5 3l6 5-6 5zM12.5 3v10',
  check: 'M3 8.5l3.2 3.2L13 5',
  sun: 'M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1',
  alert: 'M8 2.5l6 10.5H2zM8 7v3M8 11.8v.2',
  plus: 'M8 3v10M3 8h10',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  edit: 'M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3zM9.5 4l2.5 2.5',
  copy: 'M5.5 5.5h7.5v7.5H5.5zM10.5 5.5v-3h-8v8h3',
  trash: 'M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9',
  minus: 'M3 8h10',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  pin: 'M9.5 2L14 6.5 12.5 7.5 9.5 11 10 13 9 14 2 7 3 6 5 6.5 8.5 3.5zM5.5 10.5l-3 3',
};
const FILLED = new Set(['pinFilled', 'play']);

// icon is the markup for a named icon. fooFilled is foo, filled in.
export function icon(name) {
  const d = PATHS[name.replace(/Filled$/, '')];
  if (!d) throw new Error('no icon ' + name);
  return `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" fill="${FILLED.has(name) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

// fillIcons draws every [data-icon] element under root.
export function fillIcons(root) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
}
