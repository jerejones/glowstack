// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/units"
)

// epoch is a fixed frame time near today's, so phase maths is tested at
// realistic magnitudes.
const epoch = 1_790_000_000.0

var palettes = palette.NewRegistry(nil)

func registry(t testing.TB) *render.Registry {
	t.Helper()
	r := render.NewRegistry()
	if err := Register(r); err != nil {
		t.Fatal(err)
	}
	return r
}

// strip is n pixels of size pitch along u from 0, all with the same
// physical size and stretch: pixel k's centre is at (k + ½)·pitch.
type strip struct {
	pixels  []int32
	u       []float32
	dl      []float32
	stretch []float32
	index   []int32
	pitch   float64
}

func newStrip(n int, pitch, stretch float64) *strip {
	s := &strip{pitch: pitch}
	for k := range n {
		s.pixels = append(s.pixels, int32(k))
		// u-length of a pixel is dl / stretch.
		s.u = append(s.u, float32((float64(k)+0.5)*pitch/stretch))
		s.dl = append(s.dl, float32(pitch))
		s.stretch = append(s.stretch, float32(stretch))
		s.index = append(s.index, int32(k))
	}
	return s
}

func resolve(t testing.TB, d *render.Def, raw map[string]any, pitch float64) *render.Values {
	t.Helper()
	v, err := render.Resolve(d.Params, raw, render.Env{Pitch: pitch, Palettes: palettes})
	if err != nil {
		t.Fatalf("%s: %v", d.ID, err)
	}
	return v
}

func (s *strip) ctx(v *render.Values, tm float64) *render.Context {
	return &render.Context{
		T: tm, Params: v, Pitch: s.pitch, Smooth: true, Seed: 42,
		Pixels: s.pixels, U: s.u, Dl: s.dl, Stretch: s.stretch, Index: s.index, Count: len(s.pixels),
	}
}

// render renders effect d with raw params on s at time tm.
func (s *strip) render(t testing.TB, d *render.Def, raw map[string]any, tm float64) []color.Color {
	t.Helper()
	out := make([]color.Color, len(s.pixels))
	d.New().Render(s.ctx(resolve(t, d, raw, s.pitch), tm), out)
	return out
}

func lin(hex string) color.Color {
	c, err := units.ParseColor(hex)
	if err != nil {
		panic(err)
	}
	return color.Linear(c)
}

func near(a, b color.Color, tol float64) bool {
	d := func(x, y float32) bool { return math.Abs(float64(x-y)) <= tol }
	return d(a.R, b.R) && d(a.G, b.G) && d(a.B, b.B) && d(a.W, b.W) && d(a.A, b.A)
}
