// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"
	"testing"

	"github.com/jerejones/glowstack/internal/color"
)

var redBlue = []any{
	map[string]any{"color": "#ff0000", "width": "1 m"},
	map[string]any{"color": "#0000ff", "width": "1 m"},
}

// atTravel returns a frame time near epoch at which a pattern moving at
// speed has travelled d (mod period).
func atTravel(speed, period, d float64) float64 {
	cycle := period / speed
	return math.Floor(epoch/cycle)*cycle + d/speed
}

func TestBandEdgesSubPixel(t *testing.T) {
	s := newStrip(40, 0.1, 1)
	// 1 px/8s at a 0.1 m pitch is 0.0125 m/s. At this time the bands have
	// moved 0.03 m: red covers [0.03, 1.03), blue [1.03, 2.03).
	raw := map[string]any{"bands": redBlue, "speed": "1 px/8s"}
	tm := atTravel(0.0125, 2, 0.03)
	out := s.render(t, Bands(), raw, tm)
	red, blue := lin("#ff0000"), lin("#0000ff")
	mixed := func(redShare float32) color.Color {
		c := color.Lerp(blue, red, redShare)
		c.A = 1
		return c
	}
	for k, want := range map[int]color.Color{
		0:  mixed(0.7), // [0, 0.1): blue up to 0.03
		5:  red,
		9:  red, // [0.9, 1.0)
		10: mixed(0.3),
		15: blue,
		20: mixed(0.7),
	} {
		if !near(out[k], want, 1e-5) {
			t.Errorf("pixel %d = %+v, want %+v", k, out[k], want)
		}
	}
	// Every pixel's shares add up to one colour's worth.
	for k, c := range out {
		if math.Abs(float64(c.R+c.B)-1) > 1e-5 || c.A != 1 {
			t.Errorf("pixel %d = %+v", k, c)
		}
	}
	// The edge glides: 0.8 s later it has moved another 0.01 m.
	later := s.render(t, Bands(), raw, tm+0.8)
	if !near(later[10], mixed(0.4), 1e-4) {
		t.Errorf("pixel 10 after 0.8 s = %+v", later[10])
	}
	// smooth: false point-samples pixel centres.
	v := resolve(t, Bands(), raw, s.pitch)
	ctx := s.ctx(v, tm)
	ctx.Smooth = false
	hard := make([]color.Color, len(s.pixels))
	Bands().New().Render(ctx, hard)
	if hard[10] != blue || hard[0] != red || hard[9] != red {
		t.Errorf("unsmoothed = %+v %+v %+v", hard[0], hard[9], hard[10])
	}
}

func TestBandsFlowAndPhysical(t *testing.T) {
	// Stretch 2: each 0.1 m pixel covers 0.05 m of u. Flow widths stay
	// 1 m of u (twice as big physically); physical ones become 0.5 m of u.
	s := newStrip(40, 0.1, 2)
	red, blue := lin("#ff0000"), lin("#0000ff")
	flow := s.render(t, Bands(), map[string]any{"bands": redBlue}, epoch)
	if !near(flow[19], red, 1e-5) || !near(flow[20], blue, 1e-5) { // u 0.975 and 1.025
		t.Errorf("flow: %+v %+v", flow[19], flow[20])
	}
	phys := s.render(t, Bands(), map[string]any{"bands": []any{
		map[string]any{"color": "#ff0000", "width": "1 m physical"},
		map[string]any{"color": "#0000ff", "width": "1 m physical"},
	}}, epoch)
	if !near(phys[9], red, 1e-5) || !near(phys[10], blue, 1e-5) || !near(phys[20], red, 1e-5) {
		t.Errorf("physical: %+v %+v %+v", phys[9], phys[10], phys[20])
	}
}

func TestSoftBands(t *testing.T) {
	s := newStrip(20, 0.1, 1)
	out := s.render(t, Bands(), map[string]any{"bands": redBlue, "edge": "soft"}, epoch)
	// Centres: red at 0.5, blue at 1.5. Pixel 4 is at 0.45 (just before
	// red's centre), pixel 9 at 0.95 (nearly half way).
	if !near(out[9], color.Lerp(lin("#ff0000"), lin("#0000ff"), 0.45), 1e-5) {
		t.Errorf("pixel 9 = %+v", out[9])
	}
	if !near(out[4], color.Lerp(lin("#0000ff"), lin("#ff0000"), 0.95), 1e-5) {
		t.Errorf("pixel 4 = %+v", out[4])
	}
}

func TestSoftBandsAveragePixelFootprint(t *testing.T) {
	d := Bands()
	for _, tc := range []struct{ pitch, red float64 }{{0.2, 0.95}, {2, 0.5}} {
		s := newStrip(1, tc.pitch, 1)
		s.u[0] = 0.5 // red band centre, where the linear blend changes slope
		v := resolve(t, d, map[string]any{"bands": redBlue, "edge": "soft"}, s.pitch)
		ctx := s.ctx(v, epoch)
		out := make([]color.Color, 1)
		d.New().Render(ctx, out)
		want := color.Color{R: float32(tc.red), B: float32(1 - tc.red), A: 1}
		if !near(out[0], want, 1e-6) {
			t.Errorf("footprint %v: got %+v, want %+v", tc.pitch, out[0], want)
		}
		ctx.Smooth = false
		d.New().Render(ctx, out)
		if !near(out[0], lin("#ff0000"), 1e-6) {
			t.Errorf("centre sample: %+v", out[0])
		}
	}
}
