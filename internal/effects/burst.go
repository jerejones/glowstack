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

// Burst draws fireworks in 3-D: shells that expand from launch points
// through the house, reaching every strip at its true distance from the
// burst. It reads positions, so it needs a scene model or plans, and works
// on any mapping.
//
// Bursts happen at `rate`, one per time slot of 1/rate, each at a random
// moment in its slot, from a random one of `centers` (moved by up to
// `scatter`), in a random color from `palette`. A shell is a sphere whose
// radius grows at `speed`; its wall is `width` thick, and the whole burst
// fades over `life`, evenly to the eye. `glow` fills the inside of the
// shell dimly, so the burst reads as a flash and not just a ring. The
// effect paints only the bursts, with alpha, so it overlays.
//
// Like sparkle, everything is hashed from the seed and the slot, never
// drawn from a generator, so the house and the preview agree.
func Burst() *render.Def {
	return &render.Def{
		ID:     "burst",
		Name:   "Burst",
		Coords: render.CoordXY,
		Params: []render.Param{
			{Name: "centers", Type: render.TList, Doc: "launch points, in meters",
				Default: []any{map[string]any{"x": "0 m", "y": "0 m", "z": "0 m"}},
				Fields: []render.Param{
					{Name: "x", Type: render.TLength, Default: "0 m", Measure: render.MeasurePhysical},
					{Name: "y", Type: render.TLength, Default: "0 m", Measure: render.MeasurePhysical},
					{Name: "z", Type: render.TLength, Default: "0 m", Measure: render.MeasurePhysical},
				}},
			{Name: "scatter", Type: render.TLength, Default: "0 m", Measure: render.MeasurePhysical, Doc: "random offset of each burst from its center"},
			{Name: "rate", Type: render.TRate, Default: "0.5 /s", Doc: "bursts per second"},
			{Name: "speed", Type: render.TSpeed, Default: "5 m/s", Doc: "how fast the shell expands"},
			{Name: "width", Type: render.TLength, Default: "0.6 m", Measure: render.MeasurePhysical, Doc: "shell thickness"},
			{Name: "life", Type: render.TDuration, Default: "2.5 s", Doc: "how long a burst lasts"},
			{Name: "glow", Type: render.TFraction, Default: 0.15, Doc: "fill inside the shell, as a fraction of the shell's brightness"},
			{Name: "palette", Type: render.TPalette, Default: "Default", Doc: "a random color per burst; Default is Party"},
			colorsParam("the colors for the palettes marked *"),
			{Name: "seed", Type: render.TSeed, Default: 0, Doc: "mixed with the layer's seed"},
		},
		New: func() render.Effect { return &burst{} },
	}
}

var party = builtinPalette("party")

type burst struct {
	pal palette.Cache
}

// shell is one live burst.
type shell struct {
	cx, cy, cz float64
	age        float64 // seconds since it went off
	col        color.Color
}

func (b *burst) Render(ctx *render.Context, out []color.Color) {
	v := ctx.Params
	p := b.pal.Resolve(v.Palette("palette"), v.Colors("colors"), ctx.T, party)
	rate := v.Rate("rate")
	speed, width, life := math.Abs(v.Speed("speed")), v.Length("width").Meters, v.Duration("life")
	glow := v.Fraction("glow")
	scatter := v.Length("scatter").Meters
	centers := v.List("centers")
	seed := hash(ctx.Seed, v.Seed("seed"))
	if rate <= 0 || life <= 0 || len(centers) == 0 || ctx.X == nil {
		for i := range out {
			out[i] = color.Transparent
		}
		return
	}
	slot := 1 / rate
	// Live shells: those that went off within the last `life` seconds.
	var live []shell
	first := int64(math.Floor((ctx.T - life) / slot))
	last := int64(math.Floor(ctx.T / slot))
	for k := first; k <= last; k++ {
		h := hash(seed, uint64(k))
		t0 := (float64(k) + unit(h)) * slot
		age := ctx.T - t0
		if age < 0 || age >= life {
			continue
		}
		c := centers[int(hash(h, 1)%uint64(len(centers)))]
		s := shell{cx: c.Length("x").Meters, cy: c.Length("y").Meters, cz: c.Length("z").Meters, age: age}
		if scatter > 0 {
			// A random point in a sphere of radius scatter.
			dx, dy, dz := 2*unit(hash(h, 2))-1, 2*unit(hash(h, 3))-1, 2*unit(hash(h, 4))-1
			if n := math.Sqrt(dx*dx + dy*dy + dz*dz); n > 1e-9 {
				r := scatter * math.Cbrt(unit(hash(h, 5)))
				s.cx, s.cy, s.cz = s.cx+dx/n*r, s.cy+dy/n*r, s.cz+dz/n*r
			}
		}
		s.col = p.At(unit(hash(h, 6))).WithAlpha(1)
		live = append(live, s)
	}
	w := max(width, 1e-3)
	for i := range out {
		var acc color.Color // premultiplied sum
		x, y, z := float64(ctx.X[i]), float64(ctx.Y[i]), float64(ctx.Z[i])
		for _, s := range live {
			r := speed * s.age
			d := math.Sqrt((x-s.cx)*(x-s.cx) + (y-s.cy)*(y-s.cy) + (z-s.cz)*(z-s.cz))
			// Gaussian shell wall, plus a dim fill inside it.
			e := (d - r) / w
			level := math.Exp(-2 * e * e)
			if d < r {
				level = math.Max(level, glow)
			}
			level *= float64(perceived(1 - s.age/life))
			if level <= 1e-4 {
				continue
			}
			acc = add(acc, s.col, float32(level))
			acc.A += float32(level)
		}
		if acc.A <= 0 {
			out[i] = color.Transparent
			continue
		}
		a := min(acc.A, 1)
		out[i] = acc.Scale(1 / acc.A).WithAlpha(a)
	}
}
