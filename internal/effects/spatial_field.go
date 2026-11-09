// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
)

// SpatialField is a reusable stateless spatial motif. It has no cue list,
// scheduling, epoch, or loop clock: native shows supply cue-local time.
// The same physical point renders identically across controller boundaries.
func SpatialField() *render.Def {
	return &render.Def{ID: "spatial-field", Name: "Spatial field", Coords: render.CoordXY,
		Params: []render.Param{
			{Name: "mode", Type: render.TEnum, Default: "tide", Enum: []string{"trace", "tide", "aurora", "orbit", "weave", "nova", "ember"}},
			{Name: "color", Type: render.TColor, Default: "#00dfff"},
			{Name: "accent", Type: render.TColor, Default: "#ff8508"},
			{Name: "level", Type: render.TFraction, Default: 0.7},
			{Name: "speed", Type: render.TSpeed, Default: "1 m/s"},
			{Name: "scale", Type: render.TLength, Default: "6 m"},
			{Name: "width", Type: render.TLength, Default: "0.7 m"},
			{Name: "origin_x", Type: render.TNumber, Default: 0},
			{Name: "origin_y", Type: render.TNumber, Default: 0},
			{Name: "origin_z", Type: render.TNumber, Default: 0},
			{Name: "phase", Type: render.TNumber, Default: 0, Doc: "phase in radians"},
		}, New: func() render.Effect { return render.Func(renderSpatialField) }}
}

func scoreSmooth(x float64) float64      { x = math.Max(0, math.Min(1, x)); return x * x * (3 - 2*x) }
func scoreBell(x, width float64) float64 { q := x / width; return math.Exp(-q * q * 2) }

func renderSpatialField(ctx *render.Context, out []color.Color) {
	v := ctx.Params
	age := ctx.LayerT
	for i := range out {
		out[i] = color.Black
	}
	if age < 0 || len(ctx.X) != len(out) || len(ctx.Y) != len(out) || len(ctx.Z) != len(out) {
		return
	}
	ox, oy, oz := v.Number("origin_x"), v.Number("origin_y"), v.Number("origin_z")
	level := v.Fraction("level")
	base, accent := v.Color("color"), v.Color("accent")
	speed, scale := v.Speed("speed"), math.Max(.05, v.Length("scale").Meters)
	width := math.Max(.025, v.Length("width").Meters)
	phase, mode := v.Number("phase"), v.Enum("mode")
	for i := range out {
		x, y, z := float64(ctx.X[i])-ox, float64(ctx.Y[i])-oy, float64(ctx.Z[i])-oz
		radius := math.Hypot(x, y)
		theta := math.Atan2(y, x)
		light, mix := 0.0, 0.0
		switch mode {
		case "trace":
			// A single expanding sphere leaves a quiet architectural silhouette.
			d := math.Sqrt(x*x + y*y + z*z)
			head := age * speed
			light = .055*scoreSmooth((head-d)/width) + scoreBell(d-head, width)
			mix = scoreBell(d-head, width*.35)
		case "tide":
			q := 2*math.Pi*(radius-speed*age)/scale + phase - .35*z
			light = .025 + .72*math.Pow(.5+.5*math.Cos(q), 10)
			mix = .5 + .5*math.Sin(q+.6)
		case "aurora":
			// Slowly folding curtains: x/y drift and height share one field.
			q := x/scale + math.Sin(y/scale+age*.13)*1.4 + z*.24 - age*speed/scale + phase
			ribbon := .5 + .5*math.Sin(q*2.2)
			light = .035 + .8*math.Pow(ribbon, 5)
			mix = .5 + .5*math.Sin(y*.19+z*.6-age*.16+phase)
		case "orbit":
			// Two opposing curved spokes, spatially continuous through gaps.
			q := theta - age*speed/scale + radius*.055 + phase
			a := math.Atan2(math.Sin(q), math.Cos(q)) * math.Max(radius, 1)
			b := math.Atan2(math.Sin(q+math.Pi), math.Cos(q+math.Pi)) * math.Max(radius, 1)
			ca, cb := scoreBell(a, width), scoreBell(b, width)
			light = .02 + ca + cb
			mix = cb / (ca + cb + 1e-9)
		case "weave":
			// Orthogonal packets intersect on a grid without strip-order seams.
			a := scoreBell(wrap(x-speed*age+phase, scale)-scale/2, width)
			b := scoreBell(wrap(y+speed*age, scale)-scale/2, width)
			light = .015 + .65*(a+b) + .3*a*b
			mix = b / (a + b + 1e-9)
		case "nova":
			// An expanding 3-D shell; the center goes dark after it passes.
			d := math.Sqrt(x*x + y*y + z*z)
			light = scoreBell(d-age*speed, width) + .12*scoreBell(d-age*speed+width*2, width*3)
			mix = scoreBell(d-age*speed, width*.4)
		case "ember":
			// World-cell hashes, independent of pixel IDs and rendering subsets.
			h := hash(uint64(int64(math.Floor(x*6))), uint64(int64(math.Floor(y*6))), uint64(int64(math.Floor(z*6))))
			sparkle := math.Pow(math.Max(0, math.Sin(age*(.35+unit(h))+unit(hash(h))*30)), 18)
			light = .035 + .8*sparkle
			mix = unit(h)
		}
		c := color.Lerp(base, accent, float32(math.Max(0, math.Min(1, mix)))).Scale(float32(level * math.Min(1, light)))
		out[i] = c
	}
}
