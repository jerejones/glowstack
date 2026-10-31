// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/units"
)

func TestWLEDEffectList(t *testing.T) {
	r := registry(t)
	names := WLEDEffectNames(r)
	want := map[int]string{0: "Solid", 2: "Breathe", 20: "Sparkle", 28: "Chase", 65: "Palette",
		83: "Solid Pattern", 87: "Glitter", 107: "Noise Pal"}
	if len(names) != 108 {
		t.Fatalf("%d names", len(names))
	}
	for i, n := range names {
		if w, ok := want[i]; ok && n != w || !ok && n != fxReserved {
			t.Errorf("fx %d = %q", i, n)
		}
	}
	defs := WLEDEffects(r)
	if len(defs) != len(want) || defs[0].ID != "solid" || defs[len(defs)-1].ID != "noise" {
		t.Errorf("WLEDEffects = %d", len(defs))
	}
}

// TestBindingsRoundTrip checks every effect's WLED bindings: they name
// real parameters, and a slider position survives slider → parameter →
// slider.
func TestBindingsRoundTrip(t *testing.T) {
	env := render.Env{Pitch: 1.0 / 60, Palettes: palettes}
	for _, d := range registry(t).All() {
		if d.WLED == nil {
			continue
		}
		for _, b := range d.WLED.Bindings {
			var values []any
			switch b.Slider {
			case render.SliderColor0, render.SliderColor1, render.SliderColor2:
				values = []any{units.Color{R: 0x12, G: 0x80, B: 0xfe}, units.Color{G: 0xff, W: 0x30, HasW: true}}
			case render.SliderPalette:
				values = []any{0, 2, 11, 72}
			case render.SliderO1, render.SliderO2, render.SliderO3:
				values = []any{true, false}
			default:
				values = []any{0, 1, 37, 128, 254, 255}
			}
			for _, val := range values {
				raw, err := d.SetWLED(map[string]any{}, b.Slider, val, env)
				if err != nil {
					t.Fatalf("%s %s=%v: %v", d.ID, b.Slider, val, err)
				}
				v, err := render.Resolve(d.Params, raw, env)
				if err != nil {
					t.Fatalf("%s %s=%v: %v", d.ID, b.Slider, val, err)
				}
				got, ok, err := d.GetWLED(v, b.Slider, env)
				if !ok || err != nil || got != val {
					t.Errorf("%s %s: %v → %v → %v (%v)", d.ID, b.Slider, val, raw, got, err)
				}
			}
		}
	}
}

// TestDeterministic renders every effect twice at the same time, once on
// all pixels and once on every third pixel in a new instance with a
// different frame number and dt: the shared pixels must match exactly.
func TestDeterministic(t *testing.T) {
	s := newStrip(300, 0.02, 1.7)
	sub := &strip{pitch: s.pitch}
	for k := 0; k < 300; k += 3 {
		sub.pixels = append(sub.pixels, s.pixels[k])
		sub.u = append(sub.u, s.u[k])
		sub.dl = append(sub.dl, s.dl[k])
		sub.stretch = append(sub.stretch, s.stretch[k])
		sub.index = append(sub.index, s.index[k])
	}
	params := map[string]map[string]any{
		"bands":    {"speed": "0.13 m/s"},
		"gradient": {"speed": "-0.4 m/s"},
		"sparkle":  {"density": "30 /m/s"},
		"chase":    {"tail": "0.4 m"},
		"noise":    {"speed": "0.2 m/s"},
		"glitter":  {"sparkle.density": "30 /m/s"},
	}
	for _, d := range registry(t).All() {
		for _, tm := range []float64{epoch, epoch + 12.345} {
			v := resolve(t, d, params[d.ID], s.pitch)
			all := make([]color.Color, 300)
			d.New().Render(s.ctx(v, tm), all)
			part := make([]color.Color, len(sub.pixels))
			ctx := sub.ctx(v, tm)
			ctx.Frame, ctx.Dt = 12345, 0.5
			d.New().Render(ctx, part)
			for j := range part {
				if part[j] != all[3*j] {
					t.Fatalf("%s at %v: pixel %d = %+v alone, %+v with the rest", d.ID, tm, 3*j, part[j], all[3*j])
				}
			}
		}
	}
}

func TestGradient(t *testing.T) {
	s := newStrip(100, 0.02, 1)
	out := s.render(t, Gradient(), map[string]any{"span": "2 m"}, epoch)
	rainbow := builtinPalette("rainbow")
	for _, k := range []int{0, 25, 50, 99} {
		if want := rainbow.At(float64(s.u[k]) / 2); !near(out[k], want, 1e-6) {
			t.Errorf("Default palette pixel %d = %+v, want rainbow %+v", k, out[k], want)
		}
	}
	// "* Color 1" is the first of the gradient's colours.
	out = s.render(t, Gradient(), map[string]any{"palette": "* Color 1", "colors": []any{"#3366ff"}}, epoch)
	if !near(out[40], lin("#3366ff"), 1e-6) {
		t.Errorf("* Color 1 = %+v", out[40])
	}
	// Moving at 0.4 m/s, the colour at u reaches u + 0.2 m (10 pixels)
	// after 0.5 s.
	raw := map[string]any{"palette": "Party", "span": "1 m", "speed": "0.4 m/s"}
	a, b := s.render(t, Gradient(), raw, epoch), s.render(t, Gradient(), raw, epoch+0.5)
	if !near(a[10], b[20], 1e-4) {
		t.Errorf("gradient didn't move by 0.2 m: %+v vs %+v", a[10], b[20])
	}
}

func TestChase(t *testing.T) {
	s := newStrip(100, 0.1, 1)
	speed := 0.5
	// Pulses 0.3 m long every 2 m; at this time they've moved 0.05 m, so
	// the first covers [0.05, 0.35).
	tm := atTravel(speed, 2, 0.05)
	raw := map[string]any{"width": "0.3 m", "spacing": "2 m", "speed": "0.5 m/s",
		"colors": []any{"#ff0000", "#00ff00"}, "background": "#000010"}
	out := s.render(t, Chase(), raw, tm)
	bg, red, green := lin("#000010"), lin("#ff0000"), lin("#00ff00")
	half := color.Lerp(bg, red, 0.5)
	for k, want := range map[int]color.Color{0: half, 1: red, 2: red, 3: half, 4: bg, 19: bg, 21: green} {
		if !near(out[k], want, 1e-5) {
			t.Errorf("pixel %d = %+v, want %+v", k, out[k], want)
		}
	}
	// A tail trails behind (below, when moving up u) and fades. Pixels
	// 18 and 19 are behind the second (green) pulse.
	raw["tail"] = "0.5 m"
	raw["overlay"] = true
	out = s.render(t, Chase(), raw, tm)
	if out[4].A != 0 || out[19].A <= 0 || out[18].A >= out[19].A || out[19].G != 1 {
		t.Errorf("tail: %v %v %v", out[4], out[18], out[19])
	}
	// Moving the other way, the tail is above the pulse.
	raw["speed"] = "-0.5 m/s"
	out = s.render(t, Chase(), raw, atTravel(speed, 2, 2-0.05))
	if out[4].A <= 0 || out[4].A <= out[5].A || out[19].A != 0 {
		t.Errorf("reverse tail: %v %v %v", out[4], out[5], out[19])
	}
}

func TestNoise(t *testing.T) {
	s := newStrip(400, 0.01, 1)
	out := s.render(t, Noise(), map[string]any{"scale": "0.5 m"}, epoch)
	maxStep, distinct := 0.0, map[color.Color]bool{}
	for k := 1; k < len(out); k++ {
		d := math.Abs(float64(out[k].R-out[k-1].R)) + math.Abs(float64(out[k].G-out[k-1].G)) + math.Abs(float64(out[k].B-out[k-1].B))
		maxStep = math.Max(maxStep, d)
		distinct[out[k]] = true
	}
	if maxStep > 0.2 || len(distinct) < 50 {
		t.Errorf("noise isn't smooth and varied: max step %v, %d colours", maxStep, len(distinct))
	}
	// It evolves in place.
	later := s.render(t, Noise(), map[string]any{"scale": "0.5 m", "evolve": "1 /s"}, epoch+0.5)
	if later[100] == out[100] {
		t.Error("noise didn't change over time")
	}
	// space: xy reads plan positions.
	d := Noise()
	v := resolve(t, d, map[string]any{"space": "xy"}, s.pitch)
	if d.CoordsOf(v) != render.CoordXY {
		t.Errorf("xy coords = %v", d.CoordsOf(v))
	}
	ctx := s.ctx(v, epoch)
	zeros := make([]float32, 400)
	ctx.X, ctx.Y = zeros, zeros
	flat := make([]color.Color, 400)
	d.New().Render(ctx, flat)
	if flat[0] != flat[399] {
		t.Error("xy noise should depend on x, y only")
	}
}

func TestBreathe(t *testing.T) {
	s := newStrip(3, 0.1, 1)
	raw := map[string]any{"color": "#ffffff", "background": "#000000", "period": "4 s", "min": 0.2, "max": 0.8}
	start := math.Floor(epoch/4) * 4
	lo := s.render(t, Breathe(), raw, start)
	hi := s.render(t, Breathe(), raw, start+2)
	mid := s.render(t, Breathe(), raw, start+1)
	if !near(lo[0], color.Color{R: perceived(0.2), G: perceived(0.2), B: perceived(0.2), A: 1}, 1e-5) {
		t.Errorf("low = %+v", lo[0])
	}
	if !near(hi[0], color.Color{R: perceived(0.8), G: perceived(0.8), B: perceived(0.8), A: 1}, 1e-5) {
		t.Errorf("high = %+v", hi[0])
	}
	if !near(mid[0], color.Color{R: perceived(0.5), G: perceived(0.5), B: perceived(0.5), A: 1}, 1e-5) {
		t.Errorf("middle = %+v", mid[0])
	}
}
