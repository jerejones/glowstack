// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jerejones/glowstack/internal/stack"
)

// copyConfig copies the example config so a test can edit it.
func copyConfig(t *testing.T) string {
	t.Helper()
	dst := t.TempDir()
	entries, err := os.ReadDir(exampleConfig)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(exampleConfig, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

func TestReloadRebuildsTheMap(t *testing.T) {
	cfg := copyConfig(t)
	f := newFixtureIn(t, cfg)
	m := f.m
	f.push(t, "porch", "#00ff00")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.srv.URL, "http")+"/api/map/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	read := func() (websocket.MessageType, []byte) {
		t.Helper()
		typ, b, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return typ, b
	}
	if _, b := read(); !strings.Contains(string(b), `"gen":0`) {
		t.Fatalf("first subscription %s", b)
	}
	for m.clients.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	f.frame(t)
	if typ, _ := read(); typ != websocket.MessageBinary {
		t.Fatal("no frame")
	}

	// Drop the shed-north area (and the zone segment using it).
	areas := filepath.Join(cfg, "areas.yaml")
	orig, _ := os.ReadFile(areas)
	fixed := strings.Replace(string(orig), "  - id: shed-north\n    include: [{ run: shed-eave, from: shed-nw, to: shed-ne }]\n", "", 1)
	fixed = strings.Replace(fixed, "      - { area: shed-north, mapping: east-west }\n", "", 1)
	if fixed == string(orig) {
		t.Fatal("test edit didn't apply to areas.yaml")
	}
	os.WriteFile(areas, []byte(fixed), 0o644)
	if _, err := f.app.Reload(); err != nil {
		t.Fatal(err)
	}

	var g struct {
		Gen   uint64     `json:"gen"`
		Areas []AreaJSON `json:"areas"`
	}
	f.get(t, "/api/map/geometry", &g)
	if g.Gen != 1 {
		t.Errorf("geometry gen %d", g.Gen)
	}
	for _, a := range g.Areas {
		if a.ID == "shed-north" {
			t.Error("geometry still lists the removed area")
		}
	}

	// The next house frame is on the new layout: the stream says so
	// first, then sends it.
	f.frame(t)
	typ, b := read()
	var sub Subscribed
	if typ != websocket.MessageText || json.Unmarshal(b, &sub) != nil || sub.Gen != 1 || sub.Count != 1084 {
		t.Fatalf("after reload: %v %s", typ, b)
	}
	if typ, _ := read(); typ != websocket.MessageBinary {
		t.Fatal("no frame after reload")
	}
	if s, _ := m.latest(); s.Gen != 1 {
		t.Errorf("snapshot gen %d", s.Gen)
	}

	// The preview engine follows too, and a preview layer pushed through
	// the app (as the control API does) shows on the map.
	pl, err := f.app.PushPreview(stack.Layer{Target: "yard", Effect: "solid", Params: map[string]any{"color": "#ff0000"}})
	if err != nil {
		t.Fatal(err)
	}
	if !m.previewing() || len(m.State().Layers) != 1 {
		t.Fatalf("API preview layer not on the map: %+v", m.State())
	}
	m.renderPreview()
	s, _ := m.latest()
	yard, _ := f.app.Current().Layout.Area("yard")
	y := yard.Pixels[0]
	if !s.Preview || s.Gen != 1 || s.Layers[s.Top[y]] != previewIDPrefix+pl.ID {
		t.Errorf("preview after reload: gen %d top %v", s.Gen, s.Layers)
	}
	if sh := m.inspect(m.state().View, y).Showing; sh == nil || !sh.Preview || sh.Layer != pl.ID {
		t.Errorf("inspect %+v", sh)
	}
}
