// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
)

func fieldContext(t testing.TB, mode string) *render.Context {
	d := SpatialField()
	v := resolve(t, d, map[string]any{"mode": mode, "color": "#00ffff", "accent": "#ff8000/ff",
		"speed": "1 m/s", "scale": "5 m", "width": ".8 m"}, 1.0/60)
	return &render.Context{Params: v, T: epoch + 6, LayerT: 4, Pixels: []int32{42, 43, 44}, X: []float32{3, 4, 5}, Y: []float32{1, 2, 3}, Z: []float32{.5, 3, 6}}
}

func TestSpatialFieldSeekAndSubset(t *testing.T) {
	for _, mode := range []string{"trace", "tide", "aurora", "orbit", "weave", "nova", "ember"} {
		t.Run(mode, func(t *testing.T) {
			c := fieldContext(t, mode)
			fx := SpatialField().New()
			a := make([]color.Color, 3)
			fx.Render(c, a)
			for _, v := range a {
				for _, ch := range []float32{v.R, v.G, v.B, v.W, v.A} {
					if math.IsNaN(float64(ch)) || ch < 0 || ch > 1 {
						t.Fatalf("invalid color %+v", v)
					}
				}
			}
			// Scrubbing away and back cannot alter the result.
			c.LayerT += 7
			fx.Render(c, make([]color.Color, 3))
			c.LayerT -= 7
			b := make([]color.Color, 3)
			fx.Render(c, b)
			for i := range a {
				if a[i] != b[i] {
					t.Fatal("seek changed result")
				}
			}
			// Same point, different controller id, target subset, creation time,
			// frame and seed: the spatial field remains synchronized.
			c.Pixels = []int32{900}
			c.X = c.X[1:2]
			c.Y = c.Y[1:2]
			c.Z = c.Z[1:2]
			c.T = 123
			c.Seed = 999
			c.Frame = 123
			fx.Render(c, b[:1])
			if b[0] != a[1] {
				t.Fatalf("subset/controller seam: %+v vs %+v", b[0], a[1])
			}
		})
	}
}

func TestSpatialFieldWhiteAndMissingGeometry(t *testing.T) {
	c := fieldContext(t, "ember")
	out := make([]color.Color, 3)
	fx := SpatialField().New()
	fx.Render(c, out)
	if out[0].W <= 0 {
		t.Fatal("lost explicit white")
	}
	c.X = nil
	fx.Render(c, out)
	for _, v := range out {
		if v != color.Black {
			t.Fatal("missing position must be black")
		}
	}
}

func TestSpatialFieldOriginTranslation(t *testing.T) {
	c := fieldContext(t, "nova")
	a := make([]color.Color, 3)
	SpatialField().New().Render(c, a)
	raw := c.Params.Raw()
	raw["origin_x"] = 10.0
	raw["origin_y"] = -5.0
	raw["origin_z"] = 2.0
	c.Params = resolve(t, SpatialField(), raw, 1.0/60)
	for i := range c.X {
		c.X[i] += 10
		c.Y[i] -= 5
		c.Z[i] += 2
	}
	b := make([]color.Color, 3)
	SpatialField().New().Render(c, b)
	for i := range a {
		if a[i] != b[i] {
			t.Fatal("translation changed score")
		}
	}
}

func BenchmarkSpatialField(b *testing.B) {
	c := fieldContext(b, "aurora")
	n := 25000
	c.Pixels = make([]int32, n)
	c.X = make([]float32, n)
	c.Y = make([]float32, n)
	c.Z = make([]float32, n)
	for i := range n {
		c.X[i] = float32(i%500) * .05
		c.Y[i] = float32(i/500) * .5
		c.Z[i] = 3
	}
	out := make([]color.Color, n)
	fx := SpatialField().New()
	b.ResetTimer()
	for b.Loop() {
		fx.Render(c, out)
	}
}

// The show engine, not SpatialField, owns cue start and loop time.
func TestSpatialFieldNativeShowClock(t *testing.T) {
	d, err := Show("test-spatial-show", "Test spatial show", ShowSpec{Length: 12, Loop: true, Cues: []Cue{
		{Name: "curtain", Effect: SpatialField(), At: 2, For: 8, Opacity: 1},
	}})
	if err != nil {
		t.Fatal(err)
	}
	strip := newStrip(100, .02, 1)
	ctx := strip.ctx(resolve(t, d, nil, .02), epoch)
	ctx.LayerT = 5
	out := make([]color.Color, 100)
	fx := d.New()
	fx.Render(ctx, out)
	child := strip.ctx(resolve(t, SpatialField(), nil, .02), 3)
	child.LayerT = 3
	want := make([]color.Color, 100)
	SpatialField().New().Render(child, want)
	for i := range want {
		if !near(out[i], want[i], 1e-6) {
			t.Fatalf("cue-local clock mismatch at %d", i)
		}
	}
	ctx.LayerT = 17
	fx.Render(ctx, out)
	for i := range want {
		if !near(out[i], want[i], 1e-6) {
			t.Fatalf("show loop mismatch at %d", i)
		}
	}
	ctx.LayerT = 1
	fx.Render(ctx, out)
	for _, c := range out {
		if c != color.Black {
			t.Fatal("show did not gate inactive field")
		}
	}
}
