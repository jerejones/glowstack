// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The live map's 3-D view of a scene model (.glb), on three.js. It owns
// the WebGL canvas: the building (see-through lines over faint
// surfaces), every pixel as one Points object whose color buffer is
// updated per frame, a translucent halo along the selected pixels,
// and the camera: computed framing, named views and the camera
// remembered per device. Picking is on demand: pixels and runs are
// projected to the screen only when a tap or hover asks.
//
// Glowstack positions are meters with Z up; three.js is Y up, so
// (x, y, z) is (x, z, −y) here. North is +y.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { load, save, clamp, nearestRun } from './util.js';

const DEFAULTS = {
  lines: { color: '#cfe3ff', opacity: 0.45 },
  surfaces: { color: '#4b6a9a', opacity: 0.06 },
};
const LAYERS = 'glowstack.layers';     // model layer visibility, per device
const CAMERA = 'glowstack.camera';     // the remembered camera, per device
const FREE = 'glowstack.camera.free';  // the last camera the user orbited to
// Without a configured view: an elevated three-quarter view from the
// −x, −y side.
const THREE_QUARTER = [-0.45, -0.8, 0.5];
const MARGIN = 1.1; // framing leaves this much room around the pixels

export const toThree = (p) => new THREE.Vector3(p[0], p[2], -p[1]);
const fromThree = (v) => [v.x, -v.z, v.y];
// zUp maps a Z-up point into three's frame, so overlays can project
// Glowstack positions directly.
const zUp = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

// Pixels: a dot sized by its pitch and distance (3–21 CSS px). flags:
// 1 dead (a gray ring), 2 gray (its controller is unreachable), 4 not
// drawn. An unlit pixel is a dim ring, so off doesn't read as missing.
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
  gl_PointSize = clamp(s, 3.0 * uDpr, 21.0 * uDpr);
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
  const layers = [];
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
      });
    }
    const def0 = st.visible ?? true;
    const visible = l.name in saved ? !!saved[l.name] : def0;
    for (const o of objs) o.visible = visible;
    layers.push({ name: l.name, kind: l.kind, visible, initial: def0 });
  }

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
        uColor: { value: new THREE.Color(1, 1, 1) }, uAlpha: { value: 0.26 },
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
  // cam is how the camera was set: by a named view or Fit (auto: framed
  // again whenever the viewport changes) or by the user (free).
  const cam = { mode: 'street', auto: true, fov: viewFov, ...named('street') };
  let W = 1, H = 1, dpr = 1, insetTop = 0, insetBottom = 0;
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
  function fitDistance(dir, target, points) {
    const hf = Math.max(H - insetTop - insetBottom, 1);
    const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / MARGIN;
    const th = tv * W / hf;
    const f = dir.clone().negate();
    const up = Math.abs(f.y) > 0.999 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const u = up.clone().addScaledVector(f, -up.dot(f)).normalize();
    const r = new THREE.Vector3().crossVectors(f, u);
    let d = 0;
    const rel = new THREE.Vector3();
    for (const q of points) {
      rel.subVectors(q, target);
      const z = rel.dot(f);
      d = Math.max(d, Math.abs(rel.dot(r)) / th - z, Math.abs(rel.dot(u)) / tv - z);
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

  // frame applies cam (a named view or Fit) for the current viewport.
  function frame() {
    project();
    const target = cam.target ? cam.target.clone() : box.getCenter(new THREE.Vector3());
    const d = Math.max(fitDistance(cam.dir, target, corners()), cam.minDist);
    place(cam.dir, target, d);
  }

  // views: the site's configured view (Street), straight down with
  // north up (Overhead).
  function named(name) {
    if (name === 'overhead') return { dir: toThree([0, -0.001, 1]).normalize(), target: null, minDist: 0 };
    if (v && v.direction) return { dir: toThree(v.direction).normalize(), target: v.to ? toThree(v.to) : null, minDist: 0 };
    if (v && v.from && v.to) {
      // The old absolute form: its camera, unless the house wouldn't fit.
      const from = toThree(v.from), to = toThree(v.to);
      return { dir: from.clone().sub(to).normalize(), target: to, minDist: from.distanceTo(to) };
    }
    return { dir: toThree(THREE_QUARTER).normalize(), target: null, minDist: 0 };
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
    if (name === 'free') {
      const f = load(FREE, null);
      if (!f) return;
      cam.mode = 'free'; cam.auto = false; cam.fov = f.fov || viewFov;
      project();
      place(toThree(f.from).sub(toThree(f.to)).normalize(), toThree(f.to), toThree(f.from).distanceTo(toThree(f.to)));
    } else if (name === 'fit') {
      cam.dir = camera.position.clone().sub(controls.target).normalize();
      cam.target = null; cam.minDist = 0; cam.auto = true;
      if (cam.mode === 'free') cam.mode = 'fit';
      frame();
    } else {
      Object.assign(cam, named(name), { mode: name, auto: true, fov: viewFov });
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
    setInsets(top, bottom) {
      if (top === insetTop && bottom === insetBottom) return;
      insetTop = top; insetBottom = bottom;
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
      changed();
    },
    // frameArrived marks the live colors for upload.
    frameArrived() {
      if (colorAttr !== liveAttr) return;
      liveAttr.needsUpdate = true;
      glDirty = true;
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
    // restore opens on the remembered camera, else Street.
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
          Object.assign(cam, { mode: 'fit', auto: true, dir: toThree(st.dir).normalize(), target: null, minDist: 0, fov: st.fov || viewFov });
          frame();
        } else if (st && st.auto && st.mode === 'overhead') {
          Object.assign(cam, named('overhead'), { mode: 'overhead', auto: true, fov: viewFov });
          frame();
        } else {
          Object.assign(cam, named('street'), { mode: 'street', auto: true, fov: viewFov });
          frame();
        }
      } finally { restoring = false; }
      emit();
    },
    // forget clears the remembered camera and returns to Street.
    forget() {
      save(CAMERA, undefined);
      save(FREE, undefined);
      Object.assign(cam, named('street'), { mode: 'street', auto: true, fov: viewFov });
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
