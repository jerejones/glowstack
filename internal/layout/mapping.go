// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"fmt"
	"math"
	"slices"

	"github.com/jerejones/glowstack/internal/color"
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
// everywhere except in flows and routes with a `lap`. The pixel's physical
// size dl is in Layout.Pixels.
//
// Gain, when not nil, is a per-pixel brightness factor (linear light, 0–1)
// that the compositor applies to whatever the layer's effect draws. Spill,
// when not nil, is each pixel's distance off the path in meters: 0 on it,
// more on a crossing strip. Only routes set them, to fade their spill and
// to let effects draw it differently (chase's spill_tail).
type Mapping struct {
	ID      string
	Kind    string // flow | local | index | axis | radial | route | plan
	U       []float32
	Stretch []float32
	Gain    []float32
	Spill   []float32
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
	case config.KindRoute:
		if err := l.solveRoute(m, out); err != nil {
			return nil, err
		}
	case config.KindAngular:
		// u is the bearing of the pixel around a vertical axis through
		// center, counter-clockwise seen from above, scaled so one full
		// turn covers `lap` meters of u; u = 0 at `angle` (default +x).
		// Stretch is the physical circumference per lap at each pixel's
		// radius, so physical lengths convert.
		c, _, err := l.point(m.Center)
		if err != nil {
			return nil, err
		}
		lap := 10.0
		if m.Lap != nil {
			lap = m.Lap.Value
		}
		start := 0.0
		if m.Angle != nil {
			start = float64(*m.Angle)
		}
		for i := range l.Pixels {
			px := &l.Pixels[i]
			if !px.HasPlan() {
				continue
			}
			dx, dy := float64(px.X)-c[0], float64(px.Y)-c[1]
			if !l.HasScene() {
				dy = -dy // plan y points down
			}
			r := math.Hypot(dx, dy)
			a := math.Atan2(dy, dx) - start
			a -= math.Floor(a/(2*math.Pi)) * 2 * math.Pi
			out.U[i] = float32(a / (2 * math.Pi) * lap)
			out.Stretch[i] = float32(2 * math.Pi * r / lap)
		}
	default:
		return nil, config.Errorf(m.Pos, "mapping %s: unknown kind %q", m.ID, m.Kind)
	}
	return out, nil
}

// solveRoute solves a route: a path through points, open or closed. A
// pixel within `snap` of the path is on it, and its u is the distance
// along the path to its nearest point. A pixel farther away, up to
// `snap + spread`, is spill: it's on a strip that crosses or leaves the
// path, d meters past the snap distance. Its u is the nearest point's u
// plus d ÷ spill_speed, so a pattern moving forward along the path
// (towards larger u) reaches it after the crossing and leaks out along the
// crossing strip at spill_speed times its speed along the path,
// and its Gain fades with d (perceptually even, to 0 at `spread`). A
// pattern moving backwards (reverse, or a negative speed) would reach the
// spill first, so to run a route the other way, list its points in the
// other order. Everything farther is outside the domain. With `lap`, u is
// scaled so the whole path covers lap meters, which lets a pattern repeat
// seamlessly around a closed route.
func (l *Layout) solveRoute(m *config.Mapping, out *Mapping) error {
	pts := make([]vec, len(m.Points))
	flat := false
	for i := range m.Points {
		p, hasZ, err := l.point(&m.Points[i])
		if err != nil {
			return err
		}
		pts[i], flat = p, flat || !hasZ
	}
	if m.Closed == nil || *m.Closed {
		pts = append(pts, pts[0])
	}
	if flat {
		for i := range pts {
			pts[i][2] = 0 // a point without height: distances are horizontal
		}
	}
	type seg struct {
		a, d   vec // start and direction (b − a)
		s, len float64
	}
	var segs []seg
	total := 0.0
	for i := 1; i < len(pts); i++ {
		d := pts[i].sub(pts[i-1])
		if n := d.len(); n > 0 {
			segs = append(segs, seg{pts[i-1], d, total, n})
			total += n
		}
	}
	if len(segs) == 0 {
		return config.Errorf(m.Pos, "route mapping %s: the points are all in the same place", m.ID)
	}
	snap, spread := m.Snap.Value, m.Spread.Value
	k := 1.0 // u per meter along the path
	if m.Lap != nil {
		k = m.Lap.Value / total
	}
	ss := 1.0
	if m.SpillSpeed != nil {
		ss = *m.SpillSpeed
	}
	out.Gain = newCoords(len(l.Pixels), 1)
	out.Spill = newCoords(len(l.Pixels), 0)
	for i := range l.Pixels {
		px := &l.Pixels[i]
		if !px.HasPlan() {
			continue
		}
		p := px.pos()
		if flat {
			p[2] = 0
		}
		best, at := math.Inf(1), 0.0
		for _, sg := range segs {
			t := math.Max(0, math.Min(1, p.sub(sg.a).dot(sg.d)/(sg.len*sg.len)))
			if dist := p.sub(sg.a.add(sg.d.scale(t))).len(); dist < best {
				best, at = dist, sg.s+t*sg.len
			}
		}
		d := math.Max(0, best-snap)
		if d > spread || d > 0 && spread == 0 {
			continue
		}
		out.U[i] = float32((at + d/ss) * k)
		out.Stretch[i] = float32(1 / k)
		out.Spill[i] = float32(d)
		if d > 0 {
			out.Stretch[i] = float32(ss / k)
			out.Gain[i] = float32(math.Pow(1-d/spread, color.DecodeGamma))
		}
	}
	return nil
}

// vec is a position or direction in meters, Z up.
type vec [3]float64

func (a vec) add(b vec) vec       { return vec{a[0] + b[0], a[1] + b[1], a[2] + b[2]} }
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
