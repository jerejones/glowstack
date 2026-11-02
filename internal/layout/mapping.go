// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"fmt"
	"math"
	"slices"

	"github.com/jerejones/glowstack/internal/config"
)

// Mapping is a solved mapping: one coordinate per global pixel id.
//
// U is the mapping's coordinate, in meters except for `index` (0–1). Pixels
// outside the mapping's domain have U = NaN; layers using this mapping paint them
// black (see render). Plan positions (x, y)
// are a property of the pixel, not the mapping: read them from
// Layout.Pixels. A `plan` mapping's U is the plan x.
//
// Stretch is dl/du per pixel: physical meters per meter of u. It's 1
// everywhere except in flows. The pixel's physical size dl is in
// Layout.Pixels.
type Mapping struct {
	ID      string
	Kind    string // flow | local | index | axis | radial | plan
	U       []float32
	Stretch []float32
	Flow    *FlowInfo // flows only
}

// FlowInfo is the solved state of a flow, for the live map and reports.
type FlowInfo struct {
	Origin      int       // node index
	NodeU       []float64 // u per node; NaN if unreached
	EdgeStretch []float64 // stretch per edge (strip and gap); NaN if unreached or a link
	EdgeMode    []string  // per edge: "", "flow", "meet", "unreached"
	Unreached   []string  // ids of runs with no path from the origin
}

// Mappings is the set of solved mappings.
type Mappings struct {
	Default  string
	Warnings config.Errors
	byID     map[string]*Mapping
	order    []string
}

// Get returns the mapping with the given id.
func (m *Mappings) Get(id string) (*Mapping, bool) {
	mp, ok := m.byID[id]
	return mp, ok
}

// IDs lists mapping ids: built-ins first, then config order.
func (m *Mappings) IDs() []string { return slices.Clone(m.order) }

// SolveMappings solves every mapping in cfg plus the built-ins (`local`,
// `index`, `plan`). Mappings are solved at load time, never per frame.
func SolveMappings(l *Layout, cfg *config.Config) (*Mappings, error) {
	ms := &Mappings{Default: cfg.DefaultMapping, byID: map[string]*Mapping{}}
	if ms.Default == "" {
		ms.Default = config.MappingLocal
	}
	var errs config.Errors
	add := func(m *Mapping) {
		ms.byID[m.ID] = m
		ms.order = append(ms.order, m.ID)
	}
	for _, kind := range []string{config.MappingLocal, config.MappingIndex, config.MappingPlan} {
		m, err := SolveSpatial(l, &config.Mapping{ID: kind, Kind: kind})
		if err != nil {
			return nil, err
		}
		add(m)
	}
	for i := range cfg.Flows {
		m, warn, err := SolveFlow(l, &cfg.Flows[i])
		ms.Warnings = append(ms.Warnings, warn...)
		if err != nil {
			errs = append(errs, asErrors(err, cfg.Flows[i].Pos)...)
			continue
		}
		add(m)
	}
	for i := range cfg.Mappings {
		m, err := SolveSpatial(l, &cfg.Mappings[i])
		if err != nil {
			errs = append(errs, asErrors(err, cfg.Mappings[i].Pos)...)
			continue
		}
		add(m)
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return ms, nil
}

func asErrors(err error, pos config.Pos) config.Errors {
	switch e := err.(type) {
	case config.Errors:
		return e
	case *config.Error:
		return config.Errors{e}
	default:
		return config.Errors{config.Errorf(pos, "%v", err)}
	}
}

func newCoords(n int, fill float32) []float32 {
	s := make([]float32, n)
	for i := range s {
		s[i] = fill
	}
	return s
}

var nan32 = float32(math.NaN())

// SolveSpatial solves a non-flow mapping. It also serves inline mappings
// from the API.
func SolveSpatial(l *Layout, m *config.Mapping) (*Mapping, error) {
	n := len(l.Pixels)
	out := &Mapping{ID: m.ID, Kind: m.Kind, U: newCoords(n, nan32), Stretch: newCoords(n, 1)}
	switch m.Kind {
	case config.KindLocal:
		for i := range l.Pixels {
			if px := &l.Pixels[i]; px.Run >= 0 {
				out.U[i] = px.RunDist
			}
		}
	case config.KindIndex:
		order := make([]int, 0, len(l.Runs))
		for _, id := range m.Order {
			ri, ok := l.runByID[id]
			if !ok {
				return nil, config.Errorf(m.Pos, "index mapping %s: unknown run %q", m.ID, id)
			}
			if slices.Contains(order, ri) {
				return nil, config.Errorf(m.Pos, "index mapping %s: run %q listed twice", m.ID, id)
			}
			order = append(order, ri)
		}
		for ri := range l.Runs {
			if !slices.Contains(order, ri) {
				order = append(order, ri)
			}
		}
		total := 0
		for _, ri := range order {
			total += l.Runs[ri].Count
		}
		denom := float32(max(total-1, 1))
		ord := 0
		for _, ri := range order {
			r := &l.Runs[ri]
			for k := range r.Count {
				out.U[r.Pixel(l, k)] = float32(ord) / denom
				ord++
			}
		}
	case config.KindPlan:
		for i := range l.Pixels {
			out.U[i] = l.Pixels[i].X
		}
	case config.KindAxis:
		var o vec
		if m.From != nil {
			var err error
			if o, _, err = l.point(m.From); err != nil {
				return nil, err
			}
		}
		var d vec
		switch {
		case m.Angle != nil:
			a := float64(*m.Angle)
			d = vec{math.Cos(a), math.Sin(a), 0}
			if !l.HasScene() {
				d[1] = -d[1] // plan y points down
			}
		case m.Direction != nil:
			d = vec{m.Direction[0], m.Direction[1], m.Direction[2]}
		default:
			to, toZ, err := l.point(m.To)
			if err != nil {
				return nil, err
			}
			_, fromZ, _ := l.point(m.From)
			d = to.sub(o)
			if !fromZ || !toZ {
				d[2] = 0 // a point without height gives a horizontal direction
			}
			if d.len() == 0 {
				return nil, config.Errorf(m.Pos, "axis mapping %s: from and to are the same point", m.ID)
			}
		}
		d = d.scale(1 / d.len())
		for i := range l.Pixels {
			if px := &l.Pixels[i]; px.HasPlan() {
				out.U[i] = float32(px.pos().sub(o).dot(d))
			}
		}
	case config.KindRadial:
		c, cz, err := l.point(m.Center)
		if err != nil {
			return nil, err
		}
		flat := m.Horizontal || !cz
		for i := range l.Pixels {
			if px := &l.Pixels[i]; px.HasPlan() {
				r := px.pos().sub(c)
				if flat {
					r[2] = 0
				}
				out.U[i] = float32(r.len())
			}
		}
	default:
		return nil, config.Errorf(m.Pos, "mapping %s: unknown kind %q", m.ID, m.Kind)
	}
	return out, nil
}

// vec is a position or direction in meters, Z up.
type vec [3]float64

func (a vec) sub(b vec) vec       { return vec{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func (a vec) dot(b vec) float64   { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }
func (a vec) scale(k float64) vec { return vec{a[0] * k, a[1] * k, a[2] * k} }
func (a vec) len() float64        { return math.Sqrt(a.dot(a)) }
func (p *Pixel) pos() vec         { return vec{float64(p.X), float64(p.Y), float64(p.Z)} }

// HasScene reports whether positions come from a scene model.
func (l *Layout) HasScene() bool { return len(l.Plans) > 0 && l.Plans[0].IsScene() }

// point resolves a point reference to meters. hasZ is false for an
// explicit [x, y] point, which has no height.
func (l *Layout) point(p *config.PointRef) (v vec, hasZ bool, err error) {
	if p.Node == "" {
		return vec{p.X.Value, p.Y.Value, p.Z.Value}, p.HasZ, nil
	}
	ni, ok := l.nodeByID[p.Node]
	if !ok {
		return v, false, config.Errorf(p.Pos, "unknown node %q", p.Node)
	}
	n := &l.Nodes[ni]
	if n.Plan < 0 {
		return v, false, config.Errorf(p.Pos, "node %q has no position (no drawn run passes it)", p.Node)
	}
	return vec{n.X, n.Y, n.Z}, true, nil
}

// Describe summarises the mapping for logs.
func (m *Mapping) Describe(l *Layout) string {
	in, lo, hi := 0, math.Inf(1), math.Inf(-1)
	for _, u := range m.U {
		if !math.IsNaN(float64(u)) {
			in++
			lo, hi = math.Min(lo, float64(u)), math.Max(hi, float64(u))
		}
	}
	s := fmt.Sprintf("%s (%s): %d pixels", m.ID, m.Kind, in)
	if in > 0 {
		s += fmt.Sprintf(", u %.2f…%.2f", lo, hi)
	}
	if m.Flow != nil {
		smin, smax := math.Inf(1), math.Inf(-1)
		for _, st := range m.Flow.EdgeStretch {
			if !math.IsNaN(st) {
				smin, smax = math.Min(smin, st), math.Max(smax, st)
			}
		}
		if smin <= smax {
			s += fmt.Sprintf(", stretch %.2f…%.2f", smin, smax)
		}
		if len(m.Flow.Unreached) > 0 {
			s += fmt.Sprintf(", unreached runs %v", m.Flow.Unreached)
		}
	}
	return s
}
