// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package scene reads a site's 3-D scene model: a glTF binary (.glb) whose
// nodes carry the runs' shapes in their extras. Only the JSON chunk is
// read; mesh data is left to the live map, which draws it.
//
// # Frame
//
// glTF is Y up. Glowstack works in meters with Z up, so a scene point
// (X, Y, Z) is returned as (X, −Z, Y). The scene must say so in its
// scene-level extras, or Parse refuses it:
//
//	{"glowstack": {"schema": 1, "units": "m", "axes": "gltf-y-up"}}
//
// # Runs
//
// A node whose extras carry glowstack_run is a run's shape:
//
//	glowstack_run  run id (required)
//	points         [[x, y, z], …] in scene coordinates, first vertex at the
//	               run's lowest index (required, at least two)
//	nodes          comma-separated node id per vertex; empty entries leave a
//	               vertex unlabeled (required, one entry per point)
//	controller     checked against the layout when present
//
// Pixel indices aren't part of the model: layout.yaml names each run's
// LEDs by output, so changing an output's count doesn't need a re-export.
// Other extras (an exporter's old `indices`, say) are ignored.
//
//	basis          per-vertex provenance; kept for inspect
//
// points is authoritative. glTF doesn't keep line vertices in order, so any
// mesh on a run node is display only. Node transforms are not applied:
// points are scene coordinates.
//
// # Layers
//
// Every other node with a mesh is a layer of the drawing, named by its node
// name. Parse reports each with whether it draws lines or surfaces.
package scene

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"

	"github.com/jerejones/glowstack/internal/plan"
)

// Scene is a parsed scene model.
type Scene struct {
	Runs   map[string]*Run // by run id
	Layers []Layer         // drawing layers, in node order
}

// Run is one run's shape and the facts the model states about it.
type Run struct {
	Status     string     // optional recorded strip condition; not controller reachability
	Path       *plan.Path // meters, Z up; Path.ID is the run id
	Controller string     // "" if the model doesn't say
	Basis      []json.RawMessage
}

// Layer kinds.
const (
	Lines    = "lines"
	Surfaces = "surfaces"
)

// Layer is one drawing node.
type Layer struct {
	Name string
	Kind string // Lines or Surfaces
}

// RunIDs returns the run ids in sorted order.
func (s *Scene) RunIDs() []string {
	ids := make([]string, 0, len(s.Runs))
	for id := range s.Runs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// ParseFile reads a .glb file.
func ParseFile(name string) (*Scene, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return Parse(f)
}

// Parse reads a .glb stream.
func Parse(r io.Reader) (*Scene, error) {
	doc, err := readJSONChunk(r)
	if err != nil {
		return nil, err
	}
	var g gltf
	if err := json.Unmarshal(doc, &g); err != nil {
		return nil, fmt.Errorf("scene: glTF JSON: %w", err)
	}
	if err := g.checkFrame(); err != nil {
		return nil, err
	}
	s := &Scene{Runs: map[string]*Run{}}
	for i, n := range g.Nodes {
		if n.Extras.Run != "" {
			run, err := n.Extras.run()
			if err != nil {
				return nil, fmt.Errorf("scene: node %d (run %s): %w", i, n.Extras.Run, err)
			}
			if s.Runs[run.Path.ID] != nil {
				return nil, fmt.Errorf("scene: run %s appears twice", run.Path.ID)
			}
			s.Runs[run.Path.ID] = run
			continue
		}
		if n.Mesh == nil || *n.Mesh < 0 || *n.Mesh >= len(g.Meshes) {
			continue
		}
		kind := Lines
		for _, p := range g.Meshes[*n.Mesh].Primitives {
			// glTF modes: 1–3 are lines; 4–6 (the default) are triangles.
			if p.Mode == nil || *p.Mode >= 4 {
				kind = Surfaces
			}
		}
		s.Layers = append(s.Layers, Layer{Name: n.Name, Kind: kind})
	}
	return s, nil
}

// readJSONChunk checks the GLB header and returns the first chunk, which
// the format requires to be JSON.
func readJSONChunk(r io.Reader) ([]byte, error) {
	var head [20]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return nil, fmt.Errorf("scene: not a glTF binary: %w", err)
	}
	le := binary.LittleEndian
	if !bytes.Equal(head[0:4], []byte("glTF")) {
		return nil, fmt.Errorf("scene: not a glTF binary (.glb)")
	}
	if v := le.Uint32(head[4:8]); v != 2 {
		return nil, fmt.Errorf("scene: glTF version %d, want 2", v)
	}
	n := le.Uint32(head[12:16])
	if !bytes.Equal(head[16:20], []byte("JSON")) {
		return nil, fmt.Errorf("scene: first glTF chunk isn't JSON")
	}
	if n > 64<<20 {
		return nil, fmt.Errorf("scene: JSON chunk of %d bytes is too large", n)
	}
	doc := make([]byte, n)
	if _, err := io.ReadFull(r, doc); err != nil {
		return nil, fmt.Errorf("scene: reading JSON chunk: %w", err)
	}
	return doc, nil
}

type gltf struct {
	Scene  *int `json:"scene"`
	Scenes []struct {
		Extras struct {
			Glowstack *frame `json:"glowstack"`
		} `json:"extras"`
	} `json:"scenes"`
	Nodes []struct {
		Name   string    `json:"name"`
		Mesh   *int      `json:"mesh"`
		Extras runExtras `json:"extras"`
	} `json:"nodes"`
	Meshes []struct {
		Primitives []struct {
			Mode *int `json:"mode"`
		} `json:"primitives"`
	} `json:"meshes"`
}

type frame struct {
	Schema int    `json:"schema"`
	Units  string `json:"units"`
	Axes   string `json:"axes"`
}

func (g *gltf) checkFrame() error {
	si := 0
	if g.Scene != nil {
		si = *g.Scene
	}
	if si < 0 || si >= len(g.Scenes) || g.Scenes[si].Extras.Glowstack == nil {
		return fmt.Errorf(`scene: the scene's extras don't state its frame; want {"glowstack": {"schema": 1, "units": "m", "axes": "gltf-y-up"}}`)
	}
	f := g.Scenes[si].Extras.Glowstack
	switch {
	case f.Schema != 1:
		return fmt.Errorf("scene: glowstack schema %d, want 1", f.Schema)
	case f.Units != "m":
		return fmt.Errorf("scene: units %q, want \"m\"", f.Units)
	case f.Axes != "gltf-y-up":
		return fmt.Errorf("scene: axes %q, want \"gltf-y-up\"", f.Axes)
	}
	return nil
}

type runExtras struct {
	Status     string            `json:"status"`
	Run        string            `json:"glowstack_run"`
	Points     [][]float64       `json:"points"`
	Nodes      *string           `json:"nodes"`
	Controller string            `json:"controller"`
	Basis      []json.RawMessage `json:"basis"`
}

func (e *runExtras) run() (*Run, error) {
	if len(e.Points) < 2 {
		return nil, fmt.Errorf("points: want at least two")
	}
	if e.Nodes == nil {
		return nil, fmt.Errorf("no nodes; want one comma-separated entry per point")
	}
	labels := strings.Split(*e.Nodes, ",")
	if len(labels) != len(e.Points) {
		return nil, fmt.Errorf("%d nodes for %d points; want one per point", len(labels), len(e.Points))
	}
	if e.Basis != nil && len(e.Basis) != len(e.Points) {
		return nil, fmt.Errorf("%d basis entries for %d points; want one per point", len(e.Basis), len(e.Points))
	}
	p := &plan.Path{ID: e.Run}
	seen := map[string]bool{}
	for i, q := range e.Points {
		if len(q) != 3 {
			return nil, fmt.Errorf("point %d: want [x, y, z]", i)
		}
		for _, v := range q {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return nil, fmt.Errorf("point %d isn't finite", i)
			}
		}
		pt := plan.Point{X: q[0], Y: -q[2], Z: q[1]}
		if i > 0 && plan.Dist(p.Points[i-1], pt) < 1e-9 {
			return nil, fmt.Errorf("points %d and %d are the same", i-1, i)
		}
		l := strings.TrimSpace(labels[i])
		if l != "" && seen[l] {
			return nil, fmt.Errorf("node %q labels two points", l)
		}
		seen[l] = true
		p.Points = append(p.Points, pt)
		p.Labels = append(p.Labels, l)
	}
	return &Run{Status: e.Status, Path: p, Controller: e.Controller, Basis: e.Basis}, nil
}
