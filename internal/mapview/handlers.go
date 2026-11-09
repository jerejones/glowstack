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
	// Section URLs serve the same shell; navigation preserves the live map.
	page, _ := fs.ReadFile(static, "index.html")
	servePage := h(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(page)
	})
	redirect := func(path string) http.Handler {
		return h(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.RawQuery != "" {
				pathWithQuery := path + "?" + r.URL.RawQuery
				http.Redirect(w, r, pathWithQuery, http.StatusPermanentRedirect)
				return
			}
			http.Redirect(w, r, path, http.StatusPermanentRedirect)
		})
	}
	mux.Handle("GET /{$}", servePage)
	mux.Handle("GET /map", redirect("/"))
	mux.Handle("GET /map/{$}", redirect("/"))
	for _, section := range []string{"looks", "presets", "setup", "status"} {
		mux.Handle("GET /"+section, servePage)
		mux.Handle("GET /"+section+"/{$}", redirect("/"+section))
		mux.Handle("GET /map/"+section, redirect("/"+section))
		mux.Handle("GET /map/"+section+"/{$}", redirect("/"+section))
	}
	notFound, _ := fs.ReadFile(static, "404.html")
	serveNotFound := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		w.Write(notFound)
	}
	files := http.StripPrefix("/map/", http.FileServerFS(static))
	mux.Handle("GET /map/", h(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/map/")
		if _, err := fs.Stat(static, name); err != nil {
			serveNotFound(w)
			return
		}
		files.ServeHTTP(w, r)
	}))
	// Pages only: the APIs keep their plain 404s.
	mux.Handle("/", h(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/json") {
			http.NotFound(w, r)
			return
		}
		serveNotFound(w)
	}))
	mux.Handle("GET /api/map/geometry", h(m.handleGeometry))
	mux.Handle("GET /api/map/plans/{n}", h(m.handlePlan))
	mux.Handle("GET /api/map/mappings/{id}", h(m.handleMapping))
	mux.Handle("GET /api/map/pixels/{id}", h(m.handlePixel))
	mux.Handle("GET /api/map/power", h(m.handlePower))
	mux.Handle("GET /api/map/ws", h(m.handleWS))
	mux.Handle("POST /api/map/params/yaml", h(m.handleParamsYAML))
	mux.Handle("POST /api/map/params/json", h(m.handleParamsJSON))
	mux.Handle("GET /api/map/preview", h(m.handlePreviewState))
	mux.Handle("POST /api/map/preview", h(m.handlePreviewControl))
	mux.Handle("GET /api/map/preview/layers", h(m.handlePreviewLayers))
	mux.Handle("POST /api/map/preview/layers", h(m.handlePreviewPush))
	mux.Handle("DELETE /api/map/preview/layers", h(m.handlePreviewClear))
	mux.Handle("DELETE /api/map/preview/layers/{id}", h(m.handlePreviewRemove))
	mux.Handle("POST /api/map/preview/promote", h(m.handlePreviewPromote))
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
	m.touch(ShowAuto)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(m.state().geom)
}

// handlePlan serves a plan SVG or the scene model named in layout.yaml
// from the config folder. Only those files are served. Browsers load it as an <img>, so
// any script in it doesn't run.
func (m *Map) handlePlan(w http.ResponseWriter, r *http.Request) {
	v := m.state().View
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 0 || n >= len(v.Layout.Plans) {
		httpError(w, http.StatusNotFound, "no plan %q", r.PathValue("n"))
		return
	}
	p := &v.Layout.Plans[n]
	name, ctype := p.SVG, "image/svg+xml"
	if p.IsScene() {
		name, ctype = p.GLB, "model/gltf-binary"
	}
	b, err := os.ReadFile(filepath.Join(v.Config.Dir, name))
	if err != nil {
		httpError(w, http.StatusNotFound, "plan %d: %v", n, err)
		return
	}
	w.Header().Set("Content-Type", ctype)
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
	Dist       float        `json:"dist"`     // meters along the edge
	RunDist    float        `json:"run_dist"` // meters along the run
	Dl         float        `json:"dl"`       // physical size, meters
	X          float        `json:"x"`
	Y          float        `json:"y"`
	Z          float        `json:"z"`
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

// showParam reads ?show= (ShowAuto or ShowHouse), replying with an error
// and returning false if it's something else.
func showParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	show := r.URL.Query().Get("show")
	if !validShow(show) {
		httpError(w, http.StatusBadRequest, "show=%q: want house or nothing", show)
		return "", false
	}
	return show, true
}

func (m *Map) handlePixel(w http.ResponseWriter, r *http.Request) {
	show, ok := showParam(w, r)
	if !ok {
		return
	}
	m.touch(show)
	st := m.state()
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id < 0 || id >= len(st.Layout.Pixels) {
		httpError(w, http.StatusNotFound, "no pixel %q", r.PathValue("id"))
		return
	}
	writeJSON(w, m.inspect(st.View, int32(id), show))
}

func (m *Map) inspect(v app.View, p int32, show string) *PixelJSON {
	l := v.Layout
	px := &l.Pixels[p]
	out := &PixelJSON{
		ID: p, Controller: l.Controllers[px.Controller].ID, Index: px.Index, RunPixel: -1,
		Edge: edgeName(l, px.Edge), Dist: float(px.Dist), RunDist: float(px.RunDist), Dl: float(px.Dl),
		X: float(px.X), Y: float(px.Y), Z: float(px.Z), Dead: px.Dead, Areas: l.AreasOf(p), Zones: []string{},
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
	if s, _ := m.latest(show); s != nil && s.Gen == v.Gen {
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
