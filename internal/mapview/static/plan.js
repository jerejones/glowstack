// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The live map's 2-D view of an SVG plan, with the same interface as
// scene.js so app.js and overlay.js don't care which one is open. It
// draws on the map canvas: the plan (inverted, as plans are black on
// white), the selection halo, then the pixels as squares sized by their
// pitch. It
// pans and zooms with a finger, two fingers or the wheel. World units
// are plan meters, y down as in the SVG.
import { clamp, nearestRun } from './util.js';

// openPlan returns the view for plan (the geometry's plan entry, index
// planIndex). opts: px, rgb (live frame, 3 bytes per pixel), onChange,
// onCamera.
export function openPlan(canvas, plan, planIndex, opts) {
  const { px } = opts;
  const n = px.count;
  let W = 1, H = 1, dpr = 1, insetTop = 0, insetBottom = 0, padSide = 0, padEdge = 0;
  const v = { k: 50, tx: 0, ty: 0 };
  let auto = true, version = 0;
  let colors = null, gray = new Set(), selection = null;
  let img = null, cache = null;

  const drawn = [];
  for (let p = 0; p < n; p++) if (px.plan[p] === planIndex && px.x[p] !== null) drawn.push(p);
  const isDrawn = new Uint8Array(n);
  for (const p of drawn) isDrawn[p] = 1;
  const dead = new Set(px.dead);

  const im = new Image();
  im.onload = () => { img = im; cache = null; if (auto) fit(); opts.onChange(); };
  im.src = plan.url;

  const changed = () => { version++; opts.onChange(); };
  const emit = () => opts.onCamera && opts.onCamera(api.cameraState());

  function planRect() {
    let [x, y, w, h] = plan.view_box;
    if (!(w > 0 && h > 0)) {
      if (!img) return null;
      x = 0; y = 0; w = img.naturalWidth; h = img.naturalHeight;
    }
    return { x: x * plan.scale, y: y * plan.scale, w: w * plan.scale, h: h * plan.scale };
  }

  // fitBox frames a world box in the area between the insets.
  function fitBox(x0, y0, x1, y1) {
    const w = Math.max(x1 - x0, 0.5), h = Math.max(y1 - y0, 0.5);
    const hf = Math.max(H - insetTop - insetBottom, 1);
    // Its own 15% of air, and never less than the pad the page asks for.
    const k = Math.min(W / (w * 1.15), hf / (h * 1.15), Math.max(W - 2 * padSide, 1) / w, Math.max(hf - 2 * padEdge, 1) / h);
    v.k = k; v.tx = W / 2 - (x0 + w / 2) * k; v.ty = insetTop + hf / 2 - (y0 + h / 2) * k;
    changed();
  }
  function bbox(ids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ids) {
      if (!isDrawn[p]) continue;
      x0 = Math.min(x0, px.x[p]); x1 = Math.max(x1, px.x[p]);
      y0 = Math.min(y0, px.y[p]); y1 = Math.max(y1, px.y[p]);
    }
    return isFinite(x0) ? [x0, y0, x1, y1] : null;
  }
  function fit() {
    let b = bbox(drawn);
    if (!b) { const r = planRect(); b = r ? [r.x, r.y, r.x + r.w, r.y + r.h] : [0, 0, 10, 10]; }
    fitBox(...b);
  }

  // ----- pan, zoom, pinch -----
  function zoomAt(x, y, f) {
    const k = clamp(v.k * f, 0.5, 20000);
    f = k / v.k;
    v.tx = x - (x - v.tx) * f; v.ty = y - (y - v.ty) * f; v.k = k;
    moved();
  }
  function moved() {
    if (auto) { auto = false; emit(); }
    changed();
  }
  const pointers = new Map();
  let drag = null, pinch = null;
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = at(e);
    zoomAt(x, y, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, at(e));
    if (pointers.size === 1) drag = { start: at(e), tx: v.tx, ty: v.ty, on: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k: v.k };
      drag = null;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const q = at(e);
    pointers.set(e.pointerId, q);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.k * d / pinch.d) / v.k);
    } else if (drag) {
      const dx = q[0] - drag.start[0], dy = q[1] - drag.start[1];
      if (!drag.on && Math.abs(dx) + Math.abs(dy) > 6) drag.on = true;
      if (drag.on) { v.tx = drag.tx + dx; v.ty = drag.ty + dy; moved(); }
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  // ----- drawing -----
  // The plan is cached per view: lightness inverted, hues kept, drawn
  // twice to thicken its antialiased hairlines.
  function planLayer(r) {
    const key = [v.k, v.tx, v.ty, W, H, dpr].join();
    if (cache && cache.key === key) return cache.canvas;
    const off = (cache && cache.canvas) || document.createElement('canvas');
    off.width = Math.round(W * dpr); off.height = Math.round(H * dpr);
    const o = off.getContext('2d');
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.filter = 'invert(1) hue-rotate(180deg)';
    for (let i = 0; i < 2; i++) o.drawImage(img, r.x * v.k + v.tx, r.y * v.k + v.ty, r.w * v.k, r.h * v.k);
    cache = { key, canvas: off };
    return off;
  }

  // sizeOf is the side of pixel p's square, in CSS px.
  const sizeOf = (p) => clamp((px.dl[p] || 0.03) * v.k * 1.275, 4, 24);

  // haloPath strokes a set of pixels as one path, so its translucency
  // doesn't build up where it overlaps itself.
  function haloPath(ctx, ranges) {
    ctx.beginPath();
    for (const [a, b] of ranges) {
      let seq = [];
      const flush = () => {
        if (!seq.length) return;
        for (let i = 0; i < seq.length; i++) {
          const p = seq[i];
          const x = px.x[p] * v.k + v.tx, y = px.y[p] * v.k + v.ty;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        if (seq.length === 1) ctx.lineTo(px.x[seq[0]] * v.k + v.tx + 0.1, px.y[seq[0]] * v.k + v.ty);
        seq = [];
      };
      for (let p = a; p <= b; p++) {
        if (!isDrawn[p] || (seq.length && px.run[p] !== px.run[seq[seq.length - 1]])) flush();
        if (isDrawn[p]) seq.push(p);
      }
      flush();
    }
  }

  function render(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0e10';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = planRect();
    const col = colors || opts.rgb;
    // The lights are the point: the plan steps back while any are lit.
    let lit = false;
    for (let i = 0; i < col.length && !lit; i++) lit = col[i] > 8;
    ctx.globalAlpha = lit ? 0.45 : 1;
    if (img && r) ctx.drawImage(planLayer(r), 0, 0, W, H);
    ctx.globalAlpha = 1;

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (selection && selection.length) {
      ctx.globalAlpha = 0.5; ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(15, 1.6 * clamp(0.017 * v.k * 1.275, 4, 24));
      haloPath(ctx, selection); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const p of drawn) {
      if (!isDrawn[p]) continue;
      const s = sizeOf(p);
      const x = px.x[p] * v.k + v.tx, y = px.y[p] * v.k + v.ty;
      if (x < -s || y < -s || x > W + s || y > H + s) continue;
      if (dead.has(p)) {
        ctx.strokeStyle = '#6b6b6b'; ctx.lineWidth = 1;
        ctx.strokeRect(x - s / 2, y - s / 2, s, s);
        continue;
      }
      let cr = col[3 * p], cg = col[3 * p + 1], cb = col[3 * p + 2];
      if (!(cr | cg | cb) && !gray.has(px.controller[p])) {
        // Unlit: a dim outline, so off doesn't read as missing.
        ctx.strokeStyle = '#333a44'; ctx.lineWidth = 1;
        ctx.strokeRect(x - s / 2, y - s / 2, s, s);
        continue;
      }
      if (gray.has(px.controller[p])) { const l = Math.round(56 + 0.25 * (0.3 * cr + 0.59 * cg + 0.11 * cb)); cr = cg = cb = l; }
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      const big = gray.has(px.controller[p]) ? s : Math.min(s * 1.5, 30); // a lit pixel outweighs the plan's lines
      ctx.fillRect(x - big / 2, y - big / 2, big, big);
    }
    return true;
  }

  const api = {
    kind: '2d',
    layers: [],
    resize(cssW, cssH, ratio) {
      W = Math.max(cssW, 1); H = Math.max(cssH, 1); dpr = ratio;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      cache = null;
      this.relayout();
    },
    setInsets(top, bottom, pad = {}) {
      const side = pad.side || 0, edge = pad.edge || 0;
      if (top === insetTop && bottom === insetBottom && side === padSide && edge === padEdge) return;
      insetTop = top; insetBottom = bottom; padSide = side; padEdge = edge;
      this.relayout();
    },
    relayout() { if (auto) fit(); else changed(); },
    setPixelVisibility(mask) {
      for (const p of drawn) isDrawn[p] = !mask || mask[p] ? 1 : 0;
      changed();
    },
    setColors(arr) { colors = arr; changed(); },
    frameArrived() {},
    setGray(ctrls) { gray = ctrls; changed(); },
    setSelection(sel) { selection = sel; changed(); },
    render,
    tick: () => false,
    toScreen: (x, y) => [x * v.k + v.tx, y * v.k + v.ty, 1],
    get version() { return version; },
    size: () => ({ w: W, h: H }),
    pickPixel(sx, sy, radius) {
      let best = -1, bd = radius * radius;
      for (const p of drawn) {
      if (!isDrawn[p]) continue;
        const dx = px.x[p] * v.k + v.tx - sx, dy = px.y[p] * v.k + v.ty - sy;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },
    pickRun(sx, sy, radius, runs) {
      return nearestRun(runs, (p) => (isDrawn[p] ? [px.x[p] * v.k + v.tx, px.y[p] * v.k + v.ty] : null), sx, sy, radius);
    },
    screenOf: (p) => (isDrawn[p] ? [px.x[p] * v.k + v.tx, px.y[p] * v.k + v.ty] : null),
    pixelRadius: (p) => sizeOf(p) / 2,
    // litSize is how wide pixel p draws when it is lit, in CSS px (render).
    litSize: (p) => Math.min(sizeOf(p) * 1.5, 30),
    setView(name) { if (name === 'fit' || name === 'street') { auto = true; fit(); emit(); } },
    cameraState: () => ({ mode: auto ? 'fit' : 'free', auto, hasFree: false }),
    restore() { auto = true; fit(); emit(); },
    forget() { this.restore(); },
    hold: () => ({ v: { ...v }, auto }),
    release(h) {
      if (!h) return;
      auto = h.auto;
      if (auto) fit(); else { Object.assign(v, h.v); changed(); }
      emit();
    },
    dragging: () => false,
    fitAll() { auto = true; fit(); },
    frameIds(ids, opts = {}) {
      const b = bbox(ids);
      if (!b) return;
      auto = false;
      const pad = Math.max(0.5, Math.hypot(b[2] - b[0], b[3] - b[1]) * (opts.pad ?? 0));
      fitBox(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad);
    },
    frameTight(ids) {
      const b = bbox(ids);
      if (!b) return;
      auto = false;
      fitBox(b[0], b[1], b[2], b[3]);
    },
  };
  return api;
}
