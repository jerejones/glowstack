// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"sort"

	"github.com/jerejones/glowstack/internal/render"
)

// FXCustom is the first WLED fx id for effects WLED doesn't have
// (composites from config). WLED's own ids end at 220 (MODE_COUNT is 221
// in WLED's main branch) and fx ids are 8-bit, so 240–255 are used,
// leaving WLED room to grow.
const FXCustom = 240

// fxReserved is WLED's name for an unused fx id in /json/eff.
const fxReserved = "RSVD"

// nextFX returns the next free id from FXCustom, or -1 when they've run
// out (the effect then has no WLED binding).
func nextFX(r *render.Registry) int {
	for id := FXCustom; id < 256; id++ {
		if _, used := r.ByWLED(id); !used {
			return id
		}
	}
	return -1
}

// WLEDEffects lists the effects with WLED fx ids, by id.
func WLEDEffects(r *render.Registry) []*render.Def {
	var out []*render.Def
	for _, d := range r.All() {
		if d.WLED != nil && d.WLED.FX >= 0 {
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WLED.FX < out[j].WLED.FX })
	return out
}

// WLEDEffectNames is the list WLED serves at /json/eff: effect names
// indexed by fx id, up to the highest id in use, with "RSVD" for ids
// Glowstack doesn't implement (WLED's own placeholder, which its UI
// hides).
func WLEDEffectNames(r *render.Registry) []string {
	defs := WLEDEffects(r)
	if len(defs) == 0 {
		return nil
	}
	names := make([]string, defs[len(defs)-1].WLED.FX+1)
	for i := range names {
		names[i] = fxReserved
	}
	for _, d := range defs {
		names[d.WLED.FX] = d.WLED.Name
	}
	return names
}
