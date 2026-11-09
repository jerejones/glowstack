// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Swatches that show a look. The server draws each effect on a short
// virtual strip, one frame per row of a sprite (/api/v1/effects/{id}/
// strip.png, and a preset's own settings at /api/v1/presets/{id}/
// strip.png): a picture of position by time. A swatch shows that picture,
// not one row of it (B3): a block whose bottom edge is the current frame at
// full strength, with the TRAIL - 1 frames before it rising above and
// fading toward the top. So a still swatch already tells the effects
// apart: a chase is slanted streaks, sparkle is scattered dots at different
// heights, breathe is horizontal bands of changing brightness, a gradient
// is steady vertical color and a solid is a flat field.
//
// It animates by scrolling the trail: every swatch reads the current frame
// from one variable on its container, so a library of swatches costs one
// style change a frame. While a preview is being shown (the map is the
// preview, and busy) they run at half rate so they do not compete with it.
// They pause when off screen or when the page is hidden, and under
// prefers-reduced-motion they hold the resting trail: the server turns each
// sprite so its fullest frame (the most lit pixels) is at row MID, so a
// still swatch has the look along its bottom edge, never a dark gap.

export const FRAMES = 30; // rows in a sprite: 3 s at FPS
export const FPS = 10;
export const SLOW_FPS = 5; // while a preview is up
export const MID = 15; // the resting frame
export const TRAIL = 30; // frames a swatch shows: the current one and the 29 before it, the sprite's whole 3 s, so a slow look (Breathe) shows a full swing
// FADE dims the trail toward the top of the swatch, over the sprite: the
// current frame, at the bottom, is at full strength.
export const FADE = 'linear-gradient(to bottom, rgba(13, 14, 16, 0.5), rgba(13, 14, 16, 0) 80%)';

// MOTION says in a few words what each built-in effect does on the lights
// at its defaults, under its name on a card: short enough to fit a 176 px
// card whole. Bands and Gradient
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
// strip's length follows the look (B139), 3 since a sparse look is drawn
// denser for its swatch (B3).
export const SPRITE_REV = 3;

export function hashParams(params) {
  const s = JSON.stringify(params || {});
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// spriteStyle is a swatch's background: the fade, over the sprite scrolled
// so the current frame's row is the swatch's bottom edge and TRAIL rows
// fill its height, over the drawn fallback, which shows while the sprite
// loads or when there is none (a show that only draws on the site's
// areas). The swatch's height is --swatch-h (ui.css); a row is 1/TRAIL of
// it, and the sprite repeats down the swatch so the trail wraps round the
// sprite's cycle.
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
  return `background-image: ${FADE}, url(${url}), ${under}; background-size: auto, 100% ${FRAMES / TRAIL * 100}%, auto; background-position: 0 0, 0 ${trailOffset()}, 0 0; background-repeat: no-repeat, repeat-y, no-repeat${tint}`;
}

// trailOffset is the sprite's vertical position, as CSS: row --tile-row at
// the swatch's bottom edge, so the row TRAIL - 1 before it is at the top.
export const trailOffset = () => `calc(var(--swatch-h, 30px) * (${TRAIL - 1} - var(--tile-row, ${MID})) / ${TRAIL})`;

// trailRows is the sprite rows a swatch shows at frame `row`, top to
// bottom: the oldest first, the current frame last.
export function trailRows(row) {
  return Array.from({ length: TRAIL }, (_, i) => (((row - (TRAIL - 1) + i) % FRAMES) + FRAMES) % FRAMES);
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
