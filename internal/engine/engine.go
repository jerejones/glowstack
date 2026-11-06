// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package engine turns stack layers into render layers. It expands
// presets, picks each layer's mapping (layer → segment → zone → global
// default), resolves params at the target's pitch and precomputes
// geometry. Resolved layers are cached by id and rebuilt only when the
// layer is edited. The effect instance survives edits, so stateful
// effects keep their state.
package engine

import (
	"fmt"
	"maps"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

// Engine resolves layers. Resolve is called from the frame loop only;
// Check may be called from any goroutine.
type Engine struct {
	cfg      *config.Config
	layout   *layout.Layout
	mappings *layout.Mappings
	effects  *render.Registry
	palettes *palette.Registry
	pitch    map[string]float64 // per area

	cache map[string]*cached
	seen  map[string]bool

	// Inline mappings solved for layers, by content id. Check (any
	// goroutine) and Resolve share them.
	inlineMu sync.Mutex
	inline   map[string]*layout.Mapping

	// OnError is told about layers that fail to resolve at render time
	// (which validation should have prevented). They're skipped.
	OnError func(id string, err error)
}

type cached struct {
	revision uint64
	updated  time.Time
	layer    *render.Layer
}

// New returns an engine.
func New(cfg *config.Config, l *layout.Layout, ms *layout.Mappings, effects *render.Registry, palettes *palette.Registry) *Engine {
	e := &Engine{cfg: cfg, layout: l, mappings: ms, effects: effects, palettes: palettes,
		pitch: map[string]float64{}, cache: map[string]*cached{}, seen: map[string]bool{},
		inline: map[string]*layout.Mapping{}}
	for _, a := range l.Areas {
		e.pitch[a.ID] = e.areaPitch(a.Pixels)
	}
	return e
}

// Check validates a stack layer: its area, effect or preset, params and
// mapping. Install it as stack.Stack.Validate.
func (e *Engine) Check(l *stack.Layer) error {
	resolved, err := e.build(l, nil, false)
	if err != nil {
		return err
	}
	l.ResolvedFades = &stack.Fades{In: -1, Out: -1}
	if resolved.Common.FadeIn >= 0 {
		l.ResolvedFades.In = time.Duration(resolved.Common.FadeIn * float64(time.Second))
	}
	if resolved.Common.FadeOut >= 0 {
		l.ResolvedFades.Out = time.Duration(resolved.Common.FadeOut * float64(time.Second))
	}
	return nil
}

// Resolve turns the stack's active layers (top first) into render layers,
// appending them to dst.
func (e *Engine) Resolve(active []stack.Active, dst []*render.Layer) []*render.Layer {
	clear(e.seen)
	for i := range active {
		a := &active[i]
		e.seen[a.ID] = true
		c := e.cache[a.ID]
		if c == nil || c.revision != a.Revision || !c.updated.Equal(a.Updated) {
			var prev *render.Layer
			if c != nil {
				prev = c.layer
			}
			L, err := e.build(&a.Layer, prev, true)
			if err != nil {
				if e.OnError != nil && (c == nil || c.layer != nil) {
					e.OnError(a.ID, err)
				}
				e.cache[a.ID] = &cached{revision: a.Revision, updated: a.Updated}
				continue
			}
			c = &cached{revision: a.Revision, updated: a.Updated, layer: L}
			e.cache[a.ID] = c
		}
		if c.layer == nil {
			continue
		}
		c.layer.Fade = a.Fade
		dst = append(dst, c.layer)
	}
	for id := range e.cache {
		if !e.seen[id] {
			delete(e.cache, id)
		}
	}
	return dst
}

// Inspect resolves a layer's effect, params and common params, without
// geometry or an effect instance, for reporting them (the WLED devices
// read slider positions back from it). It may be called from any
// goroutine.
func (e *Engine) Inspect(l *stack.Layer) (*render.Layer, error) { return e.build(l, nil, false) }

// Expand returns a layer's effect id and full raw params, expanding a
// preset and applying the layer's overrides.
func (e *Engine) Expand(l *stack.Layer) (effect string, params map[string]any, err error) {
	if l.Preset == "" {
		return l.Effect, l.Params, nil
	}
	p, ok := e.cfg.Preset(l.Preset)
	if !ok {
		return "", nil, fmt.Errorf("no preset %q", l.Preset)
	}
	params = maps.Clone(p.Params)
	if params == nil {
		params = map[string]any{}
	}
	maps.Copy(params, l.Params)
	return p.Effect, params, nil
}

// Mapping returns the id of the mapping a layer uses when it doesn't name
// one: its WLED segment's, then its zone's, then the global default.
func (e *Engine) Mapping(l *stack.Layer) string {
	zone, seg := e.ownerSegment(l.Owner)
	if zone == nil {
		zone, seg = e.zoneFor(l.Target)
	}
	if seg != nil && seg.Mapping != "" {
		return seg.Mapping
	}
	if zone != nil && zone.Mapping != "" {
		return zone.Mapping
	}
	return e.mappings.Default
}

// ownerSegment finds the zone and segment of a "wled-device:<zone>/<n>"
// owner.
func (e *Engine) ownerSegment(owner string) (*config.Zone, *config.Segment) {
	rest, ok := strings.CutPrefix(owner, stack.OwnerWLEDPrefix)
	if !ok {
		return nil, nil
	}
	zid, sn, _ := strings.Cut(rest, "/")
	for i := range e.cfg.Zones {
		z := &e.cfg.Zones[i]
		if z.ID != zid {
			continue
		}
		if n, err := strconv.Atoi(sn); err == nil && n >= 0 && n < len(z.Segments) {
			return z, &z.Segments[n]
		}
		return z, nil
	}
	return nil, nil
}

// zoneFor finds the first zone with a segment on area, or else the first
// zone whose own area is area.
func (e *Engine) zoneFor(area string) (*config.Zone, *config.Segment) {
	for i := range e.cfg.Zones {
		z := &e.cfg.Zones[i]
		for j := range z.Segments {
			if z.Segments[j].Area == area {
				return z, &z.Segments[j]
			}
		}
	}
	for i := range e.cfg.Zones {
		if e.cfg.Zones[i].Area == area {
			return &e.cfg.Zones[i], nil
		}
	}
	return nil, nil
}

// build resolves l. With prev set and the same effect, the effect
// instance is kept. Without full, it only validates: no geometry and no
// effect instance.
func (e *Engine) build(l *stack.Layer, prev *render.Layer, full bool) (*render.Layer, error) {
	area, ok := e.layout.Area(l.Target)
	if !ok {
		return nil, fmt.Errorf("no area %q", l.Target)
	}
	effectID, raw, err := e.Expand(l)
	if err != nil {
		return nil, err
	}
	def, ok := e.effects.Get(effectID)
	if !ok {
		return nil, fmt.Errorf("no effect %q", effectID)
	}
	pitch, ok := e.pitch[area.ID]
	if !ok { // an implicit run:<id>, controller:<id> or all area
		pitch = e.areaPitch(area.Pixels)
	}
	env := render.Env{Pitch: pitch, Palettes: e.palettes}
	commonRaw, effectRaw := render.SplitParams(raw)
	common, err := render.ResolveCommon(commonRaw, env)
	if err != nil {
		return nil, err
	}
	m, err := e.mapping(l, &common)
	if err != nil {
		return nil, err
	}
	values, err := render.Resolve(def.Params, effectRaw, env)
	if err != nil {
		return nil, fmt.Errorf("effect %s: %w", def.ID, err)
	}
	L := &render.Layer{
		ID: l.ID, Def: def, Params: values, Common: common, Seed: l.Seed,
		Created: clock.Seconds(l.Created), Pitch: env.Pitch,
	}
	// Extra mappings and areas (shows): check them always, solve them
	// when building geometry.
	var extraMaps map[string]*layout.Mapping
	var extraAreas map[string][]int32
	if def.Extra != nil {
		extraMaps, extraAreas = map[string]*layout.Mapping{}, map[string][]int32{}
		for _, em := range def.Extra.Mappings {
			xm, err := e.extraMapping(em.Raw, env)
			if err != nil {
				return nil, fmt.Errorf("effect %s: mapping %s: %w", def.ID, em.Key, err)
			}
			extraMaps[em.Key] = xm
		}
		for _, id := range def.Extra.Areas {
			a, ok := e.layout.Area(id)
			if !ok {
				return nil, fmt.Errorf("effect %s: no area %q", def.ID, id)
			}
			extraAreas[id] = a.Pixels
		}
	}
	if !full {
		return L, nil
	}
	L.Geometry = render.BuildGeometry(e.layout, m, area.Pixels, def.CoordsOf(values), common)
	if def.Extra != nil {
		L.Geometry.Extra, L.Geometry.Masks = map[string]*render.ExtraCoords{}, map[string][]bool{}
		for k, xm := range extraMaps {
			L.Geometry.Extra[k] = L.Geometry.BuildExtra(xm)
		}
		for id, pix := range extraAreas {
			L.Geometry.Masks[id] = L.Geometry.BuildMask(pix)
		}
	}
	if prev != nil && prev.Def == def {
		L.Effect = prev.Effect
	} else {
		L.Effect = def.New()
	}
	return L, nil
}

// extraMapping resolves a Def.Extra mapping value: a mapping id or an
// inline mapping object.
func (e *Engine) extraMapping(raw any, env render.Env) (*layout.Mapping, error) {
	v, err := render.Resolve([]render.Param{{Name: render.ParamMapping, Type: render.TMapping, Default: ""}},
		map[string]any{render.ParamMapping: raw}, env)
	if err != nil {
		return nil, err
	}
	c := render.Common{Mapping: v.Mapping(render.ParamMapping), Inline: v.InlineMapping(render.ParamMapping)}
	if c.Inline == nil && c.Mapping == "" {
		return nil, fmt.Errorf("empty mapping")
	}
	return e.mapping(nil, &c)
}

// mapping finds a layer's mapping: an inline one, a named one or the
// default (setting common.Mapping to the default's id).
func (e *Engine) mapping(l *stack.Layer, common *render.Common) (*layout.Mapping, error) {
	if common.Inline != nil {
		return e.Inline(common.Inline)
	}
	if common.Mapping == "" {
		common.Mapping = e.Mapping(l)
	}
	m, ok := e.mappings.Get(common.Mapping)
	if !ok {
		return nil, fmt.Errorf("no mapping %q (mappings: %s)", common.Mapping, strings.Join(e.mappings.IDs(), ", "))
	}
	return m, nil
}

// MaxInline is how many solved inline mappings an engine keeps. Past it
// the cache starts again; layers already resolved keep their geometry.
const MaxInline = 32

// Inline solves an inline mapping on the engine's layout, or returns the
// solve of an equal one from before. Errors (an unknown node, a loop
// under `loops: error`) say what's wrong without file positions.
func (e *Engine) Inline(im *config.InlineMapping) (*layout.Mapping, error) {
	e.inlineMu.Lock()
	defer e.inlineMu.Unlock()
	if m, ok := e.inline[im.ID]; ok {
		return m, nil
	}
	var m *layout.Mapping
	var err error
	if im.Flow != nil {
		f := *im.Flow
		m, _, err = layout.SolveFlow(e.layout, &f)
	} else {
		mp := *im.Mapping
		m, err = layout.SolveSpatial(e.layout, &mp)
	}
	if err != nil {
		return nil, config.InlineError(err)
	}
	if len(e.inline) >= MaxInline {
		clear(e.inline)
	}
	e.inline[im.ID] = m
	return m, nil
}

// CheckMapping checks a mapping parameter's value as a preset or layer
// gives it: a known id, or an inline mapping that solves. "" (the
// default) is fine.
func (e *Engine) CheckMapping(c render.Common) error {
	if c.Inline == nil && c.Mapping == "" {
		return nil
	}
	_, err := e.mapping(nil, &c)
	return err
}

// areaPitch is the most common pitch among the runs of pixels: px
// parameters on a layer use it.
func (e *Engine) areaPitch(pixels []int32) float64 {
	count := map[int32]int{}
	for _, p := range pixels {
		if r := e.layout.Pixels[p].Run; r >= 0 {
			count[r]++
		}
	}
	best, bestN := e.layout.Pitch, 0
	for r, n := range count {
		pitch := e.layout.Runs[r].Pitch
		if n > bestN || n == bestN && pitch < best {
			best, bestN = pitch, n
		}
	}
	return best
}
