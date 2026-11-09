// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
	"github.com/jerejones/glowstack/internal/units"
)

const exampleConfig = "../../examples/fictional/config"

var t0 = time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)

// fixture is the fictional example with a manual clock, the map and an
// HTTP server.
type fixture struct {
	clock *clock.Manual
	app   *app.App
	m     *Map
	srv   *httptest.Server
}

func newFixture(t *testing.T) *fixture { return newFixtureIn(t, exampleConfig) }

func newFixtureIn(t *testing.T, configDir string) *fixture {
	t.Helper()
	data := t.TempDir()
	b, err := os.ReadFile("../../examples/fictional/data/anchors.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "anchors.yaml"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	c := clock.NewManual(t0)
	a, err := app.New(app.Options{ConfigDir: configDir, DataDir: data, Clock: c})
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(a, Options{})
	if err != nil {
		t.Fatal(err)
	}
	mux := httpserver.New("")
	m.Register(mux)
	srv := httptest.NewServer(mux.Handler())
	t.Cleanup(srv.Close)
	return &fixture{clock: c, app: a, m: m, srv: srv}
}

// push puts a solid layer on the house stack with no fade.
func (f *fixture) push(t *testing.T, target, hex string) stack.Layer {
	t.Helper()
	l, err := f.app.Stack.Push(stack.Layer{Owner: stack.OwnerCLI, Target: target, Effect: "solid",
		Params: map[string]any{"color": hex, "fade_in": "0s"}})
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// frame advances the house clock past the stream interval and renders.
func (f *fixture) frame(t *testing.T) {
	t.Helper()
	f.clock.Advance(100 * time.Millisecond)
	if err := f.app.RenderFrame(f.app.Ticker.Next()); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) get(t *testing.T, path string, v any) {
	t.Helper()
	resp, err := http.Get(f.srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET %s: %s %s", path, resp.Status, b)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) post(t *testing.T, path string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(f.srv.URL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// geometryJSON mirrors the geometry JSON with nullable floats.
type geometryJSON struct {
	FPS    float64 `json:"fps"`
	Pixels struct {
		Count int        `json:"count"`
		X     []*float64 `json:"x"`
		Y     []*float64 `json:"y"`
		Plan  []int      `json:"plan"`
		Run   []int      `json:"run"`
		Index []int      `json:"index"`
		Dead  []int32    `json:"dead"`
	} `json:"pixels"`
	Plans []PlanJSON `json:"plans"`
	Runs  []RunJSON  `json:"runs"`
	Nodes []struct {
		ID   string   `json:"id"`
		X    *float64 `json:"x"`
		Sync bool     `json:"sync"`
	} `json:"nodes"`
	Edges    []EdgeJSON   `json:"edges"`
	Areas    []AreaJSON   `json:"areas"`
	Zones    []ZoneJSON   `json:"zones"`
	Mappings []MappingRef `json:"mappings"`
}

// Every run, node and controller reaches the page with a name to read.
func TestGeometryNames(t *testing.T) {
	f := newFixture(t)
	type named struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	var g struct {
		Runs        []named `json:"runs"`
		Nodes       []named `json:"nodes"`
		Controllers []named `json:"controllers"`
	}
	f.get(t, "/api/map/geometry", &g)
	if len(g.Runs) == 0 || len(g.Nodes) == 0 || len(g.Controllers) == 0 {
		t.Fatalf("%d runs, %d nodes, %d controllers", len(g.Runs), len(g.Nodes), len(g.Controllers))
	}
	for _, list := range [][]named{g.Runs, g.Nodes, g.Controllers} {
		for _, n := range list {
			if n.Name == "" {
				t.Errorf("%q has no name", n.ID)
			}
		}
	}
}

func TestGeometryJSON(t *testing.T) {
	f := newFixture(t)
	var g geometryJSON
	f.get(t, "/api/map/geometry", &g)
	l := f.app.Layout

	if g.FPS != DefaultFPS || g.Pixels.Count != 1084 || len(g.Pixels.X) != 1084 || len(g.Pixels.Run) != 1084 {
		t.Fatalf("fps %v, %d pixels, %d x", g.FPS, g.Pixels.Count, len(g.Pixels.X))
	}
	for _, p := range []int{0, 305, 700, 1083} {
		px := l.Pixels[p]
		if g.Pixels.X[p] == nil || math.Abs(*g.Pixels.X[p]-float64(px.X)) > 1e-4 || math.Abs(*g.Pixels.Y[p]-float64(px.Y)) > 1e-4 {
			t.Errorf("pixel %d at %v,%v, want %v,%v", p, g.Pixels.X[p], g.Pixels.Y[p], px.X, px.Y)
		}
		if g.Pixels.Run[p] != int(px.Run) || g.Pixels.Index[p] != int(px.Index) {
			t.Errorf("pixel %d run %d index %d", p, g.Pixels.Run[p], g.Pixels.Index[p])
		}
	}
	// The two dead pixels between the eave and the tower aren't on a run
	// or the plan: null coordinates.
	if len(g.Pixels.Dead) != 2 || g.Pixels.Dead[0] != 482 || g.Pixels.X[482] != nil || g.Pixels.Plan[482] != -1 {
		t.Errorf("dead %v, x %v plan %d", g.Pixels.Dead, g.Pixels.X[482], g.Pixels.Plan[482])
	}
	if len(g.Plans) != 1 || g.Plans[0].URL != "/api/map/plans/0" || g.Plans[0].ViewBox != [4]float64{0, 0, 400, 400} || g.Plans[0].Scale != 0.05 {
		t.Errorf("plans %+v", g.Plans)
	}
	// shed-nw is measured at index 305 (layout.yaml), shed-sw in the data
	// folder's anchors.yaml; shed-eave-mid is estimated.
	eave := g.Runs[0]
	sources := map[string]string{}
	for _, an := range eave.Anchors {
		sources[l.Nodes[an.Node].ID] = an.Source
		if l.Nodes[an.Node].ID == "shed-nw" && (an.Index != 305 || an.Pixel != 305) {
			t.Errorf("shed-nw anchor %+v", an)
		}
	}
	if eave.ID != "shed-eave" || sources["shed-nw"] != "measured" || sources["shed-sw"] != "measured" || sources["shed-eave-mid"] != "estimated" || sources["shed-se"] != "end" {
		t.Errorf("eave %s anchors %v", eave.ID, sources)
	}
	var link, gap int
	for _, e := range g.Edges {
		switch e.Kind {
		case "link":
			link++
		case "gap":
			gap++
			if e.Length != 1.2 {
				t.Errorf("gap %+v", e)
			}
		}
	}
	if link != 1 || gap != 1 {
		t.Errorf("%d links, %d gaps", link, gap)
	}
	for _, n := range g.Nodes {
		if n.ID == "tower-top" && (!n.Sync || n.X == nil) {
			t.Errorf("tower-top %+v", n)
		}
	}
	// Areas come as ranges that cover exactly the area's pixels.
	for _, a := range g.Areas {
		want, _ := l.Area(a.ID)
		n := 0
		for _, r := range a.Ranges {
			for p := r[0]; p <= r[1]; p++ {
				if want.Pixels[n] != p {
					t.Fatalf("area %s: range pixel %d, want %d", a.ID, p, want.Pixels[n])
				}
				n++
			}
		}
		if n != len(want.Pixels) || a.Count != n {
			t.Errorf("area %s: %d pixels in ranges, want %d", a.ID, n, len(want.Pixels))
		}
	}
	if len(g.Zones) != 2 || g.Zones[1].Segments[1].Mapping != "east-west" {
		t.Errorf("zones %+v", g.Zones)
	}
	if len(g.Mappings) != len(f.app.Mappings.IDs()) || g.Mappings[3].ID != "front-sweep" || g.Mappings[3].Kind != "flow" {
		t.Errorf("mappings %+v", g.Mappings)
	}

	// The plan SVG is served; other files aren't reachable.
	resp, err := http.Get(f.srv.URL + "/api/map/plans/0")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/svg+xml" || !bytes.Contains(body, []byte(`id="eave"`)) {
		t.Errorf("plan: %s %s", resp.Status, resp.Header.Get("Content-Type"))
	}
	for _, path := range []string{"/api/map/plans/1", "/api/map/plans/..%2flayout.yaml", "/api/map/plans/-1"} {
		resp, err := http.Get(f.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %s", path, resp.Status)
		}
	}

	// The page is served too.
	resp, err = http.Get(f.srv.URL + "/map/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !bytes.Contains(body, []byte("app.js")) {
		t.Errorf("page: %s", resp.Status)
	}
	// So are its modules, including those in subfolders.
	for _, path := range []string{"/map/app.js", "/map/ui.css", "/map/panel/looks.js", "/map/panel/calibrate.js"} {
		resp, err := http.Get(f.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Errorf("%s: %s", path, resp.Status)
		}
	}
}

func TestMappingJSON(t *testing.T) {
	f := newFixture(t)
	var m struct {
		ID      string     `json:"id"`
		U       []*float64 `json:"u"`
		Stretch []*float64 `json:"stretch"`
		Min     float64    `json:"min"`
		Max     float64    `json:"max"`
		Flow    *struct {
			Origin      int        `json:"origin"`
			EdgeStretch []*float64 `json:"edge_stretch"`
		} `json:"flow"`
	}
	f.get(t, "/api/map/mappings/from-gate", &m)
	mp, _ := f.app.Mappings.Get("from-gate")
	if len(m.U) != 1084 || m.Flow == nil || len(m.Flow.EdgeStretch) != len(f.app.Layout.Edges) {
		t.Fatalf("u %d, flow %+v", len(m.U), m.Flow)
	}
	// from-gate leaves the porch dark: null u there.
	porch, _ := f.app.Layout.Area("porch")
	if m.U[porch.Pixels[0]] != nil {
		t.Errorf("porch u = %v", *m.U[porch.Pixels[0]])
	}
	if m.U[0] == nil || math.Abs(*m.U[0]-float64(mp.U[0])) > 1e-4 || m.Min < 0 || m.Max <= m.Min {
		t.Errorf("u[0] %v, range %v–%v", m.U[0], m.Min, m.Max)
	}
	resp, _ := http.Get(f.srv.URL + "/api/map/mappings/nope")
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("unknown mapping: %s", resp.Status)
	}
}

func TestDisplayEncoding(t *testing.T) {
	// Authored colors show as authored.
	for _, v := range []uint8{0, 32, 64, 128, 200, 255} {
		if got := display(color.Linear(units.Color{R: v}).R); got != v {
			t.Errorf("display(%d) = %d", v, got)
		}
	}
	if display(float32(math.NaN())) != 0 || display(-1) != 0 || display(7) != 255 {
		t.Error("out of range values")
	}
}

func TestEncodeFrame(t *testing.T) {
	s := &Snapshot{Seq: 7, T: 1767290400.25, Preview: true, Paused: true, RGB: make([]byte, 3*10)}
	for i := range s.RGB {
		s.RGB[i] = byte(i)
	}
	all := encodeFrame(nil, s, []Range{{0, 9}})
	if len(all) != frameHeader+30 || all[0] != 1 || all[1] != flagPreview|flagPaused || all[2] != 0 || all[3] != 0 {
		t.Fatalf("header % x", all[:4])
	}
	if binary.LittleEndian.Uint32(all[4:]) != 7 || math.Float64frombits(binary.LittleEndian.Uint64(all[8:])) != s.T {
		t.Errorf("seq/time % x", all[4:16])
	}
	if !bytes.Equal(all[frameHeader:], s.RGB) {
		t.Errorf("payload %v", all[frameHeader:])
	}
	sub := encodeFrame(nil, &Snapshot{Seq: 1, RGB: s.RGB}, []Range{{1, 2}, {8, 8}})
	want := []byte{3, 4, 5, 6, 7, 8, 24, 25, 26}
	if sub[1] != 0 || !bytes.Equal(sub[frameHeader:], want) {
		t.Errorf("subset flags %d payload %v", sub[1], sub[frameHeader:])
	}

	if rs := ranges([]int32{1, 2, 3, 7, 9, 10}); len(rs) != 3 || rs[0] != (Range{1, 3}) || rs[1] != (Range{7, 7}) || rs[2] != (Range{9, 10}) {
		t.Errorf("ranges %v", rs)
	}
}

func TestCaptureFoldsWhiteAndTracksLayers(t *testing.T) {
	f := newFixture(t)
	f.m.clients.Add(1) // someone's watching
	bottom := f.push(t, "everything", "#000080")
	top := f.push(t, "porch", "#ff0000/80")
	f.frame(t)
	s, _ := f.m.latest(ShowAuto)
	if s == nil || s.Preview {
		t.Fatalf("snapshot %+v", s)
	}
	porch, _ := f.app.Layout.Area("porch")
	p := porch.Pixels[0] // yard:390, the porch's last pixel: it's wired from the east
	// The porch is on an RGB controller, but the map folds W into RGB
	// for every pixel: red + white at 0x80.
	if got := s.RGB[3*p : 3*p+3]; got[0] != 255 || got[1] != 98 || got[2] != 64 {
		t.Errorf("porch rgb %v", got)
	}
	if s.Layers[s.Top[p]] != top.ID || s.Layers[s.Top[0]] != bottom.ID {
		t.Errorf("top: porch %d, 0 %d of %v", s.Top[p], s.Top[0], s.Layers)
	}
	// Dead pixels show no layer: they're in no area.
	if s.Top[482] != -1 {
		t.Errorf("dead pixel top %d", s.Top[482])
	}

	px := f.m.inspect(f.m.state().View, p, ShowAuto)
	if px.Showing == nil || px.Showing.Layer != top.ID || px.Showing.Preview || px.Showing.Target != "porch" ||
		px.RGB != "#ff6240" || px.Run != "porch" || px.Controller != "yard" || px.Index != 390 || px.RunPixel != 89 {
		t.Errorf("inspect %+v showing %+v", px, px.Showing)
	}
	if strings.Join(px.Zones, ",") != "front,porch" || len(px.Mappings) != len(f.app.Mappings.IDs()) {
		t.Errorf("zones %v, %d mappings", px.Zones, len(px.Mappings))
	}

	// The house frame loop only captures at the stream rate.
	seq := s.Seq
	f.clock.Advance(time.Millisecond)
	f.app.RenderFrame(f.app.Ticker.Next())
	if s, _ := f.m.latest(ShowAuto); s.Seq != seq {
		t.Errorf("captured a frame 1 ms later")
	}
}

func TestPowerEstimate(t *testing.T) {
	f := newFixture(t)
	f.m.clients.Add(1)
	// Full white on the tower (shed output 2, 120 RGBW pixels at r,g,b 12 mA,
	// w 20 mA, 1 mA idle).
	f.push(t, "shed", "#ffffff/ff")
	f.frame(t)
	var pw struct {
		Frame    uint32        `json:"frame"`
		Estimate []OutputPower `json:"estimate"`
		Stage    *PowerReport  `json:"stage"`
	}
	f.get(t, "/api/map/power", &pw)
	if pw.Frame == 0 || len(pw.Estimate) != 4 {
		t.Fatalf("power %+v", pw)
	}
	// The default output stage reports its own figures and limit scale.
	if st := pw.Stage; st == nil || st.Group != "global" || !(st.Scale > 0 && st.Scale <= 1) ||
		len(st.Outputs) != 4 || len(st.Controllers) != 2 || st.Outputs[1].MA > st.Outputs[1].MaxMA+1e-6 {
		t.Errorf("stage %+v", pw.Stage)
	}
	tower := pw.Estimate[1]
	if tower.Controller != "shed" || tower.Output != 2 || math.Abs(tower.MA-120*(3*12+20+1)) > 1e-6 || tower.MaxMA != 2000 || !tower.Known {
		t.Errorf("tower %+v", tower)
	}
	// The porch is dark: idle only.
	if porch := pw.Estimate[3]; porch.MA != 90 || porch.Count != 90 {
		t.Errorf("porch %+v", porch)
	}
}

func TestPreviewClock(t *testing.T) {
	f := newFixture(t)
	m := f.m
	control := func(c PreviewControl) PreviewState {
		t.Helper()
		resp := f.post(t, "/api/map/preview", c)
		var st PreviewState
		if err := json.NewDecoder(resp.Body).Decode(&st); err != nil || resp.StatusCode != 200 {
			t.Fatalf("%+v: %s %v", c, resp.Status, err)
		}
		return st
	}
	at := func(st PreviewState, want time.Time) {
		t.Helper()
		if math.Abs(st.T-clock.Seconds(want)) > 1e-6 {
			t.Errorf("preview at %v, want %v", st.T, clock.Seconds(want))
		}
	}
	if st := m.State(); !st.Following || st.Previewing || st.Paused || st.Speed != 1 {
		t.Fatalf("initial %+v", st)
	}

	st := control(PreviewControl{Action: "pause"})
	f.clock.Advance(2 * time.Second)
	st = control(PreviewControl{Action: "step"}) // one house frame (40 fps)
	at(st, t0.Add(25*time.Millisecond))
	if !st.Paused || st.Following || !st.Previewing || math.Abs(st.Offset+1.975) > 1e-6 {
		t.Errorf("paused %+v", st)
	}
	back := -0.5
	at(control(PreviewControl{Action: "step", Seconds: &back}), t0.Add(-475*time.Millisecond))

	// Speed is clamped to 0.1–10.
	if st := control(PreviewControl{Action: "speed", Speed: 50}); st.Speed != MaxSpeed {
		t.Errorf("speed %v", st.Speed)
	}
	if st := control(PreviewControl{Action: "speed", Speed: 0.01}); st.Speed != MinSpeed {
		t.Errorf("speed %v", st.Speed)
	}
	control(PreviewControl{Action: "speed", Speed: 4})
	control(PreviewControl{Action: "resume"})
	f.clock.Advance(time.Second)
	at(m.State(), t0.Add(3525*time.Millisecond))

	// Scrub: seek to an absolute time, or relative to the preview.
	tt := clock.Seconds(t0.Add(time.Hour))
	at(control(PreviewControl{Action: "seek", T: &tt}), t0.Add(time.Hour))
	off := -30.0
	control(PreviewControl{Action: "pause"})
	at(control(PreviewControl{Action: "seek", Offset: &off}), t0.Add(time.Hour-30*time.Second))

	for _, bad := range []PreviewControl{{Action: "speed", Speed: -1}, {Action: "seek"}, {Action: "rewind"}} {
		if resp := f.post(t, "/api/map/preview", bad); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%+v: %s", bad, resp.Status)
		}
	}

	// Live rejoins the house.
	st = control(PreviewControl{Action: "live"})
	at(st, f.clock.Now())
	if !st.Following || st.Previewing || st.Paused || st.Speed != 1 {
		t.Errorf("live %+v", st)
	}
}

func TestPreviewRendersWithoutTouchingTheHouse(t *testing.T) {
	f := newFixture(t)
	m := f.m
	m.clients.Add(1)
	house := f.push(t, "everything", "#0000ff")
	// A house layer that ends in a minute.
	brief, err := f.app.Stack.Push(stack.Layer{Owner: stack.OwnerCLI, Target: "porch", Effect: "solid",
		Params: map[string]any{"color": "#00ff00", "fade_in": "0s"}, Lifetime: stack.Lifetime{For: units.Duration(time.Minute)}})
	if err != nil {
		t.Fatal(err)
	}

	// A preview layer goes through the preview engine's validation.
	if resp := f.post(t, "/api/map/preview/layers", map[string]any{"target": "nowhere", "effect": "solid"}); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("bad target: %s", resp.Status)
	}
	resp := f.post(t, "/api/map/preview/layers", map[string]any{"target": "yard", "effect": "solid", "params": map[string]any{"color": "#ff0000"}})
	var pl stack.Layer
	if err := json.NewDecoder(resp.Body).Decode(&pl); err != nil || resp.StatusCode != 200 {
		t.Fatalf("push: %s %v", resp.Status, err)
	}
	if !strings.HasPrefix(pl.ID, "p") || pl.Owner != OwnerPreview || !m.previewing() {
		t.Errorf("preview layer %+v", pl)
	}

	// Scrub two hours ahead and render the preview.
	off := 2 * 3600.0
	if err := m.Control(PreviewControl{Action: "seek", Offset: &off}); err != nil {
		t.Fatal(err)
	}
	m.renderPreview()
	s, _ := m.latest(ShowAuto)
	if s == nil || !s.Preview {
		t.Fatalf("snapshot %+v", s)
	}
	yard, _ := f.app.Layout.Area("yard")
	porch, _ := f.app.Layout.Area("porch")
	y, p := yard.Pixels[0], porch.Pixels[0]
	if got := s.RGB[3*y : 3*y+3]; got[0] != 255 || got[2] != 0 || s.Layers[s.Top[y]] != previewIDPrefix+pl.ID {
		t.Errorf("yard %v top %v", got, s.Layers[s.Top[y]])
	}
	// The brief house layer has ended at the preview's time; the porch
	// shows the long-lived house layer.
	if got := s.RGB[3*p : 3*p+3]; got[1] != 0 || got[2] != 255 || s.Layers[s.Top[p]] != houseIDPrefix+house.ID {
		t.Errorf("porch %v top %v", got, s.Layers[s.Top[p]])
	}
	if sh := m.inspect(m.state().View, y, ShowAuto).Showing; sh == nil || !sh.Preview || sh.Layer != pl.ID {
		t.Errorf("inspect showing %+v", sh)
	}

	// The house still has both layers, and its frames don't show the
	// preview layer.
	if ls := f.app.Stack.List(); len(ls) != 2 || ls[0].ID != brief.ID {
		t.Errorf("house stack %+v", ls)
	}
	var houseBuf *render.Buffer
	f.app.OnFrame(func(_ clock.Frame, b *render.Buffer) { houseBuf = b })
	f.frame(t)
	if c := houseBuf.Pix[y]; c.R != 0 || c.B != 1 {
		t.Errorf("house yard pixel %+v", c)
	}
	// While previewing, house frames aren't captured.
	if s2, _ := m.latest(ShowAuto); s2 != s {
		t.Errorf("house frame replaced the preview")
	}

	// Paused and unchanged: no new render.
	m.Control(PreviewControl{Action: "pause"})
	m.renderPreview()
	s, _ = m.latest(ShowAuto)
	m.renderPreview()
	if s2, _ := m.latest(ShowAuto); s2 != s {
		t.Error("re-rendered an unchanged paused preview")
	}

	// Removing the preview layer and going live hands back to the house.
	req, _ := http.NewRequest(http.MethodDelete, f.srv.URL+"/api/map/preview/layers/"+pl.ID, nil)
	dresp, err := http.DefaultClient.Do(req)
	if err != nil || dresp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %v %v", dresp.Status, err)
	}
	dresp.Body.Close()
	if len(m.State().Layers) != 0 {
		t.Errorf("preview layers %+v", m.State().Layers)
	}
	m.Control(PreviewControl{Action: "live"})
	if m.previewing() {
		t.Error("still previewing")
	}
	f.frame(t)
	if s, _ := m.latest(ShowAuto); s.Preview {
		t.Error("expected a house frame")
	}
}

func TestWebsocketStream(t *testing.T) {
	f := newFixture(t)
	f.push(t, "porch", "#00ff00")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.srv.URL, "http")+"/api/map/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()

	readSub := func() Subscribed {
		t.Helper()
		typ, b, err := c.Read(ctx)
		if err != nil || typ != websocket.MessageText {
			t.Fatalf("read: %v %v", typ, err)
		}
		var s Subscribed
		if err := json.Unmarshal(b, &s); err != nil || s.Type != "subscribed" {
			t.Fatalf("subscribed: %s %v", b, err)
		}
		return s
	}
	readFrame := func() []byte {
		t.Helper()
		typ, b, err := c.Read(ctx)
		if err != nil || typ != websocket.MessageBinary {
			t.Fatalf("read frame: %v %v", typ, err)
		}
		return b
	}

	s := readSub()
	if s.FPS != DefaultFPS || s.Count != 1084 || len(s.Ranges) != 1 || s.Ranges[0] != (Range{0, 1083}) {
		t.Errorf("default subscription %+v", s)
	}
	for f.m.clients.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	f.frame(t)
	b := readFrame()
	if len(b) != frameHeader+3*1084 || b[0] != frameVersion || b[1] != 0 {
		t.Fatalf("frame len %d header % x", len(b), b[:4])
	}
	if got := math.Float64frombits(binary.LittleEndian.Uint64(b[8:])); math.Abs(got-clock.Seconds(f.clock.Now())) > 1e-6 {
		t.Errorf("frame time %v", got)
	}
	porch, _ := f.app.Layout.Area("porch")
	p := int(porch.Pixels[0])
	if px := b[frameHeader+3*p : frameHeader+3*p+3]; px[0] != 0 || px[1] != 255 || px[2] != 0 {
		t.Errorf("porch pixel %v", px)
	}

	// Ask for the porch only at 5 fps (and an area that doesn't exist).
	msg, _ := json.Marshal(Subscription{FPS: 5, Areas: []string{"porch", "attic"}})
	if err := c.Write(ctx, websocket.MessageText, msg); err != nil {
		t.Fatal(err)
	}
	s = readSub()
	if s.FPS != 5 || s.Count != 90 || len(s.Unknown) != 1 || s.Unknown[0] != "attic" || len(s.Ranges) != 1 {
		t.Errorf("porch subscription %+v", s)
	}
	// The current frame is resent in the new shape.
	b = readFrame()
	if len(b) != frameHeader+3*90 || b[frameHeader+1] != 255 {
		t.Errorf("porch frame len %d", len(b))
	}
	// Asking for more than the cap gets the cap.
	msg, _ = json.Marshal(Subscription{FPS: 100})
	c.Write(ctx, websocket.MessageText, msg)
	if s = readSub(); s.FPS != DefaultFPS || s.Count != 1084 {
		t.Errorf("capped subscription %+v", s)
	}
}

// TestService runs the real frame loop and the map's own loop together,
// streaming to a client while the preview is driven, under -race.
func TestService(t *testing.T) {
	hs := httpserver.New("127.0.0.1:0", Mount(Options{FPS: 50}))
	a, err := app.New(app.Options{ConfigDir: exampleConfig, FPS: 100, Services: []app.Service{hs.Service()}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Stack.Push(stack.Layer{Target: "shed", Effect: "solid", Params: map[string]any{"color": "#ff0000"}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	addr, err := hs.ListenAddr(ctx)
	if err != nil {
		t.Fatal(err)
	}
	srv := struct{ URL string }{"http://" + addr.String()}

	var c *websocket.Conn
	for c == nil {
		c, _, err = websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/map/ws", nil)
		if err != nil {
			if ctx.Err() != nil {
				t.Fatal(err)
			}
			time.Sleep(5 * time.Millisecond) // routes register when the service starts
		}
	}
	defer c.CloseNow()
	frames := func(n int) (preview int) {
		for got := 0; got < n; {
			typ, b, err := c.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if typ == websocket.MessageBinary {
				got++
				if b[1]&flagPreview != 0 {
					preview++
				}
			}
		}
		return preview
	}
	frames(3)
	post := func(path, body string) {
		resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
		if err != nil || resp.StatusCode >= 300 {
			t.Fatalf("%s %s: %v %v", path, body, resp.Status, err)
		}
		resp.Body.Close()
	}
	post("/api/map/preview", `{"action":"speed","speed":2}`)
	post("/api/map/preview/layers", `{"target":"porch","effect":"solid"}`)
	if n := frames(5); n < 3 {
		t.Errorf("%d of 5 frames from the preview", n)
	}
	post("/api/map/preview", `{"action":"live"}`)
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/map/preview/layers", nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}
	frames(3)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestPreviewNamespaceCannotCollideWithChosenHouseID(t *testing.T) {
	f := newFixture(t)
	house, err := f.app.Stack.Push(stack.Layer{ID: "preview:p1", Target: "porch", Effect: "solid", Params: map[string]any{"color": "#ff0000"}})
	if err != nil {
		t.Fatal(err)
	}
	pl, err := f.app.PushPreview(stack.Layer{Target: "yard", Effect: "solid", Params: map[string]any{"color": "#0000ff"}})
	if err != nil {
		t.Fatal(err)
	}
	f.m.renderPreview()
	s, _ := f.m.latest(ShowAuto)
	porch, _ := f.app.Current().Layout.Area("porch")
	p := porch.Pixels[0]
	if got := s.RGB[3*p : 3*p+3]; !bytes.Equal(got, []byte{255, 0, 0}) {
		t.Errorf("preview cache collision changed house layer on map: %v", got)
	}
	if sh := f.m.inspect(f.m.state().View, p, ShowAuto).Showing; sh == nil || sh.Preview || sh.Layer != house.ID {
		t.Errorf("house layer misidentified as preview %s: %+v", pl.ID, sh)
	}
	// The same chosen id must also inspect correctly in a house snapshot.
	f.m.ClearPreview()
	f.m.touch(ShowAuto)
	f.frame(t)
	if sh := f.m.inspect(f.m.state().View, p, ShowAuto).Showing; sh == nil || sh.Preview || sh.Layer != house.ID {
		t.Errorf("house snapshot misidentified: %+v", sh)
	}
}

// pushPreview puts a solid preview layer on target through the API.
func (f *fixture) pushPreview(t *testing.T, target, hex string) stack.Layer {
	t.Helper()
	resp := f.post(t, "/api/map/preview/layers", map[string]any{"target": target, "effect": "solid",
		"params": map[string]any{"color": hex, "fade_in": "0s"}})
	var l stack.Layer
	if err := json.NewDecoder(resp.Body).Decode(&l); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("push preview: %s %v", resp.Status, err)
	}
	return l
}

func TestPromote(t *testing.T) {
	f := newFixture(t)
	house := f.push(t, "yard", "#0000ff")
	bottom := f.pushPreview(t, "yard", "#ff0000")
	top := f.pushPreview(t, "porch", "#00ff00")

	// An unknown id moves nothing.
	if resp := f.post(t, "/api/map/preview/promote", map[string]any{"ids": []string{top.ID, "p99"}}); resp.StatusCode != http.StatusNotFound {
		t.Errorf("unknown id: %s", resp.Status)
	}
	if n := len(f.app.Preview.List()); n != 2 {
		t.Fatalf("preview has %d layers after a failed promote", n)
	}

	// One layer.
	var out struct{ Layers []stack.Layer }
	resp := f.post(t, "/api/map/preview/promote", map[string]any{"ids": []string{top.ID}})
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || resp.StatusCode != http.StatusOK || len(out.Layers) != 1 {
		t.Fatalf("promote one: %s %v %+v", resp.Status, err, out)
	}
	got := out.Layers[0]
	if hs := f.app.Stack.List(); len(hs) != 2 || hs[0].ID != got.ID || hs[1].ID != house.ID {
		t.Errorf("house stack %+v", hs)
	}
	if got.Owner != OwnerPreview || got.Target != "porch" || got.Seed != top.Seed || got.Params["color"] != "#00ff00" {
		t.Errorf("promoted %+v", got)
	}
	if ps := f.app.Preview.List(); len(ps) != 1 || ps[0].ID != bottom.ID {
		t.Errorf("preview %+v", ps)
	}

	// Everything (no body), keeping the preview's order: the top one ends
	// on top of the house stack.
	upper := f.pushPreview(t, "yard", "#ffffff")
	r, err := http.Post(f.srv.URL+"/api/map/preview/promote", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	out.Layers = nil
	if err := json.NewDecoder(r.Body).Decode(&out); err != nil || r.StatusCode != http.StatusOK || len(out.Layers) != 2 {
		t.Fatalf("promote all: %s %v %+v", r.Status, err, out)
	}
	r.Body.Close()
	hs := f.app.Stack.List()
	if len(hs) != 4 || hs[0].Params["color"] != "#ffffff" || hs[1].Params["color"] != "#ff0000" || hs[0].Seed != upper.Seed {
		t.Errorf("house stack %+v", hs)
	}
	if n := len(f.app.Preview.List()); n != 0 {
		t.Errorf("preview still has %d layers", n)
	}

	// The lights show it.
	var buf *render.Buffer
	f.app.OnFrame(func(_ clock.Frame, b *render.Buffer) { buf = b })
	f.frame(t)
	yard, _ := f.app.Layout.Area("yard")
	if c := buf.Pix[yard.Pixels[0]]; c.R != 1 || c.G != 1 || c.B != 1 {
		t.Errorf("house yard pixel %+v", c)
	}
}

// TestShowHouseWhilePreviewing checks that a viewer can ask for the
// house's frames while the preview is active, without changing what
// other viewers see.
func TestShowHouseWhilePreviewing(t *testing.T) {
	f := newFixture(t)
	f.push(t, "yard", "#0000ff")
	pl := f.pushPreview(t, "yard", "#ff0000")
	yard, _ := f.app.Layout.Area("yard")
	y := int(yard.Pixels[0])

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.srv.URL, "http")+"/api/map/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	read := func(want websocket.MessageType) []byte {
		t.Helper()
		typ, b, err := c.Read(ctx)
		if err != nil || typ != want {
			t.Fatalf("read: %v %v", typ, err)
		}
		return b
	}
	read(websocket.MessageText) // default subscription
	msg, _ := json.Marshal(Subscription{Show: ShowHouse})
	if err := c.Write(ctx, websocket.MessageText, msg); err != nil {
		t.Fatal(err)
	}
	var s Subscribed
	if err := json.Unmarshal(read(websocket.MessageText), &s); err != nil || s.Show != ShowHouse {
		t.Fatalf("subscribed %+v %v", s, err)
	}
	for f.m.houseClients.Load() == 0 {
		time.Sleep(time.Millisecond)
	}

	// While previewing, the house frame is still captured for this
	// client, and the preview is rendered for everyone else.
	f.frame(t)
	b := read(websocket.MessageBinary)
	if b[1]&1 != 0 {
		t.Errorf("flags %x: got a preview frame", b[1])
	}
	if px := b[frameHeader+3*y : frameHeader+3*y+3]; px[0] != 0 || px[2] != 255 {
		t.Errorf("house yard pixel %v", px)
	}
	f.m.renderPreview()
	if s, _ := f.m.latest(ShowAuto); s == nil || !s.Preview || s.RGB[3*y] != 255 {
		t.Errorf("auto snapshot %+v", s)
	}
	if s, _ := f.m.latest(ShowHouse); s == nil || s.Preview || s.RGB[3*y+2] != 255 {
		t.Errorf("house snapshot %+v", s)
	}

	// Inspect follows ?show=.
	var px PixelJSON
	f.get(t, "/api/map/pixels/"+strconv.Itoa(y)+"?show=house", &px)
	if px.Preview || px.RGB != "#0000ff" || px.Showing == nil || px.Showing.Preview {
		t.Errorf("inspect show=house %+v", px)
	}
	f.get(t, "/api/map/pixels/"+strconv.Itoa(y), &px)
	if !px.Preview || px.Showing == nil || px.Showing.Layer != pl.ID {
		t.Errorf("inspect auto %+v", px)
	}
	if r, _ := http.Get(f.srv.URL + "/api/map/power?show=lights"); r.StatusCode != http.StatusBadRequest {
		t.Errorf("bad show: %s", r.Status)
	}

	// Back to auto: the client stops counting as a house viewer.
	msg, _ = json.Marshal(Subscription{})
	c.Write(ctx, websocket.MessageText, msg)
	read(websocket.MessageText)
	for f.m.houseClients.Load() != 0 {
		time.Sleep(time.Millisecond)
	}
}

func TestAreaIncludeGraph(t *testing.T) {
	dir := copyConfig(t)
	path := filepath.Join(dir, "areas.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Add an area referencing a range area and two runs (one repeated).
	s := strings.Replace(string(b), "areas:\n", `areas:
  - id: assembly
    include: [{area: shed-north}, tower, {run: shed-eave, from: shed-nw, to: shed-ne}, tower, {area: porch}]
`, 1)
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
	f := newFixtureIn(t, dir)
	var g struct {
		Areas []AreaJSON `json:"areas"`
	}
	f.get(t, "/api/map/geometry", &g)
	areas := map[string]AreaJSON{}
	for _, a := range g.Areas {
		areas[a.ID] = a
		if a.Includes == nil || a.Runs == nil {
			t.Errorf("null graph fields: %+v", a)
		}
	}
	for _, tt := range []struct {
		id             string
		includes, runs []string
	}{
		{"shed-north", []string{}, []string{"shed-eave"}},
		{"assembly", []string{"shed-north", "porch"}, []string{"tower", "shed-eave"}},
		{"everything", []string{"shed", "yard", "porch"}, []string{}},
	} {
		a := areas[tt.id]
		if !reflect.DeepEqual(a.Includes, tt.includes) || !reflect.DeepEqual(a.Runs, tt.runs) {
			t.Errorf("area %s: %+v", tt.id, a)
		}
	}
}

func TestMapDistinguishesWarmWhiteFromRGBWhite(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   units.Color
		want [3]byte
	}{
		{"RGB white", units.Color{R: 255, G: 255, B: 255}, [3]byte{255, 255, 255}},
		{"warm white", units.Color{W: 255}, [3]byte{255, 196, 128}},
		{"dim warm white", units.Color{W: 128}, [3]byte{128, 98, 64}},
		{"RGB plus warm white", units.Color{R: 100, G: 40, W: 128}, [3]byte{228, 138, 64}},
		{"RGB unchanged", units.Color{R: 18, G: 52, B: 86}, [3]byte{18, 52, 86}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := displayRGBW(color.Linear(tc.in)); got != tc.want {
				t.Fatalf("display RGBW = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSectionRoutes(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{"/presets", "/presets/", "/map/presets", "/map/presets/", "/", "/looks", "/setup", "/status", "/looks/", "/setup/", "/status/", "/map/", "/map/looks", "/map/setup", "/map/status", "/map/looks/", "/map/setup/", "/map/status/"} {
		t.Run(path, func(t *testing.T) {
			resp, err := http.Get(f.srv.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Content-Type"), "text/html") || !bytes.Contains(body, []byte(`<base href="/map/">`)) {
				t.Fatalf("route %s: status=%d type=%s missing shell or asset base", path, resp.StatusCode, resp.Header.Get("Content-Type"))
			}
		})
	}
	for _, path := range []string{"/map/unknown", "/map/looks/unknown"} {
		resp, err := http.Get(f.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound || !bytes.Contains(body, []byte("Back to the map")) {
			t.Fatalf("%s: got %d, designed page: %v", path, resp.StatusCode, bytes.Contains(body, []byte("Back to the map")))
		}
	}
	resp, err := http.Get(f.srv.URL + "/api/map/nothing-here")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound || bytes.Contains(body, []byte("Back to the map")) {
		t.Fatalf("an unknown API path should keep its plain 404: %d %s", resp.StatusCode, body)
	}
}

// The real server also registers the API under a pattern with no
// method; the page routes have to coexist with that.
func TestPageRoutesCoexistWithAPIMounts(t *testing.T) {
	f := newFixture(t)
	mux := httpserver.New("")
	mux.Handle("/api/v1/", http.NotFoundHandler())
	f.m.Register(mux)
}

func TestLegacySectionRedirects(t *testing.T) {
	f := newFixture(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for from, to := range map[string]string{"/map/presets": "/presets", "/presets/": "/presets", "/map": "/", "/map/": "/", "/map/looks": "/looks", "/map/setup/": "/setup", "/map/status?show=house": "/status?show=house", "/looks/": "/looks"} {
		resp, err := client.Get(f.srv.URL + from)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusPermanentRedirect || resp.Header.Get("Location") != to {
			t.Errorf("%s: status %d location %q, want %s", from, resp.StatusCode, resp.Header.Get("Location"), to)
		}
	}
}
