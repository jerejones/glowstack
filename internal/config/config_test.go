// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const exampleDir = "../../examples/fictional"

func TestLoadExample(t *testing.T) {
	c, err := Load(filepath.Join(exampleDir, "config"), filepath.Join(exampleDir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Controllers) != 2 || c.Controllers[1].Port != DefaultPort || c.Controllers[1].Transport != "ddp" {
		t.Errorf("controllers: %+v", c.Controllers)
	}
	if got := c.Layout.Pitch.Value; got < 0.0333 || got > 0.0334 {
		t.Errorf("pitch = %v", got)
	}
	eave := c.Layout.Runs[0]
	if eave.ID != "shed-eave" || eave.Pos.Line == 0 || eave.Pos.File != LayoutFileName {
		t.Errorf("eave pos = %v", eave.Pos)
	}
	if eave.Anchors[0].Source != SourceEstimated || eave.Anchors[1].Source != SourceMeasured || *eave.Anchors[1].Index != 305 {
		t.Errorf("anchors = %+v", eave.Anchors)
	}
	if c.Layout.Runs[4].Indices != [2]int{479, 390} || !c.Layout.Runs[4].Plan.Reverse {
		t.Errorf("porch = %+v", c.Layout.Runs[4])
	}
	if len(c.Anchors) != 1 || c.Anchors[0].Index != 186 {
		t.Errorf("data anchors = %+v", c.Anchors)
	}
	if c.Areas[3].Include[0].From.Node != "shed-nw" || c.Areas[4].Include[1].Area != "yard" {
		t.Errorf("areas = %+v", c.Areas)
	}
	f := c.Flows[0]
	if f.Pace != PaceReference || f.Unreached != UnreachedLocal || f.Orient[0].Into != "tower-top" {
		t.Errorf("flow = %+v", f)
	}
	if c.Mappings[3].Order[1] != "tower" || c.Mappings[1].Angle == nil {
		t.Errorf("mappings = %+v", c.Mappings)
	}
	if !c.Palettes[1].Stops[2].Color.HasW || !*c.Palettes[1].Wrap {
		t.Errorf("palettes = %+v", c.Palettes)
	}
	p, ok := c.Preset("slow-crawl")
	if !ok || p.Params["speed"] != "1 px/8s" {
		t.Errorf("preset = %+v", p)
	}
	if bands, ok := p.Params["bands"].([]any); !ok || len(bands) != 2 {
		t.Errorf("bands param = %#v", p.Params["bands"])
	}
	if time.Duration(*c.Settings.Fade.In) != 300*time.Millisecond || c.Settings.Boot != "restore" {
		t.Errorf("settings = %+v", c.Settings)
	}
}

// writeConfig writes a minimal valid config folder, with files overridden
// by extra.
func writeConfig(t *testing.T, extra map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		ControllersFileName: "schema: 1\ncontrollers:\n  - { id: shed, host: 192.0.2.1, pixels: 100 }\n",
		LayoutFileName:      "schema: 1\npitch: 1/60 m\nruns:\n  - { id: a, controller: shed, indices: [0, 99], path: [x, y] }\n",
	}
	for k, v := range extra {
		files[k] = v
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestLoadErrorsNameFileAndLine(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{"unknown field", map[string]string{ControllersFileName: "schema: 1\ncontrollers:\n  - id: shed\n    host: h\n    pixels: 10\n    colour: red\n"},
			`controllers.yaml:6: unknown field "colour"`},
		{"bad unit", map[string]string{LayoutFileName: "schema: 1\npitch: 1/60 furlongs\n"},
			`layout.yaml:2: bad length "1/60 furlongs"`},
		{"missing schema", map[string]string{LayoutFileName: "pitch: 1 m\n"},
			"layout.yaml:1: missing `schema: 1`"},
		{"wrong schema", map[string]string{LayoutFileName: "schema: 2\n"},
			`layout.yaml:1: unsupported schema "2"`},
		{"unknown controller", map[string]string{LayoutFileName: "schema: 1\npitch: 1 cm\nruns:\n  - id: a\n    controller: nope\n    indices: [0, 9]\n    path: [x, y]\n"},
			`layout.yaml:4: run "a": unknown controller "nope"`},
		{"index out of range", map[string]string{LayoutFileName: "schema: 1\npitch: 1 cm\nruns:\n  - { id: a, controller: shed, indices: [0, 100], path: [x, y] }\n"},
			`layout.yaml:4: run "a": index 100 outside`},
		{"duplicate run", map[string]string{LayoutFileName: "schema: 1\npitch: 1 cm\nruns:\n  - { id: a, controller: shed, indices: [0, 9], path: [x, y] }\n  - { id: a, controller: shed, indices: [10, 19], path: [x, y] }\n"},
			`layout.yaml:5: duplicate run id "a" (first at layout.yaml:4)`},
		{"bad enum", map[string]string{MappingsFileName: "schema: 1\nflows:\n  - { id: f, origin: x, pace: fastest }\n"},
			`mappings.yaml:3: pace "fastest"`},
		{"unknown area in zone", map[string]string{AreasFileName: "schema: 1\nzones:\n  - { id: z, area: nope }\n"},
			`areas.yaml:3: zone "z": unknown area "nope"`},
		{"bad colour", map[string]string{PalettesFileName: "schema: 1\npalettes:\n  - id: p\n    stops: [[0, \"#zz0000\"]]\n"},
			`palettes.yaml:4: bad colour "#zz0000"`},
		{"wrong shape", map[string]string{ControllersFileName: "schema: 1\ncontrollers: shed\n"},
			`controllers.yaml:2: want a list, got a value`},
		{"gap without length", map[string]string{LayoutFileName: "schema: 1\npitch: 1 cm\nedges:\n  - { kind: gap, from: a, to: b }\n"},
			`layout.yaml:4: gap a–b needs a positive length`},
		{"reserved mapping id", map[string]string{MappingsFileName: "schema: 1\nmappings:\n  - { id: local, kind: local }\n"},
			`mappings.yaml:3: mapping id "local" is built in`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load(writeConfig(t, tt.files), "")
			if err == nil {
				t.Fatal("want error")
			}
			var es Errors
			if !errors.As(err, &es) {
				t.Fatalf("error type %T: %v", err, err)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error:\n%v\nwant it to contain %q", err, tt.want)
			}
		})
	}
}

func TestMissingRequiredFile(t *testing.T) {
	dir := t.TempDir()
	_, err := Load(dir, "")
	if err == nil || !strings.Contains(err.Error(), ControllersFileName) || !strings.Contains(err.Error(), LayoutFileName) {
		t.Fatalf("err = %v", err)
	}
}

func TestSavedPresetShadows(t *testing.T) {
	dir := writeConfig(t, map[string]string{PresetsFileName: "schema: 1\npresets:\n  - { id: p, effect: solid }\n"})
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(data, SavedPresetsFileName), []byte("schema: 1\npresets:\n  - { id: p, effect: bands }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := c.Preset("p"); p.Effect != "bands" || !p.Saved {
		t.Errorf("preset = %+v", p)
	}
}

func TestAnchorOverridesRejectUnknownRunsAndDuplicates(t *testing.T) {
	for _, tt := range []struct{ name, body, want string }{
		{"unknown run", "  - {run: missing, node: corner, index: 5}\n", `unknown run "missing"`},
		{"duplicate", "  - {run: a, node: corner, index: 5}\n  - {run: a, node: corner, index: 6}\n", "duplicate anchor"},
		{"outside run", "  - {run: a, node: corner, index: 100}\n", "outside run"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := writeConfig(t, nil)
			data := t.TempDir()
			if err := os.WriteFile(filepath.Join(data, AnchorsFileName), []byte("schema: 1\nanchors:\n"+tt.body), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := Load(dir, data)
			if err == nil || !strings.Contains(err.Error(), "anchors.yaml:") || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want anchors.yaml file:line and %q", err, tt.want)
			}
		})
	}
}
