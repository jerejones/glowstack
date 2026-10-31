// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPresetsFileRoundTrip(t *testing.T) {
	half := 0.5
	in := &PresetsFile{Schema: 1,
		Presets: []Preset{
			{ID: "red", Name: "Red", Effect: "solid", Params: map[string]any{"color": "#ff0000", "opacity": 0.5}},
			{ID: "7", Effect: "bands", Params: map[string]any{
				"bands":   []any{map[string]any{"color": "#ff5a00", "width": "20 px"}},
				"mapping": map[string]any{"origin": "gate-w", "pin": []any{map[string]any{"node": "gate-e", "u": "1 m"}}},
			}},
			{ID: "bare", Effect: "solid"},
		},
		Composites: []Composite{{ID: "c", Layers: []CompositeLayer{
			{Name: "base", Effect: "solid"},
			{Effect: "sparkle", Blend: "add", Opacity: &half, Params: map[string]any{"density": "3 /m/s"}},
		}}},
	}
	b, err := EncodePresetsFile(in)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("\n%s", b)
	out, err := DecodePresetsFile(SavedPresetsFileName, b)
	if err != nil {
		t.Fatal(err)
	}
	for i := range in.Presets {
		if got, want := out.Presets[i], in.Presets[i]; got.ID != want.ID || got.Effect != want.Effect || !reflect.DeepEqual(got.Params, want.Params) {
			t.Errorf("preset %d = %+v, want %+v", i, got, want)
		}
	}
	if c := out.Composites[0]; len(c.Layers) != 2 || *c.Layers[1].Opacity != 0.5 || c.Layers[1].Blend != "add" {
		t.Errorf("composite %+v", c)
	}
	// Load reads it back as saved presets.
	dir, data := writeConfig(t, nil), t.TempDir()
	os.WriteFile(filepath.Join(data, SavedPresetsFileName), b, 0o644)
	c, err := Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := c.Preset("7"); !ok || !p.Saved {
		t.Errorf("loaded %+v", c.Presets)
	}
}
