// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
)

// presetList returns id → source from GET /api/v1/presets.
func (f *fixture) presetList() map[string]string {
	f.t.Helper()
	out := map[string]string{}
	for _, p := range f.must(http.StatusOK, "GET", "/api/v1/presets", nil)["presets"].([]any) {
		m := p.(map[string]any)
		out[m["id"].(string)] = m["source"].(string)
	}
	return out
}

func TestSavePreset(t *testing.T) {
	f := newFixture(t, nil)
	if got := f.presetList(); got["slow-crawl"] != SourceConfig || got["red"] != "" {
		t.Fatalf("presets %v", got)
	}

	// From a body.
	p := f.must(http.StatusCreated, "PUT", "/api/v1/presets/red", map[string]any{
		"name": "Red", "effect": "solid", "params": map[string]any{"color": "#ff0000", "fade_in": "0s"}})
	if p["source"] != SourceSaved || p["effect"] != "solid" || p["name"] != "Red" {
		t.Errorf("saved %v", p)
	}
	if got := f.presetList(); got["red"] != SourceSaved {
		t.Errorf("presets %v", got)
	}
	// It's usable at once, and on disk.
	id := f.must(http.StatusCreated, "POST", "/api/v1/layers", map[string]any{"target": "porch", "use": "red", "fade_out": "0s"})["id"].(string)
	f.render(0)
	f.expect(f.porch, "100", "the saved preset")
	b, err := os.ReadFile(filepath.Join(f.data, config.SavedPresetsFileName))
	if err != nil || !strings.HasPrefix(string(b), "# Written by Glowstack") || !strings.Contains(string(b), "id: red") {
		t.Fatalf("presets.saved.yaml: %v\n%s", err, b)
	}

	// Replacing it is a 200, and a layer using it by id follows.
	f.must(http.StatusOK, "PUT", "/api/v1/presets/red", map[string]any{"effect": "solid", "params": map[string]any{"color": "#00ff00"}})
	f.render(0)
	f.expect(f.porch, "010", "the replaced preset")

	// From a layer, expanding its preset, with params merged over it.
	p = f.must(http.StatusCreated, "PUT", "/api/v1/presets/dim-green", map[string]any{
		"from_layer": id, "params": map[string]any{"opacity": 0.5, "fade_out": nil}})
	if pp := p["params"].(map[string]any); p["effect"] != "solid" || pp["color"] != "#00ff00" || pp["opacity"] != 0.5 || pp["fade_out"] != nil {
		t.Errorf("from layer: %v", p)
	}
	// From a preview layer.
	pv := f.must(http.StatusCreated, "POST", "/api/v1/preview/layers", map[string]any{
		"target": "yard", "effect": "gradient", "params": map[string]any{"palette": "Ocean", "mapping": map[string]any{"origin": "gate-e"}}})
	p = f.must(http.StatusCreated, "PUT", "/api/v1/presets/ocean-gate", map[string]any{"from_layer": pv["id"], "preview": true})
	if p["effect"] != "gradient" {
		t.Errorf("from a preview layer: %v", p)
	}
	// The preview stack is searched anyway; preview: true searches only it.
	f.must(http.StatusOK, "PUT", "/api/v1/presets/ocean-gate", map[string]any{"from_layer": pv["id"]})
	f.must(http.StatusNotFound, "PUT", "/api/v1/presets/dim-green", map[string]any{"from_layer": id, "preview": true})

	// Saved presets survive a restart, inline mapping and all.
	f.restart()
	if got := f.presetList(); got["red"] != SourceSaved || got["dim-green"] != SourceSaved || got["ocean-gate"] != SourceSaved {
		t.Errorf("after restart: %v", got)
	}
	if p := f.must(http.StatusOK, "GET", "/api/v1/presets/ocean-gate", nil); p["params"].(map[string]any)["mapping"].(map[string]any)["origin"] != "gate-e" {
		t.Errorf("ocean-gate %v", p)
	}

	// Deleting one: layers that named it are dropped by the reload.
	del := f.must(http.StatusOK, "DELETE", "/api/v1/presets/red", nil)
	if del["deleted"] != "red" || len(del["dropped"].([]any)) != 1 || del["now"] != nil {
		t.Errorf("delete %v", del)
	}
	if got := f.presetList(); got["red"] != "" {
		t.Errorf("after delete: %v", got)
	}
}

func TestSavePresetErrors(t *testing.T) {
	f := newFixture(t, nil)
	layer := f.push("porch", "#ff0000", nil)
	for _, tt := range []struct {
		method, path string
		body         any
		status       int
		want         string
	}{
		{"PUT", "/api/v1/presets/slow-crawl", map[string]any{"effect": "solid"}, 409, "presets.yaml, which Glowstack never changes"},
		{"DELETE", "/api/v1/presets/slow-crawl", nil, 409, "presets.yaml"},
		{"DELETE", "/api/v1/presets/nope", nil, 404, `no saved preset "nope"`},
		{"GET", "/api/v1/presets/nope", nil, 404, `no preset "nope"`},
		{"PUT", "/api/v1/presets/x", map[string]any{"effect": "fire"}, 400, `no effect "fire"`},
		{"PUT", "/api/v1/presets/x", map[string]any{}, 400, "needs an effect or from_layer"},
		{"PUT", "/api/v1/presets/x", map[string]any{"effect": "solid", "params": map[string]any{"colour": "#fff"}}, 400, `unknown parameter "colour"`},
		{"PUT", "/api/v1/presets/x", map[string]any{"effect": "solid", "params": map[string]any{"mapping": "sideways"}}, 400, `no mapping "sideways"`},
		{"PUT", "/api/v1/presets/x", map[string]any{"effect": "solid", "params": map[string]any{"mapping": map[string]any{"origin": "nowhere"}}}, 400, `unknown origin node "nowhere"`},
		{"PUT", "/api/v1/presets/x", map[string]any{"effect": "solid", "from_layer": layer}, 400, "not both"},
		{"PUT", "/api/v1/presets/x", map[string]any{"from_layer": "99"}, 404, `no layer "99"`},
		{"PUT", "/api/v1/presets/x", map[string]any{"effect": "solid", "colour": "#fff"}, 400, `unknown field "colour"`},
		{"PUT", "/api/v1/presets/x", map[string]any{"effect": "solid", "id": "y"}, 400, "doesn't match"},
		{"PUT", "/api/v1/presets/a%20b", map[string]any{"effect": "solid"}, 400, `id "a b"`},
	} {
		code, out := f.do(tt.method, tt.path, tt.body)
		if code != tt.status || !strings.Contains(out["error"].(string), tt.want) {
			t.Errorf("%s %s %v: %d %v, want %d %q", tt.method, tt.path, tt.body, code, out, tt.status, tt.want)
		}
	}
	if _, err := os.Stat(filepath.Join(f.data, config.SavedPresetsFileName)); err == nil {
		t.Error("a failed save wrote presets.saved.yaml")
	}
}

// A saved preset may shadow a configured one (written by hand); the API
// edits and deletes the saved one, and the configured one comes back.
func TestSavedPresetShadowsConfig(t *testing.T) {
	f := newFixture(t, nil)
	os.WriteFile(filepath.Join(f.data, config.SavedPresetsFileName),
		[]byte("schema: 1\npresets:\n  - { id: warm-white, effect: solid, params: { color: \"#0000ff\" } }\n"), 0o644)
	f.must(http.StatusOK, "POST", "/api/v1/reload", nil)
	p := f.must(http.StatusOK, "GET", "/api/v1/presets/warm-white", nil)
	if p["source"] != SourceSaved || p["shadows"] != true {
		t.Errorf("shadowing preset %v", p)
	}
	if n := len(f.must(http.StatusOK, "GET", "/api/v1/presets", nil)["presets"].([]any)); n != 11 {
		t.Errorf("%d presets listed, want 11 (the shadowed one once)", n)
	}
	f.must(http.StatusOK, "PUT", "/api/v1/presets/warm-white", map[string]any{"effect": "solid", "params": map[string]any{"color": "#00ff00"}})
	del := f.must(http.StatusOK, "DELETE", "/api/v1/presets/warm-white", nil)
	if now := del["now"].(map[string]any); now["source"] != SourceConfig {
		t.Errorf("after delete %v", del)
	}
}
