// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The one line a phone's lowered sheet shows (move H): the state of the
// current tab, so a peek is a whole map with one line of truth under it.
import { plural } from './util.js';

// peekLine is that line. tab is the open tab. previewing counts the looks in
// the preview; looks names the looks on the lights, or is null while the
// lights have not been read. status is { fault, issues } from the Status
// tab's headline (fault: the unreachable controllers in words, issues: how
// many warnings), or null before the first reading. cal is { done, total }
// calibration steps, or null. presets is { n, pinned }.
export function peekLine({ tab, previewing = 0, looks = [], status = null, cal = null, presets = null }) {
  if (tab === 'looks') {
    if (previewing > 0) return `Previewing ${plural(previewing, 'look')}`;
    if (looks === null) return 'Checking the lights…';
    if (looks.length === 1) return `${String(looks[0]).replace(/ /g, ' ')} on the lights`;
    return looks.length ? `${looks.length} looks on the lights` : 'Nothing on the lights';
  }
  if (tab === 'status') {
    if (!status) return 'Checking…';
    if (status.fault) return status.fault;
    return status.issues > 0 ? `${plural(status.issues, 'warning')} to check` : 'All good';
  }
  if (tab === 'setup') {
    if (!cal || !cal.total) return 'Set up the map';
    return cal.done >= cal.total ? `Calibrated: ${cal.done} of ${cal.total}` : `Calibration: ${cal.done} of ${cal.total} steps`;
  }
  if (tab === 'presets') {
    if (!presets) return 'Presets';
    return plural(presets.n, 'preset') + (presets.pinned ? `, ${presets.pinned} pinned` : '');
  }
  return '';
}
