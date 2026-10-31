// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package color is the renderer's color type: linear-light RGBW with a
// straight (not premultiplied) alpha, as float32.
//
// # Linear light and gamma
//
// Colors are authored like WLED colors ("#ff8000"): perceptual 8-bit
// values. Glowstack composites in linear light, so authored colors are
// decoded once, when parsed, with DecodeGamma. The default of 2.8 matches
// WLED's default gamma correction, so "#808080" ends up at the same LED
// drive level (≈ 37/255) that WLED would send. Linear values map directly
// to LED drive: the output stage scales, power-limits, dithers and
// quantises them, and must not apply gamma again.
package color

import (
	"math"

	"github.com/jerejones/glowstack/internal/units"
)

// DecodeGamma is the exponent that turns authored 0–1 values into linear
// light.
var DecodeGamma = 2.8

// Color is linear-light RGBW (nominally 0–1 each) plus alpha (0–1).
type Color struct{ R, G, B, W, A float32 }

// Common colors.
var (
	Black       = Color{A: 1}
	Transparent = Color{}
)

// decodeTable maps 8-bit authored values to linear light.
var decodeTable [256]float32

func init() { rebuildTable() }

func rebuildTable() {
	for i := range decodeTable {
		decodeTable[i] = float32(math.Pow(float64(i)/255, DecodeGamma))
	}
}

// SetDecodeGamma changes DecodeGamma (call before parsing colors).
func SetDecodeGamma(g float64) {
	DecodeGamma = g
	rebuildTable()
}

// Linear decodes an authored color to linear light, opaque.
func Linear(c units.Color) Color {
	return Color{R: decodeTable[c.R], G: decodeTable[c.G], B: decodeTable[c.B], W: decodeTable[c.W], A: 1}
}

// Encode converts a linear channel value back to the authored 0–255 scale
// (for reporting colors back through the WLED API).
func Encode(v float32) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 1 {
		return 255
	}
	return uint8(math.Round(math.Pow(float64(v), 1/DecodeGamma) * 255))
}

// Authored converts back to an authored color (alpha dropped).
func (c Color) Authored() units.Color {
	return units.Color{R: Encode(c.R), G: Encode(c.G), B: Encode(c.B), W: Encode(c.W), HasW: c.W > 0}
}

// Lerp interpolates between a and b (including alpha).
func Lerp(a, b Color, t float32) Color {
	return Color{
		R: a.R + (b.R-a.R)*t,
		G: a.G + (b.G-a.G)*t,
		B: a.B + (b.B-a.B)*t,
		W: a.W + (b.W-a.W)*t,
		A: a.A + (b.A-a.A)*t,
	}
}

// Scale multiplies the color channels (not alpha) by k.
func (c Color) Scale(k float32) Color {
	return Color{R: c.R * k, G: c.G * k, B: c.B * k, W: c.W * k, A: c.A}
}

// WithAlpha returns c with alpha a.
func (c Color) WithAlpha(a float32) Color {
	c.A = a
	return c
}
