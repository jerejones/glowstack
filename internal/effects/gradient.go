// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/render"
)

// Gradient stretches a palette over u, one full cycle per `span`,
// optionally moving. WLED's "Palette" (fx 65). Span follows the flow
// unless given as physical; speed is along u.
func Gradient() *render.Def {
	return &render.Def{
		ID:     "gradient",
		Name:   "Gradient",
		Coords: render.CoordU,
		Params: []render.Param{
			{Name: "palette", Type: render.TPalette, Default: "Default", Doc: "Default is Rainbow"},
			colorsParam("colours for the colour palettes (* Color 1, …)"),
			{Name: "span", Type: render.TLength, Default: "2 m", Doc: "length of one full palette cycle"},
			{Name: "speed", Type: render.TSpeed, Default: "0 m/s", Doc: "along u; negative moves backwards"},
		},
		WLED: &render.WLED{FX: 65, Name: "Palette", Bindings: append([]render.Binding{
			{Slider: render.SliderSpeed, Param: "speed", Curve: render.CurveExp, Min: "0 m/s", Max: "2 m/s"},
			{Slider: render.SliderIntensity, Param: "span", Curve: render.CurveExp, Min: "0.25 m", Max: "20 m"},
			{Slider: render.SliderPalette, Param: "palette"},
		}, colourBindings("")...)},
		New: func() render.Effect { return &gradient{} },
	}
}

var rainbow = builtinPalette("rainbow")

type gradient struct{ pal palette.Cache }

func (g *gradient) Render(ctx *render.Context, out []color.Color) {
	p := g.pal.Resolve(ctx.Params.Palette("palette"), ctx.Params.Colors("colors"), ctx.T, rainbow)
	span := ctx.Params.Length("span")
	speed := ctx.Params.Speed("speed")
	physical := span.Measure == render.MeasurePhysical
	s := span.Metres
	shift := travel(speed, ctx.T, s)
	for i := range out {
		if physical {
			s = span.InU(stretchAt(ctx, i))
			shift = travel(speed, ctx.T, s)
		}
		if s <= 0 {
			out[i] = p.At(0)
			continue
		}
		out[i] = p.At((float64(ctx.U[i]) - shift) / s)
	}
}
