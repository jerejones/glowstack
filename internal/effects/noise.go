// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/render"
)

// Noise colours pixels from a palette by smooth 3-D gradient noise over u
// and time (`space: u`) or plan x, y and time (`space: xy`). WLED's
// "Noise Pal" (fx 107).
//
// `scale` is the feature size. It's physical by default, so the grain
// looks the same everywhere, stretched or not; give it as "1 m flow" to
// stretch with the flow. `speed` drifts the field along u (or plan x),
// and `evolve` is how fast it changes in place.
func Noise() *render.Def {
	return &render.Def{
		ID:     "noise",
		Name:   "Noise",
		Coords: render.CoordU,
		CoordsFor: func(v *render.Values) render.Coords {
			if v.Enum("space") == "xy" {
				return render.CoordXY
			}
			return render.CoordU
		},
		Params: []render.Param{
			{Name: "palette", Type: render.TPalette, Default: "Default", Doc: "Default is Party"},
			colorsParam("colours for the colour palettes (* Color 1, …)"),
			{Name: "scale", Type: render.TLength, Default: "1 m", Measure: render.MeasurePhysical, Doc: "feature size"},
			{Name: "speed", Type: render.TSpeed, Default: "0 m/s", Doc: "drift along u (or plan x)"},
			{Name: "evolve", Type: render.TRate, Default: "0.2 /s", Doc: "how fast the pattern changes in place"},
			{Name: "space", Type: render.TEnum, Default: "u", Enum: []string{"u", "xy"}},
			{Name: "seed", Type: render.TSeed, Default: 0, Doc: "mixed with the layer's seed"},
		},
		WLED: &render.WLED{FX: 107, Name: "Noise Pal", Bindings: append([]render.Binding{
			{Slider: render.SliderSpeed, Param: "evolve", Curve: render.CurveExp, Min: "0 /s", Max: "3 /s"},
			// WLED's Scale: higher is finer.
			{Slider: render.SliderIntensity, Param: "scale", Curve: render.CurveLog, Min: "5 m", Max: "0.1 m"},
			{Slider: render.SliderPalette, Param: "palette"},
		}, colourBindings("")...)},
		New: func() render.Effect { return &noise{} },
	}
}

type noise struct{ pal palette.Cache }

func (n *noise) Render(ctx *render.Context, out []color.Color) {
	v := ctx.Params
	p := n.pal.Resolve(v.Palette("palette"), v.Colors("colors"), ctx.T, nil)
	scale := v.Length("scale")
	speed, evolve := v.Speed("speed"), v.Rate("evolve")
	seed := hash(ctx.Seed, v.Seed("seed"))
	xy := v.Enum("space") == "xy" && ctx.X != nil
	// Keep the time coordinate small: evolve·t at epoch times is ~10⁸,
	// beyond which float64 noise loses its fine detail. Wrapping it every
	// 2²⁰ features is invisible.
	z := math.Mod(evolve*ctx.T, 1<<20)
	for i := range out {
		s := scale.InU(stretchAt(ctx, i))
		if xy {
			s = scale.Metres
		}
		if s <= 0 {
			out[i] = p.At(0)
			continue
		}
		drift := travel(speed, ctx.T, s*(1<<20))
		var x, y float64
		if xy {
			x, y = (float64(ctx.X[i])-drift)/s, float64(ctx.Y[i])/s
		} else {
			x = (float64(ctx.U[i]) - drift) / s
		}
		// Perlin noise mostly stays within ±0.7; spread it over the palette.
		out[i] = p.At(0.5 + 0.7*perlin(x, y, z, seed))
	}
}

// perlin is improved Perlin gradient noise in 3-D, about −1…1, with
// gradients picked by hashing the lattice point with seed.
func perlin(x, y, z float64, seed uint64) float64 {
	xf, yf, zf := math.Floor(x), math.Floor(y), math.Floor(z)
	xi, yi, zi := int64(xf), int64(yf), int64(zf)
	x, y, z = x-xf, y-yf, z-zf
	u, v, w := fade(x), fade(y), fade(z)
	g := func(dx, dy, dz int64) float64 {
		h := hash(seed, uint64(xi+dx), uint64(yi+dy), uint64(zi+dz))
		return grad(h, x-float64(dx), y-float64(dy), z-float64(dz))
	}
	return lerp(w,
		lerp(v, lerp(u, g(0, 0, 0), g(1, 0, 0)), lerp(u, g(0, 1, 0), g(1, 1, 0))),
		lerp(v, lerp(u, g(0, 0, 1), g(1, 0, 1)), lerp(u, g(0, 1, 1), g(1, 1, 1))))
}

func fade(t float64) float64 { return t * t * t * (t*(t*6-15) + 10) }

func lerp(t, a, b float64) float64 { return a + t*(b-a) }

// grad is Ken Perlin's 12 edge gradients (plus 4 repeats) dotted with
// (x, y, z).
func grad(h uint64, x, y, z float64) float64 {
	switch h >> 60 {
	case 0, 12:
		return x + y
	case 1, 13:
		return -x + y
	case 2:
		return x - y
	case 3:
		return -x - y
	case 4:
		return x + z
	case 5:
		return -x + z
	case 6:
		return x - z
	case 7:
		return -x - z
	case 8:
		return y + z
	case 9, 14:
		return -y + z
	case 10:
		return y - z
	default:
		return -y - z
	}
}
