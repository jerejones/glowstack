// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package calibrate is calibration mode (docs/design.md, "Calibration
// mode"): a guided way to turn the drawing's estimated anchors into
// measured ones, using the live map and the real lights together.
//
// A session (one per Glowstack, shared by every client) calibrates one
// target at a time: an anchor on a run, a run's first or last pixel, the
// two nodes of a link, a gap's length, a range of dead pixels, or the
// coarse band view over a run or controller. While it runs, the session
// keeps its own layers on top of the house stack, owned by "calibration"
// and Ephemeral (never saved to state.json). They use the internal
// calibration effect on the implicit run:<id> or controller:<id> area:
// the cursor pixel white, a ruler every 10th pixel (red towards the run's
// start, green towards its end), the rest of the run dim. Only those
// pixels change; the layers below are untouched and show again when the
// session ends. The lights show it only on controllers selected by
// --output; State says which.
//
// Confirm writes the measurement to anchors.yaml in the data folder (a
// scratch copy is loaded and solved first, then the real file is written
// atomically through storage), then App.Reload re-solves the layout: the
// anchor becomes measured and the estimates on its run between measured
// neighbours move with it. The live map follows the reload.
//
// Routes are listed on Manager.Routes; `glowstack ctl cal …` is the CLI.
package calibrate
