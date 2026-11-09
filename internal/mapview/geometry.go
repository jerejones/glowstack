// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"cmp"
	"encoding/json"
	"math"
	"sort"
	"strconv"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/names"
)

// Geometry is the map's static description of the installation: the
// pixel table in columns (indexed by global id), runs with anchors,
// nodes, edges, areas, zones and plans. It's built at start and again
// after each config reload; Gen is the reload generation (app.View.Gen),
// which the frame stream's "subscribed" message repeats so a page can
// tell its geometry is stale.
type Geometry struct {
	Gen         uint64           `json:"gen"`
	FPS         float64          `json:"fps"`       // stream cap
	HouseFPS    float64          `json:"house_fps"` // the frame loop's rate
	Pixels      PixelColumns     `json:"pixels"`
	Plans       []PlanJSON       `json:"plans"`
	Map         MapJSON          `json:"map"`
	Controllers []ControllerJSON `json:"controllers"`
	// ControllerLocations is where the scene model puts controllers,
	// including boards controllers.yaml doesn't list.
	ControllerLocations []ControllerLocationJSON `json:"controller_locations"`
	Runs                []RunJSON                `json:"runs"`
	Nodes               []NodeJSON               `json:"nodes"`
	Edges               []EdgeJSON               `json:"edges"`
	Areas               []AreaJSON               `json:"areas"`
	Zones               []ZoneJSON               `json:"zones"`
	Mappings            []MappingRef             `json:"mappings"`
	DefaultMapping      string                   `json:"default_mapping"`
	Effects             []NamedJSON              `json:"effects"`
	Presets             []NamedJSON              `json:"presets"`
}

// PixelColumns is the pixel table, one array per column, indexed by
// global id. X, Y and Z are meters, Z up (null where unknown); Plan, Run and
// Edge are indices (-1 for none).
type PixelColumns struct {
	Count      int     `json:"count"`
	X          floats  `json:"x"`
	Y          floats  `json:"y"`
	Z          floats  `json:"z"`
	Plan       []int16 `json:"plan"`
	Controller []int16 `json:"controller"`
	Index      []int32 `json:"index"`
	Run        []int32 `json:"run"`
	Edge       []int32 `json:"edge"`
	Dl         floats  `json:"dl"`
	Dead       []int32 `json:"dead"` // global ids of dead pixels
}

// PlanJSON is one drawing: a plan SVG or the scene model. For a plan,
// pixel and node coordinates are plan units times Scale, so the SVG's
// viewBox in meters is ViewBox × Scale. The scene is a .glb in meters, Y up
// (see package scene); Layers lists its drawing nodes.
type PlanJSON struct {
	Kind           string      `json:"kind"` // svg | scene
	URL            string      `json:"url"`
	Name           string      `json:"name"`
	Layers         []LayerJSON `json:"layers,omitempty"`
	ViewBox        [4]float64  `json:"view_box"` // min-x, min-y, width, height in plan units; zero if the SVG has none
	Scale          float64     `json:"scale"`    // meters per plan unit
	ScaleEstimated bool        `json:"scale_estimated"`
}

// MapJSON is the 3-D view's presentation from glowstack.yaml `map:`.
// View is null when the config doesn't set one; the page then frames the
// pixels itself.
type MapJSON struct {
	View       *ViewJSON      `json:"view"`
	AutoRotate bool           `json:"auto_rotate"`
	Layers     []MapLayerJSON `json:"layers"`
}

// ViewJSON is a camera in meters, Z up.
type ViewJSON struct {
	From      []float64 `json:"from,omitempty"`
	Direction []float64 `json:"direction,omitempty"`
	To        []float64 `json:"to,omitempty"`
	FOV       float64   `json:"fov"`
}

// MapLayerJSON styles one scene layer; empty fields take the default.
type MapLayerJSON struct {
	Name    string   `json:"name"`
	Color   string   `json:"color,omitempty"`
	Opacity *float64 `json:"opacity,omitempty"`
	Visible *bool    `json:"visible,omitempty"`
}

// LayerJSON is one drawing node of the scene.
type LayerJSON struct {
	Name string `json:"name"`
	Kind string `json:"kind"` // lines | surfaces
}

type ControllerJSON struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"` // what a person reads
	Base     int32        `json:"base"`
	Pixels   int          `json:"pixels"`
	Channels string       `json:"channels"`
	Outputs  []OutputJSON `json:"outputs"`
}

// ControllerLocationJSON is a controller's place in the scene model.
// Controller is its index in Controllers, or -1 for a board the config
// doesn't list.
type ControllerLocationJSON struct {
	ID         string          `json:"id"`
	Label      string          `json:"label,omitempty"`
	Controller int             `json:"controller"`
	Plan       int             `json:"plan"`
	X          float           `json:"x"`
	Y          float           `json:"y"`
	Z          float           `json:"z"`
	Basis      json.RawMessage `json:"basis,omitempty"`
}

type OutputJSON struct {
	Reversed bool    `json:"reversed,omitempty"`
	Output   int     `json:"output"` // WLED output number
	GPIO     *int    `json:"gpio,omitempty"`
	Start    int     `json:"start"`
	Count    int     `json:"count"`
	MaxMA    float64 `json:"max_ma,omitempty"`
}

type RunJSON struct {
	Status         string       `json:"status"`
	ID             string       `json:"id"`
	Name           string       `json:"name"` // what a person reads
	Controller     int          `json:"controller"`
	First          int          `json:"first"`
	Last           int          `json:"last"`
	Count          int          `json:"count"`
	Pitch          float64      `json:"pitch"`
	Length         float64      `json:"length"`
	Plan           int          `json:"plan"` // -1: not drawn
	DrawnMeters    float64      `json:"drawn_m,omitempty"`
	LengthMismatch float64      `json:"length_mismatch,omitempty"`
	Path           []int        `json:"path"`  // node indices
	Edges          []int        `json:"edges"` // strip edge indices in run order
	Anchors        []AnchorJSON `json:"anchors"`
}

type AnchorJSON struct {
	Node   int    `json:"node"`
	Index  int    `json:"index"`  // controller index
	Pixel  int32  `json:"pixel"`  // global id
	Source string `json:"source"` // measured | estimated | end
}

// NodeLocationJSON is one run-specific physical occurrence of a shared node.
type NodeLocationJSON struct {
	Run  string `json:"run"`
	Plan int    `json:"plan"`
	X    float  `json:"x"`
	Y    float  `json:"y"`
	Z    float  `json:"z"`
}

type NodeJSON struct {
	Locations []NodeLocationJSON `json:"locations,omitempty"`
	ID        string             `json:"id"`
	Name      string             `json:"name"` // what a person reads
	Label     string             `json:"label,omitempty"`
	Sync      bool               `json:"sync,omitempty"`
	X         float              `json:"x"`
	Y         float              `json:"y"`
	Z         float              `json:"z"`
	Plan      int                `json:"plan"`
	Edges     []int              `json:"edges"`
}

type EdgeJSON struct {
	Kind     string  `json:"kind"`
	From     int     `json:"from"`
	To       int     `json:"to"`
	Length   float64 `json:"length"`
	Measured bool    `json:"measured,omitempty"`
	Run      int     `json:"run"`
	Name     string  `json:"name"`
}

type AreaJSON struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Internal bool     `json:"internal,omitempty"` // bookkeeping, not a place for a look
	Count    int      `json:"count"`
	Ranges   []Range  `json:"ranges"`
	Includes []string `json:"includes"`
	Runs     []string `json:"runs"`
}

type ZoneJSON struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Area     string        `json:"area"`
	Mapping  string        `json:"mapping,omitempty"`
	Segments []SegmentJSON `json:"segments"`
}

type SegmentJSON struct {
	Area    string `json:"area"`
	Mapping string `json:"mapping,omitempty"`
}

type MappingRef struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

type NamedJSON struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

func (m *Map) geometry(v app.View) *Geometry {
	a, l := m.app, v.Layout
	n := len(l.Pixels)
	g := &Geometry{
		Gen: v.Gen,
		FPS: m.opts.FPS, HouseFPS: a.Ticker.FPS(),
		Pixels: PixelColumns{
			Count: n, X: make(floats, n), Y: make(floats, n), Z: make(floats, n), Plan: make([]int16, n),
			Controller: make([]int16, n), Index: make([]int32, n), Run: make([]int32, n),
			Edge: make([]int32, n), Dl: make(floats, n), Dead: []int32{},
		},
		DefaultMapping: v.Mappings.Default,
	}
	for i := range l.Pixels {
		px := &l.Pixels[i]
		c := &g.Pixels
		c.X[i], c.Y[i], c.Z[i], c.Plan[i] = float64(px.X), float64(px.Y), float64(px.Z), px.Plan
		c.Controller[i], c.Index[i], c.Run[i], c.Edge[i] = px.Controller, px.Index, px.Run, px.Edge
		c.Dl[i] = float64(px.Dl)
		if px.Run < 0 {
			c.Dl[i] = math.NaN()
		}
		if px.Dead {
			c.Dead = append(c.Dead, int32(i))
		}
	}
	for i, p := range l.Plans {
		pj := PlanJSON{Kind: "svg", URL: "/api/map/plans/" + strconv.Itoa(i), Name: p.SVG, Scale: p.Scale, ScaleEstimated: p.ScaleEstimated}
		if p.Drawing != nil {
			pj.ViewBox = p.Drawing.ViewBox
		}
		if p.IsScene() {
			pj.Kind, pj.Name = "scene", p.GLB
			for _, ly := range p.Scene.Layers {
				pj.Layers = append(pj.Layers, LayerJSON{Name: ly.Name, Kind: ly.Kind})
			}
		}
		g.Plans = append(g.Plans, pj)
	}
	g.Map = mapJSON(&v.Config.Settings.Map)
	for _, c := range l.Controllers {
		cj := ControllerJSON{ID: c.ID, Name: names.Run(c.ID), Base: c.Base, Pixels: c.Pixels, Channels: cmp.Or(c.Config.Channels, "rgb"), Outputs: []OutputJSON{}}
		for _, o := range c.Config.Outputs {
			cj.Outputs = append(cj.Outputs, OutputJSON{Reversed: o.Reversed, Output: o.Number, GPIO: o.GPIO, Start: o.Start, Count: o.Count, MaxMA: o.MaxMA})
		}
		g.Controllers = append(g.Controllers, cj)
	}
	g.ControllerLocations = []ControllerLocationJSON{}
	for i, p := range l.Plans {
		if !p.IsScene() {
			continue
		}
		for _, id := range p.Scene.ControllerIDs() {
			sc := p.Scene.Controllers[id]
			cl := ControllerLocationJSON{ID: id, Label: sc.Label, Controller: -1, Plan: i,
				X: float(sc.Point.X), Y: float(sc.Point.Y), Z: float(sc.Point.Z), Basis: sc.Basis}
			for ci, c := range l.Controllers {
				if c.ID == id {
					cl.Controller = ci
				}
			}
			g.ControllerLocations = append(g.ControllerLocations, cl)
		}
	}
	for i := range l.Runs {
		r := &l.Runs[i]
		rj := RunJSON{
			ID: r.ID, Name: names.Run(r.ID), Controller: r.Controller, First: r.First, Last: r.Last, Count: r.Count,
			Pitch: r.Pitch, Length: r.Length, Plan: r.Plan, DrawnMeters: r.DrawnMeters,
			LengthMismatch: r.LengthMismatch, Path: r.Path, Edges: r.Edges,
		}
		rj.Status = "working"
		if r.Plan >= 0 && r.PlanPath != nil && l.Plans[r.Plan].Scene != nil {
			if sr := l.Plans[r.Plan].Scene.Runs[r.PlanPath.ID]; sr != nil && sr.Status != "" {
				rj.Status = sr.Status
			}
		}
		for _, an := range r.Anchors {
			rj.Anchors = append(rj.Anchors, AnchorJSON{
				Node: an.Node, Index: an.Index, Source: an.Source,
				Pixel: l.Controllers[r.Controller].Base + int32(an.Index),
			})
		}
		g.Runs = append(g.Runs, rj)
	}
	for _, nd := range l.Nodes {
		g.Nodes = append(g.Nodes, NodeJSON{ID: nd.ID, Name: names.Node(nd.ID, nd.Label), Label: nd.Label, Sync: nd.Sync,
			X: float(nd.X), Y: float(nd.Y), Z: float(nd.Z), Plan: nd.Plan, Edges: nd.Edges})
	}
	// A logical junction can occur at different physical positions on its runs.
	// Preserve each occurrence rather than showing only the first run's position.
	for _, r := range l.Runs {
		if r.Plan < 0 || r.PlanPath == nil {
			continue
		}
		pl := l.Plans[r.Plan]
		for _, a := range r.Anchors {
			nd := &g.Nodes[a.Node]
			px := l.Pixels[l.Controllers[r.Controller].Base+int32(a.Index)]
			x, y, z := float64(px.X), float64(px.Y), float64(px.Z)
			_, d, found := r.PlanPath.Vertex(nd.ID)
			if a.Source == layout.SourceEnd {
				d = 0.0
				if a.Index == r.Last {
					d = r.DrawnLength
				}
				found = true
			}
			if found {
				p := r.PlanPath.At(d)
				x, y, z = p.X*pl.Scale, p.Y*pl.Scale, pl.Z+p.Z*pl.Scale
			}
			nd.Locations = append(nd.Locations, NodeLocationJSON{Run: r.ID, Plan: r.Plan, X: float(x), Y: float(y), Z: float(z)})
		}
	}
	for i := range l.Edges {
		e := &l.Edges[i]
		g.Edges = append(g.Edges, EdgeJSON{Kind: e.Kind.String(), From: e.From, To: e.To,
			Length: e.Length, Measured: e.Measured, Run: e.Run, Name: e.Name(l)})
	}
	areaConfigs := make(map[string]config.Area, len(v.Config.Areas))
	for _, ar := range v.Config.Areas {
		areaConfigs[ar.ID] = ar
	}
	for _, ar := range l.Areas {
		aj := AreaJSON{ID: ar.ID, Name: names.Humanize(ar.ID), Internal: names.InternalArea(ar.ID), Count: len(ar.Pixels), Ranges: ranges(ar.Pixels), Includes: []string{}, Runs: []string{}}
		seenRuns := map[string]bool{}
		for _, part := range areaConfigs[ar.ID].Include {
			if part.Area != "" {
				aj.Includes = append(aj.Includes, part.Area)
			}
			if part.Run != "" && !seenRuns[part.Run] {
				aj.Runs = append(aj.Runs, part.Run)
				seenRuns[part.Run] = true
			}
		}
		g.Areas = append(g.Areas, aj)
	}
	for _, z := range v.Config.Zones {
		zj := ZoneJSON{ID: z.ID, Name: names.Zone(z.ID, z.Device.Name), Area: z.Area, Mapping: z.Mapping}
		for _, s := range z.Segments {
			zj.Segments = append(zj.Segments, SegmentJSON{Area: s.Area, Mapping: s.Mapping})
		}
		g.Zones = append(g.Zones, zj)
	}
	for _, id := range v.Mappings.IDs() {
		mp, _ := v.Mappings.Get(id)
		g.Mappings = append(g.Mappings, MappingRef{ID: id, Kind: mp.Kind})
	}
	for _, d := range a.Effects.All() {
		g.Effects = append(g.Effects, NamedJSON{ID: d.ID, Name: d.Name})
	}
	for _, p := range v.Config.Presets {
		g.Presets = append(g.Presets, NamedJSON{ID: p.ID, Name: p.Name})
	}
	return g
}

// float is a float64 that encodes NaN and infinities as null, rounded to
// 6 significant digits (plenty for meters on a map).
type float float64

func (f float) MarshalJSON() ([]byte, error) { return appendFloat(nil, float64(f)), nil }

// floats encodes like []float.
type floats []float64

func (fs floats) MarshalJSON() ([]byte, error) {
	b := make([]byte, 0, 8*len(fs)+2)
	b = append(b, '[')
	for i, f := range fs {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendFloat(b, f)
	}
	return append(b, ']'), nil
}

func appendFloat(b []byte, f float64) []byte {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return append(b, "null"...)
	}
	return strconv.AppendFloat(b, f, 'g', 6, 64)
}

// floats32 converts a float32 slice to floats.
func floats32(s []float32) floats {
	out := make(floats, len(s))
	for i, v := range s {
		out[i] = float64(v)
	}
	return out
}

// edgeName returns the edge's name, or "" for -1.
func edgeName(l *layout.Layout, e int32) string {
	if e < 0 {
		return ""
	}
	return l.Edges[e].Name(l)
}

func mapJSON(m *config.MapSettings) MapJSON {
	out := MapJSON{AutoRotate: m.AutoRotate, Layers: []MapLayerJSON{}}
	if w := m.View; w != nil {
		out.View = &ViewJSON{From: w.From, Direction: w.Direction, To: w.To, FOV: w.FOV}
	}
	names := make([]string, 0, len(m.Layers))
	for name := range m.Layers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		l := m.Layers[name]
		out.Layers = append(out.Layers, MapLayerJSON{Name: name, Color: l.Color, Opacity: l.Opacity, Visible: l.Visible})
	}
	return out
}
