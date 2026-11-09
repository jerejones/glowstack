// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Effect tiles that show motion. The server draws each effect on a short
// virtual strip, one frame per row of a sprite (/api/v1/effects/{id}/
// strip.png, and a preset's own settings at /api/v1/presets/{id}/
// strip.png). A tile shows one row and steps through them at the sprite's
// rate: every tile reads the row from one variable on its container, so
// a library of tiles costs one style change a frame. While a preview is
// being shown (the map is the preview, and busy) the tiles run at half
// rate so they do not compete with it. They pause when off screen or when
// the page is hidden, and under prefers-reduced-motion they hold the
// resting frame: the server turns each sprite so its fullest frame (the
// most lit pixels) is at row MID, so a still tile shows the look, never a
// dark gap in its cycle.

export const FRAMES = 30; // rows in a sprite: 3 s at FPS
export const FPS = 10;
export const SLOW_FPS = 5; // while a preview is up
export const MID = 15; // the resting frame

// MOTION says in a few words what each built-in effect does on the lights
// at its defaults, under its name on a tile, after the word Effect (B2):
// short enough that the two fit a 176 px card whole. Bands and Gradient
// hold still until given a speed, so their words don't promise motion.
export const MOTION = {
  solid: 'Steady',
  breathe: 'Fades in and out',
  bands: 'Bands of color',
  gradient: 'Palette gradient',
  sparkle: 'Sparkles',
  chase: 'Pulses run along',
  noise: 'Drifting noise',
  burst: 'Bursts outward',
  glitter: 'Sparkly gradient',
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
// the browser's cache). A show (effect.show: it draws on the site's own
// areas) has no sprite, and asking would only be a 404: the tile keeps its
// drawn strip.
export function spriteURL(kind, id, params, effect) {
  if (effect && effect.show) return '';
  const base = `/api/v1/${kind === 'preset' ? 'presets' : 'effects'}/${encodeURIComponent(id)}/strip.png`;
  return kind === 'preset' ? `${base}?v=${hashParams(params)}&r=${SPRITE_REV}` : `${base}?r=${SPRITE_REV}`;
}

// SPRITE_REV changes when the renderer draws sprites differently, so the
// browser's day-long cache of the old pictures is not shown: 2 since the
// strip's length follows the look (B139).
export const SPRITE_REV = 2;

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
  // The drawn strip is a background shorthand: image layers, perhaps with
  // a plain color last (Sparkle's specks over white). The color is not an
  // image, and one in the image list would void the whole declaration, so
  // it goes to background-color; a strip that is only a color becomes a
  // flat gradient layer.
  const layers = splitLayers(fallback);
  const color = layers.length && !isImage(layers[layers.length - 1]) ? layers.pop() : '';
  const under = layers.length ? layers.join(', ') : `linear-gradient(${color}, ${color})`;
  const tint = color && layers.length ? `; background-color: ${color}` : '';
  if (!url) return `background-image: ${under}; background-size: auto; background-position: 0 0; background-repeat: no-repeat${tint}`;
  return `background-image: url(${url}), ${under}; background-size: 100% ${FRAMES * 100}%, auto; background-position: 0 calc(var(--tile-row, ${MID}) / ${FRAMES - 1} * 100%), 0 0; background-repeat: no-repeat${tint}`;
}

// isImage says whether a background layer is an image (a gradient or url)
// rather than a color.
const isImage = (layer) => /^(url|[a-z-]*gradient)\(/.test(layer);

// splitLayers splits a background value at the commas outside parentheses.
export function splitLayers(value) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
  }
  const last = value.slice(start).trim();
  if (last) out.push(last);
  return out;
}

// DARK is how far off black (0–255, the brightest channel) a sprite pixel
// must be to count as lit.
export const DARK = 8;

// spriteLit says whether a decoded sprite (RGBA bytes) shows anything.
// Every frame within DARK of black is a black bar, which the drawn strip
// beats: a renderer that drew nothing where the strip's pixels lie. Fewer
// lit pixels than half the frames counts as nothing too (a stray dot), while
// a sparse sparkle, lit somewhere in most frames, is the effect as it is.
export function spriteLit(data, width, frames) {
  let lit = 0;
  for (let i = 0; i + 3 < data.length; i += 4) if (data[i] > DARK || data[i + 1] > DARK || data[i + 2] > DARK) lit++;
  return lit >= frames / 2;
}

// guardSprite checks a tile's sprite once it has loaded and drops the sprite
// layer, leaving the drawn strip, when it shows nothing. Sprites are small
// (60 px by 30 rows), so the check is one tiny canvas read per distinct URL;
// the answer is kept so the same sprite is checked once per page.
const litByURL = new Map();
export function guardSprite(el, url, fallback, doc = globalThis.document) {
  if (!url || typeof Image !== 'function') return;
  const drop = () => { el.style.cssText = spriteStyle('', fallback); };
  const known = litByURL.get(url);
  if (known === false) { drop(); return; }
  if (known === true) return;
  const img = new Image();
  img.onload = () => {
    try {
      const c = doc.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const lit = spriteLit(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      litByURL.set(url, lit);
      if (!lit) drop();
    } catch { /* a canvas that can't be read says nothing; keep the sprite */ }
  };
  img.src = url;
}

// tileState says whether the tiles step ('running'), step at half rate
// behind a preview ('slow'), hold where they are ('paused'), or hold the
// resting frame ('still', reduced motion).
export function tileState({ reduced, hidden, visible, previewing }) {
  if (reduced) return 'still';
  if (hidden || !visible) return 'paused';
  return previewing ? 'slow' : 'running';
}

// rateOf is the frames per second of a tile state; 0 holds.
export const rateOf = (state) => (state === 'running' ? FPS : state === 'slow' ? SLOW_FPS : 0);

// createTiles runs the one clock the tiles share. watch(el) tells it which
// containers' visibility matter.
export function createTiles(S, doc = document) {
  const boxes = new Set(); // the containers whose tiles step
  const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener() {} };
  const seen = new Map(); // container → on screen?
  let timer = null, rate = 0, row = MID;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { for (const e of es) seen.set(e.target, e.isIntersecting); sync(); }) : null;
  const state = () => tileState({ reduced: reduced.matches, hidden: doc.hidden, visible: !io || [...seen.values()].some(Boolean), previewing: !!(S.preview && S.preview.layers && S.preview.layers.length) });
  const show = (r) => { for (const b of boxes) b.style.setProperty('--tile-row', r); };
  function step() { row = (row + 1) % FRAMES; show(row); }
  function sync() {
    const st = state(), fps = rateOf(st);
    if (fps !== rate) {
      if (timer) clearInterval(timer);
      timer = fps ? setInterval(step, 1000 / fps) : null;
      rate = fps;
    }
    if (st === 'still') { row = MID; show(MID); }
  }
  S.on('preview', sync);
  doc.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  sync();
  return { watch: (el) => { boxes.add(el); el.style.setProperty('--tile-row', row); if (io) io.observe(el); else sync(); }, sync, state, rate: () => rate };
}
