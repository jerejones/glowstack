// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What the map is showing, worked out once: the chip's words and the
// Preview/Lights toggle both come from here, so they can't disagree.
import { esc, plural } from './util.js';
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
// reading hasn't come back yet, so nothing has failed), dimZones (how many
// zones at 0% the preview draws dim). The chip follows one rule, on every tab and with
// the sheet open or shut: nothing lit never reads as the lights showing, and
// the tab says why, once. looks names the looks on the lights (stack order)
// and levels is each zone's brightness, 0–1; with looks on and lit the chip
// names them (see litWords).
export function mapStatus({ connected, connecting = false, show, preview, target, measuring = '', calActive = false, mode = 'live', lit = null, mapless = false, fresh = true, reading = false, dimZones = 0, looks = [], levels = null, scope = null }) {
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
    return { ...toggle, text: 'Showing your preview', detail: (preview.paused ? ' · paused' : '') + (!fresh && !reading ? ' · lights unknown' : '') + (dimZones ? ` · ${dimZones} ${dimZones === 1 ? 'zone' : 'zones'} at 0% shown dim` : ''), cls: 'preview', title: (fresh || reading ? 'The map shows your preview, not the lights' : "The map shows your preview. The last reading of the lights failed.") + (dimZones ? ' Zones at 0% are drawn dim; on the lights they stay dark.' : '') };
  }
  if (!fresh) return reading ? { ...toggle, text: 'Lights: checking…', detail: '', cls: '', title: 'Reading the lights' } : { ...toggle, text: 'Lights: unknown', detail: " · couldn't refresh", cls: 'mode', title: 'The last reading of the lights failed, so the map may not match them.' };
  // Looks are on the lights and dark zones hide them: say that, not "nothing lit".
  if (lit?.dark) {
    const zones = !lit.empty && lit.zones.length > 0;
    // A preview the Lights view is hiding is said on every tab, as on Looks.
    return { ...toggle, text: lit.dark === 'none' ? (zones ? 'Lights: dark' : 'Lights: nothing lit') : 'Lights: partly lit', detail: zones ? ', zones at 0%' : previewing ? ' · preview hidden' : lit.empty ? ' · no looks on them' : '', cls: 'unlit', title: lit.message + (previewing ? ' A preview is hidden: Preview shows it.' : '') };
  }
  if (looks.length) {
    const w = litWords(looks, levels, scope);
    const hidden = previewing ? ' · preview hidden' : '';
    return { ...toggle, ...w, detail: w.detail + hidden, shortDetail: hidden || w.shortDetail, cls: 'house', title: `On ${w.where}: ${looks.join(', ')}. The map shows what the lights show.` };
  }
  return { ...toggle, text: 'Showing the lights', detail: previewing ? ' · preview hidden' : ' · no preview', cls: 'house', title: 'The map shows what the lights show' };
}

// NAMES_SHOWN is how many look names the chip spells out before "+N more":
// two keep it to one line at 1440 px beside the brand and the toggle.
export const NAMES_SHOWN = 2;

// litWords is the chip with looks on the lights: the names (two, then
// "+N more") and where they are. scope is { all, place }: all says the looks
// cover every light; otherwise place names the one place they are on, or is
// '' when they are on several, which reads "part of the house". The chip
// says coverage in those words and never by quoting zone brightness: the
// detail is the zones' level only when some zone is not at 100%. short and
// shortDetail are the phone's two lines: the count, then the place.
export function litWords(looks, levels, scope = null) {
  const names = looks.slice(0, NAMES_SHOWN).map((n) => String(n).replace(/\u00a0/g, ' ')).join(', ') + (looks.length > NAMES_SHOWN ? `, +${looks.length - NAMES_SHOWN} more` : '');
  const part = !!scope && !scope.all;
  const where = !part ? 'the lights' : scope.place || 'part of the house';
  const level = levelPhrase(levels);
  const detail = level ? ` · ${level}` : '';
  return { names, where, text: `${names} on ${where}`, short: `${plural(looks.length, 'look')} on the lights`, detail, shortDetail: part ? ` · ${scope.place ? `on ${scope.place} only` : 'on part of the house'}` : detail };
}

// levelPhrase is the brightness of the zones that are on, said only when it
// is not simply 100%: one figure when they agree, a range when they don't.
// '' with no reading, with every zone at 0, or with all of them at 100%.
export function levelPhrase(levels) {
  const on = (levels || []).filter((l) => l > 0).map((l) => Math.round(l * 100));
  if (!on.length) return '';
  const lo = Math.min(...on), hi = Math.max(...on);
  if (lo === 100 && hi === 100) return '';
  return `brightness ${lo === hi ? `${lo}%` : `${lo}–${hi}%`}`;
}

// lookScope is where the looks on the lights are, for the chip: ranges is
// each look's pixel ranges (null for an unknown target), targets their
// target ids, total the number of pixels on runs, nameOf a target's name.
export function lookScope(ranges, targets, total, nameOf) {
  const lit = new Set();
  for (const rs of ranges) for (const [a, b] of rs || []) for (let p = a; p <= b; p++) lit.add(p);
  if (!total || lit.size >= total) return { all: true, place: '' };
  const same = targets.length > 0 && targets.every((t) => t === targets[0]);
  return { all: false, place: same ? nameOf(targets[0]) : '' };
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
// A one-line state is a one-line pill: the second line is there only when
// there is a detail to put on it, so no pill has an empty line and its words
// sit centered. (The header's chip may be one or two lines tall as the state
// changes; a hollow pill was the worse of the two.)
// stackedLines says how many lines the stacked chip has for a status.
export const stackedLines = (m) => ((m.short ? m.shortDetail ?? m.detail : m.detail) ? 2 : 1);
export function badgeHTML(m, stacked = false) {
  const second = m.shortDetail ?? m.detail;
  if (stacked && m.short) return `<span class="stack"><span>${esc(m.short)}</span>${second ? `<span class="detail">${esc(second.replace(/^( · |, )/, ''))}</span>` : ''}</span>`;
  if (m.names) return `<span><b>${esc(m.names)}</b>${esc(m.text.slice(m.names.length))}<span class="detail">${esc(m.detail)}</span></span>`;
  if (stacked && m.detail) return `<span class="stack"><span>${esc(m.text)}</span><span class="detail">${esc(m.detail.replace(/^( · |, )/, '').replace(' shown dim', ' dim'))}</span></span>`;
  if (stacked) return `<span class="stack"><span>${esc(m.text)}</span></span>`;
  return `<span>${esc(m.text)}<span class="detail">${esc(m.detail)}</span></span>`;
}
