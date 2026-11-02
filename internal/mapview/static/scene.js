// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The live map's 3-D view of a scene model (.glb). It draws only the
// building, see-through: lines over faint surfaces, nothing writing depth.
// Pixels, nodes and picking stay in map.js, which draws them on the 2-D
// canvas above through this module's projection. Glowstack positions are
// meters with Z up; three.js is Y up, so (x, y, z) is (x, z, −y) here.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEFAULTS = {
  lines: { color: '#cfe3ff', opacity: 0.45 },
  surfaces: { color: '#4b6a9a', opacity: 0.06 },
};
const STORE = 'glowstack.layers';

const toThree = (p) => new THREE.Vector3(p[0], p[2], -p[1]);
const fromThree = (v) => [v.x, -v.z, v.y];
// zUp maps a Z-up point into three's frame, so map.js can project
// Glowstack positions directly.
const zUp = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

// open loads the model and attaches orbit controls to the overlay canvas
// (input) while drawing on the GL canvas below it. opts:
//   url      the .glb
//   layers   [{name, kind}] from the geometry
//   map      the geometry's map settings: view, auto_rotate, layers
//   bounds   [[x0, y0, z0], [x1, y1, z1]] of the pixels, for framing
//   onChange called when the camera moves
async function open(glCanvas, overlay, opts) {
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
  renderer.setClearColor(0x0d0e10, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  const gltf = await new GLTFLoader().loadAsync(opts.url);
  scene.add(gltf.scene);

  // Style the drawing layers; hide the run nodes (map.js draws the pixels).
  const kinds = new Map(opts.layers.map((l) => [l.name, l.kind]));
  const styles = new Map((opts.map.layers || []).map((l) => [l.name, l]));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { /* ignore */ }
  const groups = new Map(); // layer name → [object]
  gltf.scene.traverse((o) => {
    if (o.userData.glowstack_run) { o.visible = false; return; }
    const name = o.userData.name;
    if (!name || !kinds.has(name)) return;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(o);
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
        const common = { color, transparent: true, opacity, depthWrite: false };
        if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ ...common, side: THREE.DoubleSide });
        else if (o.isLine) o.material = new THREE.LineBasicMaterial(common);
        else if (o.isPoints) o.material = new THREE.PointsMaterial({ ...common, size: 2, sizeAttenuation: false });
      });
    }
    const visible = l.name in saved ? !!saved[l.name] : st.visible ?? true;
    for (const o of objs) o.visible = visible;
    layers.push({ name: l.name, kind: l.kind, visible });
  }
  // Surfaces first, so the lines draw over them.
  gltf.scene.traverse((o) => { if (o.isMesh) o.renderOrder = 0; else if (o.isLine || o.isPoints) o.renderOrder = 1; });

  // Framing: the model's box, or the pixels' if the model is empty.
  const box = new THREE.Box3().setFromObject(gltf.scene);
  if (opts.bounds) {
    box.expandByPoint(toThree(opts.bounds[0]));
    box.expandByPoint(toThree(opts.bounds[1]));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  camera.near = Math.max(sphere.radius / 500, 0.01);
  camera.far = sphere.radius * 50;

  const controls = new OrbitControls(camera, overlay);
  controls.enableDamping = true;
  controls.zoomToCursor = true;
  controls.maxPolarAngle = Math.PI * 0.95;
  controls.autoRotateSpeed = 0.6;
  let glDirty = true;
  const changed = () => { glDirty = true; opts.onChange(); };
  controls.addEventListener('change', changed);
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  function reset() {
    const v = opts.map.view;
    if (v) {
      camera.fov = v.fov || 40;
      camera.position.copy(toThree(v.from));
      controls.target.copy(toThree(v.to));
    } else {
      // An elevated three-quarter view from the -x, -y side.
      camera.fov = 40;
      const dir = toThree([-0.45, -0.8, 0.5]).normalize();
      const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;
      controls.target.copy(sphere.center);
      camera.position.copy(sphere.center).addScaledVector(dir, dist);
    }
    camera.updateProjectionMatrix();
    controls.autoRotate = !!opts.map.auto_rotate;
    controls.update();
    changed();
  }

  let w = 1, h = 1;
  const api = {
    layers,
    setVisible(name, on) {
      for (const o of groups.get(name) || []) o.visible = on;
      const l = layers.find((x) => x.name === name);
      if (l) l.visible = on;
      saved[name] = on;
      localStorage.setItem(STORE, JSON.stringify(saved));
      changed();
    },
    resize(cssW, cssH, dpr) {
      w = cssW; h = cssH;
      renderer.setPixelRatio(dpr);
      renderer.setSize(cssW, cssH, false);
      camera.aspect = cssW / Math.max(cssH, 1);
      camera.updateProjectionMatrix();
      glDirty = true;
    },
    // render draws the model and returns the projection for this frame:
    // m maps a Z-up point to clip space (column-major), ppm is CSS px per
    // meter at view depth 1.
    render() {
      // The GL canvas keeps its last frame, so redraw only on change.
      if (glDirty) { renderer.render(scene, camera); glDirty = false; }
      const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(zUp);
      return { m: m.elements, w, h, ppm: h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))), near: camera.near };
    },
    reset,
    // view is the camera as glowstack.yaml `map:` (meters, Z up).
    view() {
      const r = (v) => '[' + v.map((x) => +x.toFixed(2)).join(', ') + ']';
      return `map:\n  view: { from: ${r(fromThree(camera.position))}, to: ${r(fromThree(controls.target))}, fov: ${+camera.fov.toFixed(1)} }\n`;
    },
  };
  // Damping and auto-rotate need updates between interactions.
  renderer.setAnimationLoop(() => controls.update());
  reset();
  return api;
}

window.GlowScene = { open };
document.dispatchEvent(new Event('glowstack:scene'));
