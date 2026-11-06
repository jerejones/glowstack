// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"testing"

	"github.com/jerejones/glowstack/internal/color"
)

func TestChaseKeepsMovingPulseColor(t *testing.T) {
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
			// colored pulse into view. Two spacings complete the color cycle.
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

func TestChaseSubpixelColors(t *testing.T) {
	d := Chase()
	for _, tc := range []struct {
		name     string
		u, pitch float64
		want     color.Color
	}{
		{"before head", 0.975, 0.1, color.Color{B: 1, A: 0.25}},
		{"several pulses", 0.25, 3, color.Color{R: 1.0 / 3, B: 2.0 / 3, A: 0.5}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newStrip(1, tc.pitch, 1)
			s.u[0] = float32(tc.u)
			out := s.render(t, d, map[string]any{"width": "0.5 m", "spacing": "1 m", "speed": "0 m/s", "colors": []any{"#ff0000", "#0000ff"}, "overlay": true}, epoch)
			if !near(out[0], tc.want, 1e-5) {
				t.Errorf("got %+v, want %+v", out[0], tc.want)
			}
		})
	}
}

func TestChaseSpillTail(t *testing.T) {
	// Pulses every 10 m (one at u 10), standing still, with a 4 m tail.
	// Pixel 0 is on a route's path, pixel 1 on its spill, where the tail is
	// a fifth as long (0.8 m).
	s := newStrip(2, 0.01, 1)
	d := Chase()
	v := resolve(t, d, map[string]any{
		"width": "0.1 m", "spacing": "10 m", "speed": "0 m/s", "tail": "4 m", "spill_tail": 0.2,
		"colors": []any{"#ff0000"}, "overlay": true,
	}, s.pitch)
	ctx := s.ctx(v, 0)
	ctx.Smooth = false
	ctx.Spill = []float32{0, 0.3}
	out := make([]color.Color, 2)

	// 2 m behind the pulse: inside the path's tail, past the spill's.
	ctx.U = []float32{8, 8}
	d.New().Render(ctx, out)
	if !(out[0].A > 0) || out[1].A != 0 {
		t.Errorf("2 m behind: path %v, spill %v; want lit, dark", out[0].A, out[1].A)
	}
	// 0.4 m behind: both lit, the spill dimmer.
	ctx.U = []float32{9.6, 9.6}
	d.New().Render(ctx, out)
	if !(out[1].A > 0 && out[1].A < out[0].A) {
		t.Errorf("0.4 m behind: path %v, spill %v; want 0 < spill < path", out[0].A, out[1].A)
	}
}
