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

// Sparkle draws random short-lived points over whatever is below: it
// paints only the sparkles, with alpha, so it overlays with blend `over`.
//
// # Randomness
//
// Time is cut into slots as long as one sparkle lasts (lifetime + decay).
// For each pixel and slot, a hash of (seed, global pixel id, slot) gives
// the number of sparkles starting in that slot, Poisson-distributed with
// mean density × dl × slot length, and each one's start time and palette
// position. dl is the pixel's physical size, so density is per meter of
// strip whatever the stretch, and it doesn't depend on the frame rate:
// rendering is a function of t, and every frame looks at the current and
// previous slots.
//
// A sparkle is at full brightness for `lifetime`, then fades out over
// `decay`, evenly to the eye.
func Sparkle() *render.Def {
	return &render.Def{
		ID:     "sparkle",
		Name:   "Sparkle",
		Coords: render.CoordU,
		Params: []render.Param{
			{Name: "density", Type: render.TDensity, Default: "2 /m/s", Doc: "sparkles per meter of strip per second"},
			{Name: "lifetime", Type: render.TDuration, Default: "80 ms", Doc: "time at full brightness"},
			{Name: "decay", Type: render.TDuration, Default: "300 ms", Doc: "fade-out time"},
			{Name: "color", Type: render.TColor, Default: "#ffffff"},
			{Name: "palette", Type: render.TPalette, Default: "Default",
				Doc: "pick each sparkle's color from a palette; Default uses the Color setting"},
			{Name: "seed", Type: render.TSeed, Default: 0, Doc: "mixed with the layer's seed"},
		},
		WLED: &render.WLED{FX: 20, Name: "Sparkle", Bindings: []render.Binding{
			{Slider: render.SliderSpeed, Param: "decay", Curve: render.CurveExp, Min: "2 s", Max: "0.05 s"},
			{Slider: render.SliderIntensity, Param: "density", Curve: render.CurveExp, Min: "0 /m/s", Max: "50 /m/s"},
			{Slider: render.SliderColor0, Param: "color"},
			{Slider: render.SliderPalette, Param: "palette"},
		}},
		New: func() render.Effect { return &sparkle{} },
	}
}

// color1 is "* Color 1": Sparkle's Default palette, its own color.
var color1 = builtinPalette("color-1")

type sparkle struct {
	pal  palette.Cache
	cols [1]color.Color
}

func (s *sparkle) Render(ctx *render.Context, out []color.Color) {
	v := ctx.Params
	s.cols[0] = v.Color("color")
	p := s.pal.Resolve(v.Palette("palette"), s.cols[:], ctx.T, color1)
	sp := sparkler{
		density: v.Density("density"),
		life:    v.Duration("lifetime"),
		decay:   v.Duration("decay"),
		seed:    hash(ctx.Seed, v.Seed("seed")),
	}
	sp.init()
	for i := range out {
		level, pos := sp.at(uint64(ctx.Pixels[i]), float64(ctx.Dl[i]), ctx.T)
		if level <= 0 {
			out[i] = color.Transparent
			continue
		}
		out[i] = p.At(pos).WithAlpha(level)
	}
}

// sparkler holds the timing maths, shared with the tests.
type sparkler struct {
	density, life, decay float64
	seed                 uint64
	slot                 float64 // slot length, s
	gamma                float64
}

// maxPerSlot caps the Poisson draw: past it a pixel is lit all the time
// anyway.
const maxPerSlot = 32

func (s *sparkler) init() {
	s.slot = max(s.life+s.decay, 1e-3)
	s.gamma = color.DecodeGamma
}

// events calls fn for each sparkle starting on pixel p in slot k, with
// its start time and palette position.
func (s *sparkler) events(p uint64, dl float64, k int64, fn func(start, pos float64)) {
	lambda := s.density * dl * s.slot
	if lambda <= 0 {
		return
	}
	h := hash(s.seed, p, uint64(k))
	// Inverse-CDF Poisson draw.
	u, term := unit(h), math.Exp(-lambda)
	cdf := term
	n := 0
	for u > cdf && n < maxPerSlot {
		n++
		term *= lambda / float64(n)
		cdf += term
	}
	for j := range n {
		hj := hash(h, uint64(j))
		fn((float64(k)+unit(hj))*s.slot, unit(hash(hj, 1)))
	}
}

// at returns the brightest live sparkle on pixel p at time t: its alpha
// and palette position.
func (s *sparkler) at(p uint64, dl, t float64) (float32, float64) {
	k := int64(math.Floor(t / s.slot))
	best, pos := 0.0, 0.0
	for kk := k - 1; kk <= k; kk++ {
		s.events(p, dl, kk, func(start, ps float64) {
			if l := s.level(t - start); l > best {
				best, pos = l, ps
			}
		})
	}
	return float32(best), pos
}

// level is a sparkle's alpha at age a.
func (s *sparkler) level(a float64) float64 {
	switch {
	case a < 0:
		return 0
	case a < s.life:
		return 1
	case a < s.life+s.decay:
		return math.Pow(1-(a-s.life)/s.decay, s.gamma)
	}
	return 0
}
