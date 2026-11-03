// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package scene

import (
	"bytes"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/plan"
)

const frameOK = `"scenes":[{"extras":{"glowstack":{"schema":1,"units":"m","axes":"gltf-y-up"}}}]`

func parse(t *testing.T, doc string) (*Scene, error) {
	t.Helper()
	return Parse(bytes.NewReader(GLB([]byte(doc))))
}

func TestParseRunAndLayers(t *testing.T) {
	s, err := parse(t, `{`+frameOK+`,
	 "nodes":[
	  {"name":"walls lines","mesh":0},
	  {"name":"walls faces","mesh":1},
	  {"name":"shed-eave","extras":{"glowstack_run":"shed-eave","controller":"shed","indices":"0-1199",
	    "points":[[0,3,0],[4,3,0],[4,3,-2]],"nodes":"shed-se, ,shed-ne","basis":["model","model","estimated"]}},
	  {"name":"empty group"}],
	 "meshes":[{"primitives":[{"mode":1}]},{"primitives":[{}]}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Layers) != 2 || s.Layers[0] != (Layer{"walls lines", Lines}) || s.Layers[1] != (Layer{"walls faces", Surfaces}) {
		t.Errorf("layers = %+v", s.Layers)
	}
	r := s.Runs["shed-eave"]
	if r == nil {
		t.Fatal("run missing")
	}
	// glTF (x, y, z) is (x, -z, y) with Z up.
	want := []plan.Point{{X: 0, Y: 0, Z: 3}, {X: 4, Y: 0, Z: 3}, {X: 4, Y: 2, Z: 3}}
	for i, p := range r.Path.Points {
		if p != want[i] {
			t.Errorf("point %d = %v, want %v", i, p, want[i])
		}
	}
	if got := strings.Join(r.Path.Labels, "|"); got != "shed-se||shed-ne" {
		t.Errorf("labels = %q", got)
	}
	if r.Path.Length() != 6 {
		t.Errorf("length = %v, want 6", r.Path.Length())
	}
	if r.Controller != "shed" || len(r.Basis) != 3 {
		t.Errorf("run facts = %q %d", r.Controller, len(r.Basis))
	}
}

// TestIgnoresIndices: pixel indices aren't the model's business; an old
// exporter's extra is ignored, even when malformed.
func TestIgnoresIndices(t *testing.T) {
	if _, err := parse(t, `{`+frameOK+`,"nodes":[{"extras":{"glowstack_run":"a","indices":"a-b",
	  "points":[[0,0,0],[1,0,0]],"nodes":"x,y"}}]}`); err != nil {
		t.Fatal(err)
	}
}

func TestParseErrors(t *testing.T) {
	run := func(extras string) string {
		return `{` + frameOK + `,"nodes":[{"extras":{"glowstack_run":"a",` + extras + `}}]}`
	}
	cases := []struct{ name, doc, want string }{
		{"no frame", `{"scenes":[{}]}`, "don't state its frame"},
		{"wrong axes", `{"scenes":[{"extras":{"glowstack":{"schema":1,"units":"m","axes":"z-up"}}}]}`, "axes"},
		{"wrong units", `{"scenes":[{"extras":{"glowstack":{"schema":1,"units":"ft","axes":"gltf-y-up"}}}]}`, "units"},
		{"one point", run(`"points":[[0,0,0]],"nodes":"x"`), "at least two"},
		{"no nodes", run(`"points":[[0,0,0],[1,0,0]]`), "no nodes"},
		{"node count", run(`"points":[[0,0,0],[1,0,0]],"nodes":"x"`), "1 nodes for 2 points"},
		{"2-d point", run(`"points":[[0,0],[1,0,0]],"nodes":"x,y"`), "want [x, y, z]"},
		{"repeat point", run(`"points":[[0,0,0],[0,0,0]],"nodes":"x,y"`), "are the same"},
		{"repeat label", run(`"points":[[0,0,0],[1,0,0],[2,0,0]],"nodes":"x,y,x"`), "labels two points"},
		{"basis count", run(`"points":[[0,0,0],[1,0,0]],"nodes":"x,y","basis":["m"]`), "basis"},
	}
	for _, c := range cases {
		_, err := parse(t, c.doc)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
	if _, err := Parse(strings.NewReader("<svg/>")); err == nil {
		t.Error("non-GLB accepted")
	}
	dup := `{` + frameOK + `,"nodes":[` +
		`{"extras":{"glowstack_run":"a","points":[[0,0,0],[1,0,0]],"nodes":"x,y"}},` +
		`{"extras":{"glowstack_run":"a","points":[[0,0,0],[1,0,0]],"nodes":"x,y"}}]}`
	if _, err := parse(t, dup); err == nil || !strings.Contains(err.Error(), "twice") {
		t.Errorf("duplicate run: err = %v", err)
	}
}
