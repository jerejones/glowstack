// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package preset turns presets (saved looks from presets.yaml and the
// data folder's presets.saved.yaml) into layer specifications.
//
// A preset is a layer without a target: an effect and raw parameters,
// which may include common layer parameters (blend, opacity, mapping, …).
// Applying one to an area makes a stack layer; any parameter can be
// overridden. Overrides replace whole parameters: overriding `bands`
// replaces the list, not one band.
//
// There are two ways to put a preset on the stack. Apply copies the
// preset's effect and parameters into the layer, so later edits to the
// preset don't change it (like applying a preset on a WLED device).
// A stack.Layer with Preset set instead refers to the preset by id, and
// the engine expands it whenever the layer is resolved.
package preset

import (
	"fmt"
	"maps"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

// Spec is an effect with raw parameters: a preset expanded.
type Spec struct {
	Effect string
	Params map[string]any
}

// Library is the effective set of presets: those in presets.yaml, with
// any from presets.saved.yaml replacing ones with the same id in place
// and the rest added after.
type Library struct {
	list []config.Preset
	byID map[string]int
}

// New builds a library from config.Config.Presets.
func New(presets []config.Preset) *Library {
	l := &Library{byID: map[string]int{}}
	for _, p := range presets {
		if i, ok := l.byID[p.ID]; ok {
			l.list[i] = p
			continue
		}
		l.byID[p.ID] = len(l.list)
		l.list = append(l.list, p)
	}
	return l
}

// Get returns the preset with the given id.
func (l *Library) Get(id string) (config.Preset, bool) {
	i, ok := l.byID[id]
	if !ok {
		return config.Preset{}, false
	}
	return l.list[i], true
}

// List returns the presets in order.
func (l *Library) List() []config.Preset { return append([]config.Preset(nil), l.list...) }

// Expand applies overrides to a preset. A nil override removes the
// parameter, so it takes the effect's default.
func Expand(p config.Preset, overrides map[string]any) Spec {
	params := maps.Clone(p.Params)
	if params == nil {
		params = map[string]any{}
	}
	for k, v := range overrides {
		if v == nil {
			delete(params, k)
		} else {
			params[k] = v
		}
	}
	return Spec{Effect: p.Effect, Params: params}
}

// Apply makes a stack layer showing preset id on area target, with its
// effect and parameters copied in and overrides applied. The caller
// pushes it (and the stack validates it).
func (l *Library) Apply(id, target string, overrides map[string]any) (stack.Layer, error) {
	p, ok := l.Get(id)
	if !ok {
		return stack.Layer{}, fmt.Errorf("no preset %q", id)
	}
	s := Expand(p, overrides)
	return stack.Layer{Target: target, Effect: s.Effect, Params: s.Params}, nil
}

// MappingCheck checks a resolved mapping parameter: a known id, or an
// inline mapping that solves (engine.Engine.CheckMapping). "" means the
// target's default and is always fine.
type MappingCheck func(render.Common) error

// Check validates every preset against the effects, palettes and (if
// mapping isn't nil) mappings, with px values at pitch. Presets are only
// checked when used otherwise, because effects are registered in code and
// composites after config loads.
func (l *Library) Check(effects *render.Registry, palettes *palette.Registry, pitch float64, mapping MappingCheck) config.Errors {
	var errs config.Errors
	for _, p := range l.list {
		if err := CheckSpec(Expand(p, nil), effects, palettes, pitch, mapping); err != nil {
			errs = append(errs, config.Errorf(p.Pos, "preset %s: %v", p.ID, err))
		}
	}
	return errs
}

// CheckSpec validates a spec's effect and parameters (effect and common),
// and its mapping if mapping isn't nil.
func CheckSpec(s Spec, effects *render.Registry, palettes *palette.Registry, pitch float64, mapping MappingCheck) error {
	d, ok := effects.Get(s.Effect)
	if !ok {
		return fmt.Errorf("no effect %q", s.Effect)
	}
	env := render.Env{Pitch: pitch, Palettes: palettes}
	common, effect := render.SplitParams(s.Params)
	c, err := render.ResolveCommon(common, env)
	if err != nil {
		return err
	}
	if _, err := render.Resolve(d.Params, effect, env); err != nil {
		return fmt.Errorf("effect %s: %w", d.ID, err)
	}
	if mapping != nil {
		if err := mapping(c); err != nil {
			return fmt.Errorf("mapping: %w", err)
		}
	}
	return nil
}
