// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package preset

import (
	"fmt"
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
	if errs := l.Check(r, palette.NewRegistry(cfg.Palettes), 1.0/60, nil); len(errs) > 0 {
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
		{ID: "p", Effect: "gradient", Params: map[string]any{"palette": "Sunset Glow"}},
		{ID: "m", Effect: "solid", Params: map[string]any{"mapping": "sideways"}},
		{ID: "i", Effect: "solid", Params: map[string]any{"mapping": map[string]any{"kind": "radial"}}},
		{ID: "ok", Effect: "gradient", Params: map[string]any{"palette": "Ocean", "opacity": 0.5, "mapping": "known"}},
	})
	mapping := func(c render.Common) error {
		if c.Inline == nil && c.Mapping != "known" {
			return fmt.Errorf("no mapping %q", c.Mapping)
		}
		return nil
	}
	errs := l.Check(r, palette.NewRegistry(nil), 0.02, mapping)
	want := []string{`no effect "fire"`, "speed", "blend", `"Sunset Glow"`, `preset m: mapping: no mapping "sideways"`, "missing center"}
	if len(errs) != len(want) {
		t.Fatalf("errors = %v", errs)
	}
	for i, w := range want {
		if !strings.Contains(errs[i].Error(), w) {
			t.Errorf("error %d = %v, want %q", i, errs[i], w)
		}
	}
}
