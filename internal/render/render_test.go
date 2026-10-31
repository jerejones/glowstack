// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package render

import (
	"math"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/plan"
	"github.com/jerejones/glowstack/internal/units"
)

// tenPixels is one 1 m run of ten pixels, a → b.
func tenPixels(t *testing.T) (*layout.Layout, *layout.Mapping) {
	t.Helper()
	cfg := &config.Config{
		Controllers: []config.Controller{{ID: "c", Host: "192.0.2.1", Pixels: 10}},
		Layout: config.Layout{Pitch: units.Length{Value: 0.1}, Runs: []config.Run{
			{ID: "r", Controller: "c", Indices: [2]int{0, 9}, Path: []string{"a", "b"}},
		}},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	l, err := layout.BuildWith(cfg, func(string) (*plan.Drawing, error) { return nil, nil })
	if err != nil {
		t.Fatal(err)
	}
	m, err := layout.SolveSpatial(l, &config.Mapping{ID: "local", Kind: config.KindLocal})
	if err != nil {
		t.Fatal(err)
	}
	return l, m
}

func ids(lo, hi int32) []int32 {
	var s []int32
	for p := lo; p <= hi; p++ {
		s = append(s, p)
	}
	return s
}

// recorder is an effect that remembers what it was asked for and paints
// a fixed colour.
type recorder struct {
	c       color.Color
	pixels  []int32
	index   []int32
	count   int
	u       []float32
	renders int
}

func (r *recorder) Render(ctx *Context, out []color.Color) {
	r.pixels = append([]int32(nil), ctx.Pixels...)
	r.index = append([]int32(nil), ctx.Index...)
	r.u = append([]float32(nil), ctx.U...)
	r.count = ctx.Count
	r.renders++
	for i := range out {
		out[i] = r.c
	}
}

func layer(t *testing.T, l *layout.Layout, m *layout.Mapping, target []int32, eff Effect, stateful bool, common map[string]any) *Layer {
	t.Helper()
	c, err := ResolveCommon(common, Env{Pitch: 0.1})
	if err != nil {
		t.Fatal(err)
	}
	def := &Def{ID: "test", Coords: CoordU, Stateful: stateful}
	return &Layer{ID: "l", Def: def, Effect: eff, Common: c, Fade: 1, Params: &Values{}, Geometry: BuildGeometry(l, m, target, def.Coords, c)}
}

var (
	red   = color.Color{R: 1, A: 1}
	blue  = color.Color{B: 1, A: 1}
	frame = clock.Frame{T: 1000}
)

func TestEarlyOutSkipsCoveredPixels(t *testing.T) {
	l, m := tenPixels(t)
	top := &recorder{c: red}
	bottom := &recorder{c: blue}
	layers := []*Layer{
		layer(t, l, m, ids(0, 4), top, false, nil),
		layer(t, l, m, ids(0, 9), bottom, false, nil),
	}
	c := NewCompositor(10)
	buf := NewBuffer(10)
	c.Render(frame, layers, buf)
	if len(bottom.pixels) != 5 || bottom.pixels[0] != 5 || bottom.count != 10 || bottom.index[0] != 5 {
		t.Errorf("bottom rendered %v (index %v, count %d)", bottom.pixels, bottom.index, bottom.count)
	}
	if !near(bottom.u[0], 0.55) {
		t.Errorf("bottom u = %v", bottom.u)
	}
	for p := range 10 {
		want := blue
		if p < 5 {
			want = red
		}
		if buf.Pix[p] != want {
			t.Errorf("pixel %d = %+v", p, buf.Pix[p])
		}
	}
	// A layer that's completely covered isn't evaluated at all.
	hidden := &recorder{c: blue}
	layers = append(layers, layer(t, l, m, ids(2, 7), hidden, false, nil))
	c.Render(frame, layers, buf)
	if hidden.renders != 0 {
		t.Errorf("hidden layer rendered %d times", hidden.renders)
	}
}

func TestTop(t *testing.T) {
	l, m := tenPixels(t)
	clear := color.Color{R: 1}
	layers := []*Layer{
		layer(t, l, m, ids(0, 2), &recorder{c: clear}, false, map[string]any{"blend": BlendOver}),
		layer(t, l, m, ids(2, 4), &recorder{c: red}, false, nil),
		layer(t, l, m, ids(0, 6), &recorder{c: blue}, false, nil),
	}
	layers[0].ID, layers[1].ID, layers[2].ID = "glass", "red", "blue"
	c := NewCompositor(10)
	c.Render(frame, layers, NewBuffer(10))
	top := make([]int32, 10)
	got := c.Top(top, nil)
	// The transparent top layer never shows; red shows above blue.
	if strings.Join(got, ",") != "red,blue" {
		t.Fatalf("ids = %v", got)
	}
	want := []int32{1, 1, 0, 0, 0, 1, 1, -1, -1, -1}
	for p := range want {
		if top[p] != want[p] {
			t.Errorf("top = %v, want %v", top, want)
			break
		}
	}
}

func TestStatefulGetsFullTarget(t *testing.T) {
	l, m := tenPixels(t)
	bottom := &recorder{c: blue}
	layers := []*Layer{
		layer(t, l, m, ids(0, 9), &recorder{c: red}, false, nil),
		layer(t, l, m, ids(0, 9), bottom, true, nil),
	}
	buf := NewBuffer(10)
	NewCompositor(10).Render(frame, layers, buf)
	if len(bottom.pixels) != 10 || bottom.renders != 1 {
		t.Errorf("stateful rendered %v", bottom.pixels)
	}
	if buf.Pix[9] != red {
		t.Errorf("covered pixel shows %+v", buf.Pix[9])
	}
}

func near(a, b float32) bool { return math.Abs(float64(a-b)) < 1e-5 }

func TestBlendModes(t *testing.T) {
	l, m := tenPixels(t)
	grey := color.Color{R: 0.5, G: 0.5, B: 0.5, A: 1}
	half := color.Color{R: 1, G: 0, B: 0.25, A: 0.5}
	tests := []struct {
		blend   string
		opacity float64
		want    color.Color
	}{
		{BlendOver, 1, color.Color{R: 0.75, G: 0.25, B: 0.375, A: 1}},
		{BlendOver, 0.5, color.Color{R: 0.625, G: 0.375, B: 0.4375, A: 1}},
		{BlendAdd, 1, color.Color{R: 1, G: 0.5, B: 0.625, A: 1}},
		{BlendMax, 1, color.Color{R: 0.75, G: 0.5, B: 0.5, A: 1}},
		{BlendMultiply, 1, color.Color{R: 0.5, G: 0.25, B: 0.3125, A: 1}},
		{BlendReplace, 1, color.Color{R: 1, G: 0, B: 0.25, A: 1}},
		{BlendReplace, 0.5, color.Color{R: 0.75, G: 0.25, B: 0.375, A: 1}},
	}
	for _, tt := range tests {
		layers := []*Layer{
			layer(t, l, m, ids(0, 0), &recorder{c: half}, false, map[string]any{"blend": tt.blend, "opacity": tt.opacity}),
			layer(t, l, m, ids(0, 0), &recorder{c: grey}, false, nil),
		}
		buf := NewBuffer(10)
		NewCompositor(10).Render(frame, layers, buf)
		got := buf.Pix[0]
		if !near(got.R, tt.want.R) || !near(got.G, tt.want.G) || !near(got.B, tt.want.B) || !near(got.A, tt.want.A) {
			t.Errorf("%s opacity %v: %+v, want %+v", tt.blend, tt.opacity, got, tt.want)
		}
	}
}

func TestBrightnessFadeWhiteGain(t *testing.T) {
	l, m := tenPixels(t)
	warm := color.Color{R: 1, G: 0.5, B: 0.25, A: 1}
	L := layer(t, l, m, ids(0, 1), &recorder{c: warm}, false, map[string]any{"brightness": 0.5, "white": "accurate"})
	L.Fade = 0.5
	c := NewCompositor(10)
	c.Master = 0.5
	c.Gain = []float32{1, 0.5, 1, 1, 1, 1, 1, 1, 1, 1}
	buf := NewBuffer(10)
	c.Render(frame, []*Layer{L}, buf)
	// brightness 0.5 → (0.5, 0.25, 0.125); accurate white moves 0.125 to W;
	// fade 0.5 over black halves it; master 0.5 halves again.
	want := color.Color{R: 0.09375, G: 0.03125, W: 0.03125}
	got := buf.Pix[0]
	if !near(got.R, want.R) || !near(got.G, want.G) || !near(got.B, 0) || !near(got.W, want.W) {
		t.Errorf("pixel 0 = %+v, want %+v", got, want)
	}
	if !near(buf.Pix[1].R, want.R/2) {
		t.Errorf("gain: %+v", buf.Pix[1])
	}
	if buf.Pix[5] != (color.Color{}) {
		t.Errorf("uncovered pixel = %+v", buf.Pix[5])
	}
}

func TestGeometry(t *testing.T) {
	l, m := tenPixels(t)
	c, _ := ResolveCommon(map[string]any{"reverse": true, "offset": "1 px"}, Env{Pitch: 0.1})
	g := BuildGeometry(l, m, ids(0, 9), CoordU, c)
	// Reversed: pixel 9 comes first with u = -0.95 - 0.1.
	if g.Pixels[0] != 9 || !near(g.U[0], -1.05) || g.Index[9] != 9 || g.Pixels[9] != 0 {
		t.Errorf("reverse geometry: %v %v", g.Pixels, g.U)
	}
	// Pixels outside the mapping are dark.
	m2 := *m
	m2.U = append([]float32(nil), m.U...)
	m2.U[3] = float32(math.NaN())
	g = BuildGeometry(l, &m2, ids(0, 9), CoordU, Common{})
	if len(g.Dark) != 1 || g.Dark[0] != 3 || len(g.Pixels) != 9 {
		t.Errorf("dark = %v", g.Dark)
	}
	// The mapping domain applies even when an effect does not read u.
	if g = BuildGeometry(l, &m2, ids(0, 9), 0, Common{}); len(g.Dark) != 1 {
		t.Errorf("no-coordinate effect dark = %v", g.Dark)
	}
	// Index mapping: position within the target, 0–1.
	im, _ := layout.SolveSpatial(l, &config.Mapping{ID: "index", Kind: config.KindIndex})
	g = BuildGeometry(l, im, ids(5, 9), CoordIndex, Common{})
	if !near(g.U[0], 0) || !near(g.U[4], 1) || !near(g.U[2], 0.5) {
		t.Errorf("index u = %v", g.U)
	}
	// Dark pixels render opaque black over lower layers.
	L := layer(t, l, &m2, ids(0, 9), &recorder{c: red}, false, nil)
	under := layer(t, l, m, ids(0, 9), &recorder{c: blue}, false, nil)
	buf := NewBuffer(10)
	NewCompositor(10).Render(frame, []*Layer{L, under}, buf)
	if buf.Pix[3] != color.Black || buf.Pix[4] != red {
		t.Errorf("dark pixel = %+v", buf.Pix[3])
	}
}

func TestResolveParams(t *testing.T) {
	params := []Param{
		{Name: "width", Type: TLength, Default: "20 px"},
		{Name: "grain", Type: TLength, Default: "1 m", Measure: MeasurePhysical},
		{Name: "speed", Type: TSpeed, Default: "1 px/8s"},
		{Name: "density", Type: TDensity, Default: "0.5 /m/s"},
		{Name: "mix", Type: TFraction, Default: "50%"},
		{Name: "angle", Type: TAngle, Default: 90},
		{Name: "edge", Type: TEnum, Default: "soft", Enum: []string{"hard", "soft"}},
		{Name: "colors", Type: TColors, Default: []any{"#ff0000", "#0000ff"}},
		{Name: "seed", Type: TSeed, Default: 7},
		{Name: "bands", Type: TList, Default: []any{}, Fields: []Param{
			{Name: "color", Type: TColor, Default: "#ffffff"},
			{Name: "width", Type: TLength, Default: "1 px"},
		}},
	}
	if err := checkSchema(params, true); err != nil {
		t.Fatal(err)
	}
	v, err := Resolve(params, map[string]any{
		"grain": "10 px flow",
		"width": map[string]any{"value": "0.5 m", "measure": "physical"},
		"bands": []any{map[string]any{"color": "#ff5a00", "width": "20 px"}, map[string]any{"color": "#3cff00"}},
	}, Env{Pitch: 0.1})
	if err != nil {
		t.Fatal(err)
	}
	if w := v.Length("width"); w.Metres != 0.5 || w.Measure != MeasurePhysical || !near(float32(w.InU(2)), 0.25) {
		t.Errorf("width = %+v", w)
	}
	if g := v.Length("grain"); !near(float32(g.Metres), 1) || g.Measure != MeasureFlow {
		t.Errorf("grain = %+v", g)
	}
	if s := v.Speed("speed"); !near(float32(s), 0.0125) {
		t.Errorf("speed = %v", s)
	}
	if v.Fraction("mix") != 0.5 || !near(float32(v.Angle("angle")), math.Pi/2) || v.Enum("edge") != "soft" || v.Seed("seed") != 7 {
		t.Errorf("values = %+v", v.vals)
	}
	bands := v.List("bands")
	if len(bands) != 2 || !near(float32(bands[0].Length("width").Metres), 2) || !near(float32(bands[1].Length("width").Metres), 0.1) {
		t.Errorf("bands = %+v", bands)
	}
	if len(v.Colors("colors")) != 2 || v.Raw()["grain"] != "10 px flow" {
		t.Errorf("colors/raw")
	}
	for raw, want := range map[string]map[string]any{
		`unknown parameter "nope"`:  {"nope": 1},
		`edge: "wavy": want one of`: {"edge": "wavy"},
		`mix: 2 is outside 0–1`:     {"mix": 2.0},
		`width: bad length`:         {"width": "3 parsecs"},
	} {
		if _, err := Resolve(params, want, Env{Pitch: 0.1}); err == nil || !strings.Contains(err.Error(), raw) {
			t.Errorf("Resolve(%v) error = %v, want %q", want, err, raw)
		}
	}
}

func TestRegistry(t *testing.T) {
	r := NewRegistry()
	newE := func() Effect { return Func(func(*Context, []color.Color) {}) }
	if err := r.Register(&Def{ID: "a", New: newE, WLED: &WLED{FX: 3}}); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		d    *Def
		want string
	}{
		{&Def{ID: "a", New: newE}, "registered twice"},
		{&Def{ID: "b", New: newE, WLED: &WLED{FX: 3}}, "already bound"},
		{&Def{ID: "c", New: newE, Params: []Param{{Name: "x", Type: TLength}}}, "has no default"},
		{&Def{ID: "d", New: newE, Params: []Param{{Name: "x", Type: TLength, Default: "fast"}}}, "bad default"},
		{&Def{ID: "e", New: newE, Params: []Param{{Name: "opacity", Type: TFraction, Default: 1}}}, "common layer parameter"},
		{&Def{ID: "f"}, "needs an id and New"},
	}
	for _, tt := range tests {
		if err := r.Register(tt.d); err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("Register(%s) = %v, want %q", tt.d.ID, err, tt.want)
		}
	}
	if d, ok := r.ByWLED(3); !ok || d.ID != "a" || d.Name != "a" {
		t.Errorf("ByWLED = %v", d)
	}
	common, effect := SplitParams(map[string]any{"opacity": 0.5, "color": "#fff"})
	if len(common) != 1 || len(effect) != 1 {
		t.Errorf("split = %v %v", common, effect)
	}
}

func TestUnreachedDarkAppliesToEffectsWithoutCoordinates(t *testing.T) {
	l, m := tenPixels(t)
	m.U[3] = float32(math.NaN())
	for _, coords := range []Coords{0, CoordXY} {
		// Supply plan positions so only the flow domain excludes pixel 3.
		for i := range l.Pixels {
			l.Pixels[i].Plan = 0
		}
		top := layer(t, l, m, ids(0, 9), &recorder{c: red}, false, nil)
		top.Def.Coords = coords
		top.Geometry = BuildGeometry(l, m, ids(0, 9), coords, top.Common)
		under := layer(t, l, m, ids(0, 9), &recorder{c: blue}, false, nil)
		buf := NewBuffer(10)
		NewCompositor(10).Render(frame, []*Layer{top, under}, buf)
		if buf.Pix[3] != color.Black || buf.Pix[4] != red {
			t.Fatalf("coords %v: unreached pixel = %+v, reached pixel = %+v", coords, buf.Pix[3], buf.Pix[4])
		}
	}
}
