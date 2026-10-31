// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package color

import (
	"testing"

	"github.com/jerejones/glowstack/internal/units"
)

func TestGammaRoundTrip(t *testing.T) {
	for i := range 256 {
		c := units.Color{R: uint8(i), G: 255 - uint8(i), B: 0}
		if got := Linear(c).Authored(); got.R != c.R || got.G != c.G || got.B != 0 {
			t.Fatalf("%d: round trip gave %+v", i, got)
		}
	}
	// #808080 lands near WLED's gamma-corrected drive level, 37/255.
	if v := Linear(units.Color{R: 128}).R * 255; v < 36 || v > 38 {
		t.Errorf("#80 decodes to %v/255", v)
	}
	if Encode(-1) != 0 || Encode(2) != 255 {
		t.Error("Encode doesn't clamp")
	}
}
