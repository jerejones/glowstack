// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"math"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/plan"
)

const (
	exampleConfig = "../../examples/fictional/config"
	exampleData   = "../../examples/fictional/data"
)

func loadExample(t *testing.T, dataDir string) (*config.Config, *Layout, *Mappings) {
	t.Helper()
	cfg, err := config.Load(exampleConfig, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	l, err := Build(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ms, err := SolveMappings(l, cfg)
	if err != nil {
		t.Fatal(err)
	}
	return cfg, l, ms
}

func anchorOf(t *testing.T, l *Layout, run, node string) Anchor {
	t.Helper()
	ri, _ := l.RunIndex(run)
	n, _ := l.NodeIndex(node)
	for _, a := range l.Runs[ri].Anchors {
		if a.Node == n {
			return a
		}
	}
	t.Fatalf("no anchor %s on %s", node, run)
	return Anchor{}
}

func TestExampleAnchors(t *testing.T) {
	// Without the data folder: shed-sw is estimated from the drawing,
	// piecewise between the run start and the measured shed-nw (305). It
	// is 120 of the 200 drawn units to shed-nw, so cell 0.6 × 305.5 =
	// 183.3, the centre of pixel 183.
	_, l, _ := loadExample(t, "")
	if a := anchorOf(t, l, "shed-eave", "shed-sw"); a.Index != 183 || a.Source != SourceEstimated {
		t.Errorf("shed-sw = %+v", a)
	}
	// shed-eave-mid is halfway along the drawn 305.5…482 stretch.
	if a := anchorOf(t, l, "shed-eave", "shed-eave-mid"); a.Index != 393 || a.Source != SourceEstimated {
		t.Errorf("mid = %+v", a)
	}
	// The tower's path comes from the drawing's labels; its top is halfway.
	if a := anchorOf(t, l, "tower", "tower-top"); a.Index != 544 || a.Source != SourceEstimated {
		t.Errorf("tower-top = %+v", a)
	}
	// With the data folder, anchors.yaml measures shed-sw.
	_, l, _ = loadExample(t, exampleData)
	if a := anchorOf(t, l, "shed-eave", "shed-sw"); a.Index != 186 || a.Source != SourceMeasured {
		t.Errorf("measured shed-sw = %+v", a)
	}
	if a := anchorOf(t, l, "shed-eave", "shed-eave-mid"); a.Index != 393 {
		t.Errorf("mid after measuring = %+v", a)
	}
}

func TestExamplePixelTable(t *testing.T) {
	_, l, _ := loadExample(t, exampleData)
	if len(l.Pixels) != 604+480 {
		t.Fatalf("pixels = %d", len(l.Pixels))
	}
	shed, yard := l.Controllers[0], l.Controllers[1]
	if shed.Base != 0 || yard.Base != 604 {
		t.Errorf("bases %d %d", shed.Base, yard.Base)
	}
	// Corners land on drawn corners: shed-sw at plan (100,180) × 0.05 m.
	g, _ := l.PixelID("shed", 186)
	if p := l.Pixels[g]; !approx(float64(p.X), 5) || !approx(float64(p.Y), 9) {
		t.Errorf("shed-sw pixel at %v,%v", p.X, p.Y)
	}
	g, _ = l.PixelID("shed", 305)
	if p := l.Pixels[g]; !approx(float64(p.X), 5) || !approx(float64(p.Y), 5) {
		t.Errorf("shed-nw pixel at %v,%v", p.X, p.Y)
	}
	// Dead pixels are flagged and in no run.
	g, _ = l.PixelID("shed", 482)
	if p := l.Pixels[g]; !p.Dead || p.Run != -1 || p.HasPlan() {
		t.Errorf("dead pixel = %+v", p)
	}
	// The porch is wired east to west and drawn west to east (reverse).
	g, _ = l.PixelID("yard", 479)
	if p := l.Pixels[g]; !approx(float64(p.X), 8-1.0/60) || !approx(float64(p.RunDist), 1.0/60) {
		t.Errorf("porch first pixel = %+v", p)
	}
	// Edge distances: the first eave pixel after shed-sw is 1 pitch along
	// the shed-sw–shed-nw edge.
	g, _ = l.PixelID("shed", 187)
	p := l.Pixels[g]
	e := l.Edges[p.Edge]
	if l.Nodes[e.From].ID != "shed-sw" || !approx(float64(p.Dist), 1.0/30) || !approx(float64(p.Dl), 1.0/30) {
		t.Errorf("pixel 187: edge %s dist %v dl %v", e.Name(l), p.Dist, p.Dl)
	}
	if len(l.Warnings) != 0 {
		t.Errorf("warnings: %v", l.Warnings)
	}
}

func TestExampleLengthReport(t *testing.T) {
	_, l, _ := loadExample(t, exampleData)
	ri, _ := l.RunIndex("tower")
	r := &l.Runs[ri]
	if !approx(r.Length, 4) || math.Abs(r.LengthMismatch-0.118) > 0.001 {
		t.Errorf("tower length %v mismatch %v", r.Length, r.LengthMismatch)
	}
	if s := r.LengthReport(l); !strings.Contains(s, "4.00 m of pixels, 4.47 m drawn, +11.8%") {
		t.Errorf("report = %q", s)
	}
}

func TestExampleAreas(t *testing.T) {
	_, l, _ := loadExample(t, exampleData)
	sizes := map[string]int{"shed": 602, "yard": 390, "porch": 90, "shed-north": 482 - 305, "everything": 1082}
	for id, n := range sizes {
		a, ok := l.Area(id)
		if !ok || len(a.Pixels) != n {
			t.Errorf("area %s: %d pixels, want %d", id, len(a.Pixels), n)
		}
	}
	g, _ := l.PixelID("shed", 400)
	if got := strings.Join(l.AreasOf(g), ","); got != "shed,shed-north,everything" {
		t.Errorf("AreasOf = %s", got)
	}
}

func TestExampleMappings(t *testing.T) {
	_, l, ms := loadExample(t, exampleData)
	if ms.Default != "front-sweep" || len(ms.Warnings) != 0 {
		t.Errorf("default %s warnings %v", ms.Default, ms.Warnings)
	}
	f, _ := ms.Get("front-sweep")
	// The tower flows up into its top, which is linked to the eave.
	checkNodes(t, l, f, map[string]float64{"shed-se": 0, "gate-e": 9.2, "tower-top": 393.5 / 30, "tower-l": 393.5/30 - 60.5/30})
	ew, _ := ms.Get("east-west")
	g, _ := l.PixelID("shed", 305)
	if !approx(float64(ew.U[g]), 5) {
		t.Errorf("east-west at shed-nw = %v", ew.U[g])
	}
	rad, _ := ms.Get("around-gate")
	g, _ = l.PixelID("yard", 240) // first pixel past the gate, 1.2 m + half a pitch east
	if !approx(float64(rad.U[g]), 1.2+1.0/60) {
		t.Errorf("radial = %v", rad.U[g])
	}
	idx, _ := ms.Get("wled-order")
	g, _ = l.PixelID("shed", 484) // first tower pixel: 482 eave pixels come first
	if !approx(float64(idx.U[g]), 482.0/1081) {
		t.Errorf("index = %v", idx.U[g])
	}
	local, _ := ms.Get("local")
	g, _ = l.PixelID("yard", 240)
	if !approx(float64(local.U[g]), 1.0/60) {
		t.Errorf("local = %v", local.U[g])
	}
}

// svgLoader serves inline SVGs.
func svgLoader(files map[string]string) PlanLoader {
	return func(name string) (*plan.Drawing, error) {
		return plan.Parse(strings.NewReader(files[name]))
	}
}

func TestDrawingEstimatesWithoutPath(t *testing.T) {
	// A path-less run takes its nodes from the drawing; vertex b is 1/4 of
	// the way along a 40-pixel run, so it's estimated at cell 10, pixel 10
	// (cell 10 is pixel 9's far edge; round(9.5) = 10).
	g := newGraph(t).run("r", 40)
	g.cfg.Layout.Runs[0].Plan = &config.RunPlan{SVG: "p.svg#r"}
	g.cfg.Layout.Runs[0].Path = nil
	if err := g.cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	g.cfg.Controllers[0].Pixels = 40
	l, err := BuildWith(g.cfg, svgLoader(map[string]string{
		"p.svg": `<svg><path id="r" d="M0 0 h10 v30" data-nodes="a,b,c"/></svg>`,
	}))
	if err != nil {
		t.Fatal(err)
	}
	r := l.Runs[0]
	if len(r.Anchors) != 3 || r.Anchors[1].Index != 10 || r.Anchors[1].Source != SourceEstimated {
		t.Fatalf("anchors = %+v", r.Anchors)
	}
	// Scale estimated from pixel lengths: 4 m over 40 units.
	if p := l.Plans[0]; !p.ScaleEstimated || !approx(p.Scale, 0.1) {
		t.Errorf("plan = %+v", p)
	}
	// Pixel 10 sits on the corner.
	if px := l.Pixels[10]; !approx(float64(px.X), 1) || !approx(float64(px.Y), 0) {
		t.Errorf("corner pixel at %v,%v", px.X, px.Y)
	}
}

func TestLayoutValidation(t *testing.T) {
	tests := []struct {
		name  string
		build func() *graph
		want  string
	}{
		{"overlap", func() *graph {
			g := newGraph(t).run("a", 10, "x", "y").run("b", 10, "p", "q")
			g.cfg.Layout.Runs[1].Indices = [2]int{5, 14}
			g.next = 15
			return g
		}, "run b overlaps run a at c:5–9"},
		{"anchors out of order", func() *graph { return newGraph(t).run("a", 10, "x", "m@6", "n@3", "y") },
			"anchors aren't in order along the run: n (index 3) comes at or before m (index 6)"},
		{"no estimate possible", func() *graph { return newGraph(t).run("a", 10, "x", "m", "y") },
			`node "m" has no anchor index and the run has no drawing`},
		{"anchor on an end", func() *graph {
			g := newGraph(t).run("a", 10, "x", "y")
			i := 3
			g.cfg.Layout.Runs[0].Anchors = []config.Anchor{{Node: "y", Index: &i}}
			return g
		}, `"y" is an end of the run`},
		{"anchor off path", func() *graph {
			g := newGraph(t).run("a", 10, "x", "y")
			i := 3
			g.cfg.Layout.Runs[0].Anchors = []config.Anchor{{Node: "z", Index: &i}}
			return g
		}, `anchor node "z" isn't on the run's path`},
		{"edge to unknown node", func() *graph { return newGraph(t).run("a", 10, "x", "y").gap("y", "nowhere", 1) },
			`gap edge: unknown node "nowhere"`},
		{"node twice", func() *graph { return newGraph(t).run("a", 10, "x", "m@3", "x@6", "y") },
			`node "x" appears twice`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := tt.build()
			g.cfg.Controllers[0].Pixels = max(g.next, 1)
			if err := g.cfg.Validate(); err != nil {
				t.Fatal(err)
			}
			_, err := BuildWith(g.cfg, nil)
			errContains(t, err, tt.want)
		})
	}
}

func TestUnassignedPixelsWarn(t *testing.T) {
	g := newGraph(t).run("a", 10, "x", "y")
	g.next = 15
	l := g.build()
	if len(l.Warnings) != 1 || !strings.Contains(l.Warnings[0].Msg, "pixels 10–14 are in no run") {
		t.Errorf("warnings = %v", l.Warnings)
	}
}

func TestMeasuredEdgeLength(t *testing.T) {
	// A strip cut and jumped round an obstacle: 10 pixels over 1.5 m.
	g := newGraph(t).run("a", 20, "x", "m@9", "y")
	g.cfg.Layout.Runs[0].Lengths = []config.EdgeLength{{From: "m", To: "y", Length: unitsMetres(1.5)}}
	l := g.build()
	r := l.Runs[0]
	if !approx(r.Length, 0.95+1.5) {
		t.Errorf("length = %v", r.Length)
	}
	p := l.Pixels[10] // first pixel after m, 1 cell along a 10.5-cell edge
	if !approx(float64(p.Dl), 1.5/10.5) || !approx(float64(p.Dist), 1.5/10.5) {
		t.Errorf("pixel = %+v", p)
	}
}

func TestMeasuredLengthRejectsUnknownEndpoint(t *testing.T) {
	g := newGraph(t).run("r", 10, "a", "b")
	g.cfg.Controllers[0].Pixels = 10
	g.cfg.Layout.Runs[0].Lengths = []config.EdgeLength{{From: "missing", To: "b", Length: unitsMetres(2)}}
	if err := g.cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	_, err := BuildWith(g.cfg, nil)
	errContains(t, err, `"missing"`)
}

func TestDrawingLabelsMustFollowMeasuredAnchorOrder(t *testing.T) {
	g := newGraph(t).run("r", 40, "a", "b@9", "c@29", "d")
	g.cfg.Controllers[0].Pixels = 40
	g.cfg.Layout.Runs[0].Plan = &config.RunPlan{SVG: "p.svg#r"}
	if err := g.cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	_, err := BuildWith(g.cfg, svgLoader(map[string]string{
		"p.svg": `<svg><path id="r" d="M0 0 H10 H30 H40" data-nodes="a,c,b,d"/></svg>`,
	}))
	errContains(t, err, "out of order")
}
