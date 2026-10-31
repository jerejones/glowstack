// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"testing"

	"github.com/jerejones/glowstack/internal/color"
)

func TestChaseKeepsMovingPulseColour(t *testing.T) {
	s := newStrip(1, 0.1, 1)
	s.u[0] = 0.25
	d := Chase()
	for _, speed := range []string{"1 m/s", "-1 m/s"} {
		t.Run(speed, func(t *testing.T) {
			v := resolve(t, d, map[string]any{
				"width": "0.5 m", "spacing": "1 m", "speed": speed,
				"colors": []any{"#ff0000", "#0000ff"},
			}, s.pitch)
			// At this fixed position, moving by one spacing brings the other
			// coloured pulse into view. Two spacings complete the colour cycle.
			for j, want := range []color.Color{lin("#ff0000"), lin("#0000ff"), lin("#ff0000")} {
				out := make([]color.Color, 1)
				ctx := s.ctx(v, epoch+float64(j))
				ctx.Smooth = false
				d.New().Render(ctx, out)
				if !near(out[0], want, 1e-6) {
					t.Errorf("after %d spacings: got %+v, want %+v", j, out[0], want)
				}
			}
		})
	}
}
