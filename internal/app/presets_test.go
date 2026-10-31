// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// copyExample copies the fictional config folder, for tests that change it.
func copyExample(t *testing.T) string {
	t.Helper()
	cfg := t.TempDir()
	entries, err := os.ReadDir(exampleConfig)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(exampleConfig, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cfg, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return cfg
}

func TestPresetWarnings(t *testing.T) {
	cfg := copyExample(t)
	path := filepath.Join(cfg, "presets.yaml")
	b, _ := os.ReadFile(path)
	broken := string(b) + `
  - { id: no-effect, effect: fire }
  - { id: no-palette, effect: gradient, params: { palette: sunset-glow } }
  - { id: no-mapping, effect: solid, params: { mapping: sideways } }
  - { id: bad-inline, effect: solid, params: { mapping: { origin: nowhere } } }
  - { id: inline-ok, effect: solid, params: { mapping: { kind: radial, center: gate-w } } }
`
	// The composites follow the presets in the file; put these before them.
	broken = strings.Replace(string(b), "\ncomposites:", broken[len(b):]+"\ncomposites:", 1)
	if err := os.WriteFile(path, []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	a, err := New(Options{ConfigDir: cfg, DataDir: dataDir(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	want := []string{
		`preset no-effect: no effect "fire"`,
		`preset no-palette:`,
		`preset no-mapping: mapping: no mapping "sideways"`,
		`preset bad-inline: mapping: inline mapping: flow`,
	}
	check := func(got []string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("warnings:\n%s", strings.Join(got, "\n"))
		}
		for i, w := range want {
			if !strings.Contains(got[i], w) || !strings.Contains(got[i], "presets.yaml:") {
				t.Errorf("warning %d = %q, want %q with its line", i, got[i], w)
			}
		}
	}
	check(a.PresetWarnings())
	var sb strings.Builder
	a.Summary(&sb)
	if !strings.Contains(sb.String(), "4 warnings:") || !strings.Contains(sb.String(), `no mapping "sideways"`) {
		t.Errorf("summary:\n%s", sb.String())
	}
	res, err := a.Reload()
	if err != nil {
		t.Fatal(err)
	}
	check(res.Warnings)
}
