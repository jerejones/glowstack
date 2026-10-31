// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/plan"
	"github.com/jerejones/glowstack/internal/units"
)

// graph builds small layouts in code: one controller "c", pitch 0.1 m, so
// ten pixels make a meter and every number in the tests is hand-checkable.
type graph struct {
	t    *testing.T
	cfg  *config.Config
	next int
}

func newGraph(t *testing.T) *graph {
	return &graph{t: t, cfg: &config.Config{
		Controllers: []config.Controller{{ID: "c", Host: "192.0.2.1", Pixels: 10000}},
		Layout:      config.Layout{Pitch: units.Length{Value: 0.1}},
	}}
}

// run adds a run of n pixels along path. A path entry "a@4" anchors node a
// at the run's pixel 4 (counted in run direction). A leading "-" on the id
// reverses the run's index order.
func (g *graph) run(id string, n int, path ...string) *graph {
	first, last := g.next, g.next+n-1
	if rev, ok := strings.CutPrefix(id, "-"); ok {
		id, first, last = rev, last, first
	}
	r := config.Run{ID: id, Controller: "c", Indices: [2]int{first, last}}
	for _, p := range path {
		node, at, ok := strings.Cut(p, "@")
		r.Path = append(r.Path, node)
		if ok {
			k, _ := strconv.Atoi(at)
			idx := first + k
			if last < first {
				idx = first - k
			}
			r.Anchors = append(r.Anchors, config.Anchor{Node: node, Index: &idx})
		}
	}
	g.cfg.Layout.Runs = append(g.cfg.Layout.Runs, r)
	g.next += n
	return g
}

func (g *graph) gap(from, to string, meters float64) *graph {
	g.cfg.Layout.Edges = append(g.cfg.Layout.Edges, config.Edge{Kind: config.EdgeGap, From: from, To: to, Length: units.Length{Value: meters}})
	return g
}

func (g *graph) link(from, to string) *graph {
	g.cfg.Layout.Edges = append(g.cfg.Layout.Edges, config.Edge{Kind: config.EdgeLink, From: from, To: to})
	return g
}

func (g *graph) sync(ids ...string) *graph {
	for _, id := range ids {
		g.cfg.Layout.Nodes = append(g.cfg.Layout.Nodes, config.Node{ID: id, Sync: true})
	}
	return g
}

func (g *graph) build() *Layout {
	g.t.Helper()
	g.cfg.Controllers[0].Pixels = max(g.next, 1)
	if err := g.cfg.Validate(); err != nil {
		g.t.Fatal(err)
	}
	l, err := BuildWith(g.cfg, func(string) (*plan.Drawing, error) { panic("no plans in graph tests") })
	if err != nil {
		g.t.Fatal(err)
	}
	return l
}

// flow solves f (defaults filled in) on the graph's layout.
func (g *graph) flow(f config.Flow) (*Layout, *Mapping, config.Errors, error) {
	g.t.Helper()
	l := g.build()
	g.cfg.Flows = []config.Flow{f}
	if err := g.cfg.Validate(); err != nil {
		g.t.Fatal(err)
	}
	m, warn, err := SolveFlow(l, &g.cfg.Flows[0])
	return l, m, warn, err
}

func (g *graph) mustFlow(f config.Flow) (*Layout, *Mapping) {
	g.t.Helper()
	l, m, warn, err := g.flow(f)
	if err != nil {
		g.t.Fatal(err)
	}
	for _, w := range warn {
		g.t.Log("warning:", w)
	}
	return l, m
}

const eps = 1e-4

func approx(a, b float64) bool {
	return math.Abs(a-b) < eps || (math.IsNaN(a) && math.IsNaN(b))
}

// u returns the flow position of run id's k-th pixel.
func pixU(l *Layout, m *Mapping, run string, k int) float64 {
	ri, _ := l.RunIndex(run)
	return float64(m.U[l.Runs[ri].Pixel(l, k)])
}

func pixStretch(l *Layout, m *Mapping, run string, k int) float64 {
	ri, _ := l.RunIndex(run)
	return float64(m.Stretch[l.Runs[ri].Pixel(l, k)])
}

func nodeU(l *Layout, m *Mapping, node string) float64 {
	n, _ := l.NodeIndex(node)
	return m.Flow.NodeU[n]
}

func checkNodes(t *testing.T, l *Layout, m *Mapping, want map[string]float64) {
	t.Helper()
	for node, u := range want {
		if got := nodeU(l, m, node); !approx(got, u) {
			t.Errorf("u(%s) = %.4f, want %.4f", node, got, u)
		}
	}
}

func checkPix(t *testing.T, l *Layout, m *Mapping, run string, k int, u, stretch float64) {
	t.Helper()
	if got := pixU(l, m, run, k); !approx(got, u) {
		t.Errorf("%s[%d] u = %.4f, want %.4f", run, k, got, u)
	}
	if got := pixStretch(l, m, run, k); !approx(got, stretch) {
		t.Errorf("%s[%d] stretch = %.4f, want %.4f", run, k, got, stretch)
	}
}

func errContains(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Errorf("error = %v, want it to contain %q", err, want)
	}
}

func unitsMeters(v float64) units.Length { return units.Length{Value: v} }
