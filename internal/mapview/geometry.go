// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"cmp"
	"math"
	"strconv"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/layout"
)

// Geometry is the map's static description of the installation: the
// pixel table in columns (indexed by global id), runs with anchors,
// nodes, edges, areas, zones and plans. It's built at start and again
// after each config reload; Gen is the reload generation (app.View.Gen),
// which the frame stream's "subscribed" message repeats so a page can
// tell its geometry is stale.
type Geometry struct {
	Gen            uint64           `json:"gen"`
	FPS            float64          `json:"fps"`       // stream cap
	HouseFPS       float64          `json:"house_fps"` // the frame loop's rate
	Pixels         PixelColumns     `json:"pixels"`
	Plans          []PlanJSON       `json:"plans"`
	Controllers    []ControllerJSON `json:"controllers"`
	Runs           []RunJSON        `json:"runs"`
	Nodes          []NodeJSON       `json:"nodes"`
	Edges          []EdgeJSON       `json:"edges"`
	Areas          []AreaJSON       `json:"areas"`
	Zones          []ZoneJSON       `json:"zones"`
	Mappings       []MappingRef     `json:"mappings"`
	DefaultMapping string           `json:"default_mapping"`
	Effects        []NamedJSON      `json:"effects"`
	Presets        []NamedJSON      `json:"presets"`
}

// PixelColumns is the pixel table, one array per column, indexed by
// global id. X and Y are plan meters (null where unknown); Plan, Run and
// Edge are indices (-1 for none).
type PixelColumns struct {
	Count      int     `json:"count"`
	X          floats  `json:"x"`
	Y          floats  `json:"y"`
	Plan       []int16 `json:"plan"`
	Controller []int16 `json:"controller"`
	Index      []int32 `json:"index"`
	Run        []int32 `json:"run"`
	Edge       []int32 `json:"edge"`
	Dl         floats  `json:"dl"`
	Dead       []int32 `json:"dead"` // global ids of dead pixels
}

// PlanJSON is one plan SVG. Pixel and node coordinates are plan units
// times Scale, so the SVG's viewBox in meters is ViewBox × Scale.
type PlanJSON struct {
	URL            string     `json:"url"`
	Name           string     `json:"name"`
	ViewBox        [4]float64 `json:"view_box"` // min-x, min-y, width, height in plan units; zero if the SVG has none
	Scale          float64    `json:"scale"`    // meters per plan unit
	ScaleEstimated bool       `json:"scale_estimated"`
}

type ControllerJSON struct {
	ID       string       `json:"id"`
	Base     int32        `json:"base"`
	Pixels   int          `json:"pixels"`
	Channels string       `json:"channels"`
	Outputs  []OutputJSON `json:"outputs"`
}

type OutputJSON struct {
	Pin   int     `json:"pin"`
	Start int     `json:"start"`
	Count int     `json:"count"`
	MaxMA float64 `json:"max_ma,omitempty"`
}

type RunJSON struct {
	ID             string       `json:"id"`
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

type NodeJSON struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	Sync  bool   `json:"sync,omitempty"`
	X     float  `json:"x"`
	Y     float  `json:"y"`
	Plan  int    `json:"plan"`
	Edges []int  `json:"edges"`
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
	ID     string  `json:"id"`
	Count  int     `json:"count"`
	Ranges []Range `json:"ranges"`
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
			Count: n, X: make(floats, n), Y: make(floats, n), Plan: make([]int16, n),
			Controller: make([]int16, n), Index: make([]int32, n), Run: make([]int32, n),
			Edge: make([]int32, n), Dl: make(floats, n), Dead: []int32{},
		},
		DefaultMapping: v.Mappings.Default,
	}
	for i := range l.Pixels {
		px := &l.Pixels[i]
		c := &g.Pixels
		c.X[i], c.Y[i], c.Plan[i] = float64(px.X), float64(px.Y), px.Plan
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
		pj := PlanJSON{URL: "/api/map/plans/" + strconv.Itoa(i), Name: p.SVG, Scale: p.Scale, ScaleEstimated: p.ScaleEstimated}
		if p.Drawing != nil {
			pj.ViewBox = p.Drawing.ViewBox
		}
		g.Plans = append(g.Plans, pj)
	}
	for _, c := range l.Controllers {
		cj := ControllerJSON{ID: c.ID, Base: c.Base, Pixels: c.Pixels, Channels: cmp.Or(c.Config.Channels, "rgb"), Outputs: []OutputJSON{}}
		for _, o := range c.Config.Outputs {
			cj.Outputs = append(cj.Outputs, OutputJSON{Pin: o.Pin, Start: o.Start, Count: o.Count, MaxMA: o.MaxMA})
		}
		g.Controllers = append(g.Controllers, cj)
	}
	for i := range l.Runs {
		r := &l.Runs[i]
		rj := RunJSON{
			ID: r.ID, Controller: r.Controller, First: r.First, Last: r.Last, Count: r.Count,
			Pitch: r.Pitch, Length: r.Length, Plan: r.Plan, DrawnMeters: r.DrawnMeters,
			LengthMismatch: r.LengthMismatch, Path: r.Path, Edges: r.Edges,
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
		g.Nodes = append(g.Nodes, NodeJSON{ID: nd.ID, Label: nd.Label, Sync: nd.Sync,
			X: float(nd.X), Y: float(nd.Y), Plan: nd.Plan, Edges: nd.Edges})
	}
	for i := range l.Edges {
		e := &l.Edges[i]
		g.Edges = append(g.Edges, EdgeJSON{Kind: e.Kind.String(), From: e.From, To: e.To,
			Length: e.Length, Measured: e.Measured, Run: e.Run, Name: e.Name(l)})
	}
	for _, ar := range l.Areas {
		g.Areas = append(g.Areas, AreaJSON{ID: ar.ID, Count: len(ar.Pixels), Ranges: ranges(ar.Pixels)})
	}
	for _, z := range v.Config.Zones {
		zj := ZoneJSON{ID: z.ID, Name: z.Device.Name, Area: z.Area, Mapping: z.Mapping}
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
