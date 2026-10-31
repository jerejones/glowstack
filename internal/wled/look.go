// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"maps"
	"strconv"

	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
	"github.com/jerejones/glowstack/internal/units"
)

// look is what a segment shows: an effect with raw params, or a preset
// with overrides. It's a layer without a position on the stack.
type look struct {
	Effect string
	Preset string
	Params map[string]any
}

// lookOf is a layer's look. The fades it was pushed with belong to that
// push, not to the look.
func lookOf(l *stack.Layer) look {
	params := maps.Clone(l.Params)
	delete(params, render.ParamFadeIn)
	delete(params, render.ParamFadeOut)
	return look{Effect: l.Effect, Preset: l.Preset, Params: params}
}

func (lk look) layer(sv segView) *stack.Layer {
	return &stack.Layer{Owner: sv.owner, Target: sv.area, Effect: lk.Effect, Preset: lk.Preset, Params: lk.Params}
}

func (lk look) clone() look {
	lk.Params = cloneRaw(lk.Params)
	return lk
}

func cloneRaw(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = cloneValue(v)
	}
	return out
}

func cloneValue(v any) any {
	switch v := v.(type) {
	case map[string]any:
		return cloneRaw(v)
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = cloneValue(x)
		}
		return out
	}
	return v
}

// controls are WLED's per-segment effect controls. A segment remembers
// the ones its effect doesn't bind, so they read back as they were set.
type controls struct {
	SX, IX, C1, C2, C3 int
	O1, O2, O3         bool
	Pal                int
	Col                [3]units.Color
}

// defaultControls are a new WLED segment's: sliders at 128 (c3 at 16, its
// range being 0–31), WLED's default orange, then black.
func defaultControls() controls {
	return controls{SX: 128, IX: 128, C1: 128, C2: 128, C3: 16,
		Col: [3]units.Color{{R: 255, G: 170}, {}, {}}}
}

func (c *controls) slider(s render.Slider) *int {
	switch s {
	case render.SliderSpeed:
		return &c.SX
	case render.SliderIntensity:
		return &c.IX
	case render.SliderC1:
		return &c.C1
	case render.SliderC2:
		return &c.C2
	}
	return &c.C3
}

func (c *controls) option(s render.Slider) *bool {
	switch s {
	case render.SliderO1:
		return &c.O1
	case render.SliderO2:
		return &c.O2
	}
	return &c.O3
}

// segMem is what a segment remembers while it's off, and the controls
// its effect doesn't bind.
type segMem struct {
	look look
	ctl  controls
	cct  int
	sel  bool
}

// zoneMem is a device's own state.
type zoneMem struct {
	bri        int // brightness to turn on at (WLED's briLast)
	transition int // default transition, 100 ms units; -1 = config default
	mainseg    int
	view       *view
}

// segMem returns segment i's memory, made on first use: WLED's new
// segment (solid orange), the first segment selected.
func (d *Devices) segMem(v *view, i int) *segMem {
	owner := v.segs[i].owner
	if sm := d.segs[owner]; sm != nil {
		return sm
	}
	sm := &segMem{ctl: defaultControls(), cct: 127, sel: i == 0}
	sm.look = d.defaultLook(v, i, sm)
	d.segs[owner] = sm
	return sm
}

// defaultLook is solid in the default colour, or the first effect WLED can
// show if there's no solid.
func (d *Devices) defaultLook(v *view, i int, sm *segMem) look {
	id := "solid"
	if _, ok := d.a.Effects.Get(id); !ok {
		if defs := wledEffects(d.a.Effects); len(defs) > 0 {
			id = defs[0].ID
		}
	}
	lk := look{Effect: id, Params: map[string]any{}}
	if def, ok := d.a.Effects.Get(id); ok {
		if raw, err := def.SetWLED(lk.Params, render.SliderColor0, sm.ctl.Col[0], render.Env{Palettes: v.Palettes}); err == nil {
			lk.Params = raw
		}
	}
	return lk
}

func (d *Devices) zoneMem(zone string) *zoneMem {
	zm := d.zones[zone]
	if zm == nil {
		zm = &zoneMem{bri: 128, transition: -1}
		if b, ok := d.saved.Zones[zone]; ok && b.Bri > 0 {
			zm.bri = b.Bri
		}
		d.zones[zone] = zm
	}
	return zm
}

func parseIndex(s string) (int, error) { return strconv.Atoi(s) }

func itoa(n int) string { return strconv.Itoa(n) }
