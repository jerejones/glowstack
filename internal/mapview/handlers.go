// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
)

//go:embed static
var staticFS embed.FS

// Register adds the map's routes to mux.
func (m *Map) Register(mux interface{ Handle(string, http.Handler) }) {
	static, _ := fs.Sub(staticFS, "static")
	h := func(fn http.HandlerFunc) http.Handler { return fn }
	mux.Handle("GET /map/", http.StripPrefix("/map/", http.FileServerFS(static)))
	mux.Handle("GET /api/map/geometry", h(m.handleGeometry))
	mux.Handle("GET /api/map/plans/{n}", h(m.handlePlan))
	mux.Handle("GET /api/map/mappings/{id}", h(m.handleMapping))
	mux.Handle("GET /api/map/pixels/{id}", h(m.handlePixel))
	mux.Handle("GET /api/map/power", h(m.handlePower))
	mux.Handle("GET /api/map/ws", h(m.handleWS))
	mux.Handle("GET /api/map/preview", h(m.handlePreviewState))
	mux.Handle("POST /api/map/preview", h(m.handlePreviewControl))
	mux.Handle("GET /api/map/preview/layers", h(m.handlePreviewLayers))
	mux.Handle("POST /api/map/preview/layers", h(m.handlePreviewPush))
	mux.Handle("DELETE /api/map/preview/layers", h(m.handlePreviewClear))
	mux.Handle("DELETE /api/map/preview/layers/{id}", h(m.handlePreviewRemove))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func httpError(w http.ResponseWriter, code int, format string, args ...any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf(format, args...)})
}

func (m *Map) handleGeometry(w http.ResponseWriter, r *http.Request) {
	m.touch()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(m.state().geom)
}

// handlePlan serves a plan SVG named in layout.yaml from the config
// folder. Only those files are served. Browsers load it as an <img>, so
// any script in it doesn't run.
func (m *Map) handlePlan(w http.ResponseWriter, r *http.Request) {
	v := m.state().View
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 0 || n >= len(v.Layout.Plans) {
		httpError(w, http.StatusNotFound, "no plan %q", r.PathValue("n"))
		return
	}
	b, err := os.ReadFile(filepath.Join(v.Config.Dir, v.Layout.Plans[n].SVG))
	if err != nil {
		httpError(w, http.StatusNotFound, "plan %d: %v", n, err)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Security-Policy", "script-src 'none'")
	w.Write(b)
}

// MappingJSON is a mapping's per-pixel coordinates for the diagnostic
// views.
type MappingJSON struct {
	ID      string    `json:"id"`
	Kind    string    `json:"kind"`
	U       floats    `json:"u"`       // per global id; null outside the domain
	Stretch floats    `json:"stretch"` // per global id
	Min     float     `json:"min"`     // range of u
	Max     float     `json:"max"`
	Flow    *FlowJSON `json:"flow,omitempty"`
}

// FlowJSON is a flow's solved state, from layout.FlowInfo.
type FlowJSON struct {
	Origin      int      `json:"origin"`       // node index
	NodeU       floats   `json:"node_u"`       // per node; null if unreached
	EdgeStretch floats   `json:"edge_stretch"` // per edge; null for links and unreached
	EdgeMode    []string `json:"edge_mode"`
	Unreached   []string `json:"unreached"`
}

func (m *Map) handleMapping(w http.ResponseWriter, r *http.Request) {
	mp, ok := m.state().Mappings.Get(r.PathValue("id"))
	if !ok {
		httpError(w, http.StatusNotFound, "no mapping %q", r.PathValue("id"))
		return
	}
	out := MappingJSON{ID: mp.ID, Kind: mp.Kind, U: floats32(mp.U), Stretch: floats32(mp.Stretch)}
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, u := range mp.U {
		if !math.IsNaN(float64(u)) {
			lo, hi = min(lo, float64(u)), max(hi, float64(u))
		}
	}
	out.Min, out.Max = float(lo), float(hi)
	if fi := mp.Flow; fi != nil {
		out.Flow = &FlowJSON{Origin: fi.Origin, NodeU: fi.NodeU, EdgeStretch: fi.EdgeStretch,
			EdgeMode: fi.EdgeMode, Unreached: fi.Unreached}
		if out.Flow.Unreached == nil {
			out.Flow.Unreached = []string{}
		}
	}
	writeJSON(w, out)
}

// PixelJSON is one inspected pixel.
type PixelJSON struct {
	ID         int32        `json:"id"`
	Controller string       `json:"controller"`
	Index      int32        `json:"index"`
	Run        string       `json:"run,omitempty"`
	RunPixel   int          `json:"run_pixel"` // position along the run (0 = first pixel), -1 if none
	Edge       string       `json:"edge,omitempty"`
	Dist       float        `json:"dist"`     // metres along the edge
	RunDist    float        `json:"run_dist"` // metres along the run
	Dl         float        `json:"dl"`       // physical size, metres
	X          float        `json:"x"`
	Y          float        `json:"y"`
	Dead       bool         `json:"dead,omitempty"`
	Areas      []string     `json:"areas"`
	Zones      []string     `json:"zones"`
	Mappings   []PixelCoord `json:"mappings"`
	Showing    *ShowingJSON `json:"showing"` // null: no layer, or no frame yet
	RGB        string       `json:"rgb,omitempty"`
	Frame      uint32       `json:"frame"`
	Preview    bool         `json:"preview"`
}

// PixelCoord is a pixel's coordinate in one mapping.
type PixelCoord struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	U       float  `json:"u"`
	Stretch float  `json:"stretch"`
}

// ShowingJSON is the layer showing at a pixel.
type ShowingJSON struct {
	Layer   string `json:"layer"`
	Preview bool   `json:"preview"` // a preview-only layer
	Effect  string `json:"effect,omitempty"`
	Preset  string `json:"preset,omitempty"`
	Target  string `json:"target,omitempty"`
	Owner   string `json:"owner,omitempty"`
}

func (m *Map) handlePixel(w http.ResponseWriter, r *http.Request) {
	m.touch()
	st := m.state()
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id < 0 || id >= len(st.Layout.Pixels) {
		httpError(w, http.StatusNotFound, "no pixel %q", r.PathValue("id"))
		return
	}
	writeJSON(w, m.inspect(st.View, int32(id)))
}

func (m *Map) inspect(v app.View, p int32) *PixelJSON {
	l := v.Layout
	px := &l.Pixels[p]
	out := &PixelJSON{
		ID: p, Controller: l.Controllers[px.Controller].ID, Index: px.Index, RunPixel: -1,
		Edge: edgeName(l, px.Edge), Dist: float(px.Dist), RunDist: float(px.RunDist), Dl: float(px.Dl),
		X: float(px.X), Y: float(px.Y), Dead: px.Dead, Areas: l.AreasOf(p), Zones: []string{},
	}
	if out.Areas == nil {
		out.Areas = []string{}
	}
	if px.Run >= 0 {
		run := &l.Runs[px.Run]
		out.Run, out.RunPixel = run.ID, run.Offset(int(px.Index))
	} else {
		out.Dist, out.RunDist, out.Dl = float(math.NaN()), float(math.NaN()), float(math.NaN())
	}
	// A pixel is in a zone if it's in the zone's area or one of its
	// segments' areas.
	for _, z := range v.Config.Zones {
		if slices.Contains(out.Areas, z.Area) || slices.ContainsFunc(z.Segments, func(s config.Segment) bool {
			return slices.Contains(out.Areas, s.Area)
		}) {
			out.Zones = append(out.Zones, z.ID)
		}
	}
	for _, id := range v.Mappings.IDs() {
		mp, _ := v.Mappings.Get(id)
		out.Mappings = append(out.Mappings, PixelCoord{ID: id, Kind: mp.Kind, U: float(mp.U[p]), Stretch: float(mp.Stretch[p])})
	}
	// A snapshot from before a reload describes other pixels.
	if s, _ := m.latest(); s != nil && s.Gen == v.Gen {
		out.Frame, out.Preview = s.Seq, s.Preview
		out.RGB = fmt.Sprintf("#%02x%02x%02x", s.RGB[3*p], s.RGB[3*p+1], s.RGB[3*p+2])
		if t := s.Top[p]; t >= 0 {
			out.Showing = m.showing(s.Layers[t], s.Preview)
		}
	}
	return out
}

// showing describes layer id from the preview stack or the house stack.
// Preview layers are renamed in the preview pass (see previewName).
func (m *Map) showing(id string, preview bool) *ShowingJSON {
	if pid, ok := strings.CutPrefix(id, previewIDPrefix); preview && ok {
		l, _ := m.app.Preview.Get(pid)
		return &ShowingJSON{Layer: pid, Preview: true, Effect: l.Effect, Preset: l.Preset, Target: l.Target, Owner: l.Owner}
	}
	if preview {
		id = strings.TrimPrefix(id, houseIDPrefix)
	}
	if l, ok := m.app.Stack.Get(id); ok {
		return &ShowingJSON{Layer: id, Effect: l.Effect, Preset: l.Preset, Target: l.Target, Owner: l.Owner}
	}
	// Fading out: gone from the stack, still on the map.
	return &ShowingJSON{Layer: id}
}
