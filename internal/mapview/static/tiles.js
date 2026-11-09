// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Effect tiles that show motion. The server draws each effect on a short
// virtual strip, one frame per row of a sprite (/api/v1/effects/{id}/
// strip.png, and a preset's own settings at /api/v1/presets/{id}/
// strip.png). A tile shows one row and steps through them at the sprite's
// rate: every tile reads the row from one variable on its container, so
// a library of tiles costs one style change a frame. The animation pauses while
// a preview is being shown (the map is the preview), when the tiles are
// off screen or the page is hidden, and under prefers-reduced-motion,
// where the tiles hold a frame from the middle of the sequence.

export const FRAMES = 30; // rows in a sprite: 3 s at FPS
export const FPS = 10;
export const MID = 15; // the still frame

// MOTION says in a few words what each built-in effect does on the lights
// at its defaults, under its name on a tile. Bands and Gradient hold still
// until given a speed, so their words don't promise motion.
export const MOTION = {
  solid: 'Steady',
  breathe: 'Fades in and out',
  bands: 'Bands of color',
  gradient: 'Palette gradient',
  sparkle: 'Random sparkles',
  chase: 'Pulses run along',
  noise: 'Drifting noise',
  burst: 'Bursts outward',
  glitter: 'Sparkles over a gradient',
  'spatial-field': 'Sweeps across',
};

// effectMotion is a tile's subtitle for effect e: its motion, or for a
// composite from config, its parts in words.
export function effectMotion(e, fallback) {
  if (MOTION[e.id]) return MOTION[e.id];
  return fallback ? fallback(e) : 'Animated effect';
}

// spriteURL is the sprite for an effect at its defaults, or a preset with
// its settings (v changes with the settings, so an edit is not served from
// the browser's cache).
export function spriteURL(kind, id, params) {
  const base = `/api/v1/${kind === 'preset' ? 'presets' : 'effects'}/${encodeURIComponent(id)}/strip.png`;
  return kind === 'preset' ? `${base}?v=${hashParams(params)}` : base;
}

export function hashParams(params) {
  const s = JSON.stringify(params || {});
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// spriteStyle is a strip's background: the sprite, sized so one row fills
// the strip, over the drawn fallback, which shows while the sprite loads
// or when there is none (a show that only draws on the site's areas).
export function spriteStyle(url, fallback) {
  // A plain color is not an image: as a layer it is a flat gradient.
  const under = /gradient\(/.test(fallback) ? fallback : `linear-gradient(${fallback}, ${fallback})`;
  return `background-image: url(${url}), ${under}; background-size: 100% ${FRAMES * 100}%, auto; background-position: 0 calc(var(--tile-row, ${MID}) / ${FRAMES - 1} * 100%), 0 0; background-repeat: no-repeat`;
}

// tileState says whether the tiles step ('running'), hold where they are
// ('paused'), or hold the middle frame ('still', reduced motion).
export function tileState({ reduced, hidden, visible, previewing }) {
  if (reduced) return 'still';
  if (hidden || !visible || previewing) return 'paused';
  return 'running';
}

// createTiles runs the one clock the tiles share. watch(el) tells it which
// containers' visibility matter.
export function createTiles(S, doc = document) {
  const boxes = new Set(); // the containers whose tiles step
  const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener() {} };
  const seen = new Map(); // container → on screen?
  let timer = null, row = MID;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { for (const e of es) seen.set(e.target, e.isIntersecting); sync(); }) : null;
  const state = () => tileState({ reduced: reduced.matches, hidden: doc.hidden, visible: !io || [...seen.values()].some(Boolean), previewing: !!(S.preview && S.preview.layers && S.preview.layers.length) });
  const show = (r) => { for (const b of boxes) b.style.setProperty('--tile-row', r); };
  function step() { row = (row + 1) % FRAMES; show(row); }
  function sync() {
    const st = state();
    if (st === 'running' && !timer) timer = setInterval(step, 1000 / FPS);
    else if (st !== 'running' && timer) { clearInterval(timer); timer = null; }
    if (st === 'still') { row = MID; show(MID); }
  }
  S.on('preview', sync);
  doc.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  sync();
  return { watch: (el) => { boxes.add(el); el.style.setProperty('--tile-row', row); if (io) io.observe(el); else sync(); }, sync, state };
}
