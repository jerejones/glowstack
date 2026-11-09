// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Setup tab: how the map is drawn and set up. Calibration (with how
// many anchors are measured), the overlay chips and their legend, the
// model's drawing layers, the plan, the camera (named views, Default,
// Copy view), the stream rate, and the runs the plan or
// model doesn't draw.
import { $, esc, copyText, save, load, press, failure, plural, count, humanize } from '../util.js';
import { calCount } from './calibrate.js';
import { controllerName, modelPartLabel } from '../names.js';
import { MODES } from '../overlay.js';
import { upgradeSelects } from '../picker.js';

const ADVANCED = 'glowstack.setup.advanced';
const PEEK_CHROME = 68; // the sheet's handle and tabs, above .content
const MAX_FIT = 64;     // past this the sheet would stop being a half

// halfSpill is how far to move the sheet's edge off the first control it
// cuts: down past it when that is near, else up above it. Rows are
// {top, bottom}, edge the height showing. 0 when nothing is cut, or the cut
// row is too tall to settle on.
export function halfSpill(rows, edge) {
  const cut = rows.find((r) => r.top < edge && r.bottom > edge);
  if (!cut) return 0;
  const down = Math.ceil(cut.bottom - edge) + 8;
  if (down <= MAX_FIT) return down;
  const up = Math.floor(cut.top - edge) - 8;
  return -up <= MAX_FIT ? up : 0;
}

export function createSetup(S, root) {
  const g = S.geo;
  const ov = S.overlay;
  const isScene = g.plans.some((p) => p.kind === 'scene');
  const undrawn = g.runs.filter((r) => r.plan < 0);
  root.innerHTML = `
    <h1 class="title">Set up the map</h1>
    <section class="setup-cal">
      <p class="muted">Calibrating lines the map up with the real lights, one point at a time.</p>
      <div class="row"><button type="button" id="suCal" class="go grow">Calibrate</button></div>
      <div class="muted small" id="suCalN"></div>
    </section>
    <h3 class="sub">Color the map by</h3>
    <div class="seg five" id="suModes" role="group" aria-label="Color the map by">${MODES.map(([m, label, hint]) => `<button type="button" data-mode="${m}" title="${esc(hint)}">${label}</button>`).join('')}</div>
    <div class="row" id="suMappingRow" hidden><span class="muted">Measured along</span><select id="suMapping" aria-label="Measured along">${g.mappings.map((m) => `<option value="${esc(m.id)}">${esc(humanize(m.id))}</option>`).join('')}</select></div>
    <div class="row" id="suZoneRow" hidden><span class="muted">Zone</span><select id="suZone" aria-label="Zone">${g.zones.map((z) => `<option value="${esc(z.id)}">${esc(z.name || humanize(z.id))}</option>`).join('')}</select></div>
    <h3 class="sub">Which lights to show</h3>
    <div class="seg" id="suRuns" role="group" aria-label="Runs shown">
      <button type="button" data-all="false">Working lights</button>
      <button type="button" data-all="true">All lights</button>
    </div>
    <div class="muted small help" id="suRunsCount"></div>
    <h3 class="sub">Show on the map</h3>
    <div class="chips toggles" role="group" aria-label="Show on the map">
      <button type="button" id="suNodes" title="Corners, links, gaps and calibration points">Points</button>
      <button type="button" id="suLabels" title="Names on points and gaps, descriptions on controllers">Names</button>
      <button type="button" id="suControllers" title="Where the model puts each controller">Controllers</button>
      <button type="button" id="suEven" title="When a run is hovered or tapped, also say so if it is spaced just as drawn" hidden>Label evenly spaced runs</button>
    </div>
    <div class="legend-inline" id="suLegend" hidden></div>
    <details id="suAdvanced"><summary>Advanced</summary>
    <div id="suModel" hidden><h3 class="sub">Model detail</h3>
      <div class="seg" id="suDetail" role="group" aria-label="Model detail"><button type="button" data-detail="simple" title="A dim outline, so the lights and targets lead">Simple</button><button type="button" data-detail="full" title="Every line of the model, including what's behind walls">Full detail</button></div>
      <h3 class="sub">Parts of the model</h3><div class="chips toggles" id="suLayers"></div><div class="muted small help">Turn pieces of the 3-D drawing on or off. They change the map only.</div></div>
    <div id="suPlanRow" hidden><h3 class="sub">Plan</h3><select id="suPlan" aria-label="Plan">${g.plans.map((p, i) => `<option value="${i}">${esc(p.name)} (${esc(p.kind)})</option>`).join('')}</select></div>
    <div id="suCamera" hidden>
      <h3 class="sub">Camera <small id="suCamMode"></small></h3>
      <div class="row">
        <button type="button" id="suDefault" title="Forget this device's camera and go back to the site's view">Default</button>
        <button type="button" id="suCopy" title="Copy this camera's position as text">Copy camera position</button>
      </div>
      <div class="muted small help">Default goes back to the site's view. Copying gives this camera's settings as text, for making it the view every device starts from.</div>
    </div>
    <h3 class="sub">Map updates</h3>
    <div class="seg" id="suRate" role="group" aria-label="Map update rate">${[[0, 'Max'], [10, '10/s'], [5, '5/s'], [1, '1/s']].map(([v, l]) => `<button type="button" data-fps="${v}">${l}</button>`).join('')}</div>
    <div class="muted small help" id="suStream"></div>
    </details>
    <h2>${isScene ? 'Lights missing from the model' : 'Lights missing from the plan'}</h2>
    <ul class="list-rows" id="suUndrawn">${undrawn.length
    ? undrawn.map((r) => `<li><span class="what"><b title="${esc(r.id)}">${esc(r.name || humanize(r.id))}</b><small>${plural(r.count, 'light')} on ${esc(controllerName(g, g.controllers[r.controller].id))}</small></span></li>`).join('')
    : '<li class="muted">Every light is on the map.</li>'}</ul>`;
  upgradeSelects(root);
  const $$ = (s) => root.querySelector(s);
  $$('#suAdvanced').open = !!load(ADVANCED, false);
  $$('#suAdvanced').addEventListener('toggle', () => { save(ADVANCED, $$('#suAdvanced').open); S.panel.refit(); });

  // At half the sheet's edge falls between controls, never through one.
  S.fitSetupHalf = (base) => {
    const top = root.getBoundingClientRect().top - root.parentElement.getBoundingClientRect().top;
    const at = root.getBoundingClientRect().top;
    const rows = [];
    let heading = null; // a heading is one row with the control under it
    for (const el of root.querySelectorAll('h1, .setup-cal, h3.sub, .seg, .chips, .help, #suAdvanced > summary, h2')) {
      if (!el.offsetHeight) continue;
      const r = el.getBoundingClientRect(), row = { top: r.top - at + top, bottom: r.bottom - at + top };
      if (heading) row.top = heading.top;
      heading = el.matches('h3.sub') ? row : null;
      if (!heading) rows.push(row);
    }
    return base + halfSpill(rows, base - PEEK_CHROME);
  };

  function renderRuns() {
    for (const b of $$('#suRuns').children) press(b, (b.dataset.all === 'true') === S.allRuns);
    const shownUndrawn = undrawn.filter((r) => S.visibility.runs[g.runs.indexOf(r)]);
    $$('#suUndrawn').innerHTML = shownUndrawn.length ? shownUndrawn.map((r) => `<li><span class="what"><b title="${esc(r.id)}">${esc(r.name || humanize(r.id))}</b><small>${plural(r.count, 'light')} on ${esc(controllerName(g, g.controllers[r.controller].id))}</small></span></li>`).join('') : '<li class="muted">Every light shown is on the map.</li>';
    const count = S.visibility.runs.filter(Boolean).length;
    $$('#suRunsCount').textContent = `${count} of ${plural(g.runs.length, 'run')} shown, based on the condition of each strip`;
  }
  for (const b of $$('#suRuns').children) b.onclick = () => S.setAllRuns(b.dataset.all === 'true');
  S.on('runVisibility', renderRuns);
  renderRuns();

  // ---------- calibration ----------
  $$('#suCal').onclick = () => S.calib.open();
  const calLabel = (running) => { $$('#suCal').textContent = running ? 'Resume calibrating' : 'Calibrate'; };
  S.on('calibration', calLabel);
  // The same count the calibration screen shows, from the same reading.
  const showCount = (st) => {
    const count = st ? calCount(st) : null;
    $$('#suCalN').textContent = count ? count.text : '';
    $$('#suCalN').title = count ? count.title : '';
  };
  S.on('calprogress', showCount);

  // ---------- overlays ----------
  async function setMode(mode) {
    ov.st.mode = mode;
    renderOverlay();
    S.refreshBadge();
    await refreshLegend();
  }
  S.setOverlayMode = setMode;
  async function refreshLegend() {
    ov.remember();
    try { legendHTML = await ov.apply(); } catch (e) { legendHTML = ''; S.fail('draw that overlay', e); }
    paintLegend();
    S.setInsets(); // the key takes room from the map on a phone
    S.markDirty();
  }
  S.refreshLegend = refreshLegend;
  // paintLegend is the key, and how many labels didn't fit on the map.
  let legendHTML = '';
  function paintLegend() {
    const n = ov.hiddenLabels();
    const note = n ? `<div class="muted label-note">${plural(n, 'label')} hidden: no room. ${S.coarse ? 'Pinch to zoom in' : 'Hover or zoom in'} to see ${n === 1 ? 'it' : 'them'}.</div>` : '';
    for (const el of [$('legend'), $$('#suLegend')]) { el.innerHTML = legendHTML + note; el.hidden = !(legendHTML + note); }
  }
  S.refreshLabelNote = paintLegend;
  function renderOverlay() {
    ov.remember();
    for (const b of $$('#suModes').children) press(b, b.dataset.mode === ov.st.mode);
    $$('#suMappingRow').hidden = ov.st.mode !== 'flow'; // spacing is against the drawing, whichever flow
    $$('#suZoneRow').hidden = ov.st.mode !== 'areas';
    $$('#suMapping').value = ov.st.mapping;
    $$('#suZone').value = ov.st.zone;
    press($$('#suNodes'), ov.st.nodes);
    press($$('#suLabels'), ov.st.labels);
    press($$('#suControllers'), ov.st.controllers);
    $$('#suControllers').hidden = !(g.controller_locations || []).length;
    press($$('#suEven'), ov.st.evenSpacing);
    $$('#suEven').hidden = ov.st.mode !== 'stretch';
  }
  for (const b of $$('#suModes').children) b.onclick = () => setMode(b.dataset.mode);
  $$('#suMapping').onchange = (e) => { ov.st.mapping = e.target.value; refreshLegend(); };
  $$('#suZone').onchange = (e) => { ov.st.zone = e.target.value; refreshLegend(); };
  $$('#suEven').onclick = () => { ov.st.evenSpacing = !ov.st.evenSpacing; renderOverlay(); refreshLegend(); };
  $$('#suNodes').onclick = () => { ov.st.nodes = !ov.st.nodes; renderOverlay(); refreshLegend(); };
  $$('#suLabels').onclick = () => { ov.st.labels = !ov.st.labels; renderOverlay(); S.markDirty(); };
  $$('#suControllers').onclick = () => { ov.st.controllers = !ov.st.controllers; renderOverlay(); refreshLegend(); };

  // ---------- model, plan, camera ----------
  function renderView() {
    const v = S.view;
    if (!v) return;
    const box = $$('#suLayers');
    box.replaceChildren(...v.layers.map((l) => {
      const b = document.createElement('button');
      b.type = 'button';
      press(b, l.visible);
      b.textContent = modelPartLabel(l.name, l.kind);
      b.onclick = () => { v.setVisible(l.name, !l.visible); press(b, l.visible); };
      return b;
    }));
    for (const b of $$('#suDetail').children) {
      press(b, b.dataset.detail === v.detail?.());
      b.onclick = () => { v.setDetail(b.dataset.detail); renderView(); };
    }
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
    if (ok) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy camera position'; }, 1500); }
  };
  S.on('camera', (st) => {
    $$('#suCamMode').textContent = { street: 'street view', overhead: 'overhead', free: 'where you left it', fit: 'fitted' }[st.mode] || '';
  });

  // ---------- stream ----------
  function renderRate() {
    for (const b of $$('#suRate').children) press(b, +b.dataset.fps === +S.fps);
    const m = S.stream;
    const now = S.streamRate();
    $$('#suStream').textContent = m ? `${count(m.count)} lights, up to ${m.fps} updates a second` + (now && now !== +S.fps ? ` (${now} while hidden or on battery)` : '') + (m.unknown ? ` · unknown: ${m.unknown.join(', ')}` : '') : '';
  }
  for (const b of $$('#suRate').children) b.onclick = () => { S.setRate(+b.dataset.fps); renderRate(); };
  S.on('stream', renderRate);

  S.on('offline', () => { $$('#suCal').disabled = S.offline; });
  S.on('view', () => { renderView(); $$('#suPlan').value = String(S.plan); S.panel.refit(); refreshLegend(); });
  // Setup's colors and labels are Setup's: the other tabs show the plain map.
  S.on('tab', (t) => { if (t === 'setup') renderRate(); refreshLegend(); });
  renderOverlay();
  renderRate();
  calLabel(false);
  return { setMode };
}
