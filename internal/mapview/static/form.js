// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Looks as data: a layer's effect, values, name and color strip, and the
// Tweak form that edits its params. The form leads with the controls
// WLED shows for the effect (its bindings: speed, intensity, colors,
// palette), then every param of the effect's schema under More, then
// the params as JSON. Edits go out through a patcher: changes made
// within ~80 ms are merged, and one PATCH is in flight at a time.
import { esc, parseColor, formatColor, displayColor, channelGradient, parseQty, formatQty, showQty, clamp, patch } from './util.js';

// ---------- looks as data ----------

export const presetOf = (S, id) => S.presets.find((p) => p.id === id) || null;
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
  if (layer.preset) { const p = presetOf(S, layer.preset); return (p && p.name) || layer.preset; }
  const e = effectFor(S, layer);
  return (e && e.name) || layer.effect || 'layer';
}

// palette finds a palette by id or name.
export function palette(S, name) {
  if (!S.palettes || typeof name !== 'string') return null;
  const k = name.toLowerCase();
  return S.palettes.find((p) => p.id === k || p.name.toLowerCase() === k) || null;
}

// lookStrip is a CSS background showing a look's colors: its bands,
// palette, colors or color, in that order of preference.
export function lookStrip(S, effectId, params) {
  const v = params || {};
  const key = (suffix) => Object.keys(v).find((k) => k === suffix || k.endsWith('.' + suffix));
  const e = (S.catalog.effects || []).find((x) => x.id === effectId);
  const def = (suffix) => { const p = e && e.params.find((q) => q.name === suffix || q.name.endsWith('.' + suffix)); return p ? p.default : undefined; };
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
  const pk = key('palette');
  const pal = palette(S, pk ? v[pk] : def('palette'));
  const ck = key('colors');
  const colors = ck ? v[ck] : null;
  if (pal && !(colors && /^\* Col/.test(pal.name))) {
    return `linear-gradient(90deg, ${pal.stops.map(([t, c]) => `${c} ${(t * 100).toFixed(1)}%`).join(', ')})`;
  }
  const cs = Array.isArray(colors) ? colors : def('colors');
  if (Array.isArray(cs) && cs.length) {
    const shown = cs.filter((c) => c !== '#000000');
    const list = (shown.length ? shown : cs).map(displayColor);
    return list.length === 1 ? list[0] : `linear-gradient(90deg, ${list.join(', ')})`;
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

// createForm builds the Tweak form for a layer. ctx: S, layer (kept
// current with update), pitch (meters per pixel, for px), send(params)
// and replace(params) to edit the layer.
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
    f.className = 'f';
    const lab = document.createElement('label');
    lab.textContent = label;
    if (title) lab.title = title;
    const c = document.createElement('div');
    c.className = 'ctl';
    c.append(...[].concat(body));
    f.append(lab, c);
    if (doc) { const d = document.createElement('div'); d.className = 'doc'; d.textContent = doc; f.append(d); }
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
      const label = b.param.replace(/\.(\d+)/g, (_, i) => ` ${+i + 1}`).replace(/\./g, ' ');
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
    const s = document.createElement('select');
    for (const p of S.palettes || []) s.add(new Option(p.name, p.id));
    const sync = () => {
      if (document.activeElement === s) return;
      const p = palette(S, get());
      if (p) s.value = p.id;
      else if (typeof get() === 'string') { s.add(new Option(get(), get())); s.value = get(); }
    };
    s.onchange = () => set(s.value);
    sync();
    ctrls.push({ sync });
    return s;
  }
  function enumSelect(options, get, set) {
    const s = document.createElement('select');
    for (const o of options) s.add(new Option(o, o));
    const sync = () => { if (document.activeElement !== s && get() != null) s.value = get(); };
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
      t.closest('.f') && t.closest('.f').classList.toggle('bad', !ok);
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
  function control(p, get, set) {
    switch (p.type) {
      case 'color': return colorInput(get, set);
      case 'colors': return colorsList(get, set);
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
      case 'list': return listEditor(p, get, set);
    }
    if (QTY.has(p.type)) {
      return textInput(get, set, (s) => Number.isFinite(parseQty(p.type, s, ctx.pitch)), String(p.default ?? ''));
    }
    return textInput(get, set, (s) => (p.type === 'int' || p.type === 'seed' ? /^-?\d+$/.test(s) : Number.isFinite(Number(s)) || p.type === 'string'), String(p.default ?? ''));
  }

  function colorsList(get, set) {
    const box = document.createElement('span');
    box.className = 'colors';
    const build = () => {
      box.replaceChildren();
      const list = [...(get() || [])];
      list.forEach((_, i) => box.append(colorInput(() => (get() || [])[i], (v) => { const l = [...(get() || [])]; l[i] = v; set(l); })));
      const add = document.createElement('button');
      add.type = 'button'; add.textContent = '+'; add.title = 'Add a color';
      add.onclick = () => { set([...(get() || []), '#ffffff']); build(); };
      const rm = document.createElement('button');
      rm.type = 'button'; rm.textContent = '−'; rm.title = 'Remove the last color';
      rm.disabled = list.length <= 1;
      rm.onclick = () => { set((get() || []).slice(0, -1)); build(); };
      box.append(add, rm);
    };
    build();
    return box;
  }

  function listEditor(p, get, set) {
    const box = document.createElement('div');
    box.className = 'list';
    const build = () => {
      box.replaceChildren();
      const list = get() || [];
      list.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'item';
        for (const f of p.fields || []) {
          const g = () => ((get() || [])[i] || {})[f.name];
          const s = (v) => { const l = JSON.parse(JSON.stringify(get() || [])); l[i] = { ...l[i], [f.name]: v }; set(l); };
          const c = control(f, g, s);
          const lab = document.createElement('span');
          lab.className = 'muted small';
          lab.textContent = f.name;
          row.append(lab, ...[].concat(c));
        }
        const rm = document.createElement('button');
        rm.type = 'button'; rm.textContent = '✕'; rm.title = 'Remove';
        rm.onclick = () => { const l = [...(get() || [])]; l.splice(i, 1); set(l); build(); };
        row.append(rm);
        box.append(row);
      });
      const add = document.createElement('button');
      add.type = 'button'; add.textContent = '+ Add';
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

  // ---- More: every param ----
  const more = document.createElement('details');
  more.innerHTML = `<summary>More settings <span class="muted">(${schema.length})</span></summary>`;
  for (const p of schema) {
    const get = () => (vals[p.name] !== undefined ? vals[p.name] : p.default);
    const set = (v) => apply({ [p.name]: v });
    const c = control(p, get, set);
    if (p.type === 'list') {
      const f = field(more, p.name, [], p.doc);
      f.querySelector('.ctl').remove();
      f.append(c);
    } else field(more, p.name, c, p.doc);
  }

  // ---- JSON ----
  const json = document.createElement('details');
  json.innerHTML = `<summary>Edit as JSON</summary>
    <textarea id="${id('json')}" spellcheck="false"></textarea>
    <div class="row end"><span class="err grow"></span><button type="button">Replace params</button></div>`;
  const ta = json.querySelector('textarea'), err = json.querySelector('.err');
  const syncJson = () => { if (document.activeElement !== ta) ta.value = JSON.stringify(layer.params || {}, null, 2); };
  json.addEventListener('toggle', syncJson);
  json.querySelector('button').onclick = () => {
    let v;
    try { v = JSON.parse(ta.value || '{}'); } catch (e) { err.textContent = e.message; return; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { err.textContent = 'params must be an object'; return; }
    err.textContent = '';
    vals = { ...valuesFor(S, { ...layer, params: {} }), ...v };
    ctx.replace(v);
  };

  if (wled.childElementCount) el.append(wled);
  else more.open = true;
  el.append(more, json);
  return {
    el,
    // update takes the layer as the server has it now.
    update(l) {
      layer = l;
      vals = valuesFor(S, l);
      for (const c of ctrls) c.sync();
      if (json.open) syncJson();
    },
  };
}
