// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"slices"
	"time"

	"github.com/jerejones/glowstack/internal/units"
)

// Defaults applied by Validate.
const (
	DefaultFPS     = 40
	DefaultPort    = 4048
	DefaultFadeIn  = 300 * time.Millisecond
	DefaultFadeOut = 500 * time.Millisecond
)

// Validate fills defaults and checks the config. Load calls it; call it
// again after building or changing a Config in code.
func (c *Config) Validate() error {
	v := &validator{}
	v.settings(&c.Settings)
	v.controllers(c.Controllers)
	v.layout(c)
	v.areas(c)
	v.mappings(c)
	v.palettes(c.Palettes)
	v.presets(c.Presets)
	v.composites(c.Composites)
	for i := range c.Anchors {
		a := &c.Anchors[i]
		v.required(a.Pos, "run", a.Run)
		v.required(a.Pos, "node", a.Node)
		v.oneOf(a.Pos, "source", &a.Source, SourceMeasured, SourceEstimated)
	}
	return v.errs.Err()
}

type validator struct{ errs Errors }

func (v *validator) errorf(pos Pos, format string, args ...any) {
	v.errs = append(v.errs, Errorf(pos, format, args...))
}

func (v *validator) required(pos Pos, field, val string) bool {
	if val == "" {
		v.errorf(pos, "missing %s", field)
		return false
	}
	return true
}

// oneOf checks *val against allowed, setting it to allowed[0] when empty.
func (v *validator) oneOf(pos Pos, field string, val *string, allowed ...string) {
	if *val == "" {
		*val = allowed[0]
		return
	}
	if !slices.Contains(allowed, *val) {
		v.errorf(pos, "%s %q: want one of %v", field, *val, allowed)
	}
}

// unique reports duplicate ids among items.
func unique[T any](v *validator, what string, items []T, id func(*T) (string, Pos)) map[string]bool {
	seen := map[string]Pos{}
	for i := range items {
		s, pos := id(&items[i])
		if !v.required(pos, what+" id", s) {
			continue
		}
		if prev, dup := seen[s]; dup {
			v.errorf(pos, "duplicate %s id %q (first at %s)", what, s, prev)
			continue
		}
		seen[s] = pos
	}
	ids := make(map[string]bool, len(seen))
	for s := range seen {
		ids[s] = true
	}
	return ids
}

func (v *validator) settings(s *Settings) {
	if s.FPS == 0 {
		s.FPS = DefaultFPS
	}
	if s.FPS < 0 || s.FPS > 1000 {
		v.errorf(s.Pos, "fps %v out of range", s.FPS)
	}
	v.oneOf(s.Pos, "boot", &s.Boot, "restore", "dark")
	if s.Fade.In == nil {
		d := units.Duration(DefaultFadeIn)
		s.Fade.In = &d
	}
	if s.Fade.Out == nil {
		d := units.Duration(DefaultFadeOut)
		s.Fade.Out = &d
	}
}

func (v *validator) controllers(cs []Controller) {
	if len(cs) == 0 {
		v.errorf(Pos{File: ControllersFileName}, "no controllers")
	}
	unique(v, "controller", cs, func(c *Controller) (string, Pos) { return c.ID, c.Pos })
	for i := range cs {
		c := &cs[i]
		v.required(c.Pos, "host", c.Host)
		v.oneOf(c.Pos, "transport", &c.Transport, "ddp")
		v.oneOf(c.Pos, "channels", &c.Channels, "rgb", "rgbw")
		v.oneOf(c.Pos, "white", &c.White, "explicit", "auto")
		if c.Port == 0 {
			c.Port = DefaultPort
		}
		if c.Port < 0 || c.Port > 65535 {
			v.errorf(c.Pos, "port %d out of range", c.Port)
		}
		if c.Pixels <= 0 {
			v.errorf(c.Pos, "controller %q: pixels must be positive", c.ID)
		}
		if c.MaxFPS < 0 {
			v.errorf(c.Pos, "max_fps must not be negative")
		}
		used := make([]int, 0, len(c.Outputs))
		for j := range c.Outputs {
			o := &c.Outputs[j]
			if o.Count <= 0 || o.Start < 0 || o.Start+o.Count > c.Pixels {
				v.errorf(o.Pos, "output pin %d: range %d+%d outside controller %q's %d pixels", o.Pin, o.Start, o.Count, c.ID, c.Pixels)
			}
			for _, k := range used {
				p := c.Outputs[k]
				if o.Start < p.Start+p.Count && p.Start < o.Start+o.Count {
					v.errorf(o.Pos, "output pin %d overlaps pin %d", o.Pin, p.Pin)
				}
			}
			used = append(used, j)
		}
	}
}

func (v *validator) layout(c *Config) {
	l := &c.Layout
	if l.Pitch.PX || l.Pitch.Value <= 0 {
		v.errorf(l.Pos, "pitch must be a positive length in metres, e.g. `pitch: 1/60 m`")
	}
	unique(v, "node", l.Nodes, func(n *Node) (string, Pos) { return n.ID, n.Pos })
	unique(v, "run", l.Runs, func(r *Run) (string, Pos) { return r.ID, r.Pos })
	for i := range l.Plans {
		p := &l.Plans[i]
		v.required(p.Pos, "svg", p.SVG)
		if p.Scale != nil && (p.Scale.PX || p.Scale.Value <= 0) {
			v.errorf(p.Pos, "plan scale must be a positive length in metres per plan unit")
		}
	}
	for i := range l.Runs {
		r := &l.Runs[i]
		ctl, ok := c.Controller(r.Controller)
		if v.required(r.Pos, "controller", r.Controller) && !ok {
			v.errorf(r.Pos, "run %q: unknown controller %q", r.ID, r.Controller)
		}
		if ok {
			for _, idx := range r.Indices {
				if idx < 0 || idx >= ctl.Pixels {
					v.errorf(r.Pos, "run %q: index %d outside controller %q's 0–%d", r.ID, idx, ctl.ID, ctl.Pixels-1)
				}
			}
		}
		if r.Pitch != nil && (r.Pitch.PX || r.Pitch.Value <= 0) {
			v.errorf(r.Pos, "run %q: pitch must be a positive length in metres", r.ID)
		}
		if len(r.Path) == 1 {
			v.errorf(r.Pos, "run %q: path needs at least two nodes (its two ends)", r.ID)
		}
		if len(r.Path) == 0 && r.Plan == nil {
			v.errorf(r.Pos, "run %q: give a path, or a plan whose vertices are labelled", r.ID)
		}
		lo, hi := min(r.Indices[0], r.Indices[1]), max(r.Indices[0], r.Indices[1])
		for j := range r.Anchors {
			a := &r.Anchors[j]
			v.required(a.Pos, "node", a.Node)
			if a.Source == "" && a.Index == nil {
				a.Source = SourceEstimated
			}
			v.oneOf(a.Pos, "source", &a.Source, SourceMeasured, SourceEstimated)
			if a.Index != nil && (*a.Index < lo || *a.Index > hi) {
				v.errorf(a.Pos, "anchor %q: index %d outside run %q's %d–%d", a.Node, *a.Index, r.ID, r.Indices[0], r.Indices[1])
			}
		}
		for j := range r.Lengths {
			e := &r.Lengths[j]
			v.required(e.Pos, "from", e.From)
			v.required(e.Pos, "to", e.To)
			if e.Length.PX || e.Length.Value <= 0 {
				v.errorf(e.Pos, "length must be a positive length in metres")
			}
		}
		if r.Plan != nil {
			v.required(r.Plan.Pos, "svg", r.Plan.SVG)
		}
	}
	for i := range l.Edges {
		e := &l.Edges[i]
		v.required(e.Pos, "from", e.From)
		v.required(e.Pos, "to", e.To)
		switch e.Kind {
		case EdgeGap:
			if e.Length.PX || e.Length.Value <= 0 {
				v.errorf(e.Pos, "gap %s–%s needs a positive length in metres", e.From, e.To)
			}
		case EdgeLink:
			if e.Length.Value != 0 {
				v.errorf(e.Pos, "link %s–%s has zero length by definition; use a gap for a physical distance", e.From, e.To)
			}
		case "":
			v.errorf(e.Pos, "missing kind (gap or link)")
		default:
			v.errorf(e.Pos, "edge kind %q: want gap or link (strip edges come from runs)", e.Kind)
		}
		if e.From == e.To && e.From != "" {
			v.errorf(e.Pos, "edge from %q to itself", e.From)
		}
	}
	for i := range l.Dead {
		d := &l.Dead[i]
		ctl, ok := c.Controller(d.Controller)
		if !ok {
			v.errorf(d.Pos, "dead: unknown controller %q", d.Controller)
			continue
		}
		if d.Indices[0] > d.Indices[1] || d.Indices[0] < 0 || d.Indices[1] >= ctl.Pixels {
			v.errorf(d.Pos, "dead: bad index range %v on controller %q", d.Indices, ctl.ID)
		}
	}
}

func (v *validator) areas(c *Config) {
	areaIDs := unique(v, "area", c.Areas, func(a *Area) (string, Pos) { return a.ID, a.Pos })
	runIDs := map[string]bool{}
	for _, r := range c.Layout.Runs {
		runIDs[r.ID] = true
	}
	for _, a := range c.Areas {
		if len(a.Include) == 0 {
			v.errorf(a.Pos, "area %q includes nothing", a.ID)
		}
		for _, p := range a.Include {
			switch {
			case p.Run != "" && p.Area != "":
				v.errorf(p.Pos, "give run or area, not both")
			case p.Area != "":
				if !areaIDs[p.Area] {
					v.errorf(p.Pos, "unknown area %q", p.Area)
				}
				if p.From != nil || p.To != nil {
					v.errorf(p.Pos, "from/to apply to runs, not areas")
				}
			case p.Run != "":
				if !runIDs[p.Run] {
					v.errorf(p.Pos, "unknown run %q", p.Run)
				}
			default:
				v.errorf(p.Pos, "include entry needs a run or an area")
			}
		}
	}
	mappingIDs := map[string]bool{}
	for _, id := range c.MappingIDs() {
		mappingIDs[id] = true
	}
	unique(v, "zone", c.Zones, func(z *Zone) (string, Pos) { return z.ID, z.Pos })
	for _, z := range c.Zones {
		if v.required(z.Pos, "area", z.Area) && !areaIDs[z.Area] {
			v.errorf(z.Pos, "zone %q: unknown area %q", z.ID, z.Area)
		}
		if z.Mapping != "" && !mappingIDs[z.Mapping] {
			v.errorf(z.Pos, "zone %q: unknown mapping %q", z.ID, z.Mapping)
		}
		for _, s := range z.Segments {
			if v.required(s.Pos, "area", s.Area) && !areaIDs[s.Area] {
				v.errorf(s.Pos, "segment: unknown area %q", s.Area)
			}
			if s.Mapping != "" && !mappingIDs[s.Mapping] {
				v.errorf(s.Pos, "segment: unknown mapping %q", s.Mapping)
			}
		}
	}
}

func (v *validator) mappings(c *Config) {
	type idPos struct {
		id  string
		pos Pos
	}
	var all []idPos
	for _, f := range c.Flows {
		all = append(all, idPos{f.ID, f.Pos})
	}
	for _, m := range c.Mappings {
		all = append(all, idPos{m.ID, m.Pos})
	}
	unique(v, "mapping", all, func(x *idPos) (string, Pos) { return x.id, x.pos })
	for _, x := range all {
		if x.id == MappingLocal || x.id == MappingIndex || x.id == MappingPlan {
			v.errorf(x.pos, "mapping id %q is built in; choose another id", x.id)
		}
	}
	if c.DefaultMapping == "" {
		c.DefaultMapping = MappingLocal
	} else if !slices.Contains(c.MappingIDs(), c.DefaultMapping) {
		v.errorf(Pos{File: MappingsFileName}, "default: unknown mapping %q", c.DefaultMapping)
	}
	for i := range c.Flows {
		f := &c.Flows[i]
		v.required(f.Pos, "origin", f.Origin)
		v.oneOf(f.Pos, "pace", &f.Pace, PaceReference, PaceLongest, PaceShortest, PaceAverage)
		v.oneOf(f.Pos, "warp", &f.Warp, WarpLinear, WarpSmooth)
		v.oneOf(f.Pos, "loops", &f.Loops, LoopsStretch, LoopsMeet, LoopsError)
		v.oneOf(f.Pos, "unreached", &f.Unreached, UnreachedLocal, UnreachedDark, UnreachedError)
		if f.MaxStretch != 0 && f.MaxStretch < 1 {
			v.errorf(f.Pos, "max_stretch %v must be at least 1 (it applies both ways)", f.MaxStretch)
		}
		for _, o := range f.Orient {
			if o.Into != o.Edge[0] && o.Into != o.Edge[1] {
				v.errorf(o.Pos, "into %q must be one of the edge's nodes %v", o.Into, o.Edge)
			}
		}
		for _, p := range f.Pin {
			v.required(p.Pos, "node", p.Node)
			if p.U.PX {
				v.errorf(p.Pos, "pin u must be in metres, not px")
			}
		}
	}
	for i := range c.Mappings {
		m := &c.Mappings[i]
		if m.Kind == KindFlow {
			v.errorf(m.Pos, "declare flows under `flows:`")
			continue
		}
		v.oneOf(m.Pos, "kind", &m.Kind, KindLocal, KindIndex, KindAxis, KindRadial, KindPlan)
		switch m.Kind {
		case KindAxis:
			if (m.Angle == nil) == (m.To == nil) {
				v.errorf(m.Pos, "axis mapping %q: give either angle or from+to", m.ID)
			}
			if m.To != nil && m.From == nil {
				v.errorf(m.Pos, "axis mapping %q: to needs from", m.ID)
			}
		case KindRadial:
			if m.Center == nil {
				v.errorf(m.Pos, "radial mapping %q: missing center", m.ID)
			}
		}
	}
}

func (v *validator) palettes(ps []Palette) {
	unique(v, "palette", ps, func(p *Palette) (string, Pos) { return p.ID, p.Pos })
	for i := range ps {
		p := &ps[i]
		v.oneOf(p.Pos, "interpolate", &p.Interpolate, "linear", "step")
		if p.Wrap == nil {
			t := true
			p.Wrap = &t
		}
		if len(p.Stops) == 0 {
			v.errorf(p.Pos, "palette %q has no stops", p.ID)
		}
		for j := 1; j < len(p.Stops); j++ {
			if p.Stops[j].At < p.Stops[j-1].At {
				v.errorf(p.Stops[j].Pos, "palette %q: stops must be in increasing order", p.ID)
			}
		}
	}
}

func (v *validator) presets(ps []Preset) {
	// presets.saved.yaml may redefine a presets.yaml id; the saved one wins.
	var cfg, saved []Preset
	for _, p := range ps {
		if p.Saved {
			saved = append(saved, p)
		} else {
			cfg = append(cfg, p)
		}
	}
	unique(v, "preset", cfg, func(p *Preset) (string, Pos) { return p.ID, p.Pos })
	unique(v, "preset", saved, func(p *Preset) (string, Pos) { return p.ID, p.Pos })
	for _, p := range ps {
		v.required(p.Pos, "effect", p.Effect)
	}
}

func (v *validator) composites(cs []Composite) {
	unique(v, "composite", cs, func(c *Composite) (string, Pos) { return c.ID, c.Pos })
	for i := range cs {
		c := &cs[i]
		if len(c.Layers) == 0 {
			v.errorf(c.Pos, "composite %q has no layers", c.ID)
		}
		for j := range c.Layers {
			l := &c.Layers[j]
			v.required(l.Pos, "effect", l.Effect)
			if l.Blend != "" {
				v.oneOf(l.Pos, "blend", &l.Blend, "over", "replace", "add", "max", "multiply")
			}
			if l.Opacity != nil && (*l.Opacity < 0 || *l.Opacity > 1) {
				v.errorf(l.Pos, "opacity %v is outside 0–1", *l.Opacity)
			}
		}
	}
}

// Preset returns the preset with the given id; a saved preset shadows a
// configured one with the same id.
func (c *Config) Preset(id string) (*Preset, bool) {
	var found *Preset
	for i := range c.Presets {
		if c.Presets[i].ID == id {
			found = &c.Presets[i]
		}
	}
	return found, found != nil
}
