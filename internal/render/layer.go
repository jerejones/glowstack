// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package render

import (
	"math"
	"sort"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
)

// Common is a layer's resolved common parameters.
type Common struct {
	Mapping    string                // mapping id; an inline mapping's is config.InlinePrefix + hash
	Inline     *config.InlineMapping // set for an inline mapping
	Reverse    bool
	Offset     float64 // meters of u
	Brightness float32
	Opacity    float32
	Blend      string
	White      string
	Smooth     bool
	FadeIn     float64 // seconds; -1 = config default
	FadeOut    float64 // seconds; -1 = config default
}

// ResolveCommon resolves the common parameters from raw values.
func ResolveCommon(raw map[string]any, env Env) (Common, error) {
	v, err := Resolve(CommonParams, raw, env)
	if err != nil {
		return Common{}, err
	}
	c := Common{
		Mapping:    v.Mapping(ParamMapping),
		Inline:     v.InlineMapping(ParamMapping),
		Reverse:    v.Bool(ParamReverse),
		Offset:     v.Length(ParamOffset).Meters,
		Brightness: float32(v.Fraction(ParamBrightness)),
		Opacity:    float32(v.Fraction(ParamOpacity)),
		Blend:      v.Enum(ParamBlend),
		White:      v.Enum(ParamWhite),
		Smooth:     v.Bool(ParamSmooth),
		FadeIn:     -1,
		FadeOut:    -1,
	}
	if v.Has(ParamFadeIn) {
		c.FadeIn = v.Duration(ParamFadeIn)
	}
	if v.Has(ParamFadeOut) {
		c.FadeOut = v.Duration(ParamFadeOut)
	}
	return c, nil
}

// Layer is a stack layer resolved and ready to render. The engine builds
// one from a stack layer and keeps it while the layer is unchanged.
type Layer struct {
	ID       string
	Def      *Def
	Effect   Effect
	Params   *Values
	Common   Common
	Fade     float32 // 0–1 from the stack's fades; multiplies opacity
	Seed     uint64
	Created  float64 // creation time on Frame.T's scale
	Pitch    float64
	Geometry *Geometry
}

// Geometry is a layer's target in its mapping, precomputed when the layer's
// target, mapping or common params change, never per frame.
type Geometry struct {
	Pixels  []int32   // target pixels inside the mapping's domain, in mapping order
	U       []float32 // aligned with Pixels
	X, Y, Z []float32 // aligned with Pixels; nil unless the effect reads positions
	Dl      []float32
	Stretch []float32
	Gain    []float32 // aligned with Pixels; nil unless the mapping fades pixels (routes)
	Spill   []float32 // aligned with Pixels; nil unless the mapping has spill (routes)
	Index   []int32   // rank in mapping order (i.e. 0, 1, 2, …)
	Dark    []int32   // target pixels outside the mapping's domain; drawn black

	// Extra holds the coordinates of Def.Extra's mappings, by key, and
	// Masks which of Pixels each Def.Extra area covers. Both are aligned
	// with Pixels. nil unless the Def asked for them.
	Extra map[string]*ExtraCoords
	Masks map[string][]bool
}

// ExtraCoords is one extra mapping's coordinates, aligned with
// Geometry.Pixels. U is NaN where the mapping doesn't cover a pixel.
type ExtraCoords struct {
	U, Stretch []float32
	Gain       []float32 // nil unless the mapping fades pixels (routes)
	Spill      []float32 // nil unless the mapping has spill (routes)
}

// BuildExtra gathers mapping m's coordinates for the geometry's pixels.
func (g *Geometry) BuildExtra(m *layout.Mapping) *ExtraCoords {
	n := len(g.Pixels)
	x := &ExtraCoords{U: make([]float32, n), Stretch: make([]float32, n)}
	if m.Gain != nil {
		x.Gain = make([]float32, n)
	}
	if m.Spill != nil {
		x.Spill = make([]float32, n)
	}
	for i, p := range g.Pixels {
		x.U[i], x.Stretch[i] = m.U[p], m.Stretch[p]
		if x.Gain != nil {
			x.Gain[i] = m.Gain[p]
		}
		if x.Spill != nil {
			x.Spill[i] = m.Spill[p]
		}
	}
	return x
}

// BuildMask marks which of the geometry's pixels are in area (global ids).
func (g *Geometry) BuildMask(area []int32) []bool {
	in := make(map[int32]bool, len(area))
	for _, p := range area {
		in[p] = true
	}
	mask := make([]bool, len(g.Pixels))
	for i, p := range g.Pixels {
		mask[i] = in[p]
	}
	return mask
}

// BuildGeometry orders target pixels along mapping m for an effect that
// reads coords. Pixels the mapping doesn't cover (NaN u, or no plan
// position for an x,y effect) go to Dark: they're inside the layer's
// target, so the layer paints them black (this is `unreached: dark`).
//
// U gets the common params applied: u' = ±u − offset, so `reverse` flips
// direction and `offset` shifts the pattern forward. For an `index`
// mapping, U is instead the position within this target, 0–1, in mapping
// order (reversed by `reverse`).
func BuildGeometry(l *layout.Layout, m *layout.Mapping, target []int32, coords Coords, c Common) *Geometry {
	g := &Geometry{}
	needXY := coords&CoordXY != 0
	type entry struct {
		p   int32
		key float64
	}
	sign := 1.0
	if c.Reverse {
		sign = -1
	}
	entries := make([]entry, 0, len(target))
	for _, p := range target {
		u := float64(m.U[p])
		if coords&CoordPixel != 0 {
			u = 0 // physical pixel ids do not depend on mapping coordinates
		}
		if math.IsNaN(u) || needXY && !l.Pixels[p].HasPlan() {
			g.Dark = append(g.Dark, p)
			continue
		}
		entries = append(entries, entry{p, sign * u})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].key != entries[j].key {
			return entries[i].key < entries[j].key
		}
		return entries[i].p < entries[j].p
	})
	n := len(entries)
	g.Pixels, g.U, g.Dl, g.Stretch, g.Index = make([]int32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]int32, n)
	if needXY {
		g.X, g.Y, g.Z = make([]float32, n), make([]float32, n), make([]float32, n)
	}
	if m.Gain != nil {
		g.Gain = make([]float32, n)
	}
	if m.Spill != nil {
		g.Spill = make([]float32, n)
	}
	for i, e := range entries {
		px := &l.Pixels[e.p]
		g.Pixels[i], g.Index[i] = e.p, int32(i)
		g.Dl[i], g.Stretch[i] = px.Dl, m.Stretch[e.p]
		if m.Kind == config.KindIndex {
			g.U[i] = float32(i) / float32(max(n-1, 1))
		} else {
			g.U[i] = float32(e.key - c.Offset)
		}
		if needXY {
			g.X[i], g.Y[i], g.Z[i] = px.X, px.Y, px.Z
		}
		if g.Gain != nil {
			g.Gain[i] = m.Gain[e.p]
		}
		if g.Spill != nil {
			g.Spill[i] = m.Spill[e.p]
		}
	}
	return g
}
