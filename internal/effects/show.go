// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/units"
)

// Cue is one cue of a show: an effect that plays from At for For, with
// its own mapping and target.
type Cue struct {
	Name    string      // parameter prefix; default the effect id
	Effect  *render.Def // may be a composite or another show
	At      float64     // seconds from the show's start
	For     float64     // seconds; 0 means to the end of the show
	FadeIn  float64     // seconds
	FadeOut float64     // seconds
	Mapping any         // mapping id or inline mapping; nil means the layer's own
	Target  string      // area id; "" means the layer's own target
	Reverse bool        // flip the cue's u
	Blend   string      // onto the cues below; default over
	Opacity float64     // 0–1
	Params  map[string]any
}

// ShowSpec is a show's timing.
type ShowSpec struct {
	Length float64 // seconds; 0 means the end of the last cue
	Loop   bool
	Cues   []Cue // bottom first
}

// Show makes a timed sequence of cues into a single effect: a whole light
// show as one layer. Each cue is any effect (a primitive, a composite, or
// another show) with its own parameters, mapping and target area, playing
// from `at` for `for` with fades in and out, blended onto the cues below
// it like a composite's parts. Pixels no cue covers show `background`,
// or the layers below with `overlay`.
//
// The show's clock is the layer's age (Context.LayerT), times `rate`, so a
// show starts when it's pushed, scrubs with the preview clock, and
// continues across a restart. Each cue's effect sees time counted from the
// cue's start, so its motion begins at phase zero when the cue comes in.
// At the end the last frame holds, or with `loop` the show starts over.
//
// Its parameters are every cue's parameters under the cue's name
// (`comet.speed`), plus the cue's `at`, `for`, `fade_in`, `fade_out`,
// `blend`, `opacity` and `reverse`, so a layer or preset can retime or
// retune any cue. Cues get their own seeds, derived from the layer's.
//
// A cue's mapping and target need the engine (render.Def.Extra); the
// mappings are solved once when the layer is built, not per frame.
func Show(id, name string, spec ShowSpec) (*render.Def, error) {
	if len(spec.Cues) == 0 {
		return nil, fmt.Errorf("show %q has no cues", id)
	}
	d := &render.Def{ID: id, Name: name, Coords: render.CoordU | render.CoordXY, Extra: &render.Extra{}}
	d.Params = []render.Param{
		{Name: "length", Type: render.TDuration, Default: dur(spec.Length), Doc: "the show's length; 0 means the end of the last cue"},
		{Name: "loop", Type: render.TBool, Default: spec.Loop, Doc: "start over at the end instead of holding the last frame"},
		{Name: "rate", Type: render.TNumber, Default: 1.0, Min: ptr(0.0), Doc: "playback speed; 1 is real time"},
		{Name: "background", Type: render.TColor, Default: "#000000", Doc: "under the cues"},
		{Name: "overlay", Type: render.TBool, Default: false, Doc: "leave uncovered pixels transparent instead of painting background"},
	}
	blendParam := render.CommonParams[slices.IndexFunc(render.CommonParams, func(c render.Param) bool { return c.Name == render.ParamBlend })]
	names := map[string]bool{}
	cues := slices.Clone(spec.Cues)
	var mapKeys []string
	for i := range cues {
		c := &cues[i]
		if c.Effect == nil {
			return nil, fmt.Errorf("show %q: cue %d has no effect", id, i)
		}
		if c.Name == "" {
			c.Name = c.Effect.ID
		}
		if names[c.Name] || strings.Contains(c.Name, ".") || slices.ContainsFunc(d.Params, func(p render.Param) bool { return p.Name == c.Name }) {
			return nil, fmt.Errorf("show %q: cue name %q is repeated, reserved or contains a dot", id, c.Name)
		}
		names[c.Name] = true
		if c.Blend == "" {
			c.Blend = render.BlendOver
		}
		if !slices.Contains(blendParam.Enum, c.Blend) {
			return nil, fmt.Errorf("show %q: cue %s: blend %q: want one of %v", id, c.Name, c.Blend, blendParam.Enum)
		}
		if c.Opacity < 0 || c.Opacity > 1 {
			return nil, fmt.Errorf("show %q: cue %s: opacity %v is outside 0–1", id, c.Name, c.Opacity)
		}
		if c.At < 0 || c.For < 0 || c.FadeIn < 0 || c.FadeOut < 0 {
			return nil, fmt.Errorf("show %q: cue %s: times can't be negative", id, c.Name)
		}
		for k := range c.Params {
			if _, ok := c.Effect.Param(k); !ok {
				return nil, fmt.Errorf("show %q: cue %s: effect %s has no parameter %q", id, c.Name, c.Effect.ID, k)
			}
		}
		key := ""
		if c.Mapping != nil {
			var err error
			if key, err = render.MappingKey(c.Mapping); err != nil {
				return nil, fmt.Errorf("show %q: cue %s: mapping: %w", id, c.Name, err)
			}
			if !slices.Contains(mapKeys, key) {
				mapKeys = append(mapKeys, key)
				d.Extra.Mappings = append(d.Extra.Mappings, render.ExtraMapping{Key: key, Raw: c.Mapping})
			}
		}
		if c.Target != "" && !slices.Contains(d.Extra.Areas, c.Target) {
			d.Extra.Areas = append(d.Extra.Areas, c.Target)
		}
		bp := blendParam
		bp.Name, bp.Default, bp.Doc = c.Name+".blend", c.Blend, "how "+c.Name+" blends onto the cues below"
		d.Params = append(d.Params, bp,
			render.Param{Name: c.Name + ".opacity", Type: render.TFraction, Default: c.Opacity},
			render.Param{Name: c.Name + ".at", Type: render.TDuration, Default: dur(c.At), Doc: "when " + c.Name + " starts"},
			render.Param{Name: c.Name + ".for", Type: render.TDuration, Default: dur(c.For), Doc: "how long " + c.Name + " plays; 0 means to the end"},
			render.Param{Name: c.Name + ".fade_in", Type: render.TDuration, Default: dur(c.FadeIn)},
			render.Param{Name: c.Name + ".fade_out", Type: render.TDuration, Default: dur(c.FadeOut)},
			render.Param{Name: c.Name + ".reverse", Type: render.TBool, Default: c.Reverse, Doc: "flip " + c.Name + "'s direction"},
		)
		for _, q := range c.Effect.Params {
			if v, ok := c.Params[q.Name]; ok {
				q.Default = v
			}
			q.Name = c.Name + "." + q.Name
			d.Params = append(d.Params, q)
		}
		d.Coords |= c.Effect.Coords
		d.Stateful = d.Stateful || c.Effect.Stateful
		if x := c.Effect.Extra; x != nil { // a show inside a show
			for _, em := range x.Mappings {
				if !slices.Contains(mapKeys, em.Key) {
					mapKeys = append(mapKeys, em.Key)
					d.Extra.Mappings = append(d.Extra.Mappings, em)
				}
			}
			for _, a := range x.Areas {
				if !slices.Contains(d.Extra.Areas, a) {
					d.Extra.Areas = append(d.Extra.Areas, a)
				}
			}
		}
	}
	keys := make([]string, len(cues))
	for i := range cues {
		if cues[i].Mapping != nil {
			keys[i], _ = render.MappingKey(cues[i].Mapping)
		}
	}
	d.New = func() render.Effect {
		s := &show{cues: cues, keys: keys}
		for _, c := range cues {
			s.fx = append(s.fx, c.Effect.New())
		}
		return s
	}
	return d, nil
}

func dur(sec float64) string { return fmt.Sprintf("%g s", sec) }

func ptr[T any](v T) *T { return &v }

type show struct {
	cues []Cue
	keys []string // mapping key per cue ("" = the layer's)
	fx   []render.Effect

	params *render.Values // what the per-cue values were made from
	sub    []*render.Values
	timing []cueTiming
	blend  []string
	op     []float32
	rev    []bool

	acc, pc []color.Color
	gather  cueGather
}

type cueTiming struct{ at, dur, in, out float64 }

// cueGather is the scratch geometry of the cue being rendered.
type cueGather struct {
	pix                []int32
	u, x, y, z, dl, st []float32
	spill, gain        []float32
	index              []int32
	src                []int32 // index into the show's own out slice
}

func (s *show) Render(ctx *render.Context, out []color.Color) {
	v := ctx.Params
	if ctx.Params != s.params {
		s.params = ctx.Params
		s.sub, s.timing, s.blend, s.op, s.rev = s.sub[:0], s.timing[:0], s.blend[:0], s.op[:0], s.rev[:0]
		for _, c := range s.cues {
			s.sub = append(s.sub, v.Sub(c.Name))
			s.timing = append(s.timing, cueTiming{v.Duration(c.Name + ".at"), v.Duration(c.Name + ".for"),
				v.Duration(c.Name + ".fade_in"), v.Duration(c.Name + ".fade_out")})
			s.blend = append(s.blend, v.Enum(c.Name+".blend"))
			s.op = append(s.op, float32(v.Fraction(c.Name+".opacity")))
			s.rev = append(s.rev, v.Bool(c.Name+".reverse"))
		}
	}
	length := v.Duration("length")
	if length <= 0 {
		for _, tm := range s.timing {
			end := tm.at + tm.dur
			if tm.dur <= 0 {
				end = tm.at
			}
			length = math.Max(length, end)
		}
	}
	if length <= 0 {
		// Only open-ended cues: the show never ends.
		length = math.Inf(1)
	}
	t := math.Max(0, ctx.LayerT) * v.Number("rate")
	if v.Bool("loop") && !math.IsInf(length, 1) {
		t = wrap(t, length)
	} else {
		t = math.Min(t, length) // hold the last frame
	}

	n := len(out)
	s.acc, s.pc = grow(s.acc, n), grow(s.pc, n)
	clear(s.acc)
	bg := v.Color("background")
	if !v.Bool("overlay") {
		for i := range s.acc {
			s.acc[i] = bg.WithAlpha(1)
		}
	}
	for k, c := range s.cues {
		tm := s.timing[k]
		end := tm.at + tm.dur
		if tm.dur <= 0 {
			end = length
		}
		level := envelope(t, tm.at, end, tm.in, tm.out)
		op := s.op[k] * perceived(level)
		if op <= 0 {
			continue
		}
		child, g := *ctx, s.gatherCue(ctx, k, c)
		if len(g.pix) == 0 {
			continue
		}
		child.Pixels, child.U, child.Dl, child.Stretch, child.Index, child.Count = g.pix, g.u, g.dl, g.st, g.index, len(g.pix)
		child.X, child.Y, child.Z = g.x, g.y, g.z
		child.Spill = g.spill
		child.Geometry = nil
		child.Params, child.Seed = s.sub[k], partSeed(ctx.Seed, k)
		// The cue's effect counts time from the cue's start, so its motion
		// starts at phase zero when the cue comes in. A looped show
		// restarts its cues each lap.
		child.T, child.LayerT = t-tm.at, t-tm.at
		pc := s.pc[:len(g.pix)]
		clear(pc)
		s.fx[k].Render(&child, pc)
		for j, i := range g.src {
			col := pc[j]
			if g.gain != nil {
				col.A *= g.gain[j]
			}
			s.acc[i] = render.Blend(s.acc[i], col, s.blend[k], op)
		}
	}
	for i, a := range s.acc {
		if a.A <= 0 {
			out[i] = color.Transparent
			continue
		}
		out[i] = a.Scale(1 / a.A)
	}
}

// gatherCue collects the pixels cue k covers (its target's, inside its
// mapping's domain) with their coordinates in the cue's mapping.
func (s *show) gatherCue(ctx *render.Context, k int, c Cue) *cueGather {
	g := &s.gather
	g.pix, g.u, g.x, g.y, g.z, g.dl, g.st = g.pix[:0], g.u[:0], g.x[:0], g.y[:0], g.z[:0], g.dl[:0], g.st[:0]
	g.spill, g.gain, g.index, g.src = g.spill[:0], g.gain[:0], g.index[:0], g.src[:0]
	var xc *render.ExtraCoords
	var mask []bool
	if ctx.Geometry != nil {
		if s.keys[k] != "" {
			xc = ctx.Geometry.Extra[s.keys[k]]
		}
		if c.Target != "" {
			mask = ctx.Geometry.Masks[c.Target]
		}
	}
	if s.keys[k] != "" && xc == nil || c.Target != "" && mask == nil {
		return g // the engine didn't supply it; the cue is dark
	}
	sign := float32(1)
	if s.rev[k] {
		sign = -1
	}
	hasXYZ := ctx.X != nil
	for i, p := range ctx.Pixels {
		gi := ctx.Index[i]
		if mask != nil && !mask[gi] {
			continue
		}
		u, st := ctx.U[i], float32(1)
		if ctx.Stretch != nil {
			st = ctx.Stretch[i]
		}
		var spill, gain float32 = 0, 1
		hasSpill := ctx.Spill != nil
		if hasSpill {
			spill = ctx.Spill[i]
		}
		if xc != nil {
			u, st = xc.U[gi], xc.Stretch[gi]
			if xc.Spill != nil {
				spill, hasSpill = xc.Spill[gi], true
			}
			if xc.Gain != nil {
				gain = xc.Gain[gi]
			}
		}
		if u != u { // NaN: outside the cue's mapping
			continue
		}
		g.pix = append(g.pix, p)
		g.u = append(g.u, sign*u)
		g.dl = append(g.dl, ctx.Dl[i])
		g.st = append(g.st, st)
		g.index = append(g.index, int32(len(g.pix)-1))
		g.src = append(g.src, int32(i))
		if hasXYZ {
			g.x, g.y, g.z = append(g.x, ctx.X[i]), append(g.y, ctx.Y[i]), append(g.z, ctx.Z[i])
		}
		if hasSpill {
			g.spill = append(g.spill, spill)
		}
		if xc != nil && xc.Gain != nil {
			g.gain = append(g.gain, gain)
		}
	}
	if !hasXYZ {
		g.x, g.y, g.z = nil, nil, nil
	}
	if len(g.spill) == 0 {
		g.spill = nil
	}
	if len(g.gain) == 0 {
		g.gain = nil
	}
	return g
}

// envelope is a cue's level at time t: 0 outside [start, end], rising over
// `in` after start and falling over `out` before end. Fades longer than
// the cue are shortened to meet in the middle.
func envelope(t, start, end, in, out float64) float64 {
	if end <= start || t < start || t > end {
		return 0
	}
	if in+out > end-start {
		k := (end - start) / (in + out)
		in, out = in*k, out*k
	}
	level := 1.0
	if in > 0 {
		level = math.Min(level, (t-start)/in)
	}
	if out > 0 {
		level = math.Min(level, (end-t)/out)
	}
	return math.Max(0, math.Min(1, level))
}

// RegisterShows adds shows defined in config (presets.yaml `shows:`) to r.
// A cue may use any registered effect, including composites and shows
// registered earlier (so RegisterComposites comes first), and shows may
// use each other in any order; a cycle is an error. Each gets a WLED fx
// id from FXCustom upwards and automatic slider bindings.
func RegisterShows(r *render.Registry, shows []config.Show) error {
	byID := map[string]*config.Show{}
	for i := range shows {
		byID[shows[i].ID] = &shows[i]
	}
	var errs config.Errors
	state := map[string]int{} // 1 = in progress, 2 = done
	var visit func(s *config.Show, path []string) bool
	visit = func(s *config.Show, path []string) bool {
		switch state[s.ID] {
		case 1:
			errs = append(errs, config.Errorf(s.Pos, "show %s is part of itself: %s", s.ID, strings.Join(append(path, s.ID), " → ")))
			return false
		case 2:
			return true
		}
		if _, taken := r.Get(s.ID); taken {
			errs = append(errs, config.Errorf(s.Pos, "show %s: an effect with that id already exists", s.ID))
			state[s.ID] = 2
			return false
		}
		state[s.ID] = 1
		spec := ShowSpec{Loop: s.Loop}
		ok := true
		if s.Length != "" {
			d, err := units.ParseDuration(s.Length)
			if err != nil {
				errs = append(errs, config.Errorf(s.Pos, "show %s: length: %v", s.ID, err))
				ok = false
			}
			spec.Length = d.Seconds()
		}
		for _, c := range s.Cues {
			if dep, isShow := byID[c.Effect]; isShow {
				if _, done := r.Get(c.Effect); !done && !visit(dep, append(path, s.ID)) {
					ok = false
					continue
				}
			}
			def, found := r.Get(c.Effect)
			if !found {
				errs = append(errs, config.Errorf(c.Pos, "show %s: no effect %q", s.ID, c.Effect))
				ok = false
				continue
			}
			cue := Cue{Name: c.Name, Effect: def, Mapping: c.Mapping, Target: c.Target, Reverse: c.Reverse, Blend: c.Blend, Opacity: 1, Params: c.Params}
			if c.Opacity != nil {
				cue.Opacity = *c.Opacity
			}
			for _, f := range []struct {
				name string
				raw  string
				dst  *float64
			}{{"at", c.At, &cue.At}, {"for", c.For, &cue.For}, {"fade_in", c.FadeIn, &cue.FadeIn}, {"fade_out", c.FadeOut, &cue.FadeOut}} {
				if f.raw == "" {
					continue
				}
				d, err := units.ParseDuration(f.raw)
				if err != nil {
					errs = append(errs, config.Errorf(c.Pos, "show %s: %s: %v", s.ID, f.name, err))
					ok = false
					continue
				}
				*f.dst = d.Seconds()
			}
			spec.Cues = append(spec.Cues, cue)
		}
		state[s.ID] = 2
		if !ok {
			return false
		}
		def, err := Show(s.ID, cmpOr(s.Name, s.ID), spec)
		if err == nil {
			def.WLED = &render.WLED{FX: nextFX(r), Name: def.Name, Bindings: autoBindings(def)}
			err = r.Register(def)
		}
		if err != nil {
			errs = append(errs, config.Errorf(s.Pos, "%v", err))
			return false
		}
		return true
	}
	for i := range shows {
		visit(&shows[i], nil)
	}
	return errs.Err()
}
