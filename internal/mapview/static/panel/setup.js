// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Setup tab: how the map is drawn and set up. Calibration (with how
// many anchors are measured), the overlay chips and their legend, the
// model's drawing layers, the plan, the camera (named views, Default,
// Copy view), the stream rate, layer ribbons, and the runs the plan or
// model doesn't draw.
import { $, api, esc, copyText, save, press } from '../util.js';
import { MODES } from '../overlay.js';

export function createSetup(S, root) {
  const g = S.geo;
  const ov = S.overlay;
  const isScene = g.plans.some((p) => p.kind === 'scene');
  const undrawn = g.runs.filter((r) => r.plan < 0);
  root.innerHTML = `
    <div class="section">
      <div class="row"><button type="button" id="suCal" class="grow">Calibrate</button></div>
      <div class="muted small" id="suCalN"></div>
    </div>
    <h2>Overlay</h2>
    <div class="chips" id="suModes">${MODES.map(([m, label]) => `<button type="button" data-mode="${m}">${label}</button>`).join('')}</div>
    <div class="row" id="suMappingRow" hidden><span class="muted">Mapping</span><select id="suMapping">${g.mappings.map((m) => `<option value="${esc(m.id)}">${esc(m.id)} (${esc(m.kind)})</option>`).join('')}</select></div>
    <div class="row" id="suZoneRow" hidden><span class="muted">Zone</span><select id="suZone">${g.zones.map((z) => `<option value="${esc(z.id)}">${esc(z.name || z.id)}</option>`).join('')}</select></div>
    <div class="chips" style="margin-top:6px">
      <button type="button" id="suNodes" title="Nodes, links, gaps and anchors">Nodes</button>
      <button type="button" id="suLabels" title="Names on nodes and gaps">Labels</button>
      <button type="button" id="suRibbons" title="A colored ribbon beside each layer's pixels">Layer ribbons</button>
    </div>
    <div class="legend-inline" id="suLegend" hidden></div>
    <div id="suModel" hidden><h2>Model layers</h2><div class="chips" id="suLayers"></div></div>
    <div id="suPlanRow" hidden><h2>Plan</h2><select id="suPlan">${g.plans.map((p, i) => `<option value="${i}">${esc(p.name)} (${esc(p.kind)})</option>`).join('')}</select></div>
    <div id="suCamera" hidden>
      <h2>Camera <small id="suCamMode"></small></h2>
      <div class="row">
        <button type="button" id="suDefault" title="Forget this device's camera and go back to the site's view">Default</button>
        <button type="button" id="suCopy" title="Copy this camera as glowstack.yaml map: view">Copy view</button>
      </div>
      <div class="muted small">Copy view writes the direction form, which frames itself on any screen.</div>
    </div>
    <h2>Stream</h2>
    <div class="row"><span class="muted">Rate</span>
      <span class="seg" id="suRate">${[[0, 'max'], [10, '10'], [5, '5'], [1, '1']].map(([v, l]) => `<button type="button" data-fps="${v}">${l}</button>`).join('')}</span>
      <span class="muted">fps</span></div>
    <div class="muted small" id="suStream"></div>
    <h2>${isScene ? 'Not in the model' : 'Not on the plan'}</h2>
    <ul class="list-rows">${undrawn.length
    ? undrawn.map((r) => `<li><span class="what"><b>${esc(r.id)}</b><small>${r.count} px on ${esc(g.controllers[r.controller].id)}</small></span></li>`).join('')
    : '<li class="muted">Every run is drawn.</li>'}</ul>`;
  const $$ = (s) => root.querySelector(s);

  // ---------- calibration ----------
  $$('#suCal').onclick = () => S.calib.open();
  async function calCount() {
    try {
      const st = await api('/api/v1/status');
      const a = st.solve.anchors;
      $$('#suCalN').textContent = `${a.measured} of ${a.measured + a.estimated} anchors measured`;
    } catch (e) { /* offline */ }
  }

  // ---------- overlays ----------
  async function setMode(mode) {
    ov.st.mode = mode;
    renderOverlay();
    await refreshLegend();
  }
  S.setOverlayMode = setMode;
  async function refreshLegend() {
    let html = '';
    try { html = await ov.apply(); } catch (e) { S.toast(e); }
    for (const el of [$('legend'), $$('#suLegend')]) { el.innerHTML = html; el.hidden = !html; }
    S.markDirty();
  }
  S.refreshLegend = refreshLegend;
  function renderOverlay() {
    for (const b of $$('#suModes').children) press(b, b.dataset.mode === ov.st.mode);
    $$('#suMappingRow').hidden = !(ov.st.mode === 'flow' || ov.st.mode === 'stretch');
    $$('#suZoneRow').hidden = ov.st.mode !== 'areas';
    $$('#suMapping').value = ov.st.mapping;
    $$('#suZone').value = ov.st.zone;
    press($$('#suNodes'), ov.st.nodes);
    press($$('#suLabels'), ov.st.labels);
    press($$('#suRibbons'), S.ribbons);
  }
  for (const b of $$('#suModes').children) b.onclick = () => setMode(b.dataset.mode);
  $$('#suMapping').onchange = (e) => { ov.st.mapping = e.target.value; refreshLegend(); };
  $$('#suZone').onchange = (e) => { ov.st.zone = e.target.value; refreshLegend(); };
  $$('#suNodes').onclick = () => { ov.st.nodes = !ov.st.nodes; renderOverlay(); refreshLegend(); };
  $$('#suLabels').onclick = () => { ov.st.labels = !ov.st.labels; renderOverlay(); S.markDirty(); };
  $$('#suRibbons').onclick = () => {
    S.ribbons = !S.ribbons;
    save('glowstack.ribbons', S.ribbons);
    renderOverlay();
    S.applyRibbons();
  };

  // ---------- model, plan, camera ----------
  function renderView() {
    const v = S.view;
    if (!v) return;
    const box = $$('#suLayers');
    box.replaceChildren(...v.layers.map((l) => {
      const b = document.createElement('button');
      b.type = 'button';
      press(b, l.visible);
      b.innerHTML = `${esc(l.name)} <small class="muted">${esc(l.kind)}</small>`;
      b.onclick = () => { v.setVisible(l.name, !l.visible); press(b, l.visible); };
      return b;
    }));
    $$('#suModel').hidden = !v.layers.length;
    $$('#suCamera').hidden = v.kind !== '3d';
  }
  $$('#suPlanRow').hidden = g.plans.length < 2;
  $$('#suPlan').value = String(S.plan);
  $$('#suPlan').onchange = (e) => S.setPlan(+e.target.value);
  $$('#suDefault').onclick = () => S.view.forget();
  $$('#suCopy').onclick = async () => {
    const b = $$('#suCopy');
    const ok = await copyText(S.view.copyView());
    if (ok) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy view'; }, 1500); }
  };
  S.on('camera', (st) => {
    $$('#suCamMode').textContent = { street: 'street view', overhead: 'overhead', free: 'where you left it', fit: 'fitted' }[st.mode] || '';
  });

  // ---------- stream ----------
  function renderRate() {
    for (const b of $$('#suRate').children) press(b, +b.dataset.fps === +S.fps);
    const m = S.stream;
    const now = S.streamRate();
    $$('#suStream').textContent = m ? `${m.count} px at up to ${m.fps} fps` + (now && now !== +S.fps ? ` (${now} fps while hidden or on battery)` : '') + (m.unknown ? ` · unknown: ${m.unknown.join(', ')}` : '') : '';
  }
  for (const b of $$('#suRate').children) b.onclick = () => { S.setRate(+b.dataset.fps); renderRate(); };
  S.on('stream', renderRate);

  S.on('view', () => { renderView(); $$('#suPlan').value = String(S.plan); });
  S.on('tab', (t) => { if (t === 'setup') { calCount(); renderRate(); } });
  renderOverlay();
  renderRate();
  if (S.panel.tab() === 'setup') calCount();
  return { setMode, calCount };
}
