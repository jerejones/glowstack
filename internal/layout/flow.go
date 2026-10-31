// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"fmt"
	"math"
	"strings"

	"github.com/jerejones/glowstack/internal/config"
)

// Flow solving
//
// The graph is first simplified:
//
//  1. Link edges merge their nodes into one group (one sync point). Every
//     node in a group gets the same u.
//  2. Groups that can carry a u of their own become break points: the
//     origin, pinned nodes, `sync: true` nodes, linked groups, ends of
//     `orient` edges, and every group whose degree isn't 2 (junctions and
//     dead ends). Everything between two break points is a chain of strip
//     and gap edges through degree-2 nodes.
//  3. Chains between the same two break points are parallel paths and form
//     a bundle. The bundle's pace length P comes from `pace`: the reference
//     chains' length (reference), the longest, the shortest or the average.
//
// Pass 1 (pin nodes) settles break points outward from the origin and the
// explicit pins, Dijkstra-style by distance, through bundles of length P.
// Under `pace: reference`, bundles containing a reference chain are always
// taken before others, so the reference path defines u and other routes
// conform. A bundle carries u away from the end that was settled first,
// unless an `orient` override makes it flow into a node, in which case u
// increases towards that node whichever end was settled first.
//
// Pass 2 (fill edges) interpolates u along every chain between its ends'
// u. Stretch is the chain's physical length over its u span, uniform along
// the chain. A bundle that wasn't used to settle either end closes a loop.
// If its ends' u already differ by its pace length (in the right direction)
// it's simply filled. Otherwise `loops` decides: stretch it to fit, meet
// (each half flows from its nearer end at the bundle's pace, peaking where
// they meet), or error. A loop whose ends have the same u (a ring back to
// the same point) can't be stretched and always meets, with a warning under
// `loops: stretch`. A bundle between two different pins isn't a loop; it's
// stretched between them.
//
// `warp: smooth` then replaces the piecewise-linear u along each run with a
// monotone cubic (Fritsch–Carlson/PCHIP derivatives) through the u of every
// break point on the run, so speed changes gradually but every sync point
// keeps its exact u. Smoothing happens along each run; where a run ends at
// a junction, stretch may still change abruptly.

type flowChain struct {
	a, b      int // groups at the ends, traversed a→b
	edges     []int
	fwd       []bool // edge traversed From→To
	length    float64
	reference bool
	orient    int // +1: flows into b; -1: flows into a; 0: free
}

type flowBundle struct {
	a, b   int // groups; a <= b
	chains []int
	flip   []bool // chain runs b→a
	pace   float64
	orient int // in a→b terms
	hasRef bool
	tree   bool // used to settle one of its ends
}

type flowSolver struct {
	l    *Layout
	f    *config.Flow
	errs config.Errors
	warn config.Errors

	group    []int // node → group
	ngroups  int
	members  [][]int
	incident [][]incidence
	bp       []bool
	oriented map[int]int // edge → into node
	refEdge  map[int]bool

	chains  []flowChain
	bundles []flowBundle

	u             []float64 // per group
	dist          []float64
	root          []int
	settled       []bool
	smoothStretch map[int][2]float64 // per-edge local extrema after smoothing
}

type incidence struct {
	edge int
	side int // 0: edge.From is in this group; 1: edge.To
}

// SolveFlow solves one flow mapping. It returns warnings (for example
// max_stretch exceeded) separately from errors.
func SolveFlow(l *Layout, f *config.Flow) (*Mapping, config.Errors, error) {
	s := &flowSolver{l: l, f: f, oriented: map[int]int{}, refEdge: map[int]bool{}}
	origin, ok := l.nodeByID[f.Origin]
	if !ok {
		return nil, nil, config.Errorf(f.Pos, "flow %s: unknown origin node %q", f.ID, f.Origin)
	}
	s.groups()
	s.overrides()
	pins := s.pins(origin)
	if len(s.errs) > 0 {
		return nil, s.warn, s.errs
	}
	s.breakPoints(pins)
	s.buildChains()
	s.buildBundles()
	if len(s.errs) > 0 {
		return nil, s.warn, s.errs
	}
	s.settle(origin, pins)
	m := s.fill(origin)
	if len(s.errs) > 0 {
		return nil, s.warn, s.errs
	}
	return m, s.warn, nil
}

func (s *flowSolver) errorf(pos config.Pos, format string, args ...any) {
	s.errs = append(s.errs, config.Errorf(pos, "flow "+s.f.ID+": "+format, args...))
}

func (s *flowSolver) warnf(format string, args ...any) {
	s.warn = append(s.warn, config.Errorf(s.f.Pos, "flow "+s.f.ID+": "+format, args...))
}

// groups merges link-connected nodes.
func (s *flowSolver) groups() {
	n := len(s.l.Nodes)
	parent := make([]int, n)
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for _, e := range s.l.Edges {
		if e.Kind == Link {
			parent[find(e.From)] = find(e.To)
		}
	}
	s.group = make([]int, n)
	ids := map[int]int{}
	for i := range n {
		r := find(i)
		g, ok := ids[r]
		if !ok {
			g = len(ids)
			ids[r] = g
			s.members = append(s.members, nil)
		}
		s.group[i] = g
		s.members[g] = append(s.members[g], i)
	}
	s.ngroups = len(ids)
	s.incident = make([][]incidence, s.ngroups)
	for ei, e := range s.l.Edges {
		if e.Kind == Link {
			continue
		}
		s.incident[s.group[e.From]] = append(s.incident[s.group[e.From]], incidence{ei, 0})
		s.incident[s.group[e.To]] = append(s.incident[s.group[e.To]], incidence{ei, 1})
	}
}

// edgesBetween lists strip and gap edges joining nodes a and b.
func (s *flowSolver) edgesBetween(a, b int) []int {
	var out []int
	for _, ei := range s.l.Nodes[a].Edges {
		e := &s.l.Edges[ei]
		if e.Kind != Link && ((e.From == a && e.To == b) || (e.From == b && e.To == a)) {
			out = append(out, ei)
		}
	}
	return out
}

func (s *flowSolver) overrides() {
	node := func(pos config.Pos, id string) (int, bool) {
		n, ok := s.l.nodeByID[id]
		if !ok {
			s.errorf(pos, "unknown node %q", id)
		}
		return n, ok
	}
	for _, o := range s.f.Orient {
		a, ok1 := node(o.Pos, o.Edge[0])
		b, ok2 := node(o.Pos, o.Edge[1])
		into, ok3 := node(o.Pos, o.Into)
		if !ok1 || !ok2 || !ok3 {
			continue
		}
		edges := s.edgesBetween(a, b)
		if len(edges) == 0 {
			s.errorf(o.Pos, "orient: no edge between %q and %q", o.Edge[0], o.Edge[1])
		}
		for _, ei := range edges {
			s.oriented[ei] = into
		}
	}
	for _, r := range s.f.Reference {
		if r.Run != "" {
			ri, ok := s.l.runByID[r.Run]
			if !ok {
				s.errorf(r.Pos, "reference: unknown run %q", r.Run)
				continue
			}
			for _, ei := range s.l.Runs[ri].Edges {
				s.refEdge[ei] = true
			}
			continue
		}
		a, ok1 := node(r.Pos, r.From)
		b, ok2 := node(r.Pos, r.To)
		if !ok1 || !ok2 {
			continue
		}
		edges := s.edgesBetween(a, b)
		if len(edges) == 0 {
			s.errorf(r.Pos, "reference: no edge between %q and %q", r.From, r.To)
		}
		for _, ei := range edges {
			s.refEdge[ei] = true
		}
	}
}

type flowPin struct {
	u   float64
	pin int // 0 for the origin, i+1 for pin i
}

// pins collects the settled-at-start groups: the origin and explicit pins.
func (s *flowSolver) pins(origin int) map[int]flowPin {
	pins := map[int]flowPin{s.group[origin]: {0, 0}}
	for i, p := range s.f.Pin {
		n, ok := s.l.nodeByID[p.Node]
		if !ok {
			s.errorf(p.Pos, "pin: unknown node %q", p.Node)
			continue
		}
		g := s.group[n]
		if prev, dup := pins[g]; dup && prev.u != p.U.Value {
			s.errorf(p.Pos, "pin: node %q is linked to a node pinned at a different u", p.Node)
			continue
		}
		pins[g] = flowPin{p.U.Value, i + 1}
	}
	return pins
}

func (s *flowSolver) breakPoints(pins map[int]flowPin) {
	s.bp = make([]bool, s.ngroups)
	for g := range s.ngroups {
		_, pinned := pins[g]
		s.bp[g] = pinned || len(s.incident[g]) != 2 || len(s.members[g]) > 1
		for _, n := range s.members[g] {
			if s.l.Nodes[n].Sync {
				s.bp[g] = true
			}
		}
	}
	for ei := range s.oriented {
		e := &s.l.Edges[ei]
		s.bp[s.group[e.From]], s.bp[s.group[e.To]] = true, true
	}
}

func (s *flowSolver) buildChains() {
	visited := make([]bool, len(s.l.Edges))
	walk := func(start int, inc incidence) {
		c := flowChain{a: start}
		g := start
		for {
			e := &s.l.Edges[inc.edge]
			visited[inc.edge] = true
			fwd := inc.side == 0
			c.edges = append(c.edges, inc.edge)
			c.fwd = append(c.fwd, fwd)
			c.length += e.Length
			if s.refEdge[inc.edge] {
				c.reference = true
			}
			if into, ok := s.oriented[inc.edge]; ok {
				arrive := e.To
				if !fwd {
					arrive = e.From
				}
				dir := -1
				if into == arrive {
					dir = 1
				}
				if c.orient != 0 && c.orient != dir {
					s.errorf(s.f.Pos, "orient overrides on %s disagree", e.Name(s.l))
				}
				c.orient = dir
			}
			other := e.To
			if !fwd {
				other = e.From
			}
			g = s.group[other]
			if s.bp[g] {
				break
			}
			// A degree-2 group: leave by its other incidence.
			arrived := incidence{inc.edge, 1 - inc.side}
			for _, next := range s.incident[g] {
				if next != arrived {
					inc = next
					break
				}
			}
		}
		c.b = g
		s.chains = append(s.chains, c)
	}
	for {
		for g := range s.ngroups {
			if !s.bp[g] {
				continue
			}
			for _, inc := range s.incident[g] {
				if !visited[inc.edge] {
					walk(g, inc)
				}
			}
		}
		// Rings with no break point: make one and go again.
		done := true
		for ei, e := range s.l.Edges {
			if e.Kind != Link && !visited[ei] {
				s.bp[s.group[e.From]] = true
				done = false
				break
			}
		}
		if done {
			return
		}
	}
}

func (s *flowSolver) buildBundles() {
	byPair := map[[2]int]int{}
	for ci, c := range s.chains {
		a, b, flip := c.a, c.b, false
		if b < a {
			a, b, flip = b, a, true
		}
		bi, ok := byPair[[2]int{a, b}]
		if !ok {
			bi = len(s.bundles)
			byPair[[2]int{a, b}] = bi
			s.bundles = append(s.bundles, flowBundle{a: a, b: b})
		}
		bd := &s.bundles[bi]
		bd.chains = append(bd.chains, ci)
		bd.flip = append(bd.flip, flip)
		o := c.orient
		if flip {
			o = -o
		}
		if o != 0 && a != b {
			if bd.orient != 0 && bd.orient != o {
				s.errorf(s.f.Pos, "parallel paths between %s and %s are oriented in opposite directions", s.groupName(a), s.groupName(b))
			}
			bd.orient = o
		}
		if c.reference {
			bd.hasRef = true
		}
	}
	for bi := range s.bundles {
		bd := &s.bundles[bi]
		var sum, refSum, lo, hi float64 = 0, 0, math.Inf(1), math.Inf(-1)
		nref := 0
		for _, ci := range bd.chains {
			L := s.chains[ci].length
			sum += L
			lo, hi = math.Min(lo, L), math.Max(hi, L)
			if s.chains[ci].reference {
				refSum += L
				nref++
			}
		}
		switch s.f.Pace {
		case config.PaceLongest:
			bd.pace = hi
		case config.PaceShortest:
			bd.pace = lo
		case config.PaceReference:
			if nref > 0 {
				bd.pace = refSum / float64(nref)
				break
			}
			// No reference chain in this bundle: fall back to the average.
			fallthrough
		default:
			bd.pace = sum / float64(len(bd.chains))
		}
	}
}

// groupName names a group by its nodes, for messages.
func (s *flowSolver) groupName(g int) string {
	var ids []string
	for _, n := range s.members[g] {
		ids = append(ids, s.l.Nodes[n].ID)
	}
	return strings.Join(ids, "=")
}

// settle is pass 1: give every reachable break point its u.
func (s *flowSolver) settle(origin int, pins map[int]flowPin) {
	n := s.ngroups
	s.u, s.dist, s.root, s.settled = make([]float64, n), make([]float64, n), make([]int, n), make([]bool, n)
	for g := range n {
		s.u[g], s.dist[g], s.root[g] = math.NaN(), math.Inf(1), -1
	}
	for g, p := range pins {
		s.u[g], s.dist[g], s.root[g], s.settled[g] = p.u, 0, p.pin, true
	}
	preferRef := s.f.Pace == config.PaceReference
	for {
		best, bestFrom := -1, -1
		bestRef, bestDist := false, math.Inf(1)
		for bi := range s.bundles {
			bd := &s.bundles[bi]
			if bd.a == bd.b || s.settled[bd.a] == s.settled[bd.b] {
				continue
			}
			from := bd.a
			if s.settled[bd.b] {
				from = bd.b
			}
			ref := preferRef && bd.hasRef
			d := s.dist[from] + bd.pace
			if best < 0 || (ref && !bestRef) || (ref == bestRef && d < bestDist) {
				best, bestFrom, bestRef, bestDist = bi, from, ref, d
			}
		}
		if best < 0 {
			return
		}
		bd := &s.bundles[best]
		to, sign := bd.b, 1.0
		if bestFrom == bd.b {
			to = bd.a
			if bd.orient == 1 { // flows into b, which is where we start
				sign = -1
			}
		} else if bd.orient == -1 {
			sign = -1
		}
		s.u[to] = s.u[bestFrom] + sign*bd.pace
		s.dist[to], s.root[to], s.settled[to] = bestDist, s.root[bestFrom], true
		bd.tree = true
	}
}

// fill is pass 2: u and stretch for every pixel.
func (s *flowSolver) fill(origin int) *Mapping {
	l := s.l
	n := len(l.Pixels)
	m := &Mapping{ID: s.f.ID, Kind: config.KindFlow, U: newCoords(n, nan32), Stretch: newCoords(n, 1)}
	info := &FlowInfo{
		Origin:      origin,
		NodeU:       make([]float64, len(l.Nodes)),
		EdgeStretch: make([]float64, len(l.Edges)),
		EdgeMode:    make([]string, len(l.Edges)),
	}
	m.Flow = info
	for i := range info.NodeU {
		info.NodeU[i] = s.u[s.group[i]]
	}
	for i := range info.EdgeStretch {
		info.EdgeStretch[i] = math.NaN()
	}
	tol := func(x float64) float64 { return 1e-6 * math.Max(1, math.Abs(x)) }

	for bi := range s.bundles {
		bd := &s.bundles[bi]
		if !s.settled[bd.a] {
			for _, ci := range bd.chains {
				for _, ei := range s.chains[ci].edges {
					info.EdgeMode[ei] = "unreached"
				}
			}
			continue
		}
		ua, ub := s.u[bd.a], s.u[bd.b]
		delta := ub - ua
		meet := false
		switch {
		case bd.tree:
		case s.root[bd.a] != s.root[bd.b]:
			// Between two different pins: stretched to fit.
			if math.Abs(delta) < tol(bd.pace) {
				s.warnf("%s and %s are pinned to the same u; the path between them meets in the middle", s.groupName(bd.a), s.groupName(bd.b))
				meet = true
			}
		default:
			consistent := false
			switch bd.orient {
			case 0:
				consistent = math.Abs(math.Abs(delta)-bd.pace) < tol(bd.pace)
			default:
				consistent = math.Abs(delta-float64(bd.orient)*bd.pace) < tol(bd.pace)
			}
			if consistent || bd.a == bd.b && bd.pace == 0 {
				break
			}
			where := s.bundleName(bd)
			switch s.f.Loops {
			case config.LoopsError:
				s.errorf(s.f.Pos, "loop: %s is reached from both ends (u %.3f and %.3f, length %.3f m); set loops: stretch or meet", where, ua, ub, bd.pace)
				continue
			case config.LoopsMeet:
				meet = true
			default:
				if math.Abs(delta) < tol(bd.pace) {
					s.warnf("loop: %s starts and ends at the same u, so it can't be stretched; it meets in the middle instead", where)
					meet = true
				}
			}
		}
		for i, ci := range bd.chains {
			c := &s.chains[ci]
			cu0, cu1 := ua, ub
			if bd.flip[i] {
				cu0, cu1 = ub, ua
			}
			s.fillChain(m, c, cu0, cu1, bd.pace, meet)
		}
	}

	if s.f.Warp == config.WarpSmooth {
		s.smooth(m)
	}

	// Unreached runs.
	for ri := range l.Runs {
		r := &l.Runs[ri]
		if info.EdgeMode[r.Edges[0]] != "unreached" {
			continue
		}
		info.Unreached = append(info.Unreached, r.ID)
		if s.f.Unreached != config.UnreachedLocal {
			continue
		}
		for k := range r.Count {
			g := r.Pixel(l, k)
			m.U[g] = l.Pixels[g].RunDist
		}
	}
	if len(info.Unreached) > 0 && s.f.Unreached == config.UnreachedError {
		s.errorf(s.f.Pos, "runs %v have no path from origin %s; link them or set unreached: local or dark", info.Unreached, s.f.Origin)
	}

	// Limits.
	if s.f.MaxStretch >= 1 {
		for ci := range s.chains {
			c := &s.chains[ci]
			st := info.EdgeStretch[c.edges[0]]
			// A smooth spline can exceed the limit between knots even when
			// the chain's average stretch is within it.
			for _, ei := range c.edges {
				if bounds, ok := s.smoothStretch[ei]; ok {
					if bounds[1] > s.f.MaxStretch*(1+1e-9) {
						st = bounds[1]
					} else if bounds[0] < 1/s.f.MaxStretch*(1-1e-9) {
						st = bounds[0]
					}
				}
			}
			if math.IsNaN(st) || (st <= s.f.MaxStretch*(1+1e-9) && st >= 1/s.f.MaxStretch*(1-1e-9)) {
				continue
			}
			names := make([]string, len(c.edges))
			for i, ei := range c.edges {
				names[i] = l.Edges[ei].Name(l)
			}
			msg := fmt.Sprintf("stretch %.2f on %s exceeds max_stretch %.2f; check the anchors", st, strings.Join(names, ", "), s.f.MaxStretch)
			if s.f.Strict {
				s.errorf(s.f.Pos, "%s", msg)
			} else {
				s.warnf("%s", msg)
			}
		}
	}
	return m
}

func (s *flowSolver) bundleName(bd *flowBundle) string {
	var parts []string
	for _, ci := range bd.chains {
		for _, ei := range s.chains[ci].edges {
			parts = append(parts, s.l.Edges[ei].Name(s.l))
		}
	}
	return strings.Join(parts, ", ")
}

// fillChain sets u along a chain whose ends have u0 (at c.a) and u1 (at
// c.b). With meet, each end flows outward at the bundle's pace and the
// smaller u wins.
func (s *flowSolver) fillChain(m *Mapping, c *flowChain, u0, u1, pace float64, meet bool) {
	l, info := s.l, m.Flow
	L := c.length
	uAt := func(d float64) float64 {
		if meet {
			k := pace / L
			return math.Min(u0+d*k, u1+(L-d)*k)
		}
		if L == 0 {
			return u0
		}
		return u0 + (u1-u0)*d/L
	}
	stretch := L / math.Abs(u1-u0)
	mode := "flow"
	if meet {
		stretch, mode = L/pace, "meet"
	}
	if L == 0 || math.IsInf(stretch, 0) {
		stretch = math.NaN()
	}
	start := 0.0
	for i, ei := range c.edges {
		e := &l.Edges[ei]
		info.EdgeStretch[ei], info.EdgeMode[ei] = stretch, mode
		for _, g := range e.Pixels {
			d := float64(l.Pixels[g].Dist)
			if !c.fwd[i] {
				d = e.Length - d
			}
			m.U[g] = float32(uAt(start + d))
			if !math.IsNaN(stretch) {
				m.Stretch[g] = float32(stretch)
			}
		}
		start += e.Length
		// Interior nodes of the chain.
		if i+1 < len(c.edges) {
			end := e.To
			if !c.fwd[i] {
				end = e.From
			}
			info.NodeU[end] = uAt(start)
		}
	}
}
