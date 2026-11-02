// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Glowstack live map. Plain JS, no build step. On an SVG plan, world
// coordinates are plan meters (y down, as in the SVG) and the view maps
// them to the canvas. With a scene model, scene.js draws the building in
// 3-D on a canvas below this one, and everything here (pixels, nodes,
// labels, picking) draws through its camera.
'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');

const S = {
  geo: null,
  n: 0,
  rgb: null,            // Uint8Array, 3 per pixel, latest frame
  plan: 0,              // plan index shown
  drawable: [],         // global ids on the current plan
  planImg: null,
  three: null,          // scene.js view when the plan is a scene model
  proj: null,           // its projection for the frame being drawn
  scr: null,            // 3-D: screen x, y and depth per pixel, this frame
  shown: [],            // 3-D: drawable pixels in front of the camera, far first
  view: { k: 50, tx: 0, ty: 0 }, // screen = world * k + t (CSS px)
  mode: 'live',
  mappingId: '',
  mappings: new Map(),  // id → mapping JSON (cached)
  pick: '',             // areas view: "area:<id>" or "zone:<id>"
  overlay: null,        // Uint8Array colors for diagnostic views
  showNodes: false,
  showLabels: false,
  hover: -1,
  pinned: -1,
  frame: { seq: 0, t: 0, preview: false, paused: false },
  show: localStorage.getItem('glowstack.show') === 'house' ? 'house' : '', // '' preview, 'house' live
  connected: false,
  preview: null,        // preview state from the server
  dirty: false,
};

// ---------- helpers ----------

async function api(path, opts) {
  const r = await fetch(path, opts);
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((body && body.error) || r.statusText);
  return body;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
// showQ is the ?show= query for the inspect and power endpoints.
const showQ = () => (S.show ? '?show=' + S.show : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : (+v).toFixed(d);
const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
function opt(sel, value, label) {
  const o = document.createElement('option');
  o.value = value; o.textContent = label ?? value;
  sel.appendChild(o);
  return o;
}
function markDirty() {
  if (!S.dirty) { S.dirty = true; requestAnimationFrame(draw); }
}

// Color ramps. turbo-ish for u, diverging blue-white-red for stretch.
function ramp(t) {
  t = Math.min(1, Math.max(0, t));
  const h = 260 - 260 * t;
  return hsl(h, 0.85, 0.55);
}
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function stretchColor(s) {
  if (s === null || !(s > 0)) return [70, 70, 70];
  const x = Math.max(-1, Math.min(1, Math.log2(s) / Math.log2(1.5))); // ±1 at 1.5× / 1/1.5×
  const w = 235;
  if (x < 0) return [Math.round(w + (40 - w) * -x), Math.round(w + (110 - w) * -x), 255];
  return [255, Math.round(w + (60 - w) * x), Math.round(w + (50 - w) * x)];
}
const PALETTE = [[255, 179, 71], [93, 220, 138], [96, 165, 250], [244, 114, 182], [250, 204, 21], [167, 139, 250], [45, 212, 191], [251, 113, 133]];

// ---------- setup ----------

async function main() {
  if (innerWidth < 760) document.body.classList.add('nopanel');
  S.geo = await api('/api/map/geometry');
  const g = S.geo;
  S.n = g.pixels.count;
  S.rgb = new Uint8Array(S.n * 3);

  const planSel = $('plan');
  g.plans.forEach((p, i) => opt(planSel, i, p.name));
  $('planWrap').hidden = g.plans.length < 2;
  g.mappings.forEach((m) => opt($('mapping'), m.id, `${m.id} (${m.kind})`));
  const flows = g.mappings.filter((m) => m.kind === 'flow');
  S.mappingId = (flows.find((m) => m.id === g.default_mapping) || flows[0] || g.mappings[0] || {}).id || '';
  $('mapping').value = S.mappingId;
  for (const a of g.areas) {
    opt($('areaPick'), 'area:' + a.id, `area ${a.id} (${a.count})`);
    opt($('pTarget'), a.id);
    opt($('streamArea'), a.id);
  }
  for (const z of g.zones) opt($('areaPick'), 'zone:' + z.id, `zone ${z.id}`);
  for (const c of g.controllers) opt($('outputPick'), c.id, `controller ${c.id}`);
  S.pick = $('areaPick').value;
  for (const e of g.effects) opt($('pLook'), 'effect:' + e.id, `effect ${e.name || e.id}`);
  for (const p of g.presets) opt($('pLook'), 'preset:' + p.id, `preset ${p.name || p.id}`);

  const isScene = g.plans.some((p) => p.kind === 'scene');
  $('undrawnTitle').textContent = isScene ? 'Not in the model' : 'Not on the plan';
  const undrawn = g.runs.filter((r) => r.plan < 0);
  $('undrawn').innerHTML = undrawn.length
    ? undrawn.map((r) => `<li>run <b>${esc(r.id)}</b>: ${r.count} px on ${esc(g.controllers[r.controller].id)}</li>`).join('')
    : '<li>Every run is drawn.</li>';

  bindUI();
  await selectPlan(0);
  connect();
  pollPreview();
  setInterval(pollPreview, 1000);
  setInterval(refreshSide, 1000);
  addEventListener('resize', () => { resize(); markDirty(); });
}

async function selectPlan(i) {
  S.plan = i;
  const g = S.geo;
  S.drawable = [];
  for (let p = 0; p < S.n; p++) if (g.pixels.plan[p] === i && g.pixels.x[p] !== null) S.drawable.push(p);
  S.planImg = null;
  const plan = g.plans[i];
  if (plan && plan.kind === 'scene') {
    await openScene(plan);
  } else if (plan) {
    const img = new Image();
    img.onload = () => { S.planImg = img; markDirty(); };
    img.src = plan.url;
  }
  resize();
  fit();
}

// sceneModule waits for scene.js, a module, which loads after this script.
function sceneModule() {
  if (window.GlowScene) return Promise.resolve(window.GlowScene);
  return new Promise((resolve, reject) => {
    document.addEventListener('glowstack:scene', () => resolve(window.GlowScene), { once: true });
    setTimeout(() => reject(new Error('the 3-D view (scene.js) did not load')), 15000);
  });
}

async function openScene(plan) {
  const px = S.geo.pixels;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of S.drawable) {
    [px.x[p], px.y[p], px.z[p] || 0].forEach((v, k) => { lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); });
  }
  const mod = await sceneModule();
  S.scr = new Float32Array(S.n * 3);
  S.three = await mod.open($('gl'), canvas, {
    url: plan.url,
    layers: plan.layers || [],
    map: S.geo.map || {},
    bounds: isFinite(lo[0]) ? [lo, hi] : null,
    onChange: markDirty,
  });
  document.body.classList.add('scene3d');
  $('copyView').hidden = false;
  $('fit').title = 'Back to the default view';
  const box = $('layers');
  box.innerHTML = '';
  for (const l of S.three.layers) {
    const lab = document.createElement('label');
    lab.className = 'check';
    lab.innerHTML = `<input type="checkbox"${l.visible ? ' checked' : ''}> ${esc(l.name)} <small class="muted">${esc(l.kind)}</small>`;
    lab.querySelector('input').onchange = (e) => S.three.setVisible(l.name, e.target.checked);
    box.appendChild(lab);
  }
  $('layersSec').hidden = S.three.layers.length === 0;
}

// copyView puts the camera on the clipboard as glowstack.yaml `map:`.
// The clipboard API needs a secure context; plain http falls back to a
// selection copy, then to a prompt the text can be copied from.
async function copyView() {
  const text = S.three.view();
  const b = $('copyView');
  const done = (msg) => { b.textContent = msg; setTimeout(() => { b.textContent = 'Copy view'; }, 1500); };
  try {
    await navigator.clipboard.writeText(text);
    return done('Copied');
  } catch (e) { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
  if (ok) return done('Copied');
  prompt('Copy this into glowstack.yaml:', text);
}

function planRect() {
  const p = S.geo.plans[S.plan];
  if (!p || p.kind === 'scene') return null;
  let [x, y, w, h] = p.view_box;
  if (!(w > 0 && h > 0)) {
    if (!S.planImg) return null;
    x = 0; y = 0; w = S.planImg.naturalWidth; h = S.planImg.naturalHeight;
  }
  return { x: x * p.scale, y: y * p.scale, w: w * p.scale, h: h * p.scale };
}

function resize() {
  const dpr = devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  if (S.three) S.three.resize(r.width, r.height, dpr);
}

function fit() {
  if (S.three) { S.three.reset(); return; }
  const g = S.geo, px = g.pixels;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of S.drawable) {
    x0 = Math.min(x0, px.x[p]); x1 = Math.max(x1, px.x[p]);
    y0 = Math.min(y0, px.y[p]); y1 = Math.max(y1, px.y[p]);
  }
  if (!isFinite(x0)) {
    const r = planRect();
    if (r) { x0 = r.x; y0 = r.y; x1 = r.x + r.w; y1 = r.y + r.h; } else { x0 = y0 = 0; x1 = y1 = 10; }
  }
  const w = Math.max(x1 - x0, 0.5), h = Math.max(y1 - y0, 0.5);
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const k = Math.min(cw / (w * 1.15), ch / (h * 1.15));
  S.view = { k, tx: cw / 2 - (x0 + w / 2) * k, ty: ch / 2 - (y0 + h / 2) * k };
  markDirty();
}

// ---------- drawing ----------

// planLayer returns the plan drawn for the current view, cached until the
// view or canvas changes. Plans are black hairlines on white, nearly
// invisible on the dark map, so the lightness is inverted (hues kept) and
// the plan drawn twice to thicken the antialiased lines.
function planLayer(r, k, tx, ty) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.width, h = canvas.height;
  const key = [S.plan, k, tx, ty, w, h, dpr].join();
  const c = S.planCache;
  if (c && c.key === key && c.img === S.planImg) return c.canvas;
  const off = c?.canvas || document.createElement('canvas');
  off.width = w; off.height = h;
  const o = off.getContext('2d');
  o.setTransform(dpr, 0, 0, dpr, 0, 0);
  o.filter = 'invert(1) hue-rotate(180deg)';
  for (let i = 0; i < 2; i++) o.drawImage(S.planImg, r.x * k + tx, r.y * k + ty, r.w * k, r.h * k);
  S.planCache = { key, img: S.planImg, canvas: off };
  return off;
}

function draw() {
  S.dirty = false;
  const dpr = devicePixelRatio || 1;
  const { k, tx, ty } = S.view;
  const g = S.geo, px = g.pixels;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.three) {
    // The building is on the GL canvas below; this one stays clear.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    S.proj = S.three.render();
  } else {
    ctx.fillStyle = '#0d0e10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const r = planRect();
  if (S.planImg && r) {
    ctx.drawImage(planLayer(r, k, tx, ty), 0, 0, canvas.clientWidth, canvas.clientHeight);
  }

  // Pixels: squares sized to their physical pitch, at least 2 CSS px.
  const col = S.mode === 'live' ? S.rgb : S.overlay;
  const dead = new Set(px.dead);
  if (S.three) drawPixels3D(col, dead);
  else for (const p of S.drawable) {
    const s = Math.min(Math.max((px.dl[p] || 0.03) * k * 0.85, 3), 16);
    const x = px.x[p] * k + tx, y = px.y[p] * k + ty;
    if (x < -s || y < -s || x > canvas.clientWidth + s || y > canvas.clientHeight + s) continue;
    if (dead.has(p)) {
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      continue;
    }
    let cr = 0, cg = 0, cb = 0;
    if (col) { cr = col[3 * p]; cg = col[3 * p + 1]; cb = col[3 * p + 2]; }
    // Unlit pixels show dimly so the strips stay visible.
    if (cr + cg + cb < 24) { cr = cg = cb = 30; }
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
  }

  if (S.mode === 'flow') drawArrows();
  if (S.mode === 'stretch') drawStretchLabels();
  if (S.mode === 'outputs') drawOutputStarts();
  if (S.showNodes) drawNodes();
  for (const [p, c] of [[S.hover, '#fff'], [S.pinned, '#ffb347']]) {
    if (p < 0 || px.plan[p] !== S.plan) continue;
    const q = pxScreen(p);
    if (!q) continue;
    const [x, y] = q;
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI); ctx.stroke();
  }
}

// drawPixels3D draws the pixels as dots sized by their pitch and depth,
// far ones first. It keeps each pixel's screen position for picking.
function drawPixels3D(col, dead) {
  const px = S.geo.pixels, scr = S.scr, cw = canvas.clientWidth, ch = canvas.clientHeight;
  const shown = [];
  for (const p of S.drawable) {
    const q = toScreen(px.x[p], px.y[p], px.z[p]);
    if (!q || q[0] < -20 || q[1] < -20 || q[0] > cw + 20 || q[1] > ch + 20) continue;
    scr[3 * p] = q[0]; scr[3 * p + 1] = q[1]; scr[3 * p + 2] = q[2];
    shown.push(p);
  }
  shown.sort((a, b) => scr[3 * b + 2] - scr[3 * a + 2]);
  S.shown = shown;
  for (const p of shown) {
    const x = scr[3 * p], y = scr[3 * p + 1];
    const s = Math.min(Math.max((px.dl[p] || 0.03) * S.proj.ppm / scr[3 * p + 2] * 0.9, 2), 14);
    if (dead.has(p)) {
      ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      continue;
    }
    let cr = 0, cg = 0, cb = 0;
    if (col) { cr = col[3 * p]; cg = col[3 * p + 1]; cb = col[3 * p + 2]; }
    // Unlit pixels show as dim blue, so the runs read against the model.
    if (cr + cg + cb < 24) { cr = 45; cg = 82; cb = 175; }
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    if (s < 4) { ctx.fillRect(x - s / 2, y - s / 2, s, s); continue; }
    ctx.beginPath(); ctx.arc(x, y, s / 2, 0, 2 * Math.PI); ctx.fill();
  }
}

// toScreen maps a world position to CSS px. In 3-D it also returns the
// view depth, or null behind the camera; z is ignored on an SVG plan.
function toScreen(x, y, z) {
  if (!S.three) return [x * S.view.k + S.view.tx, y * S.view.k + S.view.ty];
  const m = S.proj.m;
  z = z || 0;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw < S.proj.near) return null;
  return [(cx / cw + 1) * 0.5 * S.proj.w, (1 - cy / cw) * 0.5 * S.proj.h, cw];
}
const pxScreen = (p) => toScreen(S.geo.pixels.x[p], S.geo.pixels.y[p], S.geo.pixels.z[p]);

// edgePixels groups the drawable pixels by strip edge.
let edgePixelsCache = null;
function edgePixels() {
  if (edgePixelsCache && edgePixelsCache.plan === S.plan) return edgePixelsCache.map;
  const map = new Map();
  for (const p of S.drawable) {
    const e = S.geo.pixels.edge[p];
    if (e < 0) continue;
    if (!map.has(e)) map.set(e, []);
    map.get(e).push(p);
  }
  edgePixelsCache = { plan: S.plan, map };
  return map;
}

// Arrows point the way u increases, one per edge, at its middle.
function drawArrows() {
  const m = S.mappings.get(S.mappingId);
  if (!m) return;
  const px = S.geo.pixels;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
  for (const pixels of edgePixels().values()) {
    const ps = pixels.filter((p) => m.u[p] !== null).sort((a, b) => m.u[a] - m.u[b]);
    if (ps.length < 4) continue;
    const i = Math.floor(ps.length / 2);
    const a = pxScreen(ps[i - 1]), b = pxScreen(ps[i + 1]), c = pxScreen(ps[i]);
    if (!a || !b || !c) continue;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const [cx, cy] = c;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -6); ctx.lineTo(-3, 0); ctx.lineTo(-6, 6); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // The origin.
  if (m.flow) {
    const nd = S.geo.nodes[m.flow.origin];
    const q = nd && nd.plan === S.plan && nd.x !== null ? toScreen(nd.x, nd.y, nd.z) : null;
    if (q) {
      const [x, y] = q;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.stroke();
      label(`origin ${nd.id}`, x + 10, y + 18, '#fff');
    }
  }
}

function drawStretchLabels() {
  const m = S.mappings.get(S.mappingId);
  if (!m || !m.flow) return;
  const px = S.geo.pixels;
  for (const [e, pixels] of edgePixels()) {
    const s = m.flow.edge_stretch[e];
    if (s === null || pixels.length < 2) continue;
    const q = pxScreen(pixels[Math.floor(pixels.length / 2)]);
    if (!q) continue;
    const [x, y] = q;
    label('×' + s.toFixed(2), x + 6, y + 14, '#eee');
  }
}

function label(text, x, y, color) {
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

// Nodes, anchors, sync points and links. Measured anchors are solid
// green, estimated ones dashed amber.
function drawNodes() {
  const g = S.geo, px = g.pixels;
  const pos = (i) => { const n = g.nodes[i]; return n && n.plan === S.plan && n.x !== null ? toScreen(n.x, n.y, n.z) : null; };
  ctx.lineWidth = 1.5;
  for (const e of g.edges) {
    if (e.kind === 'strip') continue;
    const a = pos(e.from), b = pos(e.to);
    if (!a || !b) continue;
    ctx.setLineDash(e.kind === 'link' ? [6, 4] : [2, 3]);
    ctx.strokeStyle = e.kind === 'link' ? '#c4b5fd' : '#7dd3fc';
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    if (S.showLabels) label(e.kind === 'link' ? 'link' : `gap ${e.length.toFixed(2)} m`, (a[0] + b[0]) / 2 - 20, (a[1] + b[1]) / 2 + 16, ctx.strokeStyle);
  }
  ctx.setLineDash([]);
  for (const r of g.runs) {
    for (const an of r.anchors) {
      if (an.source === 'end' || px.plan[an.pixel] !== S.plan || px.x[an.pixel] === null) continue;
      const q = pxScreen(an.pixel);
      if (!q) continue;
      const [x, y] = q;
      const measured = an.source === 'measured';
      ctx.strokeStyle = measured ? '#5ddc8a' : '#ffb347';
      ctx.lineWidth = 2;
      ctx.setLineDash(measured ? [] : [3, 3]);
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  g.nodes.forEach((n, i) => {
    const p = pos(i);
    if (!p) return;
    const [x, y] = p;
    ctx.fillStyle = n.sync ? '#f472b6' : '#e5e7eb';
    ctx.beginPath();
    if (n.sync) { ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); } else ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
    ctx.fill();
    if (S.showLabels) label(n.id, x + 8, y - 6, n.sync ? '#f9a8d4' : '#e5e7eb');
  });
}

// ---------- diagnostic views ----------

async function loadMapping(id) {
  if (!S.mappings.has(id)) S.mappings.set(id, await api('/api/map/mappings/' + encodeURIComponent(id)));
  return S.mappings.get(id);
}

async function setMode(mode) {
  S.mode = mode;
  $('mappingWrap').hidden = !(mode === 'flow' || mode === 'stretch');
  $('areaWrap').hidden = mode !== 'areas';
  $('outputWrap').hidden = mode !== 'outputs';
  S.overlay = null;
  const legend = $('legend');
  legend.innerHTML = '';
  if (mode === 'flow' || mode === 'stretch') {
    const m = await loadMapping(S.mappingId);
    const out = new Uint8Array(S.n * 3);
    for (let p = 0; p < S.n; p++) {
      let c;
      if (mode === 'flow') {
        c = m.u[p] === null ? [70, 70, 70] : ramp((m.u[p] - m.min) / ((m.max - m.min) || 1));
      } else {
        c = m.u[p] === null ? [70, 70, 70] : stretchColor(m.stretch[p]);
      }
      out.set(c, 3 * p);
    }
    S.overlay = out;
    if (mode === 'flow') {
      const stops = [0, .25, .5, .75, 1].map((t) => `rgb(${ramp(t)})`).join(',');
      const unit = m.kind === 'index' ? '' : ' m';
      legend.innerHTML = `<div>u in <b>${esc(m.id)}</b> (${esc(m.kind)}); arrows point the way u grows</div>
        <div class="ramp" style="background:linear-gradient(90deg,${stops})"></div>
        <div class="row"><span>${fmt(m.min, 2)}${unit}</span><span>${fmt(m.max, 2)}${unit}</span></div>`;
    } else {
      const stops = [1 / 1.5, 1 / 1.2, 1, 1.2, 1.5].map((s) => `rgb(${stretchColor(s)})`).join(',');
      legend.innerHTML = `<div>stretch in <b>${esc(m.id)}</b>${m.flow ? '' : ' (not a flow: 1 everywhere)'}</div>
        <div class="ramp" style="background:linear-gradient(90deg,${stops})"></div>
        <div class="row"><span>compressed ≤×0.67</span><span>1</span><span>stretched ≥×1.5</span></div>`;
    }
  } else if (mode === 'areas') {
    S.overlay = areaOverlay(legend);
  } else if (mode === 'outputs') {
    S.overlay = outputOverlay(legend);
  }
  if (S.showNodes) {
    legend.insertAdjacentHTML('beforeend', `<div><span class="sw" style="background:#5ddc8a"></span>measured anchor
      <span class="sw" style="background:#ffb347"></span>estimated anchor
      <span class="sw" style="background:#f472b6"></span>sync node</div>`);
  }
  markDirty();
}

function inRanges(ranges, cb) {
  for (const [a, b] of ranges) for (let p = a; p <= b; p++) cb(p);
}

// outputs lists every controller output with its global pixel range and
// a color: the palette first, then golden-angle hues past its end.
let outputsCache = null;
function outputs() {
  if (outputsCache) return outputsCache;
  outputsCache = [];
  for (const c of S.geo.controllers) {
    for (const o of c.outputs) {
      const i = outputsCache.length;
      const color = i < PALETTE.length ? PALETTE[i] : hsl((i * 137.508) % 360, 0.75, 0.6);
      outputsCache.push({ controller: c.id, pin: o.pin, start: o.start, first: c.base + o.start, last: c.base + o.start + o.count - 1, count: o.count, color });
    }
  }
  return outputsCache;
}
const outputOf = (p) => outputs().find((o) => p >= o.first && p <= o.last);

// outputOverlay colors each pixel by the controller output it's wired to.
// Picking a controller dims the others' pixels.
function outputOverlay(legend) {
  const out = new Uint8Array(S.n * 3).fill(40);
  const pick = $('outputPick').value;
  const shown = outputs().filter((o) => !pick || o.controller === pick);
  for (const o of shown) inRanges([[o.first, o.last]], (p) => out.set(o.color, 3 * p));
  let html = '<div class="muted">rings mark where data enters each output</div>', ctrl = '';
  for (const o of shown) {
    if (o.controller !== ctrl) { ctrl = o.controller; html += `<div><b>${esc(ctrl)}</b></div>`; }
    html += `<div><span class="sw" style="background:rgb(${o.color})"></span>pin ${o.pin}: ${o.count} px (${o.start}–${o.start + o.count - 1})</div>`;
  }
  legend.innerHTML = html;
  return out;
}

// drawOutputStarts rings each shown output's first pixel, where its data
// enters, and names it.
function drawOutputStarts() {
  const pick = $('outputPick').value;
  for (const o of outputs()) {
    if (pick && o.controller !== pick) continue;
    if (S.geo.pixels.plan[o.first] !== S.plan || S.geo.pixels.x[o.first] === null) continue;
    const q = pxScreen(o.first);
    if (!q) continue;
    ctx.strokeStyle = `rgb(${o.color})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(q[0], q[1], 8, 0, 2 * Math.PI); ctx.stroke();
    label(`${o.controller} pin ${o.pin}`, q[0] + 10, q[1] - 8, `rgb(${o.color})`);
  }
}

function areaOverlay(legend) {
  const g = S.geo;
  const out = new Uint8Array(S.n * 3).fill(40);
  const [kind, id] = S.pick.split(/:(.*)/s);
  const area = (aid) => g.areas.find((a) => a.id === aid);
  let parts = [];
  if (kind === 'area') parts = [{ name: id, area: area(id) }];
  else {
    const z = g.zones.find((z) => z.id === id);
    if (z) parts = z.segments.map((s, i) => ({ name: `segment ${i}: ${s.area}`, area: area(s.area) }));
  }
  // Bigger areas paint first so smaller ones stay visible where they
  // overlap.
  const order = parts.map((_, i) => i).filter((i) => parts[i].area).sort((a, b) => parts[b].area.count - parts[a].area.count);
  for (const i of order) {
    const c = PALETTE[i % PALETTE.length];
    inRanges(parts[i].area.ranges, (p) => out.set(c, 3 * p));
  }
  legend.innerHTML = parts.map((pt, i) => `<div><span class="sw" style="background:rgb(${PALETTE[i % PALETTE.length]})"></span>${esc(pt.name)}</div>`).join('');
  return out;
}

// ---------- interaction ----------

function bindUI() {
  $('view').onchange = (e) => setMode(e.target.value);
  $('mapping').onchange = (e) => { S.mappingId = e.target.value; setMode(S.mode); };
  $('areaPick').onchange = (e) => { S.pick = e.target.value; setMode(S.mode); };
  $('outputPick').onchange = () => setMode(S.mode);
  $('plan').onchange = (e) => selectPlan(+e.target.value);
  $('showNodes').onchange = (e) => { S.showNodes = e.target.checked; setMode(S.mode); };
  $('showLabels').onchange = (e) => { S.showLabels = e.target.checked; markDirty(); };
  $('fit').onclick = fit;
  $('copyView').onclick = copyView;
  $('panelToggle').onclick = () => { document.body.classList.toggle('nopanel'); resize(); markDirty(); };
  $('fps').onchange = subscribe;
  for (const b of $('showSeg').querySelectorAll('button')) b.onclick = () => setShow(b.dataset.show);
  setShow(S.show);
  $('streamArea').onchange = subscribe;

  // Preview clock.
  const control = async (body) => { try { setPreview(await post('/api/map/preview', body)); } catch (e) { console.warn(e); } };
  $('playPause').onclick = () => control({ action: S.preview && S.preview.paused ? 'resume' : 'pause' });
  $('stepBack').onclick = () => control({ action: 'step', seconds: -1 / S.geo.house_fps });
  $('stepFwd').onclick = () => control({ action: 'step', seconds: 1 / S.geo.house_fps });
  $('live').onclick = () => control({ action: 'live' });
  const speed = $('speed');
  speed.oninput = () => { $('speedOut').textContent = speedLabel(10 ** +speed.value); };
  speed.onchange = () => control({ action: 'speed', speed: 10 ** +speed.value });
  // Scrubbing pauses, then seeks relative to where the drag started.
  const scrub = $('scrub');
  let scrubBase = null, scrubBusy = false, scrubWant = null;
  const seek = async () => {
    if (scrubBusy) return;
    scrubBusy = true;
    while (scrubWant !== null) { const t = scrubWant; scrubWant = null; await control({ action: 'seek', t }); }
    scrubBusy = false;
  };
  scrub.oninput = async () => {
    if (scrubBase === null) {
      const st = await post('/api/map/preview', { action: 'pause' });
      setPreview(st);
      scrubBase = st.t;
    }
    scrubWant = scrubBase + +scrub.value;
    seek();
  };
  scrub.onchange = () => { scrubBase = null; scrub.value = 0; };

  // Preview layers.
  $('pushForm').onsubmit = async (e) => {
    e.preventDefault();
    $('pError').textContent = '';
    const [kind, id] = $('pLook').value.split(/:(.*)/s);
    let params;
    try { params = $('pParams').value.trim() ? JSON.parse($('pParams').value) : undefined; } catch (err) { $('pError').textContent = 'params: ' + err.message; return; }
    try {
      await post('/api/map/preview/layers', { target: $('pTarget').value, [kind]: id, params });
      pollPreview();
    } catch (err) { $('pError').textContent = err.message; }
  };
  $('pClear').onclick = async () => { await api('/api/map/preview/layers', { method: 'DELETE' }); pollPreview(); };
  $('pPromote').onclick = () => promote([]);

  // Zoom, pan, pinch, hover and tap. In 3-D, scene.js's orbit controls
  // move the camera; this only tells taps from drags.
  const pointers = new Map();
  let drag = null, pinch = null, moved = false;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (S.three) return;
    zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    moved = false;
    if (pointers.size === 1) drag = { x: e.offsetX, y: e.offsetY, tx: S.view.tx, ty: S.view.ty };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: S.view.k }; drag = null; }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') hoverAt(e.offsetX, e.offsetY);
      return;
    }
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (S.three) {
      if (drag && Math.abs(e.offsetX - drag.x) + Math.abs(e.offsetY - drag.y) > 4) moved = true;
      if (pointers.size > 1) moved = true;
    } else if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.k * d / pinch.d) / S.view.k);
      moved = true;
    } else if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) { S.view.tx = drag.tx + dx; S.view.ty = drag.ty + dy; markDirty(); }
    }
  });
  const up = (e) => {
    if (pointers.has(e.pointerId) && !moved && pointers.size === 1) {
      const p = nearest(e.offsetX, e.offsetY, e.pointerType === 'mouse' ? 12 : 24);
      S.pinned = p;
      S.hover = -1;
      inspect(p);
      document.dispatchEvent(new CustomEvent('glowstack:tap', { detail: p })); // calibrate.js
      markDirty();
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); drag = pinch = null; });
  canvas.addEventListener('pointerleave', () => { if (S.hover >= 0) { S.hover = -1; markDirty(); } });
  canvas.addEventListener('dblclick', fit);
}

function zoomAt(x, y, f) {
  const v = S.view;
  const k = Math.min(Math.max(v.k * f, 0.5), 20000);
  f = k / v.k;
  v.tx = x - (x - v.tx) * f;
  v.ty = y - (y - v.ty) * f;
  v.k = k;
  markDirty();
}

function nearest(sx, sy, radius) {
  const { k, tx, ty } = S.view, px = S.geo.pixels;
  let best = -1, bd = radius * radius;
  if (S.three) {
    // Nearest on screen; shown is far first, so ties go to the nearer.
    const scr = S.scr;
    for (const p of S.shown) {
      const dx = scr[3 * p] - sx, dy = scr[3 * p + 1] - sy;
      const d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = p; }
    }
    return best;
  }
  for (const p of S.drawable) {
    const dx = px.x[p] * k + tx - sx, dy = px.y[p] * k + ty - sy;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

let hoverTimer = 0;
function hoverAt(x, y) {
  const p = nearest(x, y, 12);
  if (p === S.hover) return;
  S.hover = p;
  markDirty();
  if (S.pinned >= 0) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => inspect(p), 60);
}

let inspectSeq = 0;
async function inspect(p) {
  const body = $('inspectBody');
  $('pinHint').textContent = S.pinned >= 0 ? 'pinned: tap empty space to release' : 'hover or tap a pixel';
  if (p < 0) { body.innerHTML = 'Nothing selected.'; body.classList.add('muted'); return; }
  const seq = ++inspectSeq;
  let d;
  try { d = await api('/api/map/pixels/' + p + showQ()); } catch (e) { return; }
  if (seq !== inspectSeq) return;
  body.classList.remove('muted');
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const sh = d.showing;
  const layer = sh
    ? `${esc(sh.layer)}${sh.preview ? ' <b>(preview)</b>' : ''}${sh.effect ? ' · ' + esc(sh.effect) : ''}${sh.preset ? ' · preset ' + esc(sh.preset) : ''}${sh.target ? ' on ' + esc(sh.target) : ''}`
    : '<span class="muted">none</span>';
  const maps = d.mappings.map((m) => row(esc(m.id), `u ${fmt(m.u)}${m.kind === 'index' ? '' : ' m'}${m.stretch !== null && Math.abs(m.stretch - 1) > 1e-4 ? ` · stretch ×${fmt(m.stretch)}` : ''}`)).join('');
  body.innerHTML = `<table class="kv">
    ${row('pixel', `#${d.id} · <b>${esc(d.controller)}:${d.index}</b>${d.dead ? ' (dead)' : ''}`)}
    ${row('output', (() => { const o = outputOf(d.id); return o ? `${esc(o.controller)} pin ${o.pin} · ${d.id - o.first + 1} of ${o.count}` : '<span class="muted">none</span>'; })())}
    ${row('run', d.run ? `${esc(d.run)} · pixel ${d.run_pixel}` : '<span class="muted">none</span>')}
    ${row('edge', d.edge ? `${esc(d.edge)} · ${fmt(d.dist)} m` : '—')}
    ${row('size dl', d.dl === null ? '—' : fmt(d.dl * 1000, 1) + ' mm')}
    ${S.three
    ? row('position', d.x === null ? '—' : `${fmt(d.x, 2)}, ${fmt(d.y, 2)}, ${fmt(d.z, 2)} m`)
    : row('plan x, y', d.x === null ? '—' : `${fmt(d.x, 2)}, ${fmt(d.y, 2)} m`)}
    ${row('areas', esc(d.areas.join(', ') || '—'))}
    ${row('zones', esc(d.zones.join(', ') || '—'))}
    ${row('showing', layer)}
    ${row('color', d.rgb ? `<span class="chip" style="background:${d.rgb}"></span>${d.rgb}` : '—')}
    ${maps}
  </table>`;
}

// ---------- stream ----------

let ws = null, ranges = [[0, -1]];
function connect() {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/map/ws';
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { S.connected = true; subscribe(); };
  ws.onclose = () => { S.connected = false; badge(); setTimeout(connect, 1000); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'subscribed') {
        // The config was reloaded: the pixel table may have changed.
        if (S.geo && m.gen !== S.geo.gen) { location.reload(); return; }
        ranges = m.ranges;
        S.rgb.fill(0);
        $('streamInfo').textContent = `${m.count} px at up to ${m.fps} fps` + (m.unknown ? ` (unknown: ${m.unknown.join(', ')})` : '');
      }
      return;
    }
    const dv = new DataView(e.data);
    if (dv.getUint8(0) !== 1) return;
    const flags = dv.getUint8(1);
    S.frame = { seq: dv.getUint32(4, true), t: dv.getFloat64(8, true), preview: !!(flags & 1), paused: !!(flags & 2) };
    const data = new Uint8Array(e.data, 16);
    let o = 0;
    for (const [a, b] of ranges) {
      const len = (b - a + 1) * 3;
      S.rgb.set(data.subarray(o, o + len), a * 3);
      o += len;
    }
    badge();
    if (S.mode === 'live') markDirty();
  };
}

function subscribe() {
  if (!ws || ws.readyState !== 1) return;
  const area = $('streamArea').value;
  ws.send(JSON.stringify({ fps: +$('fps').value, areas: area ? [area] : [], show: S.show }));
}

// setShow picks what the map shows: '' the preview (house frames when
// nothing is being previewed), 'house' what the lights show.
function setShow(v) {
  S.show = v;
  localStorage.setItem('glowstack.show', v);
  for (const b of $('showSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.show === v);
  subscribe();
  badge();
  refreshSide();
}

function badge() {
  const b = $('badge');
  if (!S.connected) { b.textContent = 'disconnected'; b.className = 'badge off'; return; }
  const f = S.frame;
  const hidden = S.show === 'house' && S.preview && S.preview.previewing;
  b.textContent = f.preview ? (f.paused ? 'preview · paused' : 'preview') : hidden ? 'house · preview hidden' : 'house';
  b.className = 'badge ' + (f.preview ? 'preview' : 'house');
}

// ---------- preview state, power ----------

const speedLabel = (s) => (s >= 1 ? s.toFixed(s >= 10 ? 0 : 1) : s.toFixed(2)) + '×';

function setPreview(st) {
  S.preview = st;
  $('playPause').textContent = st.paused ? '▶' : '⏸';
  $('playPause').classList.toggle('on', st.paused);
  $('live').classList.toggle('on', st.following);
  if (document.activeElement !== $('speed')) {
    $('speed').value = Math.log10(st.speed);
    $('speedOut').textContent = speedLabel(st.speed);
  }
  const d = new Date(st.t * 1000);
  const off = st.offset;
  $('clockText').textContent = `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    (st.following ? ' · following the house' : ` · ${off >= 0 ? '+' : '−'}${Math.abs(off).toFixed(2)} s vs house`);
  $('pLayers').innerHTML = st.layers.map((l) =>
    `<li><span>${esc(l.id)} · ${esc(l.effect || 'preset ' + l.preset)} on ${esc(l.target)} <code>${esc(JSON.stringify(l.params || {}))}</code></span>
     <button class="golive" data-promote="${esc(l.id)}" title="Move this layer onto the lights">→ live</button>
     <button data-remove="${esc(l.id)}" title="Remove">✕</button></li>`).join('');
  for (const b of $('pLayers').querySelectorAll('button[data-remove]')) {
    b.onclick = async () => { await api('/api/map/preview/layers/' + encodeURIComponent(b.dataset.remove), { method: 'DELETE' }); pollPreview(); };
  }
  for (const b of $('pLayers').querySelectorAll('button[data-promote]')) b.onclick = () => promote([b.dataset.promote]);
  $('pPromote').disabled = st.layers.length === 0;
  badge();
}

// promote moves preview layers (all of them if ids is empty) onto the
// house stack, so the lights show them.
async function promote(ids) {
  $('pError').textContent = '';
  try { await post('/api/map/preview/promote', ids.length ? { ids } : {}); } catch (err) { $('pError').textContent = err.message; }
  pollPreview();
}

async function pollPreview() {
  try { setPreview(await api('/api/map/preview')); } catch (e) { /* offline */ }
}

async function refreshSide() {
  if (document.body.classList.contains('nopanel')) return;
  if (S.pinned >= 0) inspect(S.pinned);
  let pw;
  try { pw = await api('/api/map/power' + showQ()); } catch (e) { return; }
  const st = pw.stage;
  const scale = st ? st.scale.toFixed(3) + (st.group ? ` (group: ${esc(st.group)})` : '') : 'n/a (output stage not reporting)';
  const rows = pw.estimate.map((o) => {
    if (!o.known) return `<div class="pw"><div class="row"><span>${esc(o.controller)} pin ${o.pin}</span><span class="muted">no led_ma</span></div></div>`;
    const pct = o.max_ma ? Math.min(100, 100 * o.ma / o.max_ma) : 0;
    return `<div class="pw"><div class="row"><span>${esc(o.controller)} pin ${o.pin} · ${o.count} px</span>
      <span>${(o.ma / 1000).toFixed(2)} A${o.max_ma ? ' / ' + (o.max_ma / 1000).toFixed(1) + ' A' : ''}</span></div>
      ${o.max_ma ? `<div class="bar"><span class="${o.ma > o.max_ma ? 'hot' : ''}" style="width:${pct}%"></span></div>` : ''}</div>`;
  }).join('');
  const totals = pw.controllers.map((c) => `${esc(c.controller)} ${(c.ma / 1000).toFixed(2)} A${c.max_ma ? ' / ' + (c.max_ma / 1000).toFixed(1) + ' A' : ''}`).join(' · ');
  // The output stage's own figures are for the house frames it sent,
  // after power limiting.
  const amps = (ma) => (ma / 1000).toFixed(2) + ' A';
  const stageRow = (o) => `<div class="row"><span>${esc(o.controller)}${o.pin ? ' pin ' + o.pin : ' total'}</span>
      <span>${amps(o.ma)}${o.requested_ma > o.ma + 0.5 ? ` <span class="muted">(asked ${amps(o.requested_ma)})</span>` : ''}${o.max_ma ? ' / ' + (o.max_ma / 1000).toFixed(1) + ' A' : ''}${o.need < 0.9995 ? ` · <b>×${o.need.toFixed(3)}</b>` : ''}</span></div>`;
  const stage = st ? `<div class="stage"><div class="muted">output stage (house frames, after limiting)</div>${(st.outputs || []).map(stageRow).join('')}${(st.controllers || []).map(stageRow).join('')}</div>` : '';
  $('power').classList.toggle('muted', !pw.frame);
  $('power').innerHTML = pw.frame ? `${rows}<div class="muted">estimate totals: ${totals}</div><div>limit scale: <b>${scale}</b></div>${stage}` : 'No frame yet.';
}

main().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<pre class="error">${esc(e.stack || e)}</pre>`); });
