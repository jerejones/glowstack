// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The Setup tab: how the map is drawn and set up. Calibration (with how
// many anchors are measured), the overlay chips and their legend, the
// model's drawing layers, the plan, the camera (Default,
// Copy view), the stream rate, and the runs the plan or
// model doesn't draw.
import { $, esc, copyText, save, load, press, failure, plural, count, humanize } from '../util.js';
import { calCount } from './calibrate.js';
import { controllerName, modelPartLabel } from '../names.js';
import { MODES } from '../overlay.js';
import { upgradeSelects } from '../picker.js';
import { icon } from '../icons.js';

const ADVANCED = 'glowstack.setup.advanced';
const KEY_FOLDED = 'glowstack.legend.folded';
const KEY_FOLDED_CAL = 'glowstack.legend.folded.calibrating';

// keyFolded says the map's key starts folded. stored is the saved choice, or
// null. Calibrating on a phone it starts folded: its map is a short strip.
export const keyFolded = (stored, phoneCalibrating) => (stored === null ? phoneCalibrating : !!stored);

// calibrateButton runs Calibrate's button. Until the calibrate panel exists it
// is off and says it is loading, so an early press does nothing wrong. It
// returns the redraw: show(running) changes the words, show() rereads the rest.
export function calibrateButton(b, S) {
  let running = false;
  const show = (now = running) => {
    running = !!now;
    b.disabled = !S.calib || !!S.offline;
    b.innerHTML = S.calib ? `${icon('target')}${running ? 'Resume calibrating' : 'Calibrate'}` : 'Loading calibration…';
  };
  b.onclick = () => S.calib?.open();
  show();
  return show;
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
      <div class="row"><button type="button" id="suCal" class="go grow icon-btn"></button></div>
      <div class="muted small" id="suCalN"></div>
    </section>
    <h2 class="sub">Color the map by</h2>
    <div class="seg five" id="suModes" role="group" aria-label="Color the map by">${MODES.map(([m, label, hint]) => `<button type="button" data-mode="${m}" title="${esc(hint)}">${label}</button>`).join('')}</div>
    <div class="row" id="suMappingRow" hidden><span class="muted">Measured along</span><select id="suMapping" aria-label="Measured along">${g.mappings.map((m) => `<option value="${esc(m.id)}">${esc(humanize(m.id))}</option>`).join('')}</select></div>
    <div class="row" id="suZoneRow" hidden><span class="muted">Zone</span><select id="suZone" aria-label="Zone">${g.zones.map((z) => `<option value="${esc(z.id)}">${esc(z.name || humanize(z.id))}</option>`).join('')}</select></div>
    <h2 class="sub">Which lights to show</h2>
    <div class="seg" id="suRuns" role="group" aria-label="Runs shown">
      <button type="button" data-all="false">Working lights</button>
      <button type="button" data-all="true">All lights</button>
    </div>
    <div class="muted small help" id="suRunsCount"></div>
    <h2 class="sub">Show on the map</h2>
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
      <h3 class="sub">Camera</h3>
      <div class="row">
        <button type="button" id="suDefault" title="Forget this device's camera and go back to the site's view">Default</button>
        <button type="button" id="suCopy" class="icon-btn" title="Copy this camera's position as text">${icon('copy')}Copy camera position</button>
      </div>
      <div class="muted small help">Default goes back to the site's view. Copying gives this camera's settings as text, for making it the view every device starts from.</div>
    </div>
    <div id="suRateGroup"><h3 class="sub">Map updates</h3>
      <div class="seg" id="suRate" role="group" aria-label="Map update rate">${[[0, 'Max'], [10, '10/s'], [5, '5/s'], [1, '1/s']].map(([v, l]) => `<button type="button" data-fps="${v}">${l}</button>`).join('')}</div>
      <div class="muted small help" id="suStream"></div></div>
    </details>
    <h2 class="sub">${isScene ? 'Lights missing from the model' : 'Lights missing from the plan'}</h2>
    <ul class="list-rows" id="suUndrawn"></ul>`;
  upgradeSelects(root);
  const $$ = (s) => root.querySelector(s);
  $$('#suAdvanced').open = !!load(ADVANCED, false);
  $$('#suAdvanced').addEventListener('toggle', () => save(ADVANCED, $$('#suAdvanced').open));

  function renderRuns() {
    for (const b of $$('#suRuns').children) press(b, (b.dataset.all === 'true') === S.allRuns);
    const shownUndrawn = undrawn.filter((r) => S.visibility.runs[g.runs.indexOf(r)]);
    $$('#suUndrawn').innerHTML = shownUndrawn.length ? shownUndrawn.map((r) => `<li><span class="what"><b title="${esc(r.id)}">${esc(r.name || humanize(r.id))}</b><small>${plural(r.count, 'light')} on ${esc(controllerName(g, g.controllers[r.controller].id))}</small></span></li>`).join('') : '<li class="muted">None missing: every light shown is on the map.</li>';
    const count = S.visibility.runs.filter(Boolean).length;
    $$('#suRunsCount').textContent = `${count} of ${plural(g.runs.length, 'run')} shown (a run is one strip of lights), based on the condition of each strip`;
  }
  for (const b of $$('#suRuns').children) b.onclick = () => S.setAllRuns(b.dataset.all === 'true');
  S.on('runVisibility', renderRuns);
  renderRuns();

  // ---------- calibration ----------
  const calLabel = calibrateButton($$('#suCal'), S);
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
    // The key's rows scroll on their own, so its button is never over them.
    const key = $('legend'), scrolled = key.querySelector('.legend-rows')?.scrollTop || 0;
    key.innerHTML = `<div class="legend-rows">${legendHTML + note}</div>`;
    key.hidden = !(legendHTML + note);
    key.firstChild.scrollTop = scrolled;
    $$('#suLegend').innerHTML = legendHTML + note;
    $$('#suLegend').hidden = key.hidden;
    // The key on the map can be folded down, so that it leaves the map free.
    const phoneCalibrating = S.calibrating && S.panel.layout() === 'sheet';
    const pref = phoneCalibrating ? KEY_FOLDED_CAL : KEY_FOLDED, folded = keyFolded(load(pref, null), phoneCalibrating);
    key.classList.toggle('folded', folded);
    if (key.hidden) return;
    const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'legend-toggle', textContent: folded ? 'Show key' : 'Hide key' });
    toggle.onclick = () => { save(pref, !folded); paintLegend(); S.setInsets(); S.markDirty(); };
    key.append(toggle);
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
    if (ok) { b.lastChild.textContent = 'Copied'; setTimeout(() => { b.lastChild.textContent = 'Copy camera position'; }, 1500); }
  };

  // ---------- stream ----------
  function renderRate() {
    for (const b of $$('#suRate').children) press(b, +b.dataset.fps === +S.fps);
    const m = S.stream;
    const now = S.streamRate();
    $$('#suStream').textContent = m ? `${count(m.count)} lights, up to ${m.fps} updates a second` + (now && now !== +S.fps ? ` (${now} while hidden or on battery)` : '') + (m.unknown ? ` · unknown: ${m.unknown.join(', ')}` : '') : '';
  }
  for (const b of $$('#suRate').children) b.onclick = () => { S.setRate(+b.dataset.fps); renderRate(); };
  S.on('stream', renderRate);

  S.on('offline', () => calLabel());
  S.on('view', () => { renderView(); $$('#suPlan').value = String(S.plan); refreshLegend(); });
  // Setup's colors and labels are Setup's: the other tabs show the plain map.
  S.on('tab', (t) => { if (t === 'setup') renderRate(); refreshLegend(); });
  renderOverlay();
  renderRate();
  return { setMode, calibrateReady: () => calLabel() };
}
