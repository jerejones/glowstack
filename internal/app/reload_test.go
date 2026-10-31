// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/output"
)

// rebuildRecorder is a recorder that notes Rebuild calls.
type rebuildRecorder struct {
	recorder
	rebuilt []*layout.Layout
}

func (r *rebuildRecorder) Rebuild(_ *config.Config, l *layout.Layout) error {
	r.rebuilt = append(r.rebuilt, l)
	return nil
}

func TestReloadRebuildsOutputs(t *testing.T) {
	cfg := t.TempDir()
	entries, err := os.ReadDir(exampleConfig)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(exampleConfig, e.Name()))
		os.WriteFile(filepath.Join(cfg, e.Name()), b, 0o644)
	}
	sink := &rebuildRecorder{}
	a, err := New(Options{ConfigDir: cfg, DataDir: dataDir(t), Sink: sink,
		Clock: clock.NewManual(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC))})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	stage := a.Stage()
	if err := a.RenderFrame(a.Ticker.Next()); err != nil {
		t.Fatal(err)
	}
	if g := stage.(output.PowerReporter).Power().Group; g != output.GroupGlobal {
		t.Fatalf("group %q", g)
	}

	settings := filepath.Join(cfg, "glowstack.yaml")
	b, _ := os.ReadFile(settings)
	os.WriteFile(settings, []byte(strings.Replace(string(b), "group: global", "group: controller", 1)), 0o644)
	if _, err := a.Reload(); err != nil {
		t.Fatal(err)
	}
	if len(sink.rebuilt) != 0 {
		t.Error("rebuilt before the next frame")
	}
	if err := a.RenderFrame(a.Ticker.Next()); err != nil {
		t.Fatal(err)
	}
	if len(sink.rebuilt) != 1 || sink.rebuilt[0] != a.Current().Layout {
		t.Errorf("sink rebuilt %d times", len(sink.rebuilt))
	}
	if a.Stage() != stage {
		t.Error("the default stage was replaced, not rebuilt")
	}
	if g := stage.(output.PowerReporter).Power().Group; g != output.GroupController {
		t.Errorf("group after reload %q", g)
	}
	if err := a.RenderFrame(a.Ticker.Next()); err != nil || len(sink.rebuilt) != 1 {
		t.Errorf("rebuilt again: %d, %v", len(sink.rebuilt), err)
	}
}
