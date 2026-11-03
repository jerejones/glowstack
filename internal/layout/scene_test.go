// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"bytes"
	"math"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/plan"
	"github.com/jerejones/glowstack/internal/scene"
	"github.com/jerejones/glowstack/internal/units"
)

// sceneDoc is a made-up shed: run "r" climbs a 1 m post and runs 3 m along
// the eave at 1 m high. In glTF (Y up) the eave heads toward -Z, which is
// +Y with Z up.
const sceneDoc = `{"scenes":[{"extras":{"glowstack":{"schema":1,"units":"m","axes":"gltf-y-up"}}}],
 "nodes":[{"name":"walls lines","mesh":0},
  {"name":"r","extras":{"glowstack_run":"r","controller":"c",
   "points":[[0,0,0],[0,1,0],[0,1,-3]],"nodes":"a,b,c"}},
  {"name":"spare","extras":{"glowstack_run":"spare","points":[[0,0,0],[1,0,0]],"nodes":"p,q"}}],
 "meshes":[{"primitives":[{"mode":1}]}]}`

// sceneGraph is a 40-pixel run at 0.1 m pitch whose shape is in the scene.
func sceneGraph(t *testing.T) *graph {
	g := newGraph(t).run("r", 40)
	g.cfg.Layout.Runs[0].Path = nil
	g.cfg.Layout.Runs[0].Model = &config.RunModel{GLB: "site.glb#r"}
	g.cfg.Layout.Scene = &config.Scene{GLB: "site.glb"}
	g.cfg.Controllers[0].Pixels = 40
	return g
}

func buildScene(t *testing.T, g *graph, doc string) (*Layout, error) {
	t.Helper()
	if err := g.cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	return BuildWithLoaders(g.cfg,
		func(string) (*plan.Drawing, error) { t.Fatal("plans are not loaded with a scene"); return nil, nil },
		func(string) (*scene.Scene, error) { return scene.Parse(bytes.NewReader(scene.GLB([]byte(doc)))) })
}

func TestSceneRunPositions(t *testing.T) {
	l, err := buildScene(t, sceneGraph(t), sceneDoc)
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Plans) != 1 || !l.Plans[0].IsScene() || l.Plans[0].Scale != 1 || l.Plans[0].ScaleEstimated {
		t.Fatalf("plans = %+v", l.Plans)
	}
	r := l.Runs[0]
	// b is 1 m along a 4 m drawing, a quarter of 40 pixels: pixel 10.
	if len(r.Anchors) != 3 || r.Anchors[1].Index != 10 || r.Anchors[1].Source != SourceEstimated {
		t.Fatalf("anchors = %+v", r.Anchors)
	}
	// Drawn in meters: no scale needed, and the length check is exact.
	if !approx(r.DrawnMeters, 4) || !approx(r.LengthMismatch, 0) {
		t.Errorf("drawn %v m, mismatch %v", r.DrawnMeters, r.LengthMismatch)
	}
	// b sits on pixel 10's center (cell 10.5), so pixel 5 (cell 5.5) is
	// 5.5/10.5 of the way up the post, and pixel 25 (cell 25.5) is 15/29.5
	// of the way along the 3 m eave. Z is up.
	if px := l.Pixels[5]; !approx(float64(px.X), 0) || !approx(float64(px.Y), 0) || !approx(float64(px.Z), 5.5/10.5) {
		t.Errorf("post pixel at %v,%v,%v", px.X, px.Y, px.Z)
	}
	if px := l.Pixels[25]; !approx(float64(px.Y), 15/29.5*3) || !approx(float64(px.Z), 1) || px.Plan != 0 {
		t.Errorf("eave pixel at %v,%v,%v plan %d", px.X, px.Y, px.Z, px.Plan)
	}
	if n := l.Nodes[l.nodeByID["b"]]; !approx(n.Z, 1) || !approx(n.Y, 0) {
		t.Errorf("node b at %v,%v,%v", n.X, n.Y, n.Z)
	}
	if len(l.Warnings) != 1 || !strings.Contains(l.Warnings[0].Error(), `run "spare" isn't used`) {
		t.Errorf("warnings = %v", l.Warnings)
	}
}

func TestSceneIgnoresPlans(t *testing.T) {
	g := sceneGraph(t)
	g.cfg.Layout.Plans = []config.Plan{{SVG: "p.svg"}}
	g.cfg.Layout.Runs[0].Plan = &config.RunPlan{SVG: "p.svg#r"}
	if _, err := buildScene(t, g, sceneDoc); err != nil {
		t.Fatal(err)
	}
}

func TestPlanElevation(t *testing.T) {
	g := newGraph(t).run("r", 40)
	g.cfg.Layout.Runs[0].Plan = &config.RunPlan{SVG: "p.svg#r"}
	g.cfg.Layout.Runs[0].Path = nil
	g.cfg.Layout.Plans = []config.Plan{{SVG: "p.svg", Z: &units.Length{Value: 3.5}}}
	g.cfg.Controllers[0].Pixels = 40
	if err := g.cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	l, err := BuildWith(g.cfg, svgLoader(map[string]string{
		"p.svg": `<svg><path id="r" d="M0 0 h40" data-nodes="a,b"/></svg>`,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if z := l.Pixels[7].Z; !approx(float64(z), 3.5) {
		t.Errorf("plan pixel z = %v, want 3.5", z)
	}
}

func TestSceneErrors(t *testing.T) {
	tests := []struct {
		name string
		edit func(g *graph)
		doc  string
		want string
	}{
		{"missing run", func(g *graph) { g.cfg.Layout.Runs[0].Model.GLB = "site.glb#nope" }, sceneDoc,
			`the scene has no run "nope"`},
		{"controller mismatch", func(g *graph) {}, `{"scenes":[{"extras":{"glowstack":{"schema":1,"units":"m","axes":"gltf-y-up"}}}],
			"nodes":[{"extras":{"glowstack_run":"r","controller":"other","points":[[0,0,0],[1,0,0]],"nodes":"a,b"}}]}`,
			`the scene says controller "other", layout.yaml says "c"`},
		{"drawn backward", func(g *graph) { g.cfg.Layout.Runs[0].Path = []string{"c", "b", "a"} }, sceneDoc,
			"against the run's direction; redraw it from the first pixel"},
		{"bad frame", func(g *graph) {}, `{"scenes":[{}]}`, "scene site.glb: scene: the scene's extras don't state its frame"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := sceneGraph(t)
			tt.edit(g)
			_, err := buildScene(t, g, tt.doc)
			errContains(t, err, tt.want)
		})
	}
}

func TestSceneConfigValidation(t *testing.T) {
	g := newGraph(t).run("r", 40)
	g.cfg.Layout.Runs[0].Model = &config.RunModel{GLB: "site.glb#r"}
	g.cfg.Controllers[0].Pixels = 40
	errContains(t, g.cfg.Validate(), "model needs the layout's `scene: { glb: site.glb }`")
	g.cfg.Layout.Scene = &config.Scene{GLB: "other.glb"}
	errContains(t, g.cfg.Validate(), `model "site.glb" isn't the layout's scene "other.glb"`)
}

func TestSceneSpatialMappings(t *testing.T) {
	l, err := buildScene(t, sceneGraph(t), sceneDoc)
	if err != nil {
		t.Fatal(err)
	}
	one := func(m config.Mapping) *Mapping {
		t.Helper()
		m.ID = "m"
		mp, err := SolveSpatial(l, &m)
		if err != nil {
			t.Fatal(err)
		}
		return mp
	}
	b := &config.PointRef{Node: "b"} // top of the post: (0, 0, 1)
	m := func(v float64) units.Length { return units.Length{Value: v} }

	// Up: u is height. Pixel 5 is 5.5/10.5 m up the post.
	up := one(config.Mapping{Kind: config.KindAxis, Direction: []float64{0, 0, 2}})
	if !approx(float64(up.U[5]), 5.5/10.5) || !approx(float64(up.U[30]), 1) {
		t.Errorf("up: %v, %v", up.U[5], up.U[30])
	}
	// From the post foot to b: also up, measured from the foot.
	ab := one(config.Mapping{Kind: config.KindAxis, From: &config.PointRef{Node: "a"}, To: b})
	if !approx(float64(ab.U[5]), 5.5/10.5) {
		t.Errorf("a→b: %v", ab.U[5])
	}
	// A point without height gives a horizontal direction: toward +y.
	flat := one(config.Mapping{Kind: config.KindAxis, From: &config.PointRef{Node: "a"}, To: &config.PointRef{X: m(0), Y: m(5)}})
	if !approx(float64(flat.U[5]), 0) || !approx(float64(flat.U[25]), 15/29.5*3) {
		t.Errorf("flat: %v, %v", flat.U[5], flat.U[25])
	}
	// In a scene, angles are counter-clockwise seen from above: 90° is +y.
	ninety := units.Angle(math.Pi / 2)
	ang := one(config.Mapping{Kind: config.KindAxis, Angle: &ninety})
	if !approx(float64(ang.U[25]), 15/29.5*3) {
		t.Errorf("angle: %v", ang.U[25])
	}
	// Radial from b: 3-D by default, horizontal on request or for [x, y].
	r3 := one(config.Mapping{Kind: config.KindRadial, Center: b})
	rh := one(config.Mapping{Kind: config.KindRadial, Center: b, Horizontal: true})
	r2 := one(config.Mapping{Kind: config.KindRadial, Center: &config.PointRef{X: m(0), Y: m(0)}})
	if !approx(float64(r3.U[5]), 1-5.5/10.5) || !approx(float64(rh.U[5]), 0) || !approx(float64(r2.U[5]), 0) {
		t.Errorf("radial at pixel 5: 3-D %v, horizontal %v, [x, y] %v", r3.U[5], rh.U[5], r2.U[5])
	}
	r3z := one(config.Mapping{Kind: config.KindRadial, Center: &config.PointRef{X: m(0), Y: m(0), Z: m(0), HasZ: true}})
	if !approx(float64(r3z.U[5]), 5.5/10.5) {
		t.Errorf("radial from [0, 0, 0]: %v", r3z.U[5])
	}
}
