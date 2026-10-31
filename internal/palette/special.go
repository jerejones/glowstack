// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Portions ported from WLED (https://github.com/wled/WLED),
// wled00/FX_fcn.cpp (Segment::loadPalette, the special palettes 0–5).
// Copyright (c) 2016-present Christian Schwinne and individual WLED
// contributors. Originally EUPL-1.2.

package palette

import (
	"math"
	"strings"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/units"
)

// Special is one of WLED's palettes 0–5. They have no fixed colours.
//
// How they resolve (Palette.Resolve):
//
//   - Default ("Default", 0): the effect's own default palette, passed by
//     the effect. With none, Party (WLED's fallback).
//   - Random ("* Random Cycle", 1): four random hues that change every
//     RandomCycle seconds, cross-fading over the first RandomFade seconds.
//     It's a function of the frame time only, so every layer using it
//     shows the same palette, as on a WLED device.
//   - Color1 ("* Color 1", 2): the effect's first colour.
//   - Colors12 ("* Colors 1&2", 3): first and second colours.
//   - ColorGradient ("* Color Gradient", 4): third → second → first.
//   - ColorsOnly ("* Colors Only", 5): the colours in distinct blocks.
//
// "The effect's colours" are what WLED calls the segment's three colours:
// each effect says which of its parameters they are (see the effects
// package). Missing colours count as black, as on WLED.
type Special uint8

const (
	SpecialNone Special = iota
	SpecialDefault
	SpecialRandom
	SpecialColor1
	SpecialColors12
	SpecialColorGradient
	SpecialColorsOnly
)

// Random cycle timing, in seconds (WLED's default change interval is 5 s).
const (
	RandomCycle = 5.0
	RandomFade  = 1.0
)

var specialNames = []struct {
	kind Special
	name string
}{
	{SpecialDefault, "Default"},
	{SpecialRandom, "* Random Cycle"},
	{SpecialColor1, "* Color 1"},
	{SpecialColors12, "* Colors 1&2"},
	{SpecialColorGradient, "* Color Gradient"},
	{SpecialColorsOnly, "* Colors Only"},
}

func init() {
	var party *Palette
	for i, s := range specialNames {
		p := &Palette{ID: slug(s.name), Name: s.name, WLED: i, Wrap: true, Special: s.kind}
		Builtins = append(Builtins, p)
	}
	for _, w := range wledPalettes {
		p := w.build()
		if w.Name == "Party" {
			party = p
		}
		Builtins = append(Builtins, p)
	}
	// Specials fall back to Party if sampled without resolving.
	for _, p := range Builtins[:len(specialNames)] {
		p.Stops, p.linear = party.Stops, party.linear
	}
	partyPalette = party
}

var partyPalette *Palette

// build converts WLED's storage to stops. A 16-entry palette is 16 evenly
// spaced stops that wrap, which is how FastLED blends a CRGBPalette16.
func (w wledPalette) build() *Palette {
	var stops []Stop
	if w.Entries != nil {
		for i, e := range w.Entries {
			stops = append(stops, Stop{At: float64(i) / 16, Color: rgb(e)})
		}
	} else {
		for i := 0; i+3 < len(w.Gradient); i += 4 {
			g := w.Gradient[i:]
			stops = append(stops, Stop{At: float64(g[0]) / 255, Color: units.Color{R: g[1], G: g[2], B: g[3]}})
		}
	}
	p := New(slug(w.Name), w.Name, stops, false, true)
	p.WLED = w.WLED
	return p
}

func rgb(x uint32) units.Color { return units.Color{R: uint8(x >> 16), G: uint8(x >> 8), B: uint8(x)} }

// slug turns a WLED palette name into an id: "* Colors 1&2" → "colors-1-2".
func slug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			dash = false
		} else {
			dash = true
		}
	}
	return b.String()
}

// Resolve returns the palette to sample for a layer: p itself unless it's
// special. colors are the effect's colours (WLED's segment colours), t the
// frame time, and dflt the effect's default palette (for "Default"). It
// allocates for special palettes; effects that sample every frame should
// use a Cache.
func (p *Palette) Resolve(colors []color.Color, t float64, dflt *Palette) *Palette {
	col := func(i int) color.Color {
		if i < len(colors) {
			return colors[i].WithAlpha(1)
		}
		return color.Black
	}
	switch p.Special {
	case SpecialNone:
		return p
	case SpecialDefault:
		if dflt != nil && dflt.Special != SpecialDefault {
			return dflt.Resolve(colors, t, nil)
		}
		return partyPalette
	case SpecialRandom:
		return randomPalette(t)
	case SpecialColor1:
		return fromLinear(p, []float64{0}, []color.Color{col(0)})
	case SpecialColors12:
		// CRGBPalette16(c1, c1, c2, c2): FastLED puts four colours at
		// entries 0, 5, 10 and 15 and wraps back to entry 0.
		return fromLinear(p, []float64{0, 5. / 16, 10. / 16, 15. / 16}, []color.Color{col(0), col(0), col(1), col(1)})
	case SpecialColorGradient:
		// CRGBPalette16(c3, c2, c1): entries 0, 8 and 15.
		return fromLinear(p, []float64{0, 8. / 16, 15. / 16}, []color.Color{col(2), col(1), col(0)})
	case SpecialColorsOnly:
		var cs []color.Color
		if c := col(2); c.R+c.G+c.B+c.W > 0 {
			for _, i := range []int{0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 0} {
				cs = append(cs, col(i))
			}
		} else {
			for i := range 16 {
				cs = append(cs, col(i/8))
			}
		}
		at := make([]float64, 16)
		for i := range at {
			at[i] = float64(i) / 16
		}
		return fromLinear(p, at, cs)
	}
	return p
}

// fromLinear makes a wrapping palette from linear-light colours, named
// after the special palette it resolves.
func fromLinear(like *Palette, at []float64, cs []color.Color) *Palette {
	q := &Palette{ID: like.ID, Name: like.Name, WLED: like.WLED, Wrap: true, linear: cs}
	q.Stops = make([]Stop, len(at))
	for i := range at {
		q.Stops[i] = Stop{At: at[i], Color: cs[i].Authored()}
	}
	return q
}

// randomPalette is "* Random Cycle" at time t.
func randomPalette(t float64) *Palette {
	slot := math.Floor(t / RandomCycle)
	f := float32(math.Min(1, (t-slot*RandomCycle)/RandomFade))
	a, b := randomColors(int64(slot)-1), randomColors(int64(slot))
	cs := make([]color.Color, 4)
	for i := range cs {
		cs[i] = color.Lerp(a[i], b[i], f)
	}
	return fromLinear(&Palette{ID: "random-cycle", Name: "* Random Cycle", WLED: 1}, []float64{0, 5. / 16, 10. / 16, 15. / 16}, cs)
}

// randomColors are slot k's four colours: hashed hues at full saturation
// and brightness from half to full, like WLED's random palette.
func randomColors(k int64) [4]color.Color {
	var cs [4]color.Color
	for i := range cs {
		h := mix(uint64(k)*4 + uint64(i))
		hue := float64(h>>11) / (1 << 53)
		val := 0.5 + 0.5*float64(h&0x3ff)/0x3ff
		cs[i] = color.Linear(hsv(hue, 1, val))
	}
	return cs
}

// mix is splitmix64's finaliser.
func mix(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ x>>30) * 0xbf58476d1ce4e5b9
	x = (x ^ x>>27) * 0x94d049bb133111eb
	return x ^ x>>31
}

// hsv converts hue (0–1), saturation and value to an authored colour.
func hsv(h, s, v float64) units.Color {
	h = (h - math.Floor(h)) * 6
	i := math.Floor(h)
	f := h - i
	p, q, t := v*(1-s), v*(1-s*f), v*(1-s*(1-f))
	var r, g, b float64
	switch int(i) {
	case 0:
		r, g, b = v, t, p
	case 1:
		r, g, b = q, v, p
	case 2:
		r, g, b = p, v, t
	case 3:
		r, g, b = p, q, v
	case 4:
		r, g, b = t, p, v
	default:
		r, g, b = v, p, q
	}
	u8 := func(x float64) uint8 { return uint8(math.Round(x * 255)) }
	return units.Color{R: u8(r), G: u8(g), B: u8(b)}
}

// Cache resolves a special palette once and reuses it while its inputs
// are unchanged. One Cache belongs to one effect instance (one layer).
type Cache struct {
	src, dflt *Palette
	cols      [3]color.Color
	ncols     int
	key       int64
	out       *Palette
}

// Resolve is Palette.Resolve with caching.
func (c *Cache) Resolve(p *Palette, colors []color.Color, t float64, dflt *Palette) *Palette {
	if p.Special == SpecialNone {
		return p
	}
	key := int64(0)
	if usesTime(p, dflt) {
		slot := math.Floor(t / RandomCycle)
		key = int64(slot) << 16
		if t-slot*RandomCycle < RandomFade {
			key |= 1 + int64((t-slot*RandomCycle)*100) // re-resolve every 10 ms while fading
		}
	}
	var cols [3]color.Color
	n := copy(cols[:], colors)
	if c.out != nil && c.src == p && c.dflt == dflt && c.cols == cols && c.ncols == n && c.key == key {
		return c.out
	}
	c.src, c.dflt, c.cols, c.ncols, c.key = p, dflt, cols, n, key
	c.out = p.Resolve(colors, t, dflt)
	return c.out
}

func usesTime(p, dflt *Palette) bool {
	return p.Special == SpecialRandom || p.Special == SpecialDefault && dflt != nil && dflt.Special == SpecialRandom
}
