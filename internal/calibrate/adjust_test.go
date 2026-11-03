// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
)

// towerData is a data folder with tower-top measured at offset 62 of the
// example's 120-LED tower (shed output 2).
func towerData(t *testing.T) string {
	t.Helper()
	data := t.TempDir()
	body := "schema: 1\nanchors:\n  - { run: tower, node: tower-top, offset: 62, pixels: 120, source: measured }\n"
	if err := os.WriteFile(filepath.Join(data, config.AnchorsFileName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return data
}

// setTowerCount copies the example config with shed output 2 at n LEDs.
func setTowerCount(t *testing.T, n string) string {
	t.Helper()
	dir := copyDir(t, exampleDir+"/config")
	p := filepath.Join(dir, config.ControllersFileName)
	b, _ := os.ReadFile(p)
	const old = "{ output: 2, gpio: 3,  count: 120,"
	s := strings.Replace(string(b), old, "{ output: 2, gpio: 3,  count: "+n+",", 1)
	if !strings.Contains(string(b), old) {
		t.Fatal("example's tower output not found")
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// towerTop loads dir and data and returns tower-top's controller index and
// the warnings.
func towerTop(t *testing.T, dir, data string) (int, config.Errors) {
	t.Helper()
	cfg, err := config.Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	l, err := layout.Build(cfg)
	if err != nil {
		t.Fatal(err)
	}
	r, _ := findRun(l, "tower")
	n, _ := l.NodeIndex("tower-top")
	for _, a := range r.Anchors {
		if a.Node == n {
			return a.Index, l.Warnings
		}
	}
	t.Fatal("no tower-top anchor")
	return 0, nil
}

func lengthWarnings(ws config.Errors) []string {
	var out []string
	for _, w := range ws {
		if strings.Contains(w.Error(), "taken when it had") {
			out = append(out, w.Error())
		}
	}
	return out
}

// TestAcceptFarEndChange: three LEDs added at the tower's far end. The
// anchor holds, one warning asks about it, and accept settles it.
func TestAcceptFarEndChange(t *testing.T) {
	dir, data := setTowerCount(t, "123"), towerData(t)
	idx, ws := towerTop(t, dir, data)
	if idx != 484+62 || len(lengthWarnings(ws)) != 1 {
		t.Fatalf("tower-top at %d, warnings %v", idx, lengthWarnings(ws))
	}
	msg, err := Adjust(dir, data, Adjustment{Op: AdjustAccept, Run: "tower"})
	if err != nil || !strings.Contains(msg, "accepted 1 measurement on tower at 123 LEDs") {
		t.Fatalf("accept: %q %v", msg, err)
	}
	if idx, ws = towerTop(t, dir, data); idx != 484+62 || len(lengthWarnings(ws)) != 0 {
		t.Errorf("after accept: tower-top at %d, warnings %v", idx, lengthWarnings(ws))
	}
	b, _ := os.ReadFile(filepath.Join(data, config.AnchorsFileName))
	if !strings.Contains(string(b), "offset: 62, pixels: 123,") {
		t.Errorf("anchors.yaml:\n%s", b)
	}
}

// TestShiftDataInputChange: five LEDs added at the tower's data input.
// The offset is now five short; shift moves it and settles the warning.
func TestShiftDataInputChange(t *testing.T) {
	dir, data := setTowerCount(t, "125"), towerData(t)
	if _, ws := towerTop(t, dir, data); len(lengthWarnings(ws)) != 1 {
		t.Fatalf("warnings %v", ws)
	}
	if _, err := Adjust(dir, data, Adjustment{Op: AdjustShift, Run: "tower", At: 0, N: 5}); err != nil {
		t.Fatal(err)
	}
	if idx, ws := towerTop(t, dir, data); idx != 484+67 || len(lengthWarnings(ws)) != 0 {
		t.Errorf("after shift: tower-top at %d, warnings %v", idx, lengthWarnings(ws))
	}
}

// TestShiftSkipsEarlierOffsets: only offsets at or past At move.
func TestShiftSkipsEarlierOffsets(t *testing.T) {
	dir, data := setTowerCount(t, "125"), towerData(t)
	if _, err := Adjust(dir, data, Adjustment{Op: AdjustShift, Run: "tower", At: 63, N: 5}); err != nil {
		t.Fatal(err)
	}
	if idx, _ := towerTop(t, dir, data); idx != 484+62 {
		t.Errorf("tower-top at %d, want unmoved", idx)
	}
}

// TestClearWhenTheConfigWontLoad: the tower cut to 50 LEDs leaves its
// anchor outside the run, so nothing loads; clear still works.
func TestClearWhenTheConfigWontLoad(t *testing.T) {
	dir, data := setTowerCount(t, "50"), towerData(t)
	if _, err := config.Load(dir, data); err == nil || !strings.Contains(err.Error(), "offset 62 outside run") {
		t.Fatalf("load: %v", err)
	}
	msg, err := Adjust(dir, data, Adjustment{Op: AdjustClear, Run: "tower"})
	if err != nil || !strings.Contains(msg, "cleared 1 measurement on tower") {
		t.Fatalf("clear: %q %v", msg, err)
	}
	if _, err := config.Load(dir, data); err != nil {
		t.Errorf("after clear: %v", err)
	}
}

func TestAdjustErrors(t *testing.T) {
	dir, data := setTowerCount(t, "120"), towerData(t)
	if _, err := Adjust(dir, data, Adjustment{Op: AdjustAccept, Run: "porch"}); err == nil || !strings.Contains(err.Error(), "no measurements for run porch") {
		t.Errorf("no measurements: %v", err)
	}
	if _, err := Adjust(dir, data, Adjustment{Op: AdjustAccept, Run: "nope"}); err == nil || !strings.Contains(err.Error(), `unknown run "nope"`) {
		t.Errorf("unknown run: %v", err)
	}
	// A shift that leaves the anchor outside the run is written, and
	// reported as config errors.
	_, err := Adjust(dir, data, Adjustment{Op: AdjustShift, Run: "tower", At: 0, N: 100})
	var errs config.Errors
	if !errors.As(err, &errs) {
		t.Errorf("bad shift: %v", err)
	}
}

// TestConfirmFlagsDensity: an anchor confirmed far from where the drawing
// puts it shows a density check in the session state, until the next
// target.
func TestConfirmFlagsDensity(t *testing.T) {
	f := newFixture(t, exampleDir+"/data", nil)
	f.ok(f.m.Select(Target{Kind: KindAnchor, Run: "shed-eave", Node: "shed-sw"}))
	f.ok(f.m.Set(-1, 60))
	st := f.ok(f.m.Confirm(ConfirmOptions{}))
	if len(st.Checks) == 0 || !strings.Contains(strings.Join(st.Checks, "\n"), "check that the anchor at shed-sw is on the right node") {
		t.Fatalf("checks = %q", st.Checks)
	}
	st = f.ok(f.m.Select(Target{Kind: KindAnchor, Run: "shed-eave", Node: "shed-nw"}))
	if len(st.Checks) != 0 {
		t.Errorf("checks after select = %q", st.Checks)
	}
}
