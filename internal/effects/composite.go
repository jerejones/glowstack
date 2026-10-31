// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"fmt"
	"slices"
	"strings"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/render"
)

// Part is one effect inside a composite.
type Part struct {
	Name    string      // prefix of its parameters ("sparkle" → "sparkle.density"); default the effect id
	Effect  *render.Def // may itself be a composite
	Blend   string      // how it blends onto the parts below it; default over
	Opacity float64     // 0–1
	// Params are the part's defaults, overriding its effect's own.
	Params map[string]any
}

// Composite makes a named stack of effects that share one target and
// mapping into a single effect. parts are listed bottom first, like
// painting: each is blended onto the ones before it with its blend mode
// and opacity, and the result (with alpha) is the composite's output.
//
// Its parameters are every part's parameters under the part's name
// ("gradient.palette", "sparkle.density"), plus "<part>.blend" and
// "<part>.opacity", so a layer or preset can adjust any of them. Parts
// get their own seeds, derived from the layer's.
//
// Composites may nest: a part's effect can be another composite, whose
// parameters then have two prefixes ("outer.inner.speed"). Cycles can
// only arise in config and are rejected by RegisterComposites.
func Composite(id, name string, parts []Part) (*render.Def, error) {
	if len(parts) == 0 {
		return nil, fmt.Errorf("composite %q has no parts", id)
	}
	d := &render.Def{ID: id, Name: name}
	names := map[string]bool{}
	var dynamic bool
	for i := range parts {
		p := &parts[i]
		if p.Effect == nil {
			return nil, fmt.Errorf("composite %q: part %d has no effect", id, i)
		}
		if p.Name == "" {
			p.Name = p.Effect.ID
		}
		if names[p.Name] || strings.Contains(p.Name, ".") {
			return nil, fmt.Errorf("composite %q: part name %q is repeated or contains a dot", id, p.Name)
		}
		names[p.Name] = true
		if p.Blend == "" {
			p.Blend = render.BlendOver
		}
		blendParam := render.CommonParams[slices.IndexFunc(render.CommonParams, func(c render.Param) bool { return c.Name == render.ParamBlend })]
		if !slices.Contains(blendParam.Enum, p.Blend) {
			return nil, fmt.Errorf("composite %q: part %s: blend %q: want one of %v", id, p.Name, p.Blend, blendParam.Enum)
		}
		if p.Opacity < 0 || p.Opacity > 1 {
			return nil, fmt.Errorf("composite %q: part %s: opacity %v is outside 0–1", id, p.Name, p.Opacity)
		}
		for k := range p.Params {
			if _, ok := p.Effect.Param(k); !ok {
				return nil, fmt.Errorf("composite %q: part %s: effect %s has no parameter %q", id, p.Name, p.Effect.ID, k)
			}
		}
		blendParam.Name, blendParam.Default, blendParam.Doc = p.Name+".blend", p.Blend, "how "+p.Name+" blends onto the parts below"
		d.Params = append(d.Params, blendParam,
			render.Param{Name: p.Name + ".opacity", Type: render.TFraction, Default: p.Opacity})
		for _, q := range p.Effect.Params {
			if v, ok := p.Params[q.Name]; ok {
				q.Default = v
			}
			q.Name = p.Name + "." + q.Name
			d.Params = append(d.Params, q)
		}
		d.Coords |= p.Effect.Coords
		d.Stateful = d.Stateful || p.Effect.Stateful
		dynamic = dynamic || p.Effect.CoordsFor != nil
	}
	if dynamic {
		d.CoordsFor = func(v *render.Values) render.Coords {
			var c render.Coords
			for _, p := range parts {
				c |= p.Effect.CoordsOf(v.Sub(p.Name))
			}
			return c
		}
	}
	d.New = func() render.Effect {
		c := &composite{parts: parts}
		for _, p := range parts {
			c.fx = append(c.fx, p.Effect.New())
		}
		return c
	}
	return d, nil
}

type composite struct {
	parts []Part
	fx    []render.Effect

	params  *render.Values // what sub, blend and op were made from
	sub     []*render.Values
	blend   []string
	op      []float32
	acc, pc []color.Color
}

func (c *composite) Render(ctx *render.Context, out []color.Color) {
	if ctx.Params != c.params {
		c.params = ctx.Params
		c.sub, c.blend, c.op = c.sub[:0], c.blend[:0], c.op[:0]
		for _, p := range c.parts {
			c.sub = append(c.sub, ctx.Params.Sub(p.Name))
			c.blend = append(c.blend, ctx.Params.Enum(p.Name+".blend"))
			c.op = append(c.op, float32(ctx.Params.Fraction(p.Name+".opacity")))
		}
	}
	n := len(out)
	c.acc, c.pc = grow(c.acc, n), grow(c.pc, n)
	clear(c.acc)
	child := *ctx
	for k := range c.parts {
		child.Params, child.Seed = c.sub[k], partSeed(ctx.Seed, k)
		clear(c.pc)
		c.fx[k].Render(&child, c.pc)
		if c.op[k] <= 0 {
			continue
		}
		for i := range c.acc {
			c.acc[i] = render.Blend(c.acc[i], c.pc[i], c.blend[k], c.op[k])
		}
	}
	// The accumulation is premultiplied by its coverage; the compositor
	// takes straight alpha.
	for i, a := range c.acc {
		if a.A <= 0 {
			out[i] = color.Transparent
			continue
		}
		out[i] = a.Scale(1 / a.A)
	}
}

// partSeed derives part k's seed from the layer's.
func partSeed(seed uint64, k int) uint64 { return hash(seed, uint64(k), 0xc0) }

// Glitter is a gradient with sparkles over it: WLED's "Glitter" (fx 87),
// built as the composite gradient + sparkle(blend: over).
func Glitter() *render.Def {
	d, err := Composite("glitter", "Glitter", []Part{
		{Effect: Gradient(), Opacity: 1, Params: map[string]any{"palette": "Rainbow"}},
		{Effect: Sparkle(), Blend: render.BlendOver, Opacity: 1, Params: map[string]any{"density": "10 /m/s"}},
	})
	if err != nil {
		panic(err)
	}
	d.WLED = &render.WLED{FX: 87, Name: "Glitter", Bindings: []render.Binding{
		{Slider: render.SliderSpeed, Param: "gradient.speed", Curve: render.CurveExp, Min: "0 m/s", Max: "10 m/s"},
		{Slider: render.SliderIntensity, Param: "sparkle.density", Curve: render.CurveExp, Min: "0 /m/s", Max: "50 /m/s"},
		{Slider: render.SliderPalette, Param: "gradient.palette"},
		{Slider: render.SliderColor0, Param: "gradient.colors.0"},
		{Slider: render.SliderColor1, Param: "gradient.colors.1"},
		// WLED's glitter color is col2 (white when unset).
		{Slider: render.SliderColor2, Param: "sparkle.color"},
	}}
	return d
}

// RegisterComposites adds composites defined in config (presets.yaml
// `composites:`) to r. They may use built-in effects and each other, in
// any order; a cycle is an error. Each gets a WLED fx id from FXCustom
// upwards and automatic slider bindings (see autoBindings).
func RegisterComposites(r *render.Registry, comps []config.Composite) error {
	byID := map[string]*config.Composite{}
	for i := range comps {
		byID[comps[i].ID] = &comps[i]
	}
	var errs config.Errors
	state := map[string]int{} // 1 = in progress, 2 = done
	var visit func(c *config.Composite, path []string) bool
	visit = func(c *config.Composite, path []string) bool {
		switch state[c.ID] {
		case 1:
			errs = append(errs, config.Errorf(c.Pos, "composite %s is part of itself: %s", c.ID, strings.Join(append(path, c.ID), " → ")))
			return false
		case 2:
			return true
		}
		if _, builtin := r.Get(c.ID); builtin {
			errs = append(errs, config.Errorf(c.Pos, "composite %s: an effect with that id already exists", c.ID))
			state[c.ID] = 2
			return false
		}
		state[c.ID] = 1
		var parts []Part
		ok := true
		for _, l := range c.Layers {
			if dep, isComp := byID[l.Effect]; isComp {
				if _, done := r.Get(l.Effect); !done && !visit(dep, append(path, c.ID)) {
					ok = false
					continue
				}
			}
			def, found := r.Get(l.Effect)
			if !found {
				errs = append(errs, config.Errorf(l.Pos, "composite %s: no effect %q", c.ID, l.Effect))
				ok = false
				continue
			}
			op := 1.0
			if l.Opacity != nil {
				op = *l.Opacity
			}
			parts = append(parts, Part{Name: l.Name, Effect: def, Blend: l.Blend, Opacity: op, Params: l.Params})
		}
		state[c.ID] = 2
		if !ok {
			return false
		}
		def, err := Composite(c.ID, cmpOr(c.Name, c.ID), parts)
		if err == nil {
			def.WLED = &render.WLED{FX: nextFX(r), Name: def.Name, Bindings: autoBindings(def)}
			err = r.Register(def)
		}
		if err != nil {
			errs = append(errs, config.Errorf(c.Pos, "%v", err))
			return false
		}
		return true
	}
	for i := range comps {
		visit(&comps[i], nil)
	}
	return errs.Err()
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// autoBindings binds a config composite's most useful parameters to WLED
// controls: sx to its first speed, ix to its first density, pal to its
// first palette, col0–col2 to its first three colors.
func autoBindings(d *render.Def) []render.Binding {
	var bs []render.Binding
	first := func(t render.ParamType) (string, bool) {
		for _, p := range d.Params {
			if p.Type == t {
				return p.Name, true
			}
		}
		return "", false
	}
	if p, ok := first(render.TSpeed); ok {
		bs = append(bs, render.Binding{Slider: render.SliderSpeed, Param: p, Curve: render.CurveExp, Min: "0 m/s", Max: "10 m/s"})
	}
	if p, ok := first(render.TDensity); ok {
		bs = append(bs, render.Binding{Slider: render.SliderIntensity, Param: p, Curve: render.CurveExp, Min: "0 /m/s", Max: "50 /m/s"})
	}
	if p, ok := first(render.TPalette); ok {
		bs = append(bs, render.Binding{Slider: render.SliderPalette, Param: p})
	}
	cols := []render.Slider{render.SliderColor0, render.SliderColor1, render.SliderColor2}
	for _, p := range d.Params {
		if p.Type == render.TColor && len(cols) > 0 {
			bs = append(bs, render.Binding{Slider: cols[0], Param: p.Name})
			cols = cols[1:]
		}
	}
	return bs
}
