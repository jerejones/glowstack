// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What the map is showing, worked out once: the chip's words and the
// Preview/Lights toggle both come from here, so they can't disagree.
import { esc } from './util.js';
import { MODES } from './overlay.js';

// mapStatus takes the page's state: connected, show ('' or 'house'),
// preview (the /api/map/preview state, or null before the first read),
// target (the map is drawing a calibration target), mode (the Setup color
// mode, 'live' when the map shows real colors).
export function mapStatus({ connected, show, preview, target, mode = 'live' }) {
  const previewing = !!(preview && preview.previewing);
  // Only a preview that exists, and isn't hidden, is on the map.
  const showing = target ? 'target' : previewing && show !== 'house' ? 'preview' : 'lights';
  const toggle = { showing, canPreview: previewing };
  if (!connected) return { ...toggle, text: 'Offline', detail: '', cls: 'off', title: 'Not connected to Glowstack. The map may be out of date.' };
  if (target) return { ...toggle, text: 'Target pattern', detail: '', cls: 'preview', title: 'Fixed reference: adjust the real lights to match' };
  const colored = MODES.find(([id]) => id === mode && id !== 'live');
  if (colored) return { ...toggle, text: `Colored by ${colored[1]}`, detail: '', cls: 'mode', title: colored[2] };
  if (showing === 'preview') {
    return { ...toggle, text: 'Showing your preview', detail: preview.paused ? ' · paused' : '', cls: 'preview', title: 'The map shows your preview, not the lights' };
  }
  return { ...toggle, text: 'Showing the lights', detail: previewing ? ' · preview hidden' : ' · nothing in preview', cls: 'house', title: 'The map shows what the lights show' };
}

// badgeHTML is the chip's content. One element holds both parts: the chip
// is a flex box, and a direct child span would lose its leading space.
export function badgeHTML(m) {
  return `<span>${esc(m.text)}<span class="detail">${esc(m.detail)}</span></span>`;
}
