// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"math"
	"net"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jerejones/glowstack/internal/units"
)

// Defaults applied by Validate.
const (
	DefaultFPS     = 40
	DefaultPort    = 4048
	DefaultHTTP    = 80
	DefaultRelease = 2 * time.Second
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
	v.shows(c.Shows)
	runs := map[string]*Run{}
	for i := range c.Layout.Runs {
		runs[c.Layout.Runs[i].ID] = &c.Layout.Runs[i]
	}
	seenAnchors := map[[2]string]Pos{}
	for i := range c.Anchors {
		a := &c.Anchors[i]
		v.required(a.Pos, "run", a.Run)
		v.required(a.Pos, "node", a.Node)
		v.oneOf(a.Pos, "source", &a.Source, SourceMeasured, SourceEstimated)
		key := [2]string{a.Run, a.Node}
		if prev, ok := seenAnchors[key]; ok {
			v.errorf(a.Pos, "duplicate anchor for %q on run %q (first at %s)", a.Node, a.Run, prev)
		}
		seenAnchors[key] = a.Pos
		if r, ok := runs[a.Run]; !ok {
			v.errorf(a.Pos, "anchor: unknown run %q", a.Run)
		} else if lo, hi := r.Span(); a.Index < lo || a.Index > hi {
			v.errorf(a.Pos, "anchor %q: offset %d outside run %q's 0–%d", a.Node, a.Index-lo, a.Run, hi-lo)
		}
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
	v.oneOf(s.Power.Pos, "power group", &s.Power.Group, "global", "zone", "controller", "output")
	if s.Power.Release == nil {
		d := units.Duration(DefaultRelease)
		s.Power.Release = &d
	}
	if *s.Power.Release < 0 {
		v.errorf(s.Power.Pos, "power release must not be negative")
	}
	if s.Dither == nil {
		on := true
		s.Dither = &on
	}
	if w := s.Map.View; w != nil {
		if (w.From != nil) == (w.Direction != nil) {
			v.errorf(w.Pos, "map view: give exactly one of from or direction")
		}
		if w.From != nil {
			if len(w.From) != 3 || len(w.To) != 3 {
				v.errorf(w.Pos, "map view: from and to want [x, y, z] in meters")
			} else if slices.Equal(w.From, w.To) {
				v.errorf(w.Pos, "map view: from and to are the same point")
			}
		}
		if w.Direction != nil {
			if len(w.Direction) != 3 {
				v.errorf(w.Pos, "map view: direction wants three finite numbers [dx, dy, dz]")
			} else {
				d := w.Direction
				scale := max(math.Abs(d[0]), math.Abs(d[1]), math.Abs(d[2]))
				switch {
				case math.IsNaN(scale) || math.IsInf(scale, 0):
					v.errorf(w.Pos, "map view: direction wants three finite numbers")
				case scale == 0:
					v.errorf(w.Pos, "map view: direction must have non-zero length")
				default:
					// Scale first to avoid overflow or underflow for any length.
					x, y, z := d[0]/scale, d[1]/scale, d[2]/scale
					n := math.Sqrt(x*x + y*y + z*z)
					w.Direction = []float64{x / n, y / n, z / n}
				}
			}
			if w.To != nil && len(w.To) != 3 {
				v.errorf(w.Pos, "map view: to wants [x, y, z] in meters")
			}
		}
		if w.FOV == 0 {
			w.FOV = 40
		}
		if w.FOV < 1 || w.FOV > 170 {
			v.errorf(w.Pos, "map view: fov %v out of range (degrees)", w.FOV)
		}
	}
	for name, l := range s.Map.Layers {
		if l.Color != "" {
			if _, err := units.ParseColor(l.Color); err != nil || len(l.Color) != 7 {
				v.errorf(l.Pos, "map layer %q: color wants #rrggbb", name)
			}
		}
		if l.Opacity != nil && (*l.Opacity < 0 || *l.Opacity > 1) {
			v.errorf(l.Pos, "map layer %q: opacity must be 0–1", name)
		}
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
		if c.HTTPPort == 0 {
			c.HTTPPort = DefaultHTTP
		}
		if c.HTTPPort < 0 || c.HTTPPort > 65535 {
			v.errorf(c.Pos, "http_port %d out of range", c.HTTPPort)
		}
		outputStarts(c)
		if c.Pixels <= 0 {
			v.errorf(c.Pos, "controller %q: needs outputs, each with a positive count", c.ID)
		}
		if c.MaxFPS < 0 {
			v.errorf(c.Pos, "max_fps must not be negative")
		}
		for j := range c.Outputs {
			o := &c.Outputs[j]
			if o.Number != j+1 {
				v.errorf(o.Pos, "output %d is listed %s; list outputs in WLED's order, numbered from 1", o.Number, ordinal(j+1))
			}
			if o.Count <= 0 {
				v.errorf(o.Pos, "%s: count must be positive", o.Name())
			}
			if o.GPIO != nil && *o.GPIO < 0 {
				v.errorf(o.Pos, "%s: gpio must not be negative", o.Name())
			}
		}
	}
}

// ordinal is 1st, 2nd, 3rd, 4th …
func ordinal(n int) string {
	suffix := "th"
	switch {
	case n%100 >= 11 && n%100 <= 13:
	case n%10 == 1:
		suffix = "st"
	case n%10 == 2:
		suffix = "nd"
	case n%10 == 3:
		suffix = "rd"
	}
	return strconv.Itoa(n) + suffix
}

func (v *validator) layout(c *Config) {
	l := &c.Layout
	if l.Pitch.PX || l.Pitch.Value <= 0 {
		v.errorf(l.Pos, "pitch must be a positive length in meters, e.g. `pitch: 1/60 m`")
	}
	unique(v, "node", l.Nodes, func(n *Node) (string, Pos) { return n.ID, n.Pos })
	unique(v, "run", l.Runs, func(r *Run) (string, Pos) { return r.ID, r.Pos })
	if l.Scene != nil {
		v.required(l.Scene.Pos, "glb", l.Scene.GLB)
	}
	for i := range l.Plans {
		p := &l.Plans[i]
		v.required(p.Pos, "svg", p.SVG)
		if p.Scale != nil && (p.Scale.PX || p.Scale.Value <= 0) {
			v.errorf(p.Pos, "plan scale must be a positive length in meters per plan unit")
		}
		if p.Z != nil && p.Z.PX {
			v.errorf(p.Pos, "plan z must be a length in meters")
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
			v.errorf(r.Pos, "run %q: pitch must be a positive length in meters", r.ID)
		}
		if len(r.Path) == 1 {
			v.errorf(r.Pos, "run %q: path needs at least two nodes (its two ends)", r.ID)
		}
		if len(r.Path) == 0 && r.Plan == nil && r.Model == nil {
			v.errorf(r.Pos, "run %q: give a path, or a plan or model whose vertices are labeled", r.ID)
		}
		lo, hi := min(r.Indices[0], r.Indices[1]), max(r.Indices[0], r.Indices[1])
		for j := range r.Anchors {
			a := &r.Anchors[j]
			v.required(a.Pos, "node", a.Node)
			if a.Source == "" && a.Index == nil && a.Offset == nil {
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
				v.errorf(e.Pos, "length must be a positive length in meters")
			}
		}
		if r.Plan != nil {
			v.required(r.Plan.Pos, "svg", r.Plan.SVG)
		}
		if r.Model != nil && v.required(r.Model.Pos, "glb", r.Model.GLB) {
			file, _, _ := strings.Cut(r.Model.GLB, "#")
			if l.Scene == nil {
				v.errorf(r.Model.Pos, "run %q: model needs the layout's `scene: { glb: %s }`", r.ID, file)
			} else if file != l.Scene.GLB {
				v.errorf(r.Model.Pos, "run %q: model %q isn't the layout's scene %q", r.ID, file, l.Scene.GLB)
			}
		}
	}
	for i := range l.Edges {
		e := &l.Edges[i]
		v.required(e.Pos, "from", e.From)
		v.required(e.Pos, "to", e.To)
		switch e.Kind {
		case EdgeGap:
			if e.Length.PX || e.Length.Value <= 0 {
				v.errorf(e.Pos, "gap %s–%s needs a positive length in meters", e.From, e.To)
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
				if p.From != nil || p.After != nil || p.To != nil || p.Before != nil {
					v.errorf(p.Pos, "from/after/to/before apply to runs, not areas")
				}
			case p.Run != "":
				if !runIDs[p.Run] {
					v.errorf(p.Pos, "unknown run %q", p.Run)
				}
				if p.From != nil && p.After != nil {
					v.errorf(p.Pos, "give one start, from (inclusive) or after (exclusive), not both")
				}
				if p.To != nil && p.Before != nil {
					v.errorf(p.Pos, "give one end, to (inclusive) or before (exclusive), not both")
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
	v.devices(c.Zones)
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

// DefaultDevicePort is a zone device's HTTP port: Home Assistant's WLED
// integration only uses port 80.
const DefaultDevicePort = 80

// devices checks the zones' WLED device blocks: Home Assistant identifies
// a device by its MAC, so each needs one of its own, and no two devices
// can listen on the same address.
func (v *validator) devices(zones []Zone) {
	type bound struct {
		ip  string
		pos Pos
	}
	macs := map[string]Pos{}
	ports := map[int][]bound{}
	for i := range zones {
		z := &zones[i]
		d := &z.Device
		if !d.Present() {
			continue
		}
		if d.Name == "" {
			d.Name = z.ID
		}
		if d.Port == 0 {
			d.Port = DefaultDevicePort
		}
		if d.Port < 0 || d.Port > 65535 {
			v.errorf(d.Pos, "zone %q: device port %d is out of range", z.ID, d.Port)
		}
		ip := net.ParseIP(d.IP)
		if d.IP != "" && ip == nil {
			v.errorf(d.Pos, "zone %q: device ip %q is not an IP address", z.ID, d.IP)
		}
		hw, err := net.ParseMAC(d.MAC)
		switch {
		case d.MAC == "":
			v.errorf(d.Pos, "zone %q: device needs a mac (Home Assistant identifies devices by it)", z.ID)
		case err != nil || len(hw) != 6:
			v.errorf(d.Pos, "zone %q: device mac %q: want six hex bytes like 02:00:00:00:00:01", z.ID, d.MAC)
		default:
			if prev, dup := macs[hw.String()]; dup {
				v.errorf(d.Pos, "zone %q: device mac %s is already used at %s; every device needs its own", z.ID, d.MAC, prev)
			}
			macs[hw.String()] = d.Pos
		}
		// Empty and unspecified IPs listen on every address. Compare
		// canonical IPs so alternate spellings cannot share a bind.
		bindIP := d.IP
		if ip != nil {
			bindIP = ip.String()
			if ip.IsUnspecified() {
				bindIP = ""
			}
		}
		for _, b := range ports[d.Port] {
			if b.ip == bindIP || b.ip == "" || bindIP == "" {
				v.errorf(d.Pos, "zone %q: device %s clashes with the device at %s", z.ID,
					net.JoinHostPort(d.IP, strconv.Itoa(d.Port)), b.pos)
				break
			}
		}
		ports[d.Port] = append(ports[d.Port], bound{bindIP, d.Pos})
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
		v.flow(&c.Flows[i])
	}
	for i := range c.Mappings {
		v.mapping(&c.Mappings[i])
	}
}

// flow fills a flow's defaults and checks it on its own.
func (v *validator) flow(f *Flow) {
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
			v.errorf(p.Pos, "pin u must be in meters, not px")
		}
	}
}

// mapping fills a non-flow mapping's defaults and checks it on its own.
func (v *validator) mapping(m *Mapping) {
	if m.Kind == KindFlow {
		v.errorf(m.Pos, "declare flows under `flows:`")
		return
	}
	v.oneOf(m.Pos, "kind", &m.Kind, KindLocal, KindIndex, KindAxis, KindRadial, KindRoute, KindPlan, KindAngular)
	switch m.Kind {
	case KindAngular:
		if m.Center == nil {
			v.errorf(m.Pos, "angular mapping %q: missing center", m.ID)
		}
		if m.Lap == nil {
			m.Lap = &units.Length{Value: 10}
		} else if m.Lap.PX || !(m.Lap.Value > 0) {
			v.errorf(m.Pos, "angular mapping %q: lap must be a positive length in meters", m.ID)
		}
	case KindAxis:
		given := 0
		for _, set := range []bool{m.Angle != nil, m.Direction != nil, m.To != nil} {
			if set {
				given++
			}
		}
		if given != 1 {
			v.errorf(m.Pos, "axis mapping %q: give one of angle, direction or from+to", m.ID)
		}
		if m.Direction != nil {
			if len(m.Direction) != 3 {
				v.errorf(m.Pos, "axis mapping %q: direction wants [x, y, z]", m.ID)
			} else if m.Direction[0] == 0 && m.Direction[1] == 0 && m.Direction[2] == 0 {
				v.errorf(m.Pos, "axis mapping %q: direction can't be [0, 0, 0]", m.ID)
			}
		}
		if m.To != nil && m.From == nil {
			v.errorf(m.Pos, "axis mapping %q: to needs from", m.ID)
		}
	case KindRadial:
		if m.Center == nil {
			v.errorf(m.Pos, "radial mapping %q: missing center", m.ID)
		}
	case KindRoute:
		if len(m.Points) < 2 {
			v.errorf(m.Pos, "route mapping %q: want at least two points", m.ID)
		}
		if m.Closed == nil {
			t := true
			m.Closed = &t
		}
		if m.SpillSpeed == nil {
			one := 1.0
			m.SpillSpeed = &one
		} else if !(*m.SpillSpeed > 0) {
			v.errorf(m.Pos, "route mapping %q: spill_speed must be positive", m.ID)
		}
		for _, f := range []struct {
			name string
			l    **units.Length
			def  float64
		}{{"snap", &m.Snap, 0.15}, {"spread", &m.Spread, 0.5}, {"lap", &m.Lap, 0}} {
			if *f.l == nil {
				if f.def > 0 {
					*f.l = &units.Length{Value: f.def}
				}
				continue
			}
			if (*f.l).PX {
				v.errorf(m.Pos, "route mapping %q: %s must be in meters, not px", m.ID, f.name)
			}
			if (*f.l).Value < 0 || f.name == "lap" && (*f.l).Value == 0 {
				v.errorf(m.Pos, "route mapping %q: %s must be positive", m.ID, f.name)
			}
		}
	}
	if m.Kind != KindRoute && (m.Points != nil || m.Closed != nil || m.Snap != nil || m.Spread != nil || m.SpillSpeed != nil) {
		v.errorf(m.Pos, "mapping %q: points, closed, snap, spread and spill_speed apply only to route mappings", m.ID)
	}
	if m.Kind != KindRoute && m.Kind != KindAngular && m.Lap != nil {
		v.errorf(m.Pos, "mapping %q: lap applies only to route and angular mappings", m.ID)
	}
	if m.Horizontal && m.Kind != KindRadial {
		v.errorf(m.Pos, "mapping %q: horizontal applies only to radial mappings", m.ID)
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

func (v *validator) shows(ss []Show) {
	unique(v, "show", ss, func(s *Show) (string, Pos) { return s.ID, s.Pos })
	for i := range ss {
		s := &ss[i]
		if len(s.Cues) == 0 {
			v.errorf(s.Pos, "show %q has no cues", s.ID)
		}
		if s.Length != "" {
			if d, err := units.ParseDuration(s.Length); err != nil || d < 0 {
				v.errorf(s.Pos, "show %q: length: want a duration like \"3 min\"", s.ID)
			}
		}
		for j := range s.Cues {
			c := &s.Cues[j]
			v.required(c.Pos, "effect", c.Effect)
			for _, f := range []struct{ name, val string }{{"at", c.At}, {"for", c.For}, {"fade_in", c.FadeIn}, {"fade_out", c.FadeOut}} {
				if f.val == "" {
					continue
				}
				if d, err := units.ParseDuration(f.val); err != nil || d < 0 {
					v.errorf(c.Pos, "show %q: %s: want a duration like \"12 s\"", s.ID, f.name)
				}
			}
			if c.Mapping != nil {
				switch m := c.Mapping.(type) {
				case string:
				case map[string]any:
					if _, err := ParseInlineMapping(m); err != nil {
						v.errorf(c.Pos, "show %q: %v", s.ID, err)
					}
				default:
					v.errorf(c.Pos, "show %q: mapping: want a mapping id or an inline mapping", s.ID)
				}
			}
			if c.Blend != "" {
				v.oneOf(c.Pos, "blend", &c.Blend, "over", "replace", "add", "max", "multiply")
			}
			if c.Opacity != nil && (*c.Opacity < 0 || *c.Opacity > 1) {
				v.errorf(c.Pos, "opacity %v is outside 0–1", *c.Opacity)
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
