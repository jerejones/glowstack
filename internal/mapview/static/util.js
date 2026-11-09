// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Shared helpers for the live map, with no state of their own: DOM and
// formatting, the JSON API, colors (ramps, accents, "#rrggbb/ww"),
// quantities with units, and pixel-id range sets. Nothing here touches
// the page when imported, so tests can load it.

export const $ = (id) => document.getElementById(id);
// outputName is how the page names a controller output: "output 3 (GPIO 2)".
export const outputName = (o) => `output ${o.output}${o.gpio != null ? ` (GPIO ${o.gpio})` : ''}`;
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : (+v).toFixed(d);
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// press shows a toggle button's state, to the eye and to screen readers.
export function press(b, on) {
  b.classList.toggle('on', !!on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
}
// plural is a count with its noun: "1 output", "2 outputs".
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
// humanize turns an id or parameter key into words: "sparkle.fade_in" is
// "Sparkle fade in"; "colors.0" is "Color 1". The server's internal/names
// follows the same rules.
export function humanize(id) {
  const s = String(id).replace(/\.(\d+)/g, (_, i) => ` ${+i + 1}`).replace(/[._-]+/g, ' ').trim().replace(/\bcolors (?=\d)/, 'color ').replace(/\b(ne|nw|se|sw|n|s|e|w)\b/gi, (c) => ({ n: 'north', s: 'south', e: 'east', w: 'west' }[c.toLowerCase()] || c.toUpperCase()));
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ---------- API ----------

export const NOT_RESPONDING = "Glowstack isn't responding.";

// failure says what went wrong with an action, for a person: the
// server's own message when it sent one, or what could not be done when
// nothing answered. doing reads after "Could not": "apply the look".
export function failure(doing, e) {
  return e && e.network ? `Could not ${doing}. ${NOT_RESPONDING}` : (e && e.message) || `Could not ${doing}.`;
}

// api fetches JSON. A failure throws an Error carrying the server's
// message, its file:line details (errors) and the status; when nothing
// answered, the Error has network set and status 0.
export async function api(path, opts) {
  let r;
  try { r = await fetch(path, opts); } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error(NOT_RESPONDING);
    err.network = true;
    err.status = 0;
    err.details = [];
    throw err;
  }
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  if (!r.ok) {
    const err = new Error((body && body.error) || text || r.statusText);
    err.status = r.status;
    err.details = (body && body.errors) || [];
    throw err;
  }
  return body;
}
const send = (method) => (path, body) => api(path, body === undefined ? { method } : {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export const post = send('POST');
export const patch = send('PATCH');
export const del = send('DELETE');

// ---------- per-device settings ----------

export function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}
export function save(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* private mode */ }
}

// ---------- colors ----------

export const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
export function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
// ramp is the flow-position ramp, violet to red.
export function ramp(t) {
  t = clamp(t, 0, 1);
  return hsl(260 - 260 * t, 0.85, 0.55);
}
// SPACING_FULL is where the spacing ramp reaches full color: the layout's
// DensityTolerance, so that a stretch Status flags is unmistakably off.
export const SPACING_FULL = 1.25;
// spacingColor is diverging: blue packed tighter than drawn, white as
// drawn, red looser; full strength at SPACING_FULL either way.
export function spacingColor(s) {
  if (s === null || !(s > 0)) return [70, 70, 70];
  const x = clamp(Math.log2(s) / Math.log2(SPACING_FULL), -1, 1);
  const w = 235;
  if (x < 0) return [Math.round(w + (40 - w) * -x), Math.round(w + (110 - w) * -x), 255];
  return [255, Math.round(w + (60 - w) * x), Math.round(w + (50 - w) * x)];
}
export const PALETTE = [[255, 179, 71], [93, 220, 138], [96, 165, 250], [244, 114, 182], [250, 204, 21], [167, 139, 250], [45, 212, 191], [251, 113, 133]];
// nthColor is the palette, then golden-angle hues past its end.
export const nthColor = (i) => i < PALETTE.length ? PALETTE[i] : hsl((i * 137.508) % 360, 0.75, 0.6);

// parseColor reads "#rrggbb" or "#rrggbb/ww" (W is the strips' warm
// white). null if it's neither.
export function parseColor(s) {
  const m = /^#([0-9a-f]{6})(?:\/([0-9a-f]{2}))?$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, w: m[2] ? parseInt(m[2], 16) : 0 };
}
export const formatColor = (c) => hex(c.r, c.g, c.b) + (c.w ? '/' + c.w.toString(16).padStart(2, '0') : '');
// WARM is roughly how the strips' warm white looks on a screen.
export const WARM = [255, 196, 128];
// displayColor is a CSS color for "#rrggbb/ww": W added as warm white.
export function displayColor(s) {
  const c = typeof s === 'string' ? parseColor(s) : s;
  if (!c) return '#555';
  const k = c.w / 255;
  return `rgb(${[c.r, c.g, c.b].map((v, i) => Math.round(Math.min(255, v + WARM[i] * k))).join(',')})`;
}

// Each stop changes only this channel. Intermediate stops preserve clipping
// in the RGBW screen approximation; endpoint-only gradients miss that shape.
export function channelGradient(color, channel) {
  const stops = Array.from({ length: 17 }, (_, i) => {
    const value = Math.round(255 * i / 16);
    return `${displayColor({ ...color, [channel]: value })} ${100 * i / 16}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

// ---------- quantities ----------

// Units the parameter types accept, as multipliers to SI. A length or
// speed in px needs the run's pitch, so it's reported separately.
const LENGTH = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
const TIME = { ms: 0.001, s: 1, min: 60, h: 3600 };

function number(s) {
  s = s.trim();
  if (s.includes('/')) {
    const [a, b] = s.split('/');
    const n = parseFloat(a), d = parseFloat(b);
    return d ? n / d : NaN;
  }
  return s === '' ? NaN : Number(s);
}

// splitQty splits "0.5 m", "20px", "1 px/8s", "2 /m/s" into a number and
// a unit, like units.splitNumber.
function splitQty(s) {
  s = String(s).trim();
  const m = /^([-+]?[\d.]+(?:e[-+]?\d+)?(?:\s*\/\s*[\d.]+(?![a-z]))?)\s*(.*)$/i.exec(s);
  if (!m) return null;
  return { n: number(m[1].replace(/\s+/g, '')), unit: m[2].trim() };
}

// parseQty reads a raw parameter value of a quantity type to SI (meters,
// seconds, per second …). pitch converts px. It returns NaN if it can't.
export function parseQty(type, raw, pitch = 1 / 60) {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && 'value' in raw) raw = raw.value;
  if (typeof raw !== 'string') return NaN;
  let s = raw.trim();
  if (type === 'length') s = s.replace(/\s+(physical|flow)$/, '');
  if (type === 'fraction' && s.endsWith('%')) return number(s.slice(0, -1)) / 100;
  const q = splitQty(s);
  if (!q || Number.isNaN(q.n)) return NaN;
  const u = q.unit.replace(/\s+/g, '');
  const len = (x) => (x === 'px' ? pitch : LENGTH[x]);
  switch (type) {
    case 'length': return u === '' ? (q.n === 0 ? 0 : NaN) : q.n * (len(u) ?? NaN);
    case 'duration': return u === '' ? (q.n === 0 ? 0 : NaN) : q.n * (TIME[u] ?? NaN);
    case 'speed': {
      if (u === '') return q.n === 0 ? 0 : NaN;
      const m = /^([a-z]+)\/(.*)$/.exec(u);
      if (!m) return NaN;
      const t = /^([\d.]*)([a-z]+)$/.exec(m[2]);
      if (!t) return NaN;
      const per = (t[1] ? Number(t[1]) : 1) * (TIME[t[2]] ?? NaN);
      return q.n * (len(m[1]) ?? NaN) / per;
    }
    case 'rate': {
      const m = /^\/(.+)$/.exec(u);
      return m ? q.n / (TIME[m[1]] ?? NaN) : (u === '' ? q.n : NaN);
    }
    case 'density': {
      const m = /^\/([a-z]+)\/([a-z]+)$/.exec(u);
      return m ? q.n / (len(m[1]) ?? NaN) / (TIME[m[2]] ?? NaN) : (u === '' ? q.n : NaN);
    }
    case 'angle': return u === 'rad' ? q.n : q.n * Math.PI / 180;
  }
  return q.n;
}

// UNITS is the unit a quantity type is written in.
export const UNITS = { length: 'm', speed: 'm/s', duration: 's', rate: '/s', density: '/m/s', angle: 'deg' };

// formatQty writes an SI value as a raw parameter value of the type.
// old is the current raw value: lengths keep a "physical" measure,
// speeds keep their sign (a slider sets the size, not the direction).
export function formatQty(type, v, old) {
  const n = (x) => String(+x.toPrecision(4));
  const oldStr = typeof old === 'string' ? old.trim() : '';
  switch (type) {
    case 'length': return n(v) + ' m' + (/\sphysical$/.test(oldStr) ? ' physical' : '');
    case 'speed': return (oldStr.startsWith('-') ? '-' : '') + n(Math.abs(v)) + ' m/s';
    case 'duration': return v < 1 ? n(v * 1000) + ' ms' : n(v) + ' s';
    case 'rate': return n(v) + ' /s';
    case 'density': return n(v) + ' /m/s';
    case 'angle': return +(v * 180 / Math.PI).toFixed(1);
    case 'fraction': return +v.toFixed(3);
  }
  return v;
}

// showQty is a short label for an SI value.
export function showQty(type, v) {
  if (!Number.isFinite(v)) return '—';
  const n = (x) => String(+x.toPrecision(3));
  switch (type) {
    case 'length': return Math.abs(v) < 1 ? n(v * 100) + ' cm' : n(v) + ' m';
    case 'duration': return Math.abs(v) < 1 ? n(v * 1000) + ' ms' : n(v) + ' s';
    case 'fraction': return Math.round(v * 100) + '%';
    case 'angle': return n(v * 180 / Math.PI) + '°';
  }
  return n(v) + (UNITS[type] ? ' ' + UNITS[type] : '');
}

// ---------- pixel-id range sets ----------
// A set is a sorted list of disjoint inclusive [first, last] ranges.

export function normRanges(rs) {
  const s = rs.filter((r) => r[1] >= r[0]).map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}
export const countRanges = (rs) => rs.reduce((n, r) => n + r[1] - r[0] + 1, 0);
// covers reports whether set a holds every pixel of set b.
export function covers(a, b) {
  let i = 0;
  for (const [lo, hi] of b) {
    while (i < a.length && a[i][1] < lo) i++;
    if (i >= a.length || a[i][0] > lo || a[i][1] < hi) return false;
  }
  return true;
}
export const sameSet = (a, b) => a.length === b.length && a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1]);
export function inRanges(rs, p) {
  let lo = 0, hi = rs.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (p < rs[m][0]) hi = m - 1;
    else if (p > rs[m][1]) lo = m + 1;
    else return true;
  }
  return false;
}
export function eachInRanges(rs, cb) {
  for (const [a, b] of rs) for (let p = a; p <= b; p++) cb(p);
}

// ---------- picking ----------

// segDist is the distance from (px, py) to the segment a–b.
export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

// nearestRun is the index of the run whose line on screen passes
// nearest (sx, sy) within radius, or -1. runs[i] is {ranges} or null;
// at(p) is pixel p's screen position, or null where it isn't drawn.
// Long runs are followed every kth pixel.
export function nearestRun(runs, at, sx, sy, radius) {
  let best = -1, bd = radius;
  runs.forEach((r, ri) => {
    if (!r) return;
    for (const [a, b] of r.ranges) {
      const step = Math.max(1, Math.ceil((b - a + 1) / 400));
      let prev = null;
      for (let p = a; ; p = Math.min(p + step, b)) {
        const q = at(p);
        if (q) {
          const d = prev ? segDist(sx, sy, prev[0], prev[1], q[0], q[1]) : Math.hypot(q[0] - sx, q[1] - sy);
          if (d < bd) { bd = d; best = ri; }
        }
        prev = q;
        if (p === b) break;
      }
    }
  });
  return best;
}

// ---------- small DOM helpers ----------

// debounce returns fn delayed until calls stop for ms.
export function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// copyText puts text on the clipboard. The clipboard API needs a secure
// context; plain http falls back to a selection copy, then to a prompt
// the text can be copied from.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
  if (!ok) prompt('Copy these camera settings:', text);
  return ok;
}
