// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package layout is the layout solver. It turns the loaded config into an
// immutable pixel table (every controller pixel gets a dense global id) with
// runs, nodes, anchors, edges, plan positions and areas, and solves mappings
// into per-pixel coordinate arrays (see mapping.go and flow.go).
//
// # Positions along a run
//
// A run of N pixels is measured in pixel cells: position 0 is the outer end
// of its first pixel, k+0.5 is the center of pixel k (counting in run
// direction), and N is the outer end of its last pixel. The run's first path
// node sits at 0 and its last at N, so a run's default physical length is
// N × pitch, and a gap measured from strip end to strip end needs no
// correction. An anchor puts its node at the center of its pixel. Strip edges
// span between consecutive path nodes; a measured `lengths:` entry rescales
// one edge without moving its pixels.
//
// # Drawing first, measuring later
//
// Anchors without an index are estimated from the run's plan path: the
// drawn path is scaled to the run's pixel span and each labeled vertex is
// placed in proportion to its distance along it, piecewise between the run
// ends and any anchors with explicit indices. Explicit indices (from
// layout.yaml or the data folder's anchors.yaml) are never moved. Pixels get
// plan positions by the same piecewise mapping, so corners land on drawn
// corners even when the drawing's proportions are off.
//
// # Drawings
//
// A run's shape comes from a plan SVG or from the scene model. With a
// `scene:`, the scene is the only drawing: run shapes come from `model:`,
// and `plans:` and runs' `plan:` are not loaded. Positions are meters with
// Z up; a plan's pixels sit at the plan's elevation.
package layout

import (
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/plan"
	"github.com/jerejones/glowstack/internal/scene"
)

// Layout is the solved, immutable pixel table and layout graph. Don't
// modify it after Build; rebuild instead.
type Layout struct {
	Pitch       float64 // default pitch, meters
	Controllers []Controller
	Pixels      []Pixel // indexed by global pixel id
	Runs        []Run
	Nodes       []Node
	Edges       []Edge
	Areas       []Area
	Plans       []Plan
	Warnings    config.Errors
	// Density lists stretches whose pixel density is off; each is in
	// Warnings too.
	Density []DensityIssue

	nodeByID map[string]int
	runByID  map[string]int
	areaByID map[string]int
	implicit map[string]*Area // run:<id>, controller:<id> and all; see Area
}

// Controller is a controller's slice of the global id space. Its pixels are
// global ids Base … Base+Pixels-1, in controller index order.
type Controller struct {
	ID     string
	Base   int32
	Pixels int
	Config *config.Controller
}

// Pixel is one row of the pixel table.
type Pixel struct {
	Controller int16   // index into Layout.Controllers
	Index      int32   // index on the controller
	Run        int32   // index into Layout.Runs, or -1
	Edge       int32   // index into Layout.Edges, or -1
	Dist       float32 // meters along the edge from Edge.From
	RunDist    float32 // meters along the run from its start
	Dl         float32 // physical size of the pixel, meters
	X, Y, Z    float32 // position, meters, Z up; NaN if unknown
	Plan       int16   // index into Layout.Plans (the drawing), or -1
	Dead       bool    // physically present but unlit or hidden
}

// HasPlan reports whether the pixel has a position.
func (p *Pixel) HasPlan() bool { return p.Plan >= 0 }

// Run is a solved run.
type Run struct {
	ID         string
	Controller int     // index into Layout.Controllers
	First      int     // controller index of the first pixel in run direction
	Last       int     // controller index of the last pixel
	Step       int     // +1 or -1
	Count      int     // pixels
	Pitch      float64 // meters
	Length     float64 // physical length, meters (sum of its strip edges)
	Path       []int   // node indices in run order
	Anchors    []Anchor
	Edges      []int // strip edge indices in run order

	Plan           int        // index into Layout.Plans (the drawing), or -1
	PlanPath       *plan.Path // the run's shape, in the drawing's units
	DrawnLength    float64    // drawing units, 0 without a drawing
	DrawnMeters    float64    // DrawnLength × plan scale
	LengthMismatch float64    // DrawnMeters / Length - 1; 0 without a drawing

	Config *config.Run
}

// Pixel returns the global id of the run's k-th pixel (in run direction).
func (r *Run) Pixel(l *Layout, k int) int32 {
	return l.Controllers[r.Controller].Base + int32(r.First+k*r.Step)
}

// Offset returns k for a controller index on this run, or -1.
func (r *Run) Offset(index int) int {
	k := (index - r.First) * r.Step
	if k < 0 || k >= r.Count {
		return -1
	}
	return k
}

// Anchor sources as solved. Run ends are SourceEnd.
const (
	SourceMeasured  = config.SourceMeasured
	SourceEstimated = config.SourceEstimated
	SourceEnd       = "end"
)

// Anchor places a path node on a run. Every path node has one, including
// the two ends.
type Anchor struct {
	Node   int
	Index  int     // controller index of the pixel at the node (the end pixel for run ends)
	At     float64 // position along the run in pixel cells (see package doc)
	Dist   float64 // meters along the run
	Source string  // measured | estimated | end
	Pos    config.Pos
}

// Node is a point in the layout graph.
type Node struct {
	ID    string
	Label string
	Sync  bool
	Edges []int   // incident edges
	X, Y  float64 // position in meters, NaN if unknown
	Z     float64
	Plan  int // index into Layout.Plans, or -1
}

// EdgeKind is strip, gap or link.
type EdgeKind uint8

const (
	Strip EdgeKind = iota
	Gap
	Link
)

func (k EdgeKind) String() string {
	return [...]string{"strip", "gap", "link"}[k]
}

// Edge connects two nodes.
type Edge struct {
	Kind      EdgeKind
	From, To  int     // node indices; strips run From→To in run direction
	Length    float64 // meters
	Measured  bool    // strip length came from a `lengths:` entry
	Run       int     // strip: run index; otherwise -1
	StartAt   float64 // strip: run cell position of From
	EndAt     float64 // strip: run cell position of To
	StartDist float64 // strip: meters along the run at From
	Pixels    []int32 // strip: global ids in From→To order
	Pos       config.Pos
}

// Name describes the edge for messages, e.g. "shed-eave shed-sw–shed-nw".
func (e *Edge) Name(l *Layout) string {
	ends := l.Nodes[e.From].ID + "–" + l.Nodes[e.To].ID
	if e.Kind == Strip {
		return l.Runs[e.Run].ID + " " + ends
	}
	return e.Kind.String() + " " + ends
}

// Area is a named set of pixels.
type Area struct {
	ID     string
	Pixels []int32 // global ids, sorted, unique
}

// Plan is one drawing: a plan SVG, or the scene model (GLB set, Scale 1).
type Plan struct {
	SVG            string  // file name relative to the config dir; "" for the scene
	GLB            string  // the scene model's file name; "" for a plan
	Scale          float64 // meters per drawing unit
	ScaleEstimated bool    // Scale came from pixel lengths, not config
	Z              float64 // elevation of a plan, meters
	Drawing        *plan.Drawing
	Scene          *scene.Scene
}

// IsScene reports whether the drawing is the scene model.
func (p *Plan) IsScene() bool { return p.Scene != nil }

// PlanLoader loads a plan SVG by its config-relative file name.
type PlanLoader func(name string) (*plan.Drawing, error)

// SceneLoader loads a scene model by its config-relative file name.
type SceneLoader func(name string) (*scene.Scene, error)

// Build solves the layout, loading plan SVGs and the scene from cfg.Dir.
func Build(cfg *config.Config) (*Layout, error) {
	return BuildWith(cfg, func(name string) (*plan.Drawing, error) {
		return plan.ParseFile(filepath.Join(cfg.Dir, name))
	})
}

// BuildWith solves the layout with a custom plan loader. The scene, if
// any, is loaded from cfg.Dir.
func BuildWith(cfg *config.Config, load PlanLoader) (*Layout, error) {
	return BuildWithLoaders(cfg, load, func(name string) (*scene.Scene, error) {
		return scene.ParseFile(filepath.Join(cfg.Dir, name))
	})
}

// BuildWithLoaders solves the layout with custom plan and scene loaders.
func BuildWithLoaders(cfg *config.Config, load PlanLoader, loadScene SceneLoader) (*Layout, error) {
	b := &builder{
		cfg:       cfg,
		load:      load,
		loadScene: loadScene,
		scene:     -1,
		l: &Layout{
			Pitch:    cfg.Layout.Pitch.Value,
			nodeByID: map[string]int{},
			runByID:  map[string]int{},
			areaByID: map[string]int{},
			implicit: map[string]*Area{},
		},
		planByFile: map[string]int{},
	}
	b.l.Warnings = append(b.l.Warnings, cfg.Warnings...)
	b.controllers()
	b.nodes()
	b.plans()
	for i := range cfg.Layout.Runs {
		b.run(&cfg.Layout.Runs[i])
	}
	b.unusedSceneRuns()
	if len(b.errs) == 0 {
		b.estimatePlanScales()
		for i := range b.l.Runs {
			b.placeRun(i)
			b.checkDensity(i)
		}
		b.nonStripEdges()
		b.dead()
		b.unassigned()
		b.areas()
		b.implicitAreas()
	}
	if len(b.errs) > 0 {
		return nil, b.errs
	}
	return b.l, nil
}

// NodeIndex returns the index of the node with the given id.
func (l *Layout) NodeIndex(id string) (int, bool) {
	i, ok := l.nodeByID[id]
	return i, ok
}

// RunIndex returns the index of the run with the given id.
func (l *Layout) RunIndex(id string) (int, bool) {
	i, ok := l.runByID[id]
	return i, ok
}

// The implicit areas: every run and every controller is also a layer
// target, as "run:<id>" and "controller:<id>", and "all" is every pixel
// on a run. They aren't listed in Areas (so they don't show up as areas,
// segments or in inspect), and an areas.yaml area with the same id wins.
const (
	AreaRunPrefix        = "run:"
	AreaControllerPrefix = "controller:"
	AreaAll              = "all"
)

// Area returns the area with the given id, or an implicit run or
// controller area.
func (l *Layout) Area(id string) (*Area, bool) {
	i, ok := l.areaByID[id]
	if !ok {
		a, ok := l.implicit[id]
		return a, ok
	}
	return &l.Areas[i], true
}

// AreasOf lists the ids of the areas containing global pixel id p.
func (l *Layout) AreasOf(p int32) []string {
	var ids []string
	for _, a := range l.Areas {
		i := sort.Search(len(a.Pixels), func(i int) bool { return a.Pixels[i] >= p })
		if i < len(a.Pixels) && a.Pixels[i] == p {
			ids = append(ids, a.ID)
		}
	}
	return ids
}

// PixelID returns the global id of (controller, index).
func (l *Layout) PixelID(controller string, index int) (int32, bool) {
	for _, c := range l.Controllers {
		if c.ID == controller {
			if index < 0 || index >= c.Pixels {
				return 0, false
			}
			return c.Base + int32(index), true
		}
	}
	return 0, false
}

// Describe names a pixel in house terms, e.g. "shed:402 (run shed-eave)".
func (l *Layout) Describe(p int32) string {
	px := &l.Pixels[p]
	s := fmt.Sprintf("%s:%d", l.Controllers[px.Controller].ID, px.Index)
	if px.Run >= 0 {
		s += " (run " + l.Runs[px.Run].ID + ")"
	}
	return s
}

type builder struct {
	cfg        *config.Config
	load       PlanLoader
	loadScene  SceneLoader
	scene      int // index of the scene in l.Plans, or -1
	l          *Layout
	errs       config.Errors
	planByFile map[string]int
	owner      []int32  // global id → index into claimIDs, -1
	claimIDs   []string // run ids in the order they claimed pixels
}

func (b *builder) errorf(pos config.Pos, format string, args ...any) {
	b.errs = append(b.errs, config.Errorf(pos, format, args...))
}

func (b *builder) warnf(pos config.Pos, format string, args ...any) {
	b.l.Warnings = append(b.l.Warnings, config.Errorf(pos, format, args...))
}

func (b *builder) controllers() {
	var base int32
	for i := range b.cfg.Controllers {
		c := &b.cfg.Controllers[i]
		b.l.Controllers = append(b.l.Controllers, Controller{ID: c.ID, Base: base, Pixels: c.Pixels, Config: c})
		base += int32(c.Pixels)
	}
	b.l.Pixels = make([]Pixel, base)
	b.owner = make([]int32, base)
	nan := float32(math.NaN())
	for ci, c := range b.l.Controllers {
		for k := range c.Pixels {
			b.l.Pixels[c.Base+int32(k)] = Pixel{
				Controller: int16(ci), Index: int32(k), Run: -1, Edge: -1, X: nan, Y: nan, Z: nan, Plan: -1,
			}
			b.owner[c.Base+int32(k)] = -1
		}
	}
}

// node returns the index of node id, creating it if needed.
func (b *builder) node(id string) int {
	if i, ok := b.l.nodeByID[id]; ok {
		return i
	}
	b.l.Nodes = append(b.l.Nodes, Node{ID: id, X: math.NaN(), Y: math.NaN(), Z: math.NaN(), Plan: -1})
	b.l.nodeByID[id] = len(b.l.Nodes) - 1
	return len(b.l.Nodes) - 1
}

func (b *builder) nodes() {
	for _, n := range b.cfg.Layout.Nodes {
		i := b.node(n.ID)
		b.l.Nodes[i].Label, b.l.Nodes[i].Sync = n.Label, n.Sync
	}
}

func (b *builder) plans() {
	if sc := b.cfg.Layout.Scene; sc != nil {
		s, err := b.loadScene(sc.GLB)
		if err != nil {
			b.errorf(sc.Pos, "scene %s: %v", sc.GLB, err)
			return
		}
		b.l.Plans = append(b.l.Plans, Plan{GLB: sc.GLB, Scale: 1, Scene: s})
		b.scene = 0
		return // the scene replaces the plans
	}
	for _, p := range b.cfg.Layout.Plans {
		i := b.plan(p.SVG, p.Pos)
		if i < 0 {
			continue
		}
		if p.Scale != nil {
			b.l.Plans[i].Scale = p.Scale.Value
		}
		if p.Z != nil {
			b.l.Plans[i].Z = p.Z.Value
		}
	}
}

// unusedSceneRuns warns about runs in the scene that no run's `model:`
// names, which usually means a renamed run.
func (b *builder) unusedSceneRuns() {
	if b.scene < 0 {
		return
	}
	used := map[string]bool{}
	for _, r := range b.cfg.Layout.Runs {
		if r.Model != nil {
			_, id, _ := strings.Cut(r.Model.GLB, "#")
			used[id] = true
		}
	}
	for _, id := range b.l.Plans[b.scene].Scene.RunIDs() {
		if !used[id] {
			b.warnf(b.cfg.Layout.Scene.Pos, "scene %s: run %q isn't used by any run's `model:`", b.cfg.Layout.Scene.GLB, id)
		}
	}
}

// plan returns the index of the plan for file, loading it on first use, or
// -1 on error.
func (b *builder) plan(file string, pos config.Pos) int {
	if i, ok := b.planByFile[file]; ok {
		return i
	}
	d, err := b.load(file)
	if err != nil {
		b.errorf(pos, "plan %s: %v", file, err)
		b.planByFile[file] = -1
		return -1
	}
	b.l.Plans = append(b.l.Plans, Plan{SVG: file, Drawing: d})
	b.planByFile[file] = len(b.l.Plans) - 1
	return len(b.l.Plans) - 1
}

// estimatePlanScales fills in missing plan scales from pixel lengths: total
// physical length of the runs drawn on the plan over their total drawn
// length.
func (b *builder) estimatePlanScales() {
	for pi := range b.l.Plans {
		p := &b.l.Plans[pi]
		if p.Scale > 0 {
			continue
		}
		var phys, drawn float64
		for _, r := range b.l.Runs {
			if r.Plan == pi {
				phys += r.Length
				drawn += r.DrawnLength
			}
		}
		if drawn > 0 {
			p.Scale, p.ScaleEstimated = phys/drawn, true
		} else {
			p.Scale, p.ScaleEstimated = 1, true
		}
	}
	for ri := range b.l.Runs {
		r := &b.l.Runs[ri]
		if r.Plan >= 0 && r.DrawnLength > 0 {
			r.DrawnMeters = r.DrawnLength * b.l.Plans[r.Plan].Scale
			r.LengthMismatch = r.DrawnMeters/r.Length - 1
		}
	}
}

func (b *builder) nonStripEdges() {
	for _, e := range b.cfg.Layout.Edges {
		from, ok1 := b.l.nodeByID[e.From]
		to, ok2 := b.l.nodeByID[e.To]
		if !ok1 || !ok2 {
			missing := e.From
			if ok1 {
				missing = e.To
			}
			b.errorf(e.Pos, "%s edge: unknown node %q (nodes come from run paths, anchors or `nodes:`)", e.Kind, missing)
			continue
		}
		kind, length := Gap, e.Length.Value
		if e.Kind == config.EdgeLink {
			kind, length = Link, 0
		}
		b.addEdge(Edge{Kind: kind, From: from, To: to, Length: length, Run: -1, Pos: e.Pos})
	}
}

func (b *builder) addEdge(e Edge) int {
	b.l.Edges = append(b.l.Edges, e)
	i := len(b.l.Edges) - 1
	b.l.Nodes[e.From].Edges = append(b.l.Nodes[e.From].Edges, i)
	if e.To != e.From {
		b.l.Nodes[e.To].Edges = append(b.l.Nodes[e.To].Edges, i)
	}
	return i
}

func (b *builder) dead() {
	for _, d := range b.cfg.Layout.Dead {
		base, _ := b.l.PixelID(d.Controller, d.Indices[0])
		for k := 0; k <= d.Indices[1]-d.Indices[0]; k++ {
			b.l.Pixels[base+int32(k)].Dead = true
		}
	}
}

// unassigned warns about pixels that are in no run and not marked dead.
func (b *builder) unassigned() {
	for _, c := range b.l.Controllers {
		var ranges []string
		start := -1
		for k := 0; k <= c.Pixels; k++ {
			free := k < c.Pixels && b.l.Pixels[c.Base+int32(k)].Run < 0 && !b.l.Pixels[c.Base+int32(k)].Dead
			switch {
			case free && start < 0:
				start = k
			case !free && start >= 0:
				if start == k-1 {
					ranges = append(ranges, fmt.Sprint(start))
				} else {
					ranges = append(ranges, fmt.Sprintf("%d–%d", start, k-1))
				}
				start = -1
			}
		}
		if len(ranges) > 0 {
			b.warnf(c.Config.Pos, "controller %s: pixels %s are in no run (mark them dead if that's expected)", c.ID, strings.Join(ranges, ", "))
		}
	}
}
