// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Looks as data: a layer's effect, values, name and color strip, and the
// Tweak form that edits its params. The form leads with the controls
// WLED shows for the effect (its bindings: speed, intensity, colors,
// palette), then under More every param of the effect's schema and the
// params as text. Edits go out through a patcher: changes made
// within ~80 ms are merged, and one PATCH is in flight at a time.
import { esc, parseColor, formatColor, displayColor, channelGradient, parseQty, formatQty, showQty, clamp, api, patch, humanize } from './util.js';
import { icon } from './icons.js';
import { createPicker, escapeCloses } from './picker.js';
import { setFieldError } from './field.js';

// ---------- looks as data ----------

export const presetOf = (S, id) => S.presets.find((p) => p.id === id) || null;
// presetName is how a preset reads: its name, or its id in words when it
// has none of its own.
export const presetName = (p) => (p.name && p.name !== p.id ? p.name : humanize(p.id));
export function effectFor(S, layer) {
  const id = layer.effect || (presetOf(S, layer.preset) || {}).effect;
  return (S.catalog.effects || []).find((e) => e.id === id) || null;
}
// valuesFor is a layer's params over its preset's.
export function valuesFor(S, layer) {
  const p = layer.preset ? presetOf(S, layer.preset) : null;
  return { ...(p ? p.params : {}), ...(layer.params || {}) };
}
export function layerName(S, layer) {
  if (layer.name) return layer.name;
  if (layer.preset) { const p = presetOf(S, layer.preset); return p ? presetName(p) : humanize(layer.preset); }
  const e = effectFor(S, layer);
  return (e && e.name) || (layer.effect ? humanize(layer.effect) : 'Look');
}

// showingLabel is what the inspect card says a pixel shows, in the panel's
// words: where is the place as the layer's card reads it.
export function showingLabel(S, sh, where) {
  return `${layerName(S, sh)}${sh.preview ? ' (preview)' : ''}${where ? ' on ' + where : ''}`;
}

// palette finds a palette as the server does: by id, then by name in
// any case.
export function palette(S, name) {
  if (!S.palettes || typeof name !== 'string') return null;
  const k = name.toLowerCase();
  return S.palettes.find((p) => p.id === name) || S.palettes.find((p) => p.name.toLowerCase() === k) || null;
}

// paletteChoice is what the Palette picker shows for a value: a catalog
// palette's id, a name the catalog doesn't have, Default when nothing is set,
// or Custom for a palette written out inline as colors.
export function paletteChoice(S, value) {
  const p = palette(S, value);
  if (p) return { value: p.id };
  if (value === undefined || value === null) return { value: 'default' };
  if (typeof value === 'string') return { value, label: value };
  return { value: CUSTOM, label: 'Custom' };
}
const CUSTOM = '__custom';

// What "Default" means for each effect: the dflt it gives Palette.Resolve.
const DEFAULT_PALETTE = { gradient: 'rainbow', burst: 'party', noise: 'party', sparkle: 'color-1' };

const blend = (list) => (list.length === 1 ? list[0] : `linear-gradient(90deg, ${list.join(', ')})`);
const stopsStrip = (stops) => `linear-gradient(90deg, ${stops.map(([t, c]) => `${displayColor(c)} ${(t * 100).toFixed(1)}%`).join(', ')})`;
// stepStrip draws "interpolate: step": each stop holds until the next, as
// in Palette.At. Before the first stop a wrapping palette shows the last.
function stepStrip(stops, wrap) {
  const pct = (t) => (t * 100).toFixed(1) + '%';
  const parts = [];
  if (stops[0][0] > 0) {
    const c = displayColor(stops[wrap ? stops.length - 1 : 0][1]);
    parts.push(`${c} 0.0%`, `${c} ${pct(stops[0][0])}`);
  }
  stops.forEach(([t, color], i) => {
    const c = displayColor(color);
    parts.push(`${c} ${pct(t)}`, `${c} ${pct(i + 1 < stops.length ? stops[i + 1][0] : 1)}`);
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

// paletteStrip is the CSS for a palette value (an id, a name or inline
// stops), resolved like Palette.Resolve; null if it can't be found.
// owner is the effect the palette belongs to, colors the effect's colors.
function paletteStrip(S, value, owner, colors) {
  if (Array.isArray(value)) return value.length ? stopsStrip(value) : null;
  const p = palette(S, value);
  if (!p) return null;
  const col = (i) => displayColor(colors[i] || '#000000');
  switch (p.id) {
    case 'default': return paletteStrip(S, DEFAULT_PALETTE[owner] || 'party', owner, colors);
    case 'color-1': return col(0);
    case 'colors-1-2': return blend([col(0), col(1)]);
    case 'color-gradient': return blend([col(2), col(1), col(0)]);
    case 'colors-only': {
      const n = colors.length >= 3 && parseColor(colors[2]) && colors[2] !== '#000000' ? 3 : 2;
      const stops = Array.from({ length: n }, (_, i) => `${col(i)} ${(100 * i / n).toFixed(1)}%, ${col(i)} ${(100 * (i + 1) / n).toFixed(1)}%`);
      return `linear-gradient(90deg, ${stops.join(', ')})`;
    }
  }
  if (!p.stops.length) return null;
  return p.interpolate === 'step' ? stepStrip(p.stops, p.wrap !== false) : stopsStrip(p.stops);
}

// Palettes built from a look's own colors, by id.
const COLOR_BASED = new Set(['color-1', 'colors-1-2', 'color-gradient', 'colors-only']);
const NO_COLORS = 'repeating-linear-gradient(135deg, #4a5361 0 3px, #20242c 3px 6px)';
const isBlack = (c) => { const x = parseColor(c); return !x || !(x.r || x.g || x.b || x.w); };

// choiceStrip is a palette row's swatch. A palette built from the look's
// colors shows them; with none set, or all of them black, a hatch says so
// where a black bar would read as a broken row.
export function choiceStrip(S, id, owner, colors) {
  const resolved = id === 'default' ? DEFAULT_PALETTE[owner] || 'party' : id;
  return COLOR_BASED.has(resolved) && colors.every(isBlack) ? NO_COLORS : paletteStrip(S, id, owner, colors);
}

// A dark layer with gaps, over the colors: sparkles are specks, not a bar.
const SPECKS = 'linear-gradient(90deg, #0b0d10 0 7%, transparent 7% 9%, #0b0d10 9% 22%, transparent 22% 24%, #0b0d10 24% 37%, transparent 37% 38.5%, #0b0d10 38.5% 55%, transparent 55% 57%, #0b0d10 57% 66%, transparent 66% 67.5%, #0b0d10 67.5% 84%, transparent 84% 86%, #0b0d10 86% 100%)';

// chaseStrip draws Chase as it runs: its pulses, each color in turn, over
// its background.
function chaseStrip(schema, v) {
  const value = (name) => (v[name] !== undefined ? v[name] : (schema.find((q) => q.name === name) || {}).default);
  const list = value('colors');
  const colors = Array.isArray(list) && list.length ? list : ['#ffffff'];
  const bg = displayColor(value('background') || '#000000');
  const duty = clamp(parseQty('length', value('width') || '0.2 m') / parseQty('length', value('spacing') || '1 m') || 0.2, 0.08, 0.6);
  const pulses = Math.max(4, colors.length);
  const stops = [];
  for (let i = 0; i < pulses; i++) {
    const at = (x) => `${(100 * (i + x) / pulses).toFixed(2)}%`;
    const c = displayColor(colors[i % colors.length]);
    stops.push(`${c} ${at(0)}`, `${c} ${at(duty)}`, `${bg} ${at(duty)}`, `${bg} ${at(1)}`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// lookStrip is a CSS background showing a look's colors: its bands,
// palette, colors or color, in that order of preference. Chase and Sparkle
// are mostly dark, and the strip says so.
export function lookStrip(S, effectId, params) {
  const schema = ((S.catalog.effects || []).find((x) => x.id === effectId) || { params: [] }).params;
  if (effectId === 'chase') return chaseStrip(schema, params || {});
  const strip = colorStrip(S, effectId, params);
  return effectId === 'sparkle' ? `${SPECKS}, ${strip}` : strip;
}

function colorStrip(S, effectId, params) {
  const v = params || {};
  const key = (suffix) => Object.keys(v).find((k) => k === suffix || k.endsWith('.' + suffix));
  const e = (S.catalog.effects || []).find((x) => x.id === effectId);
  const schema = e ? e.params : [];
  const def = (suffix) => { const p = schema.find((q) => q.name === suffix || q.name.endsWith('.' + suffix)); return p ? p.default : undefined; };
  const named = (name) => (v[name] !== undefined ? v[name] : (schema.find((q) => q.name === name) || {}).default);
  const bands = v.bands || (effectId === 'bands' ? def('bands') : null);
  if (Array.isArray(bands) && bands.length) {
    const w = bands.map((b) => Math.max(parseQty('length', b.width || '0.5 m') || 0.01, 0.001));
    const total = w.reduce((a, b) => a + b, 0) * Math.max(1, Math.ceil(4 / bands.length));
    const stops = [];
    let x = 0;
    for (let rep = 0; x < total - 1e-9; rep++) {
      bands.forEach((b, i) => {
        const c = displayColor(b.color || '#ffffff');
        stops.push(`${c} ${(100 * x / total).toFixed(2)}%`, `${c} ${(100 * (x + w[i]) / total).toFixed(2)}%`);
        x += w[i];
      });
    }
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }
  // A palette's colors are those of the effect it belongs to, so in a
  // composite "sparkle.palette" goes with "sparkle.color".
  const pname = (schema.find((q) => q.type === 'palette') || {}).name || key('palette');
  if (pname) {
    const prefix = pname.slice(0, -'palette'.length);
    const list = named(prefix + 'colors'), one = named(prefix + 'color');
    const colors = Array.isArray(list) ? list : one !== undefined ? [one] : [];
    const strip = paletteStrip(S, named(pname), prefix ? prefix.slice(0, -1).split('.').pop() : effectId, colors);
    if (strip) return strip;
  }
  const ck = key('colors');
  const cs = ck && Array.isArray(v[ck]) ? v[ck] : def('colors');
  if (Array.isArray(cs) && cs.length) {
    const shown = cs.filter((c) => c !== '#000000');
    return blend((shown.length ? shown : cs).map(displayColor));
  }
  const one = [key('color'), key('background')].filter(Boolean).map((k) => v[k]);
  if (!one.length && def('color')) one.push(def('color'));
  if (one.length) return one.length === 1 ? displayColor(one[0]) : `linear-gradient(90deg, ${displayColor(one[0])} 60%, ${displayColor(one[1])} 60%)`;
  return '#3a404a';
}

// ---------- the patcher ----------

// patcher sends {params} edits to url(): changes within ms of the first
// are merged into one PATCH, and one PATCH is in flight at a time.
export function patcher(url, ms, done, fail) {
  let pending = null, timer = 0, busy = false;
  async function flush() {
    timer = 0;
    if (busy || !pending) return;
    const body = pending;
    pending = null;
    busy = true;
    try { done(await patch(url(), body)); } catch (e) { fail(e); }
    busy = false;
    if (pending && !timer) timer = setTimeout(flush, 0);
  }
  return {
    set(params) {
      pending = pending || { params: {} };
      Object.assign(pending.params, params);
      if (!timer) timer = setTimeout(flush, ms);
    },
    replace(params) {
      pending = { params, replace: true };
      if (!timer) timer = setTimeout(flush, 0);
    },
    busy: () => busy || !!pending,
  };
}

// ---------- WLED binding curves (internal/render/wled.go) ----------

const K = 4;
const curve = {
  linear: { value: (x) => x, slider: (y) => y },
  exp: { value: (x) => Math.expm1(K * x) / Math.expm1(K), slider: (y) => Math.log1p(y * Math.expm1(K)) / K },
  log: { value: (x) => Math.log1p(x * Math.expm1(K)) / K, slider: (y) => Math.expm1(K * y) / Math.expm1(K) },
};
const SLIDERS = { sx: 'Speed', ix: 'Intensity', c1: 'Custom 1', c2: 'Custom 2', c3: 'Custom 3', pal: 'Palette', col0: 'Color 1', col1: 'Color 2', col2: 'Color 3' };

// ---------- param paths ----------

// leaf resolves a param path such as "speed", "colors.0" or
// "bands.0.width" against a schema: the top-level param, the leaf's
// type, and get/set on a values object. set returns the top-level
// value to send, as list params go whole.
function leaf(params, path) {
  const parts = path.split('.');
  for (let i = parts.length; i > 0; i--) {
    const name = parts.slice(0, i).join('.');
    const p = params.find((q) => q.name === name);
    if (!p) continue;
    const rest = parts.slice(i);
    let type = p.type;
    if (rest.length && p.type === 'colors') type = 'color';
    if (rest.length && p.type === 'list') {
      const f = (p.fields || []).find((x) => x.name === rest[1]);
      type = f ? f.type : 'number';
    }
    const top = (vals) => (vals[name] !== undefined ? vals[name] : p.default);
    return {
      param: p, name, type,
      get(vals) {
        let x = top(vals);
        for (const r of rest) x = x == null ? undefined : x[r];
        return x;
      },
      set(vals, value) {
        if (!rest.length) return { [name]: value };
        const whole = JSON.parse(JSON.stringify(top(vals) || []));
        let x = whole;
        for (let j = 0; j < rest.length - 1; j++) {
          if (x[rest[j]] == null) x[rest[j]] = {};
          x = x[rest[j]];
        }
        x[rest[rest.length - 1]] = value;
        return { [name]: whole };
      },
    };
  }
  return null;
}

// ---------- the form ----------

const QTY = new Set(['length', 'speed', 'duration', 'rate', 'density', 'angle']);
let uid = 0;

// paramLabel is a parameter's label, in words a person would use.
export function paramLabel(name) {
  return humanize(name.replace(/(^|\.)span$/, '$1repeat_length'));
}

// boundEntries counts the entries at the start of list or colors param p
// that WLED controls already edit in full.
function boundEntries(p, bindings) {
  const bound = new Set(bindings.map((b) => b.param));
  const whole = (i) => (p.type === 'colors' ? bound.has(`${p.name}.${i}`) : (p.fields || []).length > 0 && p.fields.every((f) => bound.has(`${p.name}.${i}.${f.name}`)));
  let n = 0;
  while (whole(n)) n++;
  return n;
}

// moreParams is what the More list shows: every param not already on the
// WLED list above it, or (outside) elsewhere on the page. from is how many
// entries of a list param the WLED list covers.
export function moreParams(schema, bindings, outside = []) {
  return schema.filter((p) => !outside.includes(p.name) && !bindings.some((b) => b.param === p.name))
    .map((p) => ({ p, from: p.type === 'colors' || p.type === 'list' ? boundEntries(p, bindings) : 0 }));
}

// createForm builds the Tweak form for a layer. ctx: S, layer (kept
// current with update), pitch (meters per pixel, for px), send(params)
// and replace(params) to edit the layer, outside (param names the page
// offers elsewhere, left out of More).
export function createForm(ctx) {
  const { S } = ctx;
  const el = document.createElement('div');
  el.className = 'form';
  let layer = ctx.layer, vals = valuesFor(S, layer);
  const effect = effectFor(S, layer);
  if (!effect) { el.innerHTML = '<div class="muted">This layer\'s effect isn\'t in the catalog.</div>'; return { el, update() {} }; }
  const schema = [...effect.params, ...(S.catalog.common || [])];
  const ctrls = []; // { sync() } refreshed from the layer when not being edited
  const id = (s) => `f${++uid}-${s}`;

  function apply(changes) {
    Object.assign(vals, changes);
    ctx.send(changes);
  }

  // field adds a labeled row; body is a node; doc a hint under it.
  function field(parent, label, body, doc, title) {
    const f = document.createElement('div');
    // A long name takes its own line, rather than two ragged ones in a narrow column.
    f.className = label.length > 16 ? 'f stack' : 'f';
    const lab = document.createElement('label');
    lab.textContent = label.replace(/ (\S{1,2})$/, '\u00a0$1'); // "color 1" doesn't break before the 1
    if (title) lab.title = title;
    const c = document.createElement('div');
    c.className = 'ctl';
    c.append(...[].concat(body));
    f.append(lab, c);
    if (doc) { const d = document.createElement('div'); d.className = 'doc'; d.textContent = doc; f.append(d); }
    f.append(Object.assign(document.createElement('span'), { className: 'field-err', role: 'alert' }));
    parent.append(f);
    return f;
  }

  // One color is four independent channels. Every track previews the mix
  // along that channel while holding the other three at their current values.
  function colorInput(get, set) {
    const box = document.createElement('details');
    box.className = 'color-picker';
    const summary = document.createElement('summary');
    const swatch = document.createElement('span');
    swatch.className = 'color-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.textContent = 'Edit color';
    summary.append(swatch, title);
    const panel = document.createElement('div');
    panel.className = 'color-mixer';
    const read = () => parseColor(get()) || { r: 0, g: 0, b: 0, w: 0 };
    const channels = [];
    const paint = (c) => {
      swatch.style.background = displayColor(c);
      summary.title = `RGB + warm white: ${c.r}, ${c.g}, ${c.b}, ${c.w}`;
      for (const { key, slider, number } of channels) {
        slider.value = number.value = c[key];
        slider.style.backgroundImage = channelGradient(c, key);
      }
    };
    const write = (c) => { paint(c); set(formatColor(c)); };
    for (const [key, name] of [['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['w', 'Warm white']]) {
      const row = document.createElement('div');
      row.className = 'channel-row';
      const label = document.createElement('label');
      label.textContent = name;
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = 0; slider.max = 255; slider.step = 1;
      slider.id = id(`channel-${key}`); label.htmlFor = slider.id;
      slider.setAttribute('aria-label', name);
      const number = document.createElement('input');
      number.type = 'number'; number.min = 0; number.max = 255; number.step = 1;
      number.setAttribute('aria-label', `${name} value`);
      const change = (input) => write({ ...read(), [key]: Math.round(clamp(+input.value || 0, 0, 255)) });
      slider.oninput = () => change(slider);
      number.oninput = () => change(number);
      row.append(label, slider, number);
      panel.append(row);
      channels.push({ key, slider, number });
    }
    const choices = document.createElement('div');
    choices.className = 'color-choices';
    for (const [name, color] of [['Warm white', '#000000/ff'], ['RGB white', '#ffffff'], ['Off', '#000000']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = name;
      button.onclick = () => write(parseColor(color));
      choices.append(button);
    }
    const note = document.createElement('div');
    note.className = 'color-note';
    note.textContent = 'Screen preview is approximate. Each slider keeps the other channels fixed.';
    panel.append(choices, note);
    box.append(summary, panel);
    escapeCloses(box, () => box.open, () => { box.open = false; summary.focus(); });
    const sync = () => { if (!box.contains(document.activeElement)) paint(read()); };
    sync();
    ctrls.push({ sync });
    return box;
  }

  // ---- the WLED controls ----
  const wled = document.createElement('div');
  if (effect.wled && effect.wled.bindings && effect.wled.bindings.length) {
    for (const b of effect.wled.bindings) {
      const lf = leaf(schema, b.param);
      if (!lf) continue;
      const title = `${SLIDERS[b.slider] || b.slider} in WLED · ${b.param}`;
      const label = paramLabel(b.param);
      if (lf.type === 'color') {
        field(wled, label, colorInput(() => lf.get(vals), (v) => apply(lf.set(vals, v))), null, title);
      } else if (lf.type === 'palette' || b.slider === 'pal') {
        field(wled, label, paletteSelect(() => lf.get(vals), (v) => apply(lf.set(vals, v))), null, title);
      } else if (lf.type === 'bool') {
        field(wled, label, checkbox(() => lf.get(vals), (v) => apply(lf.set(vals, v))), null, title);
      } else if (lf.type === 'enum') {
        field(wled, label, enumSelect(lf.param.enum || [], () => lf.get(vals), (v) => apply(lf.set(vals, v))), null, title);
      } else {
        field(wled, label, bindingSlider(b, lf), null, title);
      }
    }
  }

  // bindingSlider maps WLED's 0–255 slider through the binding's curve
  // onto the param's range, as WLED would.
  function bindingSlider(b, lf) {
    const cv = curve[b.curve || 'linear'] || curve.linear;
    const lo = parseQty(lf.type, b.min, ctx.pitch), hi = parseQty(lf.type, b.max, ctx.pitch);
    const r = document.createElement('input');
    r.type = 'range'; r.min = 0; r.max = 255; r.step = 1;
    const out = document.createElement('output');
    const sync = () => {
      const v = Math.abs(parseQty(lf.type, lf.get(vals), ctx.pitch));
      out.textContent = showQty(lf.type, v);
      if (document.activeElement === r || !Number.isFinite(v) || hi === lo) return;
      r.value = Math.round(clamp(cv.slider(clamp((v - lo) / (hi - lo), 0, 1)), 0, 1) * 255);
    };
    r.oninput = () => {
      const v = lo + (hi - lo) * cv.value(+r.value / 255);
      out.textContent = showQty(lf.type, v);
      apply(lf.set(vals, formatQty(lf.type, v, lf.get(vals))));
    };
    sync();
    ctrls.push({ sync });
    return [r, out];
  }

  function paletteSelect(get, set) {
    // The look's own colors: its list or single color, set or by default.
    const colors = () => {
      const value = (name) => (vals[name] !== undefined ? vals[name] : (schema.find((q) => q.name === name) || {}).default);
      const list = value('colors'), one = value('color');
      return Array.isArray(list) ? list : one !== undefined ? [one] : [];
    };
    const choices = () => (S.palettes || []).map((p) => ({ value: p.id, label: p.name.replace(/^\*\s*/, ''), swatch: choiceStrip(S, p.id, effect.id, colors()) }));
    const s = createPicker(choices());
    const sync = () => {
      if (s.isOpen) return;
      s.options = choices(); // the color-based palettes follow the colors
      const shown = paletteChoice(S, get());
      if (shown.label && !s.options.some((o) => o.value === shown.value)) {
        s.options = [...s.options, { ...shown, swatch: shown.value === CUSTOM ? paletteStrip(S, get(), effect.id, []) : undefined }];
      }
      s.value = shown.value;
    };
    s.onchange = () => { if (s.value !== CUSTOM) set(s.value); };
    sync();
    ctrls.push({ sync });
    return s;
  }
  function enumSelect(options, get, set) {
    const s = createPicker(options.map((o) => ({ value: o, label: o === '' ? 'None' : humanize(o) })));
    const sync = () => { if (!s.isOpen && get() != null) s.value = get(); };
    s.onchange = () => set(s.value);
    sync();
    ctrls.push({ sync });
    return s;
  }
  function checkbox(get, set) {
    const lab = document.createElement('label');
    lab.className = 'check';
    const c = document.createElement('input');
    c.type = 'checkbox';
    lab.append(c);
    const sync = () => { c.checked = !!get(); };
    c.onchange = () => set(c.checked);
    sync();
    ctrls.push({ sync });
    return lab;
  }
  // textInput edits a raw value; valid(raw) says whether to send it.
  function textInput(get, set, valid, placeholder) {
    const t = document.createElement('input');
    t.type = 'text'; t.spellcheck = false; t.autocomplete = 'off';
    if (placeholder) t.placeholder = placeholder;
    const sync = () => { if (document.activeElement !== t) t.value = get() == null ? '' : String(get()); };
    const commit = () => {
      const ok = t.value.trim() === '' || valid(t.value.trim());
      const row = t.closest('.f');
      if (row) {
        row.classList.toggle('bad', !ok);
        setFieldError(t, ok ? '' : `That isn't a valid value${placeholder ? ` (like ${placeholder})` : ''}.`);
      }
      if (ok) set(t.value.trim() === '' ? null : coerce(t.value.trim()));
    };
    t.onchange = commit;
    t.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
    sync();
    ctrls.push({ sync });
    return t;
  }
  const coerce = (s) => (/^-?[\d.]+(e-?\d+)?$/.test(s) ? Number(s) : s);

  // control builds the editor for one schema param.
  function control(p, get, set, from = 0) {
    switch (p.type) {
      case 'color': return colorInput(get, set);
      case 'colors': return colorsList(get, set, from);
      case 'palette': return paletteSelect(get, set);
      case 'enum': return enumSelect(p.enum || [], get, set);
      case 'bool': return checkbox(get, set);
      case 'mapping': return enumSelect(['', ...S.geo.mappings.map((m) => m.id)], () => get() || '', (v) => set(v || null));
      case 'fraction': {
        const r = document.createElement('input');
        r.type = 'range'; r.min = 0; r.max = 1; r.step = 0.01;
        const out = document.createElement('output');
        const sync = () => {
          const v = parseQty('fraction', get());
          out.textContent = showQty('fraction', v);
          if (document.activeElement !== r && Number.isFinite(v)) r.value = v;
        };
        r.oninput = () => { out.textContent = showQty('fraction', +r.value); set(+r.value); };
        sync();
        ctrls.push({ sync });
        return [r, out];
      }
      case 'list': return listEditor(p, get, set, from);
    }
    if (QTY.has(p.type)) {
      return textInput(get, set, (s) => Number.isFinite(parseQty(p.type, s, ctx.pitch)), String(p.default ?? 'Default'));
    }
    return textInput(get, set, (s) => (p.type === 'int' || p.type === 'seed' ? /^-?\d+$/.test(s) : Number.isFinite(Number(s)) || p.type === 'string'), String(p.default ?? 'Default'));
  }

  // colorsList edits a list of colors from index from; earlier ones are
  // on the WLED list.
  function colorsList(get, set, from = 0) {
    const box = document.createElement('span');
    box.className = 'colors';
    const build = () => {
      box.replaceChildren();
      const list = [...(get() || [])];
      list.forEach((_, i) => { if (i >= from) box.append(colorInput(() => (get() || [])[i], (v) => { const l = [...(get() || [])]; l[i] = v; set(l); })); });
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'icon-btn'; add.innerHTML = icon('plus'); add.title = 'Add a color'; add.setAttribute('aria-label', 'Add a color');
      add.onclick = () => { set([...(get() || []), '#ffffff']); build(); };
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'icon-btn'; rm.innerHTML = icon('minus'); rm.title = 'Remove the last color'; rm.setAttribute('aria-label', 'Remove the last color');
      rm.disabled = list.length <= Math.max(1, from);
      rm.onclick = () => { set((get() || []).slice(0, -1)); build(); };
      box.append(add, rm);
    };
    build();
    return box;
  }

  function listEditor(p, get, set, from = 0) {
    const box = document.createElement('div');
    box.className = 'list';
    const build = () => {
      box.replaceChildren();
      const list = get() || [];
      list.forEach((item, i) => {
        if (i < from) return;
        const row = document.createElement('div');
        row.className = 'item';
        for (const f of p.fields || []) {
          const g = () => ((get() || [])[i] || {})[f.name];
          const s = (v) => { const l = JSON.parse(JSON.stringify(get() || [])); l[i] = { ...l[i], [f.name]: v }; set(l); };
          const c = control(f, g, s);
          const lab = document.createElement('span');
          lab.className = 'muted small';
          lab.textContent = humanize(f.name);
          lab.title = f.name;
          row.append(lab, ...[].concat(c));
        }
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'icon-btn'; rm.innerHTML = icon('close'); rm.title = 'Remove'; rm.setAttribute('aria-label', 'Remove');
        rm.onclick = () => { const l = [...(get() || [])]; l.splice(i, 1); set(l); build(); };
        row.append(rm);
        box.append(row);
      });
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'icon-btn'; add.innerHTML = `${icon('plus')}Add`;
      add.onclick = () => {
        const item = {};
        for (const f of p.fields || []) item[f.name] = f.default;
        set([...(get() || []), item]);
        build();
      };
      box.append(add);
    };
    build();
    return box;
  }

  // ---- More: the rest of the params ----
  const rest = moreParams(schema, (effect.wled && effect.wled.bindings) || [], ctx.outside);
  const more = document.createElement('details');
  more.innerHTML = `<summary>More settings <span class="muted">(${rest.length})</span></summary>`;
  for (const { p, from } of rest) {
    const get = () => (vals[p.name] !== undefined ? vals[p.name] : p.default);
    const set = (v) => apply({ [p.name]: v });
    const c = control(p, get, set, from);
    const label = from ? `More ${paramLabel(p.name).toLowerCase()}` : paramLabel(p.name);
    if (p.type === 'list') {
      const f = field(more, label, [], p.doc, p.name);
      f.querySelector('.ctl').remove();
      f.append(c);
    } else field(more, label, c, p.doc, p.name);
  }

  // ---- every setting as YAML, under More ----
  const yaml = document.createElement('details');
  yaml.innerHTML = `<summary>Edit every setting as YAML</summary>
    <textarea id="${id('yaml')}" spellcheck="false" placeholder="speed: 40" aria-label="Every setting, written as YAML"></textarea>
    <span class="field-err" role="alert"></span>
    <div class="row end"><button type="button">Replace settings</button></div>`;
  const ta = yaml.querySelector('textarea'), err = yaml.querySelector('.field-err'), replaceBtn = yaml.querySelector('button');
  let yamlAsk = 0;
  const convert = (to, body) => api(`/api/map/params/${to}`, { method: 'POST', headers: { 'Content-Type': to === 'yaml' ? 'application/json' : 'text/yaml' }, body });
  async function syncYaml() {
    if (!yaml.open || document.activeElement === ta) return;
    const ask = ++yamlAsk;
    try {
      const { yaml: text } = await convert('yaml', JSON.stringify(layer.params || {}));
      if (ask === yamlAsk && document.activeElement !== ta) { ta.value = text; err.textContent = ''; }
    } catch (e) { if (ask === yamlAsk) err.textContent = e.message; }
  }
  yaml.addEventListener('toggle', syncYaml);
  replaceBtn.onclick = async () => {
    replaceBtn.disabled = true;
    try {
      const v = await convert('json', ta.value);
      err.textContent = '';
      vals = { ...valuesFor(S, { ...layer, params: {} }), ...v };
      ctx.replace(v);
    } catch (e) { err.textContent = e.message; }
    replaceBtn.disabled = false;
  };

  if (wled.childElementCount) el.append(wled);
  else more.open = true;
  more.append(yaml);
  el.append(more);
  return {
    el,
    // update takes the layer as the server has it now.
    update(l) {
      layer = l;
      vals = valuesFor(S, l);
      for (const c of ctrls) c.sync();
      syncYaml();
    },
  };
}
