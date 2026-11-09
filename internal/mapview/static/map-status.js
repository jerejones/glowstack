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
// any other calibration step on the real lights, or ''), calActive (a
// calibration session is running), mode (the Setup
// color mode, 'live' when the map shows real colors), lit (lightOutcome for
// the looks on the lights), mapless (the map couldn't be loaded or drawn;
// the page still answers), connecting (no socket result yet: a first
// connection hasn't opened or failed), fresh (the latest reading of the
// lights came back; a failed one can't vouch for them), reading (the first
// reading hasn't come back yet, so nothing has failed). The chip follows one rule, on every tab and with
// the sheet open or shut: nothing lit never reads as the lights showing, and
// the tab says why, once.
export function mapStatus({ connected, connecting = false, show, preview, target, measuring = '', calActive = false, mode = 'live', lit = null, mapless = false, fresh = true, reading = false }) {
  const previewing = !!(preview && preview.previewing);
  // Only a preview that exists, and isn't hidden, is on the map.
  const showing = target ? 'target' : measuring ? 'calibration' : previewing && show !== 'house' ? 'preview' : 'lights';
  const toggle = { showing, canPreview: previewing };
  // Offline is a connection lost or refused; waiting for the first isn't one.
  if (connecting) return { ...toggle, text: 'connecting…', detail: '', cls: '', title: 'Connecting to Glowstack' };
  if (!connected) return { ...toggle, text: 'Offline', detail: '', cls: 'off', title: 'Not connected to Glowstack. The map may be out of date.' };
  if (mapless) return { ...toggle, text: 'Map unavailable', detail: '', cls: 'off', title: "The map couldn't be loaded. Status and presets still work; use Retry on the map." };
  if (target) return { ...toggle, text: 'Target pattern', detail: '', cls: 'preview', title: 'Fixed reference: adjust the real lights to match' };
  if (measuring) return { ...toggle, text: MEASURING[measuring] || (calActive ? 'Calibrating' : 'Calibration'), detail: '', cls: 'mode', title: 'The map shows what calibration has put on the lights' };
  const colored = MODES.find(([id]) => id === mode && id !== 'live');
  if (colored) return { ...toggle, text: `Colored by ${colored[1]}`, detail: '', cls: 'mode', title: colored[2] };
  if (showing === 'preview') {
    return { ...toggle, text: 'Showing your preview', detail: (preview.paused ? ' · paused' : '') + (!fresh && !reading ? ' · lights unknown' : ''), cls: 'preview', title: fresh || reading ? 'The map shows your preview, not the lights' : "The map shows your preview. The last reading of the lights failed." };
  }
  if (!fresh) return reading ? { ...toggle, text: 'Lights: checking…', detail: '', cls: '', title: 'Reading the lights' } : { ...toggle, text: 'Lights: unknown', detail: " · couldn't refresh", cls: 'mode', title: 'The last reading of the lights failed, so the map may not match them.' };
  // Looks are on the lights and dark zones hide them: say that, not "nothing lit".
  if (lit?.dark) {
    const zones = !lit.empty && lit.zones.length > 0;
    return { ...toggle, text: lit.dark === 'none' ? (zones ? 'Lights: dark' : 'Lights: nothing lit') : 'Lights: partly lit', detail: zones ? ', zones at 0%' : lit.empty ? ' · no looks on them' : '', cls: 'unlit', title: lit.message };
  }
  return { ...toggle, text: 'Showing the lights', detail: previewing ? ' · preview hidden' : ' · no preview', cls: 'house', title: 'The map shows what the lights show' };
}

// showButton is one Preview/Lights button's state: off, with the reason, until
// the map is there to act on (failed: it never will be without a Retry).
// choice is the button's data-show. A preview with nothing to show stays a
// control that explains itself when pressed.
export function showButton(choice, { ready, failed, canPreview, word }) {
  if (failed) return { disabled: true, ariaDisabled: false, title: "The map didn't load. Use Retry on the map." };
  if (!ready) return { disabled: true, ariaDisabled: false, title: 'Waiting for the map to load' };
  if (choice !== '') return { disabled: false, ariaDisabled: false, title: 'What the lights show' };
  return canPreview ? { disabled: false, ariaDisabled: false, title: 'Your preview, on the map only' } : { disabled: false, ariaDisabled: true, title: `No preview yet. ${word} a preset to preview it.` };
}

// badgeHTML is the chip's content. One element holds both parts: the chip
// is a flex box, and a direct child span would lose its leading space. On a
// phone (stacked) the detail is a second line, since it won't fit on the first.
export function badgeHTML(m, stacked = false) {
  if (stacked && m.detail) return `<span class="stack"><span>${esc(m.text)}</span><span class="detail">${esc(m.detail.replace(/^( · |, )/, ''))}</span></span>`;
  return `<span>${esc(m.text)}<span class="detail">${esc(m.detail)}</span></span>`;
}
