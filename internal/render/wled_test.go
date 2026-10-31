// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package render

import (
	"math"
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/units"
)

func TestCurveRoundTrip(t *testing.T) {
	for _, c := range []Curve{CurveLinear, CurveExp, CurveLog} {
		if c.Value(0) != 0 || math.Abs(c.Value(1)-1) > 1e-12 {
			t.Errorf("%s: ends are %v, %v", c, c.Value(0), c.Value(1))
		}
		for s := range 256 {
			x := float64(s) / 255
			if got := int(math.Round(c.Slider(c.Value(x)) * 255)); got != s {
				t.Errorf("%s: slider %d → %d", c, s, got)
			}
		}
	}
	// exp gives fine control near the bottom.
	if CurveExp.Value(0.5) > 0.2 || CurveLog.Value(0.5) < 0.8 {
		t.Errorf("curve shapes: exp(0.5) = %v, log(0.5) = %v", CurveExp.Value(0.5), CurveLog.Value(0.5))
	}
}

func bindingDef() *Def {
	return &Def{
		ID: "test",
		Params: []Param{
			{Name: "speed", Type: TSpeed, Default: "0.1 m/s"},
			{Name: "density", Type: TDensity, Default: "1 /m/s"},
			{Name: "period", Type: TDuration, Default: "4 s"},
			{Name: "bands", Type: TList, Default: []any{map[string]any{"width": "1 m", "color": "#ff0000"}},
				Fields: []Param{{Name: "width", Type: TLength, Default: "1 m"}, {Name: "color", Type: TColor, Default: "#ffffff"}}},
			{Name: "colors", Type: TColors, Default: []any{"#ffa000"}},
			{Name: "palette", Type: TPalette, Default: "Rainbow"},
			{Name: "flag", Type: TBool, Default: false},
			{Name: "edge", Type: TEnum, Default: "hard", Enum: []string{"hard", "soft", "fuzzy"}},
			{Name: "count", Type: TInt, Default: 3},
		},
		WLED: &WLED{FX: 1, Name: "Test", Bindings: []Binding{
			{Slider: SliderSpeed, Param: "speed", Curve: CurveExp, Min: "0 m/s", Max: "2 m/s"},
			{Slider: SliderIntensity, Param: "bands.0.width", Curve: CurveLinear, Min: "1 px", Max: "256 px"},
			{Slider: SliderC1, Param: "period", Curve: CurveLog, Min: "10 s", Max: "0.5 s"},
			{Slider: SliderC2, Param: "edge"},
			{Slider: SliderC3, Param: "count", Min: 0, Max: 255},
			{Slider: SliderO1, Param: "flag"},
			{Slider: SliderColor0, Param: "colors.0"},
			{Slider: SliderColor1, Param: "colors.2"},
			{Slider: SliderColor2, Param: "bands.1.color"},
			{Slider: SliderPalette, Param: "palette"},
		}},
	}
}

func TestSlidersRoundTrip(t *testing.T) {
	d := bindingDef()
	env := Env{Pitch: 1.0 / 60, Palettes: testPalettes()}
	for _, s := range []Slider{SliderSpeed, SliderIntensity, SliderC1, SliderC3} {
		for pos := range 256 {
			raw, err := d.SetWLED(map[string]any{}, s, pos, env)
			if err != nil {
				t.Fatal(err)
			}
			v, err := Resolve(d.Params, raw, env)
			if err != nil {
				t.Fatalf("%s %d: %v (raw %v)", s, pos, err, raw)
			}
			got, ok, err := d.GetWLED(v, s, env)
			if err != nil || !ok || got != pos {
				t.Fatalf("%s: %d → %v → %v (%v)", s, pos, raw, got, err)
			}
		}
	}
	// Enums split the slider into equal parts.
	for pos, want := range map[int]string{0: "hard", 100: "soft", 255: "fuzzy"} {
		raw, _ := d.SetWLED(nil, SliderC2, pos, env)
		if raw["edge"] != want {
			t.Errorf("c2 %d = %v", pos, raw["edge"])
		}
		v, _ := Resolve(d.Params, raw, env)
		back, _, _ := d.GetWLED(v, SliderC2, env)
		again, _ := d.SetWLED(nil, SliderC2, back.(int), env)
		if again["edge"] != want {
			t.Errorf("c2 %s didn't round-trip: %v", want, back)
		}
	}
}

func TestSliderKeepsSignAndMeasure(t *testing.T) {
	d := bindingDef()
	env := Env{Pitch: 0.1, Palettes: testPalettes()}
	raw := map[string]any{"speed": "-0.5 m/s", "bands": []any{map[string]any{"width": "3 m physical"}}}
	raw2, err := d.SetWLED(raw, SliderSpeed, 255, env)
	if err != nil {
		t.Fatal(err)
	}
	if raw2["speed"] != "-2 m/s" {
		t.Errorf("speed = %v", raw2["speed"])
	}
	raw3, _ := d.SetWLED(raw2, SliderIntensity, 0, env)
	if w := raw3["bands"].([]any)[0].(map[string]any)["width"]; w != "0.1 m physical" {
		t.Errorf("width = %v", w)
	}
	if raw["speed"] != "-0.5 m/s" {
		t.Error("SetWLED changed its input")
	}
	v, err := Resolve(d.Params, raw3, env)
	if err != nil {
		t.Fatal(err)
	}
	if sx, _, _ := d.GetWLED(v, SliderSpeed, env); sx != 255 {
		t.Errorf("reverse speed reads back as %v", sx)
	}
}

func TestColorPaletteAndOptionBindings(t *testing.T) {
	d := bindingDef()
	env := Env{Pitch: 0.1, Palettes: testPalettes()}
	raw := map[string]any{}
	var err error
	set := func(s Slider, v any) {
		if raw, err = d.SetWLED(raw, s, v, env); err != nil {
			t.Fatal(err)
		}
	}
	set(SliderColor0, units.Color{R: 0x12, G: 0x34, B: 0x56})
	set(SliderColor1, units.Color{R: 0xff, W: 0x40, HasW: true})
	set(SliderColor2, units.Color{B: 0xff})
	set(SliderPalette, 11)
	set(SliderO1, true)
	cols := raw["colors"].([]any)
	if len(cols) != 3 || cols[0] != "#123456" || cols[1] != "#000000" || cols[2] != "#ff0000/40" {
		t.Errorf("colors = %v", cols)
	}
	if raw["palette"] != "rainbow" || raw["flag"] != true {
		t.Errorf("raw = %v", raw)
	}
	bands := raw["bands"].([]any)
	if len(bands) != 2 || bands[0].(map[string]any)["width"] != "1 m" || bands[1].(map[string]any)["color"] != "#0000ff" {
		t.Errorf("bands = %v", bands)
	}
	v, err := Resolve(d.Params, raw, env)
	if err != nil {
		t.Fatal(err)
	}
	for s, want := range map[Slider]any{
		SliderColor0:  units.Color{R: 0x12, G: 0x34, B: 0x56},
		SliderColor1:  units.Color{R: 0xff, W: 0x40, HasW: true},
		SliderColor2:  units.Color{B: 0xff},
		SliderPalette: 11,
		SliderO1:      true,
	} {
		if got, ok, err := d.GetWLED(v, s, env); !ok || err != nil || got != want {
			t.Errorf("%s = %v (%v), want %v", s, got, err, want)
		}
	}
	if _, ok, _ := d.GetWLED(v, SliderO3, env); ok {
		t.Error("unbound o3 reported a value")
	}
}

func TestSub(t *testing.T) {
	params := []Param{
		{Name: "a.speed", Type: TSpeed, Default: "1 m/s"},
		{Name: "a.b.speed", Type: TSpeed, Default: "2 m/s"},
		{Name: "c.speed", Type: TSpeed, Default: "3 m/s"},
	}
	v, err := Resolve(params, map[string]any{"a.b.speed": "4 m/s"}, Env{Pitch: 1})
	if err != nil {
		t.Fatal(err)
	}
	a := v.Sub("a")
	if a.Speed("speed") != 1 || a.Sub("b").Speed("speed") != 4 || a.Has("c.speed") {
		t.Errorf("Sub(a) = %+v", a)
	}
	if raw := a.Sub("b").Raw(); raw["speed"] != "4 m/s" {
		t.Errorf("raw = %v", raw)
	}
}

func TestWhiteModes(t *testing.T) {
	c := color.Color{R: 0.5, G: 0.4, B: 0.3, A: 1}
	if got := deriveWhite(c, WhiteExplicit); got != c {
		t.Errorf("explicit = %+v", got)
	}
	if got := deriveWhite(c.WithAlpha(1), WhiteBrighter); got.W != 0.3 || got.R != 0.5 {
		t.Errorf("brighter = %+v", got)
	}
	if got := deriveWhite(c, WhiteAccurate); got.W != 0.3 || math.Abs(float64(got.R-0.2)) > 1e-6 || got.B != 0 {
		t.Errorf("accurate = %+v", got)
	}
	withW := color.Color{R: 0.5, G: 0.5, B: 0.5, W: 0.2, A: 1}
	if got := deriveWhite(withW, WhiteAccurate); got != withW {
		t.Errorf("accurate with authored white = %+v", got)
	}
	if got := deriveWhite(withW, WhiteNone); got.W != 0 || got.R != 0.5 {
		t.Errorf("none = %+v", got)
	}
}

func testPalettes() *palette.Registry {
	return palette.NewRegistry(nil)
}

func TestSliderPreservesStructuredPhysicalMeasure(t *testing.T) {
	d := bindingDef()
	env := Env{Pitch: 0.1, Palettes: testPalettes()}
	raw := map[string]any{"bands": []any{map[string]any{"width": map[string]any{"value": "3 m", "measure": "physical"}}}}
	updated, err := d.SetWLED(raw, SliderIntensity, 128, env)
	if err != nil {
		t.Fatal(err)
	}
	v, err := Resolve(d.Params, updated, env)
	if err != nil {
		t.Fatal(err)
	}
	if got := v.List("bands")[0].Length("width").Measure; got != MeasurePhysical {
		t.Fatalf("slider changed structured physical width to %q", got)
	}
}
