// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What the map is showing, worked out once: the chip's words and the
// Preview/Lights toggle both come from here, so they can't disagree.
import { esc } from './util.js';
import { MODES } from './overlay.js';

// What the chip calls a calibration step that isn't a target pattern.
const MEASURING = { bands: 'Test bands', link: 'Lining up a link', gap: 'Measuring a gap', dead: 'Marking dead pixels' };

// mapStatus takes the page's state: connected, show ('' or 'house'),
// preview (the /api/map/preview state, or null before the first read),
// target (the map is drawing a calibration target), measuring (the kind of
// any other calibration step on the real lights, or ''), mode (the Setup
// color mode, 'live' when the map shows real colors), lit (lightOutcome for
// the looks on the lights), mapless (the map couldn't be loaded or drawn;
// the page still answers), connecting (no socket result yet: a first
// connection hasn't opened or failed). The chip follows one rule, on every tab and with
// the sheet open or shut: nothing lit never reads as the lights showing, and
// the tab says why, once.
export function mapStatus({ connected, connecting = false, show, preview, target, measuring = '', mode = 'live', lit = null, mapless = false }) {
  const previewing = !!(preview && preview.previewing);
  // Only a preview that exists, and isn't hidden, is on the map.
  const showing = target ? 'target' : measuring ? 'calibration' : previewing && show !== 'house' ? 'preview' : 'lights';
  const toggle = { showing, canPreview: previewing };
  // Offline is a connection lost or refused; waiting for the first isn't one.
  if (connecting) return { ...toggle, text: 'connecting…', detail: '', cls: '', title: 'Connecting to Glowstack' };
  if (!connected) return { ...toggle, text: 'Offline', detail: '', cls: 'off', title: 'Not connected to Glowstack. The map may be out of date.' };
  if (mapless) return { ...toggle, text: 'Map unavailable', detail: '', cls: 'off', title: "The map couldn't be loaded. Status and presets still work; use Retry on the map." };
  if (target) return { ...toggle, text: 'Target pattern', detail: '', cls: 'preview', title: 'Fixed reference: adjust the real lights to match' };
  if (measuring) return { ...toggle, text: MEASURING[measuring] || 'Calibrating', detail: '', cls: 'mode', title: 'The map shows what calibration has put on the lights' };
  const colored = MODES.find(([id]) => id === mode && id !== 'live');
  if (colored) return { ...toggle, text: `Colored by ${colored[1]}`, detail: '', cls: 'mode', title: colored[2] };
  if (showing === 'preview') {
    return { ...toggle, text: 'Showing your preview', detail: preview.paused ? ' · paused' : '', cls: 'preview', title: 'The map shows your preview, not the lights' };
  }
  if (lit?.dark) return { ...toggle, text: lit.dark === 'none' ? 'Lights: nothing lit' : 'Lights: partly lit', detail: lit.empty ? ' · no looks on them' : '', cls: 'unlit', title: lit.message };
  return { ...toggle, text: 'Showing the lights', detail: previewing ? ' · preview hidden' : ' · no preview', cls: 'house', title: 'The map shows what the lights show' };
}

// badgeHTML is the chip's content. One element holds both parts: the chip
// is a flex box, and a direct child span would lose its leading space. On a
// phone (stacked) the detail is a second line, since it won't fit on the first.
export function badgeHTML(m, stacked = false) {
  if (stacked && m.detail) return `<span class="stack"><span>${esc(m.text)}</span><span class="detail">${esc(m.detail.replace(/^ · /, ''))}</span></span>`;
  return `<span>${esc(m.text)}<span class="detail">${esc(m.detail)}</span></span>`;
}
