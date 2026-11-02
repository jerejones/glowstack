// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"bytes"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/scene"
)

// shedScene is a made-up model of the example: one wall layer, the shed
// eave at 2.5 m, the tower climbing to 1.7 m, and the west fence at
// 2.5 m. glTF is Y up, so a point is [x, height, plan y].
const shedScene = `{"scenes":[{"extras":{"glowstack":{"schema":1,"units":"m","axes":"gltf-y-up"}}}],
 "nodes":[{"name":"walls lines","mesh":0},{"name":"walls faces","mesh":1},
  {"extras":{"glowstack_run":"shed-eave","points":[[11,2.5,9],[5,2.5,9],[5,2.5,5],[8,2.5,5],[11,2.5,5]],
   "nodes":"shed-se,shed-sw,shed-nw,shed-eave-mid,shed-ne"}},
  {"extras":{"glowstack_run":"tower","points":[[12.5,0,9.5],[13.5,1.7,9.5],[14.5,0,9.5]],"nodes":"tower-l,tower-top,tower-r"}},
  {"extras":{"glowstack_run":"fence-west","points":[[11,2.5,9],[11,2.5,17]],"nodes":"shed-se,gate-w"}}],
 "meshes":[{"primitives":[{"mode":1}]},{"primitives":[{}]}]}`

// TestSceneMap serves the example with a scene model: the geometry says
// so, carries heights and glowstack.yaml's map settings, and the model is
// served for the page to load.
func TestSceneMap(t *testing.T) {
	dir := copyConfig(t)
	if err := os.WriteFile(filepath.Join(dir, "site.glb"), scene.GLB([]byte(shedScene)), 0o644); err != nil {
		t.Fatal(err)
	}
	edit := func(name, old, new string) {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		s := string(b)
		if !strings.Contains(s, old) {
			t.Fatalf("%s has no %q", name, old)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(strings.Replace(s, old, new, 1)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	edit("layout.yaml", "plans:", "scene: { glb: site.glb }\nplans:")
	for _, run := range []string{"eave", "tower", "fence-west"} {
		model := map[string]string{"eave": "shed-eave"}[run]
		if model == "" {
			model = run
		}
		edit("layout.yaml", `plan: { svg: "plan.svg#`+run+`" }`, `model: { glb: "site.glb#`+model+`" }`)
	}
	edit("glowstack.yaml", "schema: 1", `schema: 1
map:
  view: { from: [-6, -14, 9], to: [4, 0, 1] }
  layers:
    walls faces: { visible: false }
    walls lines: { color: "#aabbcc", opacity: 0.5 }`)
	f := newFixtureIn(t, dir)

	var g struct {
		Pixels struct {
			Z []*float64 `json:"z"`
		} `json:"pixels"`
		Plans []PlanJSON `json:"plans"`
		Map   MapJSON    `json:"map"`
	}
	f.get(t, "/api/map/geometry", &g)
	if len(g.Plans) != 1 || g.Plans[0].Kind != "scene" || len(g.Plans[0].Layers) != 2 ||
		g.Plans[0].Layers[0] != (LayerJSON{Name: "walls lines", Kind: "lines"}) || g.Plans[0].Layers[1].Kind != "surfaces" {
		t.Fatalf("plans %+v", g.Plans)
	}
	// fence-west is yard 0–239; the yard's first global id follows the shed's.
	p := int(f.app.Layout.Controllers[1].Base)
	if z := g.Pixels.Z[p+100]; z == nil || math.Abs(*z-2.5) > 1e-6 {
		t.Errorf("fence pixel z = %v, want 2.5", z)
	}
	if v := g.Map.View; v == nil || v.FOV != 40 || v.From[2] != 9 {
		t.Errorf("view %+v", v)
	}
	if len(g.Map.Layers) != 2 || g.Map.Layers[0].Name != "walls faces" || *g.Map.Layers[0].Visible || g.Map.Layers[1].Color != "#aabbcc" {
		t.Errorf("layers %+v", g.Map.Layers)
	}

	resp, err := http.Get(f.srv.URL + g.Plans[0].URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "model/gltf-binary" || !bytes.HasPrefix(body, []byte("glTF")) {
		t.Errorf("model: %s %s", resp.Status, resp.Header.Get("Content-Type"))
	}
}

func TestDirectionViewJSON(t *testing.T) {
	dir := copyConfig(t)
	if err := os.WriteFile(filepath.Join(dir, "glowstack.yaml"), []byte("schema: 1\nmap:\n  view: {direction: [0, -3, 4]}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := newFixtureIn(t, dir)
	var g struct {
		Map struct {
			View map[string]any `json:"view"`
		} `json:"map"`
	}
	f.get(t, "/api/map/geometry", &g)
	v := g.Map.View
	d, ok := v["direction"].([]any)
	if !ok || len(d) != 3 || d[1] != -0.6 || d[2] != 0.8 || v["fov"] != float64(40) {
		t.Fatalf("view = %v", v)
	}
	if _, ok := v["from"]; ok {
		t.Errorf("from must be omitted: %v", v)
	}
	if _, ok := v["to"]; ok {
		t.Errorf("to must be omitted: %v", v)
	}
}
