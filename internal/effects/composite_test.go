// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/render"
)

// layer makes a render layer of d on strip s.
func (s *strip) layer(t testing.TB, d *render.Def, raw map[string]any, seed uint64, blend string, op float32) *render.Layer {
	return &render.Layer{
		ID: d.ID, Def: d, Effect: d.New(), Params: resolve(t, d, raw, s.pitch), Seed: seed, Fade: 1, Pitch: s.pitch,
		Common:   render.Common{Blend: blend, Opacity: op, Brightness: 1, White: render.WhiteExplicit, Smooth: true},
		Geometry: &render.Geometry{Pixels: s.pixels, U: s.u, Dl: s.dl, Stretch: s.stretch, Index: s.index},
	}
}

// compare renders two stacks (top first) at several times and checks
// they agree.
func compare(t *testing.T, n int, a, b []*render.Layer) {
	t.Helper()
	ca, cb := render.NewCompositor(n), render.NewCompositor(n)
	ba, bb := render.NewBuffer(n), render.NewBuffer(n)
	for f := range 40 {
		fr := clock.Frame{Seq: uint64(f), T: epoch + float64(f)*0.037, Dt: 0.037}
		ca.Render(fr, a, ba)
		cb.Render(fr, b, bb)
		for i := range ba.Pix {
			if !near(ba.Pix[i], bb.Pix[i], 1e-5) {
				t.Fatalf("frame %d pixel %d: %+v vs %+v", f, i, ba.Pix[i], bb.Pix[i])
			}
		}
	}
}

func TestGlitterIsGradientPlusSparkle(t *testing.T) {
	s := newStrip(600, 1.0/60, 1)
	const seed = 99
	glitter := s.layer(t, Glitter(), map[string]any{
		"gradient.palette": "Ocean", "gradient.speed": "0.3 m/s", "gradient.span": "3 m",
		"sparkle.density": "30 /m/s", "sparkle.color": "#ffe0a0",
	}, seed, render.BlendOver, 1)
	gradient := s.layer(t, Gradient(), map[string]any{"palette": "Ocean", "speed": "0.3 m/s", "span": "3 m"},
		partSeed(seed, 0), render.BlendOver, 1)
	sparkle := s.layer(t, Sparkle(), map[string]any{"density": "30 /m/s", "color": "#ffe0a0"},
		partSeed(seed, 1), render.BlendOver, 1)
	compare(t, 600, []*render.Layer{glitter}, []*render.Layer{sparkle, gradient})
}

// A composite of translucent parts over a base looks the same as its
// parts stacked over that base, because blend over is associative. (add,
// max and multiply parts act on the composite's own parts only.)
func TestCompositeOfTranslucentParts(t *testing.T) {
	s := newStrip(300, 0.02, 1.3)
	glow, err := Composite("glow", "Glow", []Part{
		{Effect: Chase(), Opacity: 0.7, Params: map[string]any{"overlay": true, "tail": "0.3 m", "colors": []any{"#ff0000", "#00ff00"}}},
		{Effect: Sparkle(), Opacity: 0.5, Params: map[string]any{"density": "40 /m/s"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	const seed = 5
	base := func() *render.Layer {
		return s.layer(t, Solid(), map[string]any{"color": "#203040"}, 1, render.BlendOver, 1)
	}
	one := []*render.Layer{s.layer(t, glow, nil, seed, render.BlendOver, 1), base()}
	chase := s.layer(t, Chase(), map[string]any{"overlay": true, "tail": "0.3 m", "colors": []any{"#ff0000", "#00ff00"}},
		partSeed(seed, 0), render.BlendOver, 0.7)
	sparkle := s.layer(t, Sparkle(), map[string]any{"density": "40 /m/s"}, partSeed(seed, 1), render.BlendOver, 0.5)
	compare(t, 300, one, []*render.Layer{sparkle, chase, base()})
}

func TestCompositesFromConfig(t *testing.T) {
	half := 0.5
	comps := []config.Composite{
		{ID: "double", Layers: []config.CompositeLayer{
			{Name: "ember", Effect: "ember-glitter"}, // defined below: order doesn't matter
			{Effect: "noise", Blend: "add", Opacity: &half, Params: map[string]any{"space": "xy"}},
		}},
		{ID: "ember-glitter", Name: "Ember glitter", Layers: []config.CompositeLayer{
			{Effect: "gradient", Params: map[string]any{"palette": "Lava", "speed": "0.1 m/s"}},
			{Effect: "sparkle", Blend: "over", Params: map[string]any{"density": "5 /m/s"}},
		}},
	}
	r := registry(t)
	if err := RegisterComposites(r, comps); err != nil {
		t.Fatal(err)
	}
	eg, _ := r.Get("ember-glitter")
	d, _ := r.Get("double")
	if eg.WLED == nil || d.WLED == nil || eg.WLED.FX != FXCustom || d.WLED.FX != FXCustom+1 {
		t.Fatalf("fx ids: %+v %+v", eg.WLED, d.WLED)
	}
	if bs := eg.Bindings(render.SliderSpeed); len(bs) != 1 || bs[0].Param != "gradient.speed" {
		t.Errorf("auto sx binding = %+v", bs)
	}
	if bs := eg.Bindings(render.SliderIntensity); len(bs) != 1 || bs[0].Param != "sparkle.density" {
		t.Errorf("auto ix binding = %+v", bs)
	}
	p, ok := d.Param("ember.gradient.speed")
	if !ok || p.Default != "0.1 m/s" {
		t.Errorf("nested param = %+v", p)
	}
	v := resolve(t, d, nil, 0.02)
	if d.CoordsOf(v) != render.CoordU|render.CoordXY {
		t.Errorf("coords = %v", d.CoordsOf(v))
	}
	names := WLEDEffectNames(r)
	if len(names) != FXCustom+2 || names[FXCustom] != "Ember glitter" || names[FXCustom+1] != "double" {
		t.Errorf("names end %v", names[len(names)-3:])
	}
	// It renders: the gradient underneath is opaque.
	st := newStrip(50, 0.02, 1)
	ctx := st.ctx(v, epoch)
	ctx.X, ctx.Y = st.u, st.u
	out := make([]color.Color, 50)
	d.New().Render(ctx, out)
	for i, c := range out {
		if !(c.A > 0.999) || c.R+c.G+c.B <= 0 {
			t.Fatalf("pixel %d = %+v", i, c)
		}
	}
}

func TestCompositeErrors(t *testing.T) {
	for _, tc := range []struct {
		comps []config.Composite
		want  string
	}{
		{[]config.Composite{
			{ID: "a", Layers: []config.CompositeLayer{{Effect: "b"}}},
			{ID: "b", Layers: []config.CompositeLayer{{Effect: "solid"}, {Effect: "a"}}},
		}, "part of itself: a → b → a"},
		{[]config.Composite{{ID: "c", Layers: []config.CompositeLayer{{Effect: "fire"}}}}, `no effect "fire"`},
		{[]config.Composite{{ID: "bands", Layers: []config.CompositeLayer{{Effect: "solid"}}}}, "already exists"},
		{[]config.Composite{{ID: "d", Layers: []config.CompositeLayer{{Effect: "solid", Params: map[string]any{"colour": "#fff"}}}}}, `no parameter "colour"`},
		{[]config.Composite{{ID: "e", Layers: []config.CompositeLayer{{Effect: "solid"}, {Effect: "solid"}}}}, "repeated"},
		{[]config.Composite{{ID: "f", Layers: []config.CompositeLayer{{Effect: "solid", Params: map[string]any{"color": "red"}}}}}, "bad default"},
	} {
		err := RegisterComposites(registry(t), tc.comps)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v: got %v, want %q", tc.comps[0].ID, err, tc.want)
		}
	}
}
