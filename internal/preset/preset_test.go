// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package preset

import (
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/render"
)

const exampleConfig = "../../examples/fictional/config"

func TestLibrary(t *testing.T) {
	l := New([]config.Preset{
		{ID: "a", Effect: "solid", Params: map[string]any{"color": "#ff0000"}},
		{ID: "b", Effect: "bands"},
		{ID: "a", Effect: "solid", Params: map[string]any{"color": "#00ff00", "opacity": 0.5}, Saved: true},
		{ID: "c", Effect: "chase", Saved: true},
	})
	list := l.List()
	if len(list) != 3 || list[0].ID != "a" || !list[0].Saved || list[2].ID != "c" {
		t.Fatalf("list = %+v", list)
	}
	layer, err := l.Apply("a", "porch", map[string]any{"color": "#0000ff", "opacity": nil, "reverse": true})
	if err != nil {
		t.Fatal(err)
	}
	if layer.Target != "porch" || layer.Effect != "solid" || layer.Params["color"] != "#0000ff" ||
		layer.Params["reverse"] != true || layer.Params["opacity"] != nil {
		t.Errorf("layer = %+v", layer)
	}
	if p, _ := l.Get("a"); p.Params["color"] != "#00ff00" {
		t.Error("Apply changed the preset")
	}
	if _, err := l.Apply("nope", "porch", nil); err == nil {
		t.Error("unknown preset: want an error")
	}
}

// TestExamplePresets loads the fictional installation and checks every
// preset and composite in it.
func TestExamplePresets(t *testing.T) {
	cfg, err := config.Load(exampleConfig, "")
	if err != nil {
		t.Fatal(err)
	}
	r := render.NewRegistry()
	if err := effects.Register(r); err != nil {
		t.Fatal(err)
	}
	if err := effects.RegisterComposites(r, cfg.Composites); err != nil {
		t.Fatal(err)
	}
	l := New(cfg.Presets)
	if errs := l.Check(r, palette.NewRegistry(cfg.Palettes), 1.0/60); len(errs) > 0 {
		t.Fatal(errs)
	}
	// Each primitive and the two milestone looks are covered.
	used := map[string]bool{}
	for _, p := range l.List() {
		used[p.Effect] = true
	}
	for _, id := range []string{"solid", "bands", "gradient", "sparkle", "chase", "noise", "breathe", "glitter"} {
		if !used[id] {
			t.Errorf("no example preset uses %s", id)
		}
	}
	for _, id := range []string{"slow-crawl", "glitter"} {
		if _, ok := l.Get(id); !ok {
			t.Errorf("no preset %q", id)
		}
	}
}

func TestCheckFindsMistakes(t *testing.T) {
	r := render.NewRegistry()
	if err := effects.Register(r); err != nil {
		t.Fatal(err)
	}
	l := New([]config.Preset{
		{ID: "x", Effect: "fire"},
		{ID: "y", Effect: "bands", Params: map[string]any{"speed": "fast"}},
		{ID: "z", Effect: "solid", Params: map[string]any{"blend": "sideways"}},
		{ID: "ok", Effect: "gradient", Params: map[string]any{"palette": "Ocean", "opacity": 0.5}},
	})
	errs := l.Check(r, palette.NewRegistry(nil), 0.02)
	if len(errs) != 3 || !strings.Contains(errs[0].Error(), `no effect "fire"`) ||
		!strings.Contains(errs[1].Error(), "speed") || !strings.Contains(errs[2].Error(), "blend") {
		t.Errorf("errors = %v", errs)
	}
}
