// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
)

// Breathe fades between `background` and `color` and back once per
// `period`, from level `min` to `max`. Levels are perceptual, so the
// breathing looks even. WLED's "Breathe" (fx 2).
//
// To make the layers below breathe instead, use color #ffffff,
// background #000000 and `blend: multiply`.
func Breathe() *render.Def {
	return &render.Def{
		ID:     "breathe",
		Name:   "Breathe",
		Coords: render.CoordU,
		Params: []render.Param{
			{Name: "color", Type: render.TColor, Default: "#ffa000"},
			{Name: "background", Type: render.TColor, Default: "#000000"},
			{Name: "period", Type: render.TDuration, Default: "4 s", Doc: "one full breath"},
			{Name: "min", Type: render.TFraction, Default: 0.0, Doc: "lowest level"},
			{Name: "max", Type: render.TFraction, Default: 1.0, Doc: "highest level"},
		},
		WLED: &render.WLED{FX: 2, Name: "Breathe", Bindings: []render.Binding{
			{Slider: render.SliderSpeed, Param: "period", Curve: render.CurveLog, Min: "10 s", Max: "0.5 s"},
			{Slider: render.SliderColor0, Param: "color"},
			{Slider: render.SliderColor1, Param: "background"},
		}},
		New: func() render.Effect { return render.Func(renderBreathe) },
	}
}

func renderBreathe(ctx *render.Context, out []color.Color) {
	v := ctx.Params
	c := color.Lerp(v.Color("background"), v.Color("color"), breathLevel(ctx.T, v.Duration("period"), v.Fraction("min"), v.Fraction("max")))
	for i := range out {
		out[i] = c
	}
}

// breathLevel is the linear-light mix at time t: a raised cosine between
// lo and hi in perceptual terms, starting at lo at t = 0 (mod period).
func breathLevel(t, period, lo, hi float64) float32 {
	if period <= 0 {
		return perceived(hi)
	}
	ph := math.Mod(t, period) / period
	return perceived(lo + (hi-lo)*(1-math.Cos(2*math.Pi*ph))/2)
}
