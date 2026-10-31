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

// WLED's default segment colours: orange, black, black.
var wledColors = []any{"#ffa000", "#000000", "#000000"}

// footprint is the length of pixel i along u: its physical size divided
// by the stretch. Sub-pixel rendering averages the pattern over it.
func footprint(ctx *render.Context, i int) float64 {
	dl, st := float64(ctx.Dl[i]), float64(ctx.Stretch[i])
	if !(st > 0) || math.IsInf(st, 0) {
		st = 1
	}
	if !(dl > 0) {
		dl = ctx.Pitch
	}
	return dl / st
}

// stretchAt returns pixel i's stretch, 1 if unknown.
func stretchAt(ctx *render.Context, i int) float32 {
	if ctx.Stretch == nil {
		return 1
	}
	if st := ctx.Stretch[i]; st > 0 {
		return st
	}
	return 1
}

// travel is how far a pattern moving at speed has gone at time t, reduced
// modulo period so that phase arithmetic stays precise at Unix-epoch
// times. Positive speed moves the pattern towards larger u.
func travel(speed, t, period float64) float64 {
	if period <= 0 || speed == 0 {
		return 0
	}
	return math.Mod(speed*t, period)
}

// wrap reduces x into [0, period).
func wrap(x, period float64) float64 {
	x -= math.Floor(x/period) * period
	if x >= period { // rounding
		x = 0
	}
	return x
}

// covered is how much of [0, x) lies inside the periodic interval
// [start, start+width) + k·period. Overlap of a pixel footprint [a, b)
// with the interval is covered(b) − covered(a), which is how band and
// pulse edges get sub-pixel anti-aliasing.
func covered(x, start, width, period float64) float64 {
	k := math.Floor(x / period)
	r := x - k*period
	return k*width + math.Max(0, math.Min(width, r-start))
}

// perceived turns a perceptual level (0–1, like a WLED brightness) into a
// linear-light factor, so fades and breathing look even to the eye.
func perceived(level float64) float32 {
	if level <= 0 {
		return 0
	}
	return float32(math.Pow(math.Min(level, 1), color.DecodeGamma))
}

// hash mixes values into a well-distributed 64-bit hash (splitmix64's
// finaliser applied per input). Effects use it instead of a random
// number generator, so the house and the preview agree.
func hash(vals ...uint64) uint64 {
	h := uint64(0x6a09e667f3bcc909)
	for _, v := range vals {
		h ^= v
		h += 0x9e3779b97f4a7c15
		h = (h ^ h>>30) * 0xbf58476d1ce4e5b9
		h = (h ^ h>>27) * 0x94d049bb133111eb
		h ^= h >> 31
	}
	return h
}

// unit maps a hash to [0, 1).
func unit(h uint64) float64 { return float64(h>>11) / (1 << 53) }

// builtinPalette finds a built-in palette by id (for effect defaults).
func builtinPalette(id string) *palette.Palette {
	for _, p := range palette.Builtins {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// grow resizes a scratch slice to n, keeping its storage.
func grow[T any](s []T, n int) []T {
	if cap(s) < n {
		return make([]T, n)
	}
	return s[:n]
}

// colorsParam is the `colors` parameter palette effects take: WLED's
// three segment colours, used by the colour palettes ("* Color 1", …).
func colorsParam(doc string) render.Param {
	return render.Param{Name: "colors", Type: render.TColors, Default: wledColors, Doc: doc}
}

// colourBindings binds col0–col2 to colors.0–2.
func colourBindings(prefix string) []render.Binding {
	return []render.Binding{
		{Slider: render.SliderColor0, Param: prefix + "colors.0"},
		{Slider: render.SliderColor1, Param: prefix + "colors.1"},
		{Slider: render.SliderColor2, Param: prefix + "colors.2"},
	}
}
