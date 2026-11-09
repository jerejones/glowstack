// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The live map's 3-D view of a scene model (.glb), on three.js. It owns
// the WebGL canvas: the building (see-through lines over faint
// surfaces), every pixel as one Points object whose color buffer is
// updated per frame, a translucent halo along the selected pixels,
// and the camera: computed framing, the site's view, Fit and the camera
// remembered per device. Picking is on demand: pixels and runs are
// projected to the screen only when a tap or hover asks.
//
// Glowstack positions are meters with Z up; three.js is Y up, so
// (x, y, z) is (x, z, −y) here. North is +y.
import { centerShift, fitDepth } from './map-frame.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { load, save, clamp, nearestRun } from './util.js';

const DEFAULTS = {
  lines: { color: '#d9e8ff', opacity: 0.28 }, // quiet: the lights lead
  surfaces: { color: '#3f5a86', opacity: 0.1 }, // a fill the outlines read against
};
const LAYERS = 'glowstack.layers';     // model layer visibility, per device
const CAMERA = 'glowstack.camera';     // the remembered camera, per device
const FREE = 'glowstack.camera.free';  // the last camera the user orbited to
// Without a configured view: an elevated three-quarter view from the
// −x, −y side.
const THREE_QUARTER = [-0.45, -0.8, 0.5];
const MARGIN = 1.04; // framing leaves this much room around the pixels
const SUBDUED = 0.4; // the model's opacity while a look is showing
const DETAIL = 'glowstack.model.detail'; // 'simple' or 'full', per device
const SIMPLE_LINES = 0.5; // simple detail's line opacity, of full's
// A layer with one of these words in its name is fine detail: left out of
// the simple drawing.
export const isFineDetail = (name) => /(^|[-_. ])(detail|details|fine|trim)([-_. ]|$)/i.test(name);

export const toThree = (p) => new THREE.Vector3(p[0], p[2], -p[1]);
const fromThree = (v) => [v.x, -v.z, v.y];
// zUp maps a Z-up point into three's frame, so overlays can project
// Glowstack positions directly.
const zUp = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

// Pixels: a dot sized by its pitch and distance (3–21 CSS px). flags:
// 1 dead (a gray ring), 2 gray (its controller is unreachable), 4 not
// drawn. An unlit pixel is a dim ring, so off doesn't read as missing; a
// lit one is half again as big, so a look reads over the model's lines.
const PIXEL_VS = `
attribute vec3 rgb;
attribute float dl;
attribute float flags;
uniform float uHalfH;
uniform float uDpr;
varying vec3 vColor;
varying float vFlags;
void main() {
  vFlags = flags;
  vColor = rgb;
  if (flags >= 4.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = dl * projectionMatrix[1][1] * uHalfH / max(-mv.z, 1e-3) * 1.35;
  bool lit = dot(rgb, rgb) >= 0.0004 && flags < 2.0;
  gl_PointSize = lit ? clamp(s * 1.5, 5.0 * uDpr, 24.0 * uDpr) : clamp(s, 3.0 * uDpr, 21.0 * uDpr);
}`;
const PIXEL_FS = `
uniform float uAlpha;
varying vec3 vColor;
varying float vFlags;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  vec3 col = vColor;
  float f = vFlags;
  bool gray = mod(floor(f / 2.0), 2.0) > 0.5;
  if (mod(f, 2.0) > 0.5) {
    if (r < 0.4) discard;
    col = vec3(0.42);
  }
  else if (dot(col, col) < 0.0004) {
    if (r < 0.45) discard;
    col = vec3(0.2);
  }
  if (gray) col = vec3(0.22 + 0.25 * dot(col, vec3(0.3, 0.59, 0.11)));
  gl_FragColor = vec4(col, uAlpha);
}`;

// The selection halo: wide translucent dots centered on the selected
// pixels, growing with them (uGrow). The stencil lets it cover a screen
// pixel once, so overlapping dots don't build up.
const HALO_VS = `
attribute float dl;
uniform float uHalfH;
uniform float uSize;
uniform float uDpr;
uniform float uGrow;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = dl * projectionMatrix[1][1] * uHalfH / max(-mv.z, 1e-3) * 1.35;
  float ps = clamp(s, 3.0 * uDpr, 21.0 * uDpr);
  gl_PointSize = max(uSize, ps * uGrow);
}`;
const HALO_FS = `
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  if (dot(c, c) > 1.0) discard;
  gl_FragColor = vec4(uColor, uAlpha);
}`;

// Draw order, all in three's transparent pass: model surfaces and lines
// (no depth test, see-through), the halo, every pixel dimmed with no depth
// test, then the pixels again tested against the surfaces' depth. So a
// pixel behind a wall shows dimmed and one in front shows fully.
const ORDER = { surfaces: 0, lines: 1, halo: 2, dim: 3, pixels: 4 };

// open loads the model and returns the view. Orbit controls listen on
// input (the overlay canvas above); drawing is on glCanvas. opts:
//   url, layers  the .glb and its drawing layers [{name, kind}]
//   map          the geometry's map settings: view, auto_rotate, layers
//   px, plan     the pixel table and the scene's plan index
//   runs         the geometry's runs, for run picking
//   rgb          the live frame, 3 bytes per pixel (shared, not copied)
//   onChange     called when anything drawn changed
//   onCamera     called with camera state when it moves or changes view
export async function open(glCanvas, input, opts) {
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, stencil: true });
  renderer.setClearColor(0x0d0e10, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  const gltf = await new GLTFLoader().loadAsync(opts.url);
  scene.add(gltf.scene);
  const { px } = opts;
  const n = px.count;

  // ----- the building -----
  const kinds = new Map(opts.layers.map((l) => [l.name, l.kind]));
  const styles = new Map((opts.map.layers || []).map((l) => [l.name, l]));
  const saved = load(LAYERS, {}) || {};
  const groups = new Map(); // layer name → [object]
  // Run and controller nodes are data; the overlay draws them.
  gltf.scene.traverse((o) => {
    if (o.userData.glowstack_run || o.userData.glowstack_controller) { o.visible = false; return; }
    const name = o.userData.name;
    if (!name || !kinds.has(name)) return;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(o);
  });
  // Surfaces also go into the depth buffer, without color, so pixels
  // behind them can be dimmed. Pushed back a little, so strips on a wall
  // aren't hidden by it.
  const depthOnly = new THREE.MeshBasicMaterial({
    colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
  });
  const layers = [], modelMaterials = [];
  // Simple: dimmer lines with the ones behind a wall hidden, so lights and
  // targets lead. Full is every line, see-through.
  let detail = load(DETAIL, 'simple') === 'full' ? 'full' : 'simple';
  const lineScale = () => (detail === 'simple' ? SIMPLE_LINES : 1);
  function applyDetail() {
    for (const m of modelMaterials) {
      m.scale = m.line ? lineScale() : 1;
      if (m.line) m.material.depthTest = detail === 'simple';
    }
  }
  for (const l of opts.layers) {
    const objs = groups.get(l.name);
    if (!objs || layers.some((x) => x.name === l.name)) continue;
    const st = styles.get(l.name) || {};
    const def = DEFAULTS[l.kind] || DEFAULTS.lines;
    const color = new THREE.Color(st.color || def.color);
    const opacity = st.opacity ?? def.opacity;
    for (const root of objs) {
      root.traverse((o) => {
        if (o.userData.glowstack_run) { o.visible = false; return; }
        if (o.userData.depthOnly) return;
        const common = { color, transparent: true, opacity, depthWrite: false, depthTest: false };
        if (o.isMesh) {
          o.material = new THREE.MeshBasicMaterial({ ...common, side: THREE.DoubleSide });
          o.renderOrder = ORDER.surfaces;
          const d = new THREE.Mesh(o.geometry, depthOnly);
          d.userData.depthOnly = true;
          o.add(d);
        } else if (o.isLine) {
          o.material = new THREE.LineBasicMaterial(common);
          o.renderOrder = ORDER.lines;
        } else if (o.isPoints) {
          o.material = new THREE.PointsMaterial({ ...common, size: 2, sizeAttenuation: false });
          o.renderOrder = ORDER.lines;
        }
        if (o.isMesh || o.isLine || o.isPoints) modelMaterials.push({ material: o.material, opacity, line: !o.isMesh });
      });
    }
    const def0 = st.visible ?? true;
    const fine = isFineDetail(l.name);
    const visible = l.name in saved ? !!saved[l.name] : def0 && !(fine && detail === 'simple');
    for (const o of objs) o.visible = visible;
    layers.push({ name: l.name, kind: l.kind, visible, initial: def0, fine });
  }
  applyDetail();

  // ----- pixels -----
  const pos = new Float32Array(3 * n), dl = new Float32Array(n), flags = new Float32Array(n);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let visibility = null, grayControllers = new Set(), currentSelection = null;
  const drawn = (p) => (!visibility || visibility[p]) && px.plan[p] === opts.plan && px.x[p] !== null;
  for (let p = 0; p < n; p++) {
    if (!drawn(p)) { flags[p] = 4; continue; }
    const g = [px.x[p], px.y[p], px.z[p] || 0];
    pos[3 * p] = g[0]; pos[3 * p + 1] = g[2]; pos[3 * p + 2] = -g[1];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], g[k]); hi[k] = Math.max(hi[k], g[k]); }
    dl[p] = px.dl[p] > 0 ? px.dl[p] : 0.03;
  }
  for (const p of px.dead) if (flags[p] < 4) flags[p] = 1;
  const baseFlags = flags.slice();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('dl', new THREE.BufferAttribute(dl, 1));
  const flagAttr = new THREE.BufferAttribute(flags, 1);
  geom.setAttribute('flags', flagAttr);
  // BufferAttribute keeps the array (Uint8BufferAttribute would copy it),
  // so each frame written into opts.rgb only needs an upload.
  const liveAttr = new THREE.BufferAttribute(opts.rgb, 3, true);
  liveAttr.setUsage(THREE.DynamicDrawUsage);
  let colorAttr = liveAttr;
  geom.setAttribute('rgb', colorAttr);
  const pixelUniforms = () => ({
    uHalfH: { value: 1 }, uDpr: { value: 1 }, uAlpha: { value: 1 },
  });
  const dimMat = new THREE.ShaderMaterial({
    uniforms: pixelUniforms(), vertexShader: PIXEL_VS, fragmentShader: PIXEL_FS,
    transparent: true, depthTest: false, depthWrite: false,
  });
  dimMat.uniforms.uAlpha.value = 0.4;
  const fullMat = new THREE.ShaderMaterial({
    uniforms: pixelUniforms(), vertexShader: PIXEL_VS, fragmentShader: PIXEL_FS,
    transparent: true, depthTest: true, depthWrite: true,
  });
  for (const [mat, order] of [[dimMat, ORDER.dim], [fullMat, ORDER.pixels]]) {
    const pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    pts.renderOrder = order;
    scene.add(pts);
  }

  // ----- selection halo -----
  const haloGroup = new THREE.Group();
  scene.add(haloGroup);
  let haloKey = '';
  const HALO_CSS = 15; // the halo's least width, CSS px
  function haloObject(ranges) {
    let k = 0;
    for (const [a, b] of ranges) for (let p = a; p <= b; p++) if (drawn(p)) k++;
    const rp = new Float32Array(3 * k), rl = new Float32Array(k);
    let i = 0;
    for (const [a, b] of ranges) {
      for (let p = a; p <= b; p++) {
        if (!drawn(p)) continue;
        rp.set(pos.subarray(3 * p, 3 * p + 3), 3 * i);
        rl[i] = dl[p];
        i++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    g.setAttribute('dl', new THREE.BufferAttribute(rl, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uHalfH: { value: 1 }, uSize: { value: HALO_CSS }, uDpr: { value: 1 }, uGrow: { value: 1.6 },
        uColor: { value: new THREE.Color(1, 1, 1) }, uAlpha: { value: 0.5 },
      },
      vertexShader: HALO_VS, fragmentShader: HALO_FS,
      transparent: true, depthTest: false, depthWrite: false,
      stencilWrite: true, stencilRef: 250, stencilFunc: THREE.NotEqualStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilFail: THREE.KeepStencilOp,
    });
    const obj = new THREE.Points(g, mat);
    obj.frustumCulled = false;
    obj.renderOrder = ORDER.halo;
    return obj;
  }
  function clearHalo() {
    for (const o of [...haloGroup.children]) { o.geometry.dispose(); o.material.dispose(); haloGroup.remove(o); }
  }
  // The pointing halo: the same soft halo, quieter, for what the panel is
  // pointing at (a card's target, a controller's runs, one run). It fades in
  // unless motion is reduced, and goes at once.
  const pointGroup = new THREE.Group();
  scene.add(pointGroup);
  let pointKey = 'null', pointFade = 0;
  const POINT_ALPHA = 0.34, POINT_FADE_MS = 120;
  function clearPoint() {
    cancelAnimationFrame(pointFade);
    for (const o of [...pointGroup.children]) { o.geometry.dispose(); o.material.dispose(); pointGroup.remove(o); }
  }

  // ----- camera -----
  const box = new THREE.Box3();
  if (isFinite(lo[0])) { box.expandByPoint(toThree(lo)); box.expandByPoint(toThree(hi)); }
  if (box.isEmpty()) box.setFromObject(gltf.scene);
  if (box.isEmpty()) box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const modelSphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
  const reach = Math.max(sphere.radius, modelSphere.radius || 0, 1);
  camera.near = Math.max(reach / 500, 0.01);
  camera.far = reach * 60;

  const controls = new OrbitControls(camera, input);
  controls.enableDamping = true;
  controls.zoomToCursor = true;
  controls.maxPolarAngle = Math.PI * 0.95;
  controls.autoRotateSpeed = 0.6;
  controls.autoRotate = !!opts.map.auto_rotate;

  const v = opts.map.view || null;
  const viewFov = (v && v.fov) || 40;
  // cam is how the camera was set: the site's view or Fit (auto: framed
  // again whenever the viewport changes) or by the user (free). A framed
  // camera's distance is always the fit to the free area: a configured
  // distance never holds the lights small in a short band of map.
  const cam = { mode: 'street', auto: true, fov: viewFov, ...siteView() };
  let W = 1, H = 1, dpr = 1, insetTop = 0, insetBottom = 0, padSide = 0, padEdge = 0;
  let version = 0; // bumps when the projection changes

  // project sets the projection for the canvas, the insets and the
  // logical fov (cam.fov spans the free area between the insets): the
  // free area's center is the view's center.
  function project() {
    const hf = Math.max(H - insetTop - insetBottom, 1);
    const cy = insetTop + hf / 2;
    const full = 2 * Math.max(cy, H - cy);
    const half = THREE.MathUtils.degToRad(cam.fov / 2);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) * full / hf));
    camera.aspect = W / full;
    camera.setViewOffset(W, full, 0, full / 2 - cy, W, H);
    camera.updateProjectionMatrix();
  }

  const corners = () => {
    const out = [];
    for (let i = 0; i < 8; i++) out.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    return out;
  };

  // fitDistance is how far from target along dir (unit, toward the
  // camera) the camera must be for every point to show in the free area.
  function axes(dir) {
    const f = dir.clone().negate();
    const up = Math.abs(f.y) > 0.999 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const u = up.clone().addScaledVector(f, -up.dot(f)).normalize();
    return { f, u, r: new THREE.Vector3().crossVectors(f, u) };
  }

  // litPoints is the lights being drawn, to find their extent. Every one on
  // a site of ordinary size: a stride skips corners, and a skipped corner is a
  // pixel or two of margin the fit promised and did not keep (B145).
  function litPoints() {
    const step = Math.max(1, Math.floor(n / 30000)), out = [];
    for (let p = 0; p < n; p += step) if (flags[p] < 4) out.push(Object.assign(new THREE.Vector3(pos[3 * p], pos[3 * p + 1], pos[3 * p + 2]), { dl: dl[p] }));
    return out;
  }

  function fitDistance(dir, target, points) {
    const hf = Math.max(H - insetTop - insetBottom, 1);
    const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / MARGIN;
    const th = tv * W / hf;
    const { f, u, r } = axes(dir);
    // The free rectangle, not only its height (B141): every point's dot stays
    // padSide px inside the left and right edges and padEdge px inside the
    // top and bottom of the band. k is px per unit of tangent.
    const k = hf / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
    let d = 0;
    const rel = new THREE.Vector3();
    for (const q of points) {
      rel.subVectors(q, target);
      const z = rel.dot(f), x = rel.dot(r), y = rel.dot(u), pitch = q.dl || 0;
      d = Math.max(d, Math.abs(x) / th - z, Math.abs(y) / tv - z, fitDepth(x, pitch, k, W / 2, padSide) - z, fitDepth(y, pitch, k, hf / 2, padEdge) - z);
    }
    return Math.max(d, camera.near * 4);
  }

  function place(dir, target, dist) {
    controls.target.copy(target);
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    version++;
    controls.update();
    changed();
  }

  // centerOn moves target so points fill the free area evenly from dir, and
  // returns the distance that fits them. Perspective makes the middle move as
  // the distance does, so this settles over a few passes.
  function centerOn(dir, target, points) {
    const fit = () => fitDistance(dir, target, points);
    const { r, u, f } = axes(dir);
    let d = fit();
    const rel = new THREE.Vector3();
    for (let i = 0; i < 6; i++) {
      const [sx, sy] = centerShift(points.map((q) => { rel.subVectors(q, target); return [rel.dot(r), rel.dot(u), -rel.dot(f)]; }), d);
      target.addScaledVector(r, sx).addScaledVector(u, sy);
      d = fit();
    }
    return d;
  }

  // frame applies cam (the site's view or Fit) for the current viewport.
  function frame() {
    project();
    const target = cam.target ? cam.target.clone() : box.getCenter(new THREE.Vector3());
    let d = fitDistance(cam.dir, target, corners());
    // The site's view and Fit center the lights in what's left of the map; a
    // camera someone placed stays where they put it. Perspective makes the
    // middle move as the distance does, so this settles over a few passes.
    const lights = cam.auto ? litPoints() : [];
    if (lights.length) d = centerOn(cam.dir, target, lights);
    place(cam.dir, target, d);
  }

  // siteView is the configured angle. frame centers the lights, so a view's
  // `to` doesn't set the opening view's center.
  function siteView() {
    if (v && v.direction) return { dir: toThree(v.direction).normalize(), target: v.to ? toThree(v.to) : null };
    if (v && v.from && v.to) {
      // The old absolute form: its angle; the distance is the fit, as above.
      const from = toThree(v.from), to = toThree(v.to);
      return { dir: from.clone().sub(to).normalize(), target: to };
    }
    return { dir: toThree(THREE_QUARTER).normalize(), target: null };
  }

  let restoring = false;
  const emit = () => { if (opts.onCamera) opts.onCamera(api.cameraState()); };
  const remember = () => {
    const st = { mode: cam.mode, auto: cam.auto, fov: cam.fov };
    if (cam.auto && cam.mode === 'fit') { st.dir = fromThree(cam.dir); }
    if (!cam.auto) {
      st.from = fromThree(camera.position); st.to = fromThree(controls.target);
      save(FREE, { from: st.from, to: st.to, fov: cam.fov });
    }
    save(CAMERA, st);
  };
  let settle = 0;
  let glDirty = true;
  const changed = () => { glDirty = true; version++; opts.onChange(); };
  // The lights are the point: the model steps back while any are lit.
  let subdued = false;
  function subdue(on) {
    if (on === subdued) return;
    subdued = on;
    paintModel();
    changed();
  }
  function paintModel() {
    for (const m of modelMaterials) m.material.opacity = m.opacity * m.scale * (subdued ? SUBDUED : 1);
  }
  paintModel();
  const anyLit = (rgb) => { for (let i = 0; i < rgb.length; i++) if (rgb[i] > 8) return true; return false; };
  // The camera is the user's (free) once a gesture moves it; a tap
  // starts and ends a gesture without moving anything.
  let grab = null;
  controls.addEventListener('change', () => {
    changed();
    if (grab && (camera.position.distanceToSquared(grab.pos) > 1e-10 || controls.target.distanceToSquared(grab.target) > 1e-10)) {
      grab = null;
      if (cam.auto || cam.mode !== 'free') { cam.mode = 'free'; cam.auto = false; emit(); }
    }
    if (cam.mode === 'free' && !restoring) {
      clearTimeout(settle);
      settle = setTimeout(() => { remember(); emit(); }, 400);
    }
  });
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    grab = { pos: camera.position.clone(), target: controls.target.clone() };
  });
  controls.addEventListener('end', () => { grab = null; });

  function setView(name) {
    if (name === 'fit') {
      cam.dir = camera.position.clone().sub(controls.target).normalize();
      cam.target = null; cam.auto = true;
      if (cam.mode === 'free') cam.mode = 'fit';
      frame();
    }
    remember();
    emit();
  }

  // ----- picking (on demand) -----
  let projVersion = -1, mver = -1, mcache = null;
  const scr = new Float32Array(3 * n);
  function projectAll() {
    if (projVersion === version) return;
    projVersion = version;
    const m = api.matrix();
    for (let p = 0; p < n; p++) {
      if (flags[p] >= 4) { scr[3 * p + 2] = NaN; continue; }
      const x = pos[3 * p], y = -pos[3 * p + 2], z = pos[3 * p + 1];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw < camera.near) { scr[3 * p + 2] = NaN; continue; }
      scr[3 * p] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) * 0.5 * W;
      scr[3 * p + 1] = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5 * H;
      scr[3 * p + 2] = cw;
    }
  }
  const api = {
    kind: '3d',
    layers,
    bounds: [lo, hi],
    detail: () => detail,
    // setDetail picks the drawing's detail. It decides the fine layers
    // again, whatever they were last toggled to.
    setDetail(value) {
      detail = value === 'full' ? 'full' : 'simple';
      save(DETAIL, detail);
      applyDetail();
      paintModel();
      for (const l of layers) {
        if (!l.fine) continue;
        delete saved[l.name];
        l.visible = l.initial && detail === 'full';
        for (const o of groups.get(l.name) || []) o.visible = l.visible;
      }
      save(LAYERS, saved);
      changed();
    },
    setVisible(name, on) {
      for (const o of groups.get(name) || []) o.visible = on;
      const l = layers.find((x) => x.name === name);
      if (l) l.visible = on;
      saved[name] = on;
      save(LAYERS, saved);
      changed();
    },
    resize(cssW, cssH, ratio) {
      W = Math.max(cssW, 1); H = Math.max(cssH, 1); dpr = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(W, H, false);
      for (const m of [dimMat, fullMat]) { m.uniforms.uHalfH.value = H * ratio / 2; m.uniforms.uDpr.value = ratio; }
      this.relayout();
    },
    // setInsets says what the chips and the sheet cover (px from the top and
    // bottom edges) and, in pad, how far inside the free rectangle's sides
    // and its top and bottom the lights must stay.
    setInsets(top, bottom, pad = {}) {
      const side = pad.side || 0, edge = pad.edge || 0;
      if (top === insetTop && bottom === insetBottom && side === padSide && edge === padEdge) return;
      insetTop = top; insetBottom = bottom; padSide = side; padEdge = edge;
      this.relayout();
    },
    // relayout applies a new viewport: framed views are framed again;
    // a camera the user moved stays where it is.
    relayout() {
      if (cam.auto) frame();
      else { project(); version++; changed(); }
    },
    // colors: null shows the live frame, or a Uint8Array (3 per pixel)
    // for a diagnostic view.
    setColors(arr) {
      const want = arr ? new THREE.BufferAttribute(arr, 3, true) : liveAttr;
      if (want === colorAttr && !arr) return;
      colorAttr = want;
      geom.setAttribute('rgb', colorAttr);
      subdue(anyLit(arr || opts.rgb));
      changed();
    },
    // frameArrived marks the live colors for upload.
    frameArrived() {
      if (colorAttr !== liveAttr) return;
      liveAttr.needsUpdate = true;
      glDirty = true;
      subdue(anyLit(opts.rgb));
    },
    // setGray grays the pixels of the given controller indices.
    setGray(ctrls) {
      grayControllers = ctrls;
      for (let p = 0; p < n; p++) flags[p] = visibility && !visibility[p] ? 4 : baseFlags[p] < 4 && ctrls.has(px.controller[p]) ? baseFlags[p] | 2 : baseFlags[p];
      flagAttr.needsUpdate = true;
      changed();
    },
    // setSelection draws the halo along the selected pixels (ranges, or
    // null), rebuilding only when they change.
    setPixelVisibility(mask) {
      visibility = mask;
      this.setGray(grayControllers);
      haloKey = null;
      this.setSelection(currentSelection);
      const pointed = JSON.parse(pointKey);
      pointKey = 'stale';
      this.setHighlight(pointed, false);
    },
    setSelection(selection) {
      currentSelection = selection;
      const key = JSON.stringify(selection);
      if (key === haloKey) return;
      haloKey = key;
      clearHalo();
      if (selection && selection.length) haloGroup.add(haloObject(selection));
      for (const o of haloGroup.children) this.sizeHalo(o);
      changed();
    },
    // setHighlight draws the pointing halo along ranges (or null to clear
    // it). fade false shows it at once (prefers-reduced-motion).
    setHighlight(ranges, fade = true) {
      const key = JSON.stringify(ranges || null);
      if (key === pointKey) return;
      pointKey = key;
      clearPoint();
      if (ranges && ranges.length) {
        const o = haloObject(ranges);
        pointGroup.add(o);
        this.sizeHalo(o);
        const u = o.material.uniforms.uAlpha, t0 = performance.now();
        u.value = fade ? 0 : POINT_ALPHA;
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / POINT_FADE_MS);
          u.value = POINT_ALPHA * k;
          changed();
          if (k < 1) pointFade = requestAnimationFrame(step);
        };
        if (fade) pointFade = requestAnimationFrame(step);
      }
      changed();
    },
    highlight: () => JSON.parse(pointKey),
    sizeHalo(o) {
      const u = o.material.uniforms;
      u.uHalfH.value = H * dpr / 2;
      u.uSize.value = HALO_CSS * dpr;
      u.uDpr.value = dpr;
    },
    // render draws if anything changed; returns whether it did.
    render() {
      if (!glDirty) return false;
      for (const o of haloGroup.children) this.sizeHalo(o);
      for (const o of pointGroup.children) this.sizeHalo(o);
      renderer.render(scene, camera);
      glDirty = false;
      return true;
    },
    // tick runs the orbit controls; true while the camera is moving.
    tick() { return controls.update() || controls.autoRotate; },
    // matrix maps a Z-up point to clip space (column-major).
    matrix() {
      return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(zUp).elements;
    },
    // toScreen maps a Z-up point to CSS px and view depth; null behind
    // the camera.
    toScreen(x, y, z) {
      if (mver !== version) { mcache = this.matrix(); mver = version; }
      const m = mcache;
      z = z || 0;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw < camera.near) return null;
      return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) * 0.5 * W, (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5 * H, cw];
    },
    get version() { return version; },
    size: () => ({ w: W, h: H }),
    // pickPixel returns the pixel nearest (sx, sy) within radius CSS px,
    // or -1; on a tie the nearer one.
    pickPixel(sx, sy, radius) {
      projectAll();
      let best = -1, bd = radius * radius, bz = Infinity;
      for (let p = 0; p < n; p++) {
        const z = scr[3 * p + 2];
        if (!(z > 0)) continue;
        const dx = scr[3 * p] - sx, dy = scr[3 * p + 1] - sy;
        const d = dx * dx + dy * dy;
        if (d < bd - 1 || (d <= bd + 1 && z < bz)) { bd = Math.min(bd, d); best = p; bz = z; }
      }
      return best;
    },
    // pickRun returns the index of the run (runs[i] is {ranges} or
    // null) drawn nearest (sx, sy) within radius, or -1.
    pickRun(sx, sy, radius, runs) {
      projectAll();
      return nearestRun(runs, (p) => (scr[3 * p + 2] > 0 ? [scr[3 * p], scr[3 * p + 1]] : null), sx, sy, radius);
    },
    // pixelRadius is the radius pixel p is drawn at, in CSS px.
    pixelRadius(p) {
      const v = new THREE.Vector3(pos[3 * p], pos[3 * p + 1], pos[3 * p + 2]).applyMatrix4(camera.matrixWorldInverse);
      const s = dl[p] * camera.projectionMatrix.elements[5] * H / 2 / Math.max(-v.z, 1e-3) * 1.35;
      return clamp(s, 3, 21) / 2;
    },
    // screenOf is a pixel's last projected screen position (for pinned
    // cards), or null.
    screenOf(p) {
      projectAll();
      return scr[3 * p + 2] > 0 ? [scr[3 * p], scr[3 * p + 1]] : null;
    },
    setView,
    cameraState() {
      return { mode: cam.mode, auto: cam.auto, hasFree: !!load(FREE, null) };
    },
    // restore opens on the remembered camera, else the site's view.
    restore() {
      const st = load(CAMERA, null);
      restoring = true;
      try {
        if (st && !st.auto && st.from && st.to) {
          cam.mode = 'free'; cam.auto = false; cam.fov = st.fov || viewFov;
          project();
          const f = toThree(st.from), t = toThree(st.to);
          place(f.clone().sub(t).normalize(), t, f.distanceTo(t));
        } else if (st && st.auto && st.mode === 'fit' && st.dir) {
          Object.assign(cam, { mode: 'fit', auto: true, dir: toThree(st.dir).normalize(), target: null, fov: st.fov || viewFov });
          frame();
        } else {
          Object.assign(cam, siteView(), { mode: 'street', auto: true, fov: viewFov });
          frame();
        }
      } finally { restoring = false; }
      emit();
    },
    // forget clears the remembered camera and returns to the site's view.
    forget() {
      save(CAMERA, undefined);
      save(FREE, undefined);
      Object.assign(cam, siteView(), { mode: 'street', auto: true, fov: viewFov });
      frame();
      emit();
    },
    // hold and release keep the camera while it's framed temporarily
    // (calibration, the full sheet): frameIds moves it, release puts
    // back what hold saved.
    hold() {
      return { cam: { ...cam, dir: cam.dir && cam.dir.clone(), target: cam.target && cam.target.clone() }, pos: camera.position.clone(), target: controls.target.clone() };
    },
    release(h) {
      if (!h) return;
      Object.assign(cam, h.cam);
      if (cam.auto) frame();
      else { project(); place(h.pos.clone().sub(h.target).normalize(), h.target, h.pos.distanceTo(h.target)); }
      emit();
    },
    // frameIds frames the given pixels from the current direction,
    // without remembering it.
    frameIds(ids) {
      const b = new THREE.Box3();
      for (const p of ids) if (flags[p] < 4) b.expandByPoint(new THREE.Vector3(pos[3 * p], pos[3 * p + 1], pos[3 * p + 2]));
      if (b.isEmpty()) return;
      const pad = Math.max(0.4, b.getSize(new THREE.Vector3()).length() * 0.05);
      b.expandByScalar(pad);
      const pts = [];
      for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
      const dir = camera.position.clone().sub(controls.target).normalize();
      const t = b.getCenter(new THREE.Vector3());
      project();
      cam.auto = false;
      place(dir, t, fitDistance(dir, t, pts));
    },
    // frameTight frames the given pixels from the current direction as closely
    // as the opening view frames the lights: to the pixels themselves.
    frameTight(ids) {
      const step = Math.max(1, Math.floor(ids.length / 1500)), pts = [];
      for (let i = 0; i < ids.length; i += step) if (flags[ids[i]] < 4) pts.push(new THREE.Vector3(pos[3 * ids[i]], pos[3 * ids[i] + 1], pos[3 * ids[i] + 2]));
      if (!pts.length) return;
      const dir = camera.position.clone().sub(controls.target).normalize();
      const t = new THREE.Box3().setFromPoints(pts).getCenter(new THREE.Vector3());
      project();
      cam.auto = false;
      const d = centerOn(dir, t, pts);
      place(dir, t, d);
    },
    // view is the camera as glowstack.yaml `map:` (meters, Z up), in the
    // direction form, so it frames itself on any screen.
    copyView() {
      const d = fromThree(camera.position.clone().sub(controls.target).normalize());
      const r = (vec, k) => '[' + vec.map((x) => +x.toFixed(k)).join(', ') + ']';
      return `map:\n  view: { direction: ${r(d, 3)}, to: ${r(fromThree(controls.target), 2)}, fov: ${+cam.fov.toFixed(1)} }\n`;
    },
  };
  return api;
}
