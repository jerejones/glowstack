// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
	"math"
)

// Bands is a repeating sequence of colored bands over u, optionally
// moving. WLED's "Solid Pattern" (fx 83) is two bands.
//
// Widths follow the flow by default, so bands stretch and compress with
// it and stay in sync; give a width as "20 px physical" to keep it a fixed
// physical size. Speed is along u, so it follows the flow too.
//
// edge: hard bands have sharp edges, anti-aliased to a fraction of a
// pixel when `smooth` is on (an edge part-way across a pixel mixes the two
// colors in proportion). soft bands blend linearly from each band's
// center to the next one's.
func Bands() *render.Def {
	return &render.Def{
		ID:     "bands",
		Name:   "Bands",
		Coords: render.CoordU,
		Params: []render.Param{
			{Name: "bands", Type: render.TList, Doc: "the repeating sequence, in order of increasing u",
				Default: []any{
					map[string]any{"color": "#ffa000", "width": "0.5 m"},
					map[string]any{"color": "#000000", "width": "0.5 m"},
				},
				Fields: []render.Param{
					{Name: "color", Type: render.TColor, Default: "#ffffff"},
					{Name: "width", Type: render.TLength, Default: "0.5 m", Doc: "band width; add `physical` to ignore stretch"},
				}},
			{Name: "speed", Type: render.TSpeed, Default: "0 m/s", Doc: "along u; negative moves backwards"},
			{Name: "edge", Type: render.TEnum, Default: "hard", Enum: []string{"hard", "soft"}},
		},
		WLED: &render.WLED{FX: 83, Name: "Solid Pattern", Bindings: []render.Binding{
			// WLED draws 1 + sx lit pixels then 1 + ix unlit ones.
			{Slider: render.SliderSpeed, Param: "bands.0.width", Curve: render.CurveLinear, Min: "1 px", Max: "256 px"},
			{Slider: render.SliderIntensity, Param: "bands.1.width", Curve: render.CurveLinear, Min: "1 px", Max: "256 px"},
			{Slider: render.SliderColor0, Param: "bands.0.color"},
			{Slider: render.SliderColor1, Param: "bands.1.color"},
		}},
		New: func() render.Effect { return &bands{} },
	}
}

type bands struct {
	cols   []color.Color
	widths []render.Length
	start  []float64 // per band, in u, at the current pixel's stretch
	w      []float64
}

func (b *bands) Render(ctx *render.Context, out []color.Color) {
	list := ctx.Params.List("bands")
	n := len(list)
	if n == 0 {
		return
	}
	b.cols, b.widths = grow(b.cols, n), grow(b.widths, n)
	b.start, b.w = grow(b.start, n), grow(b.w, n)
	physical := false
	for i, e := range list {
		b.cols[i], b.widths[i] = e.Color("color"), e.Length("width")
		physical = physical || b.widths[i].Measure == render.MeasurePhysical
	}
	speed := ctx.Params.Speed("speed")
	soft := ctx.Params.Enum("edge") == "soft"

	period, shift := 0.0, 0.0
	layout := func(st float32) {
		period = 0
		for i := range n {
			b.start[i], b.w[i] = period, b.widths[i].InU(st)
			period += b.w[i]
		}
		shift = travel(speed, ctx.T, period)
	}
	layout(1)
	for i := range out {
		if physical {
			layout(stretchAt(ctx, i))
		}
		if period <= 0 {
			out[i] = b.cols[0]
			continue
		}
		x := wrap(float64(ctx.U[i])-shift, period)
		switch {
		case soft:
			fw := footprint(ctx, i)
			if ctx.Smooth && fw >= period*1e-6 {
				out[i] = b.softAverage(x, fw, period)
			} else {
				out[i] = b.soft(x, period)
			}
		case ctx.Smooth:
			fw := footprint(ctx, i)
			if fw < period*1e-6 {
				out[i] = b.cols[b.at(x)]
				continue
			}
			lo, hi := x-fw/2, x+fw/2
			var c color.Color
			for k := range n {
				share := (covered(hi, b.start[k], b.w[k], period) - covered(lo, b.start[k], b.w[k], period)) / fw
				if share > 0 {
					c = add(c, b.cols[k], float32(share))
				}
			}
			c.A = 1
			out[i] = c
		default:
			out[i] = b.cols[b.at(x)]
		}
	}
}

// at returns the band containing x (0 ≤ x < period).
func (b *bands) at(x float64) int {
	for k := len(b.start) - 1; k > 0; k-- {
		if x >= b.start[k] {
			return k
		}
	}
	return 0
}

// soft blends between band centers.
func (b *bands) soft(x, period float64) color.Color {
	n := len(b.start)
	center := func(k int) float64 { return b.start[k] + b.w[k]/2 }
	if x < center(0) {
		x += period
	}
	for k := range n {
		c0 := center(k)
		c1 := period + center(0)
		if k+1 < n {
			c1 = center(k + 1)
		}
		if x >= c0 && x < c1 || k == n-1 {
			t := float32(0)
			if c1 > c0 {
				t = float32((x - c0) / (c1 - c0))
			}
			return color.Lerp(b.cols[k], b.cols[(k+1)%n], max(0, min(1, t)))
		}
	}
	return b.cols[0]
}

// softAverage integrates the linear transitions between band centers.
// Each transition contributes the areas under its two color weights,
// including complete cycles when a pixel covers a compressed pattern.
func (b *bands) softAverage(x, fw, period float64) color.Color {
	center := func(k int) float64 { return b.start[k] + b.w[k]/2 }
	lo, hi := x-center(0)-fw/2, x-center(0)+fw/2
	var c color.Color
	for k := range b.cols {
		start := center(k) - center(0)
		end := period
		if k+1 < len(b.cols) {
			end = center(k+1) - center(0)
		}
		width := end - start
		if width <= 0 {
			continue
		}
		rampArea := func(t float64) float64 {
			cycles := math.Floor(t / period)
			z := max(0, min(width, t-cycles*period-start))
			return cycles*width/2 + z*z/(2*width)
		}
		right := rampArea(hi) - rampArea(lo)
		total := covered(hi, start, width, period) - covered(lo, start, width, period)
		c = add(c, b.cols[k], float32((total-right)/fw))
		c = add(c, b.cols[(k+1)%len(b.cols)], float32(right/fw))
	}
	c.A = 1
	return c
}

// add returns c + k·d (channels only).
func add(c, d color.Color, k float32) color.Color {
	return color.Color{R: c.R + d.R*k, G: c.G + d.G*k, B: c.B + d.B*k, W: c.W + d.W*k, A: c.A}
}
