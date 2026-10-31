// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
)

// Chase draws pulses `width` long, one every `spacing`, moving at `speed`
// along u, each followed by a fading `tail`. Pulses take `colors` in turn.
// Between pulses it paints `background`, or nothing when `overlay` is set
// (then it shows over the layers below). WLED's "Chase" (fx 28).
//
// Width, spacing and tail follow the flow unless given as physical. Pulse
// edges are anti-aliased when `smooth` is on.
func Chase() *render.Def {
	return &render.Def{
		ID:     "chase",
		Name:   "Chase",
		Coords: render.CoordU,
		Params: []render.Param{
			{Name: "width", Type: render.TLength, Default: "0.2 m"},
			{Name: "spacing", Type: render.TLength, Default: "1 m", Doc: "from one pulse to the next"},
			{Name: "speed", Type: render.TSpeed, Default: "0.5 m/s", Doc: "along u; negative moves backwards"},
			{Name: "colors", Type: render.TColors, Default: []any{"#ffffff"}, Doc: "pulse colours, in turn"},
			{Name: "tail", Type: render.TLength, Default: "0 m", Doc: "fading trail behind each pulse"},
			{Name: "background", Type: render.TColor, Default: "#000000"},
			{Name: "overlay", Type: render.TBool, Default: false, Doc: "leave the gaps transparent instead of painting background"},
		},
		// WLED's Chase draws col1 pulses over a col0 background.
		WLED: &render.WLED{FX: 28, Name: "Chase", Bindings: []render.Binding{
			{Slider: render.SliderSpeed, Param: "speed", Curve: render.CurveExp, Min: "0 m/s", Max: "5 m/s"},
			{Slider: render.SliderIntensity, Param: "width", Curve: render.CurveExp, Min: "1 px", Max: "2 m"},
			{Slider: render.SliderColor0, Param: "background"},
			{Slider: render.SliderColor1, Param: "colors.0"},
			{Slider: render.SliderColor2, Param: "colors.1"},
		}},
		New: func() render.Effect { return render.Func(renderChase) },
	}
}

func renderChase(ctx *render.Context, out []color.Color) {
	v := ctx.Params
	width, spacing, tail := v.Length("width"), v.Length("spacing"), v.Length("tail")
	speed := v.Speed("speed")
	cols := v.Colors("colors")
	bg := v.Color("background")
	overlay := v.Bool("overlay")
	if len(cols) == 0 {
		cols = []color.Color{color.Black}
	}
	for i := range out {
		st := stretchAt(ctx, i)
		w, p, tl := width.InU(st), spacing.InU(st), tail.InU(st)
		if p <= 0 {
			out[i] = bg
			continue
		}
		w = min(w, p)
		// Reduce by the full colour cycle, so wrapping the phase does
		// not change which colour belongs to a moving pulse.
		pos := float64(ctx.U[i]) - travel(speed, ctx.T, p*float64(len(cols)))
		x := wrap(pos, p)
		pulse := math.Floor(pos / p) // which pulse's period this is

		c := cols[int(mod(int64(pulse), int64(len(cols))))]
		var level float64
		if ctx.Smooth {
			fw := footprint(ctx, i)
			if fw > p*1e-6 {
				// Average the coloured pulses over the whole footprint. A
				// pixel in the gap may cover the next pulse's head, and a
				// compressed pattern may cover several differently coloured
				// pulses in one pixel.
				cycle := p * float64(len(cols))
				cx := wrap(pos, cycle)
				var sum color.Color
				for j, col := range cols {
					start := float64(j) * p
					share := (covered(cx+fw/2, start, w, cycle) - covered(cx-fw/2, start, w, cycle)) / fw
					if share > 0 {
						level += share
						sum = add(sum, col, float32(share))
					}
				}
				if level > 0 {
					c = sum.Scale(1 / float32(level)).WithAlpha(1)
				}
			} else if x < w {
				level = 1
			}
		} else if x < w {
			level = 1
		}
		// The tail trails the head: below the pulse when moving up u,
		// above it when moving down.
		if tl > 0 {
			var behind float64 // distance behind the pulse's trailing edge
			owner := pulse
			if speed >= 0 {
				behind = p - x // tail of the next pulse along
				owner++
			} else {
				behind = x - w
			}
			if behind > 0 && behind < tl {
				if t := float64(perceived(1 - behind/tl)); t > level {
					level = t
					c = cols[int(mod(int64(owner), int64(len(cols))))]
				}
			}
		}
		switch {
		case overlay:
			out[i] = c.WithAlpha(float32(level))
		default:
			out[i] = color.Lerp(bg, c.WithAlpha(1), float32(level))
		}
	}
}

func mod(a, n int64) int64 {
	m := a % n
	if m < 0 {
		m += n
	}
	return m
}
