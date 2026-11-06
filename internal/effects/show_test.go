// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/render"
)

// showCtx is a strip context with the layer's age set: shows run on
// LayerT, not T.
func (s *strip) showCtx(v *render.Values, age float64) *render.Context {
	c := s.ctx(v, epoch+age)
	c.LayerT = age
	return c
}

func TestShowCuesComeAndGo(t *testing.T) {
	s := newStrip(10, 1.0/60, 1)
	d, err := Show("two-step", "Two step", ShowSpec{Length: 10, Cues: []Cue{
		{Name: "red", Effect: Solid(), At: 0, For: 4, Opacity: 1, Params: map[string]any{"color": "#ff0000"}},
		{Name: "blue", Effect: Solid(), At: 4, For: 0, Opacity: 1, FadeIn: 2, Params: map[string]any{"color": "#0000ff"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	v := resolve(t, d, nil, s.pitch)
	fx := d.New()
	at := func(age float64) color.Color {
		out := make([]color.Color, len(s.pixels))
		fx.Render(s.showCtx(v, age), out)
		return out[3]
	}
	red, blue, black := lin("#ff0000"), lin("#0000ff"), lin("#000000")
	if c := at(1); !near(c, red, 1e-5) {
		t.Fatalf("t=1: %+v, want red", c)
	}
	if c := at(5); near(c, blue, 1e-5) || near(c, black, 1e-5) {
		t.Fatalf("t=5 (fading in): %+v, want part-way to blue", c)
	}
	if c := at(8); !near(c, blue, 1e-5) {
		t.Fatalf("t=8: %+v, want blue", c)
	}
	// Past the end the last frame holds.
	if c := at(30); !near(c, blue, 1e-5) {
		t.Fatalf("t=30 (held): %+v, want blue", c)
	}
	// Looping starts over.
	vl := resolve(t, d, map[string]any{"loop": true}, s.pitch)
	out := make([]color.Color, len(s.pixels))
	d.New().Render(s.showCtx(vl, 11), out)
	if !near(out[3], red, 1e-5) {
		t.Fatalf("looped t=11: %+v, want red", out[3])
	}
	// Uncovered pixels show the background, or nothing with overlay.
	if c := at(4.0001); c.A != 1 {
		t.Fatalf("t=4: alpha %v, want opaque background", c.A)
	}
	vo := resolve(t, d, map[string]any{"overlay": true, "blue.fade_in": "0 s"}, s.pitch)
	gap, _ := Show("gap", "Gap", ShowSpec{Length: 10, Cues: []Cue{
		{Name: "red", Effect: Solid(), At: 0, For: 2, Opacity: 1, Params: map[string]any{"color": "#ff0000"}},
	}})
	vg := resolve(t, gap, map[string]any{"overlay": true}, s.pitch)
	gap.New().Render(s.showCtx(vg, 5), out)
	if out[3].A != 0 {
		t.Fatalf("overlay gap: alpha %v, want 0", out[3].A)
	}
	_ = vo
}

func TestShowCueTimeStartsAtZero(t *testing.T) {
	// A chase in a cue counts time from the cue's start: its pulse is at
	// u = 0 when the cue begins, whatever the show's age.
	s := newStrip(120, 1.0/60, 1)
	d, err := Show("late", "Late", ShowSpec{Cues: []Cue{
		{Name: "pulse", Effect: Chase(), At: 50, For: 10, Opacity: 1,
			Params: map[string]any{"width": "0.1 m", "spacing": "100 m", "speed": "0.5 m/s", "colors": []any{"#ffffff"}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	v := resolve(t, d, nil, s.pitch)
	out := make([]color.Color, len(s.pixels))
	d.New().Render(s.showCtx(v, 50.001), out)
	if out[0].R < 0.5 || out[100].R > 1e-3 {
		t.Fatalf("at the cue's start the pulse should be at u = 0: px0 %v px100 %v", out[0].R, out[100].R)
	}
	d.New().Render(s.showCtx(v, 52), out)
	// After 2 s at 0.5 m/s the pulse is at u = 1 m: pixel 60.
	if out[60].R < 0.5 || out[0].R > 1e-3 {
		t.Fatalf("after 2 s the pulse should be at 1 m: px0 %v px60 %v", out[0].R, out[60].R)
	}
}

func TestShowExtraMappingsAndMasks(t *testing.T) {
	// A cue with its own mapping reads Geometry.Extra, and a cue with a
	// target only paints its mask.
	s := newStrip(10, 1.0/60, 1)
	d, err := Show("spatial", "Spatial", ShowSpec{Cues: []Cue{
		{Name: "far", Effect: Bands(), Mapping: map[string]any{"kind": "radial", "center": []any{0, 0, 0}}, Opacity: 1,
			Params: map[string]any{"bands": []any{map[string]any{"color": "#ff0000", "width": "1 m"}, map[string]any{"color": "#00ff00", "width": "1 m"}}}},
		{Name: "patch", Effect: Solid(), Target: "patch", Opacity: 1, Params: map[string]any{"color": "#0000ff"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Extra.Mappings) != 1 || d.Extra.Areas[0] != "patch" {
		t.Fatalf("extra: %+v", d.Extra)
	}
	key := d.Extra.Mappings[0].Key
	if !strings.HasPrefix(key, config.InlinePrefix) {
		t.Fatalf("inline key %q", key)
	}
	// Pixels 0-4 are "near" (u 0.5) and 5-9 "far" (u 1.5) in the extra
	// mapping; the patch is pixels 8-9.
	g := &render.Geometry{Pixels: s.pixels, U: s.u, Dl: s.dl, Stretch: s.stretch, Index: s.index,
		Extra: map[string]*render.ExtraCoords{key: {U: make([]float32, 10), Stretch: make([]float32, 10)}},
		Masks: map[string][]bool{"patch": make([]bool, 10)}}
	for i := range 10 {
		g.Extra[key].U[i], g.Extra[key].Stretch[i] = 0.5, 1
		if i >= 5 {
			g.Extra[key].U[i] = 1.5
		}
		g.Masks["patch"][i] = i >= 8
	}
	g.Extra[key].U[4] = float32(math.NaN()) // outside the cue's mapping
	v := resolve(t, d, nil, s.pitch)
	ctx := s.showCtx(v, 1)
	ctx.Geometry = g
	out := make([]color.Color, 10)
	d.New().Render(ctx, out)
	red, green, blue, black := lin("#ff0000"), lin("#00ff00"), lin("#0000ff"), lin("#000000")
	for i, want := range []color.Color{red, red, red, red, black, green, green, green, blue, blue} {
		if !near(out[i], want, 1e-4) {
			t.Errorf("pixel %d: %+v, want %+v", i, out[i], want)
		}
	}
}

func TestShowErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		spec ShowSpec
		want string
	}{
		{"no cues", ShowSpec{}, "no cues"},
		{"bad param", ShowSpec{Cues: []Cue{{Effect: Solid(), Opacity: 1, Params: map[string]any{"nope": 1}}}}, "no parameter"},
		{"reserved name", ShowSpec{Cues: []Cue{{Name: "loop", Effect: Solid(), Opacity: 1}}}, "reserved"},
		{"dup name", ShowSpec{Cues: []Cue{{Effect: Solid(), Opacity: 1}, {Effect: Solid(), Opacity: 1}}}, "repeated"},
		{"bad mapping", ShowSpec{Cues: []Cue{{Effect: Solid(), Opacity: 1, Mapping: 3}}}, "mapping"},
		{"negative", ShowSpec{Cues: []Cue{{Effect: Solid(), Opacity: 1, At: -1}}}, "negative"},
	} {
		if _, err := Show("x", "x", tc.spec); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err %v, want %q", tc.name, err, tc.want)
		}
	}
}

func TestRegisterShows(t *testing.T) {
	r := registry(t)
	err := RegisterShows(r, []config.Show{
		{ID: "outer", Length: "20 s", Cues: []config.ShowCue{{Effect: "inner", At: "5 s"}}},
		{ID: "inner", Cues: []config.ShowCue{
			{Name: "a", Effect: "solid", For: "3 s", FadeOut: "1 s", Params: map[string]any{"color": "#ff0000"}},
			{Name: "b", Effect: "glitter", At: "3 s", Mapping: "local", Target: "porch"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	outer, ok := r.Get("outer")
	if !ok || outer.WLED == nil || outer.WLED.FX < FXCustom {
		t.Fatalf("outer not registered with a WLED id: %+v", outer)
	}
	// The outer show inherits the inner's extra mapping and area.
	if len(outer.Extra.Mappings) != 1 || outer.Extra.Mappings[0].Key != "local" || len(outer.Extra.Areas) != 1 {
		t.Fatalf("outer extra: %+v", outer.Extra)
	}
	if _, ok := outer.Param("inner.b.gradient.span"); !ok {
		t.Fatal("nested cue params should be prefixed twice")
	}
	for _, bad := range [][]config.Show{
		{{ID: "a", Cues: []config.ShowCue{{Effect: "b"}}}, {ID: "b", Cues: []config.ShowCue{{Effect: "a"}}}},
		{{ID: "solid", Cues: []config.ShowCue{{Effect: "solid"}}}},
		{{ID: "c", Cues: []config.ShowCue{{Effect: "nope"}}}},
		{{ID: "d", Cues: []config.ShowCue{{Effect: "solid", At: "soon"}}}},
	} {
		if err := RegisterShows(registry(t), bad); err == nil {
			t.Errorf("%v: want an error", bad[0].ID)
		}
	}
}

func TestEnvelope(t *testing.T) {
	for _, tc := range []struct {
		t, start, end, in, out, want float64
	}{
		{-1, 0, 10, 0, 0, 0},
		{5, 0, 10, 0, 0, 1},
		{1, 0, 10, 2, 0, 0.5},
		{9, 0, 10, 0, 2, 0.5},
		{11, 0, 10, 0, 0, 0},
		{2.5, 0, 10, 10, 10, 0.5}, // fades longer than the cue are shortened to meet in the middle
	} {
		if got := envelope(tc.t, tc.start, tc.end, tc.in, tc.out); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("envelope(%v, %v, %v, %v, %v) = %v, want %v", tc.t, tc.start, tc.end, tc.in, tc.out, got, tc.want)
		}
	}
}
