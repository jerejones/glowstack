// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package ctl

import (
	"errors"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/api"
	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/calibrate"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/render"
)

func TestCalibrateCommands(t *testing.T) {
	data := t.TempDir()
	b, err := os.ReadFile("../../examples/fictional/data/anchors.yaml")
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(data, "anchors.yaml"), b, 0o644)
	a, err := app.New(app.Options{ConfigDir: "../../examples/fictional/config", DataDir: data,
		Clock: clock.NewManual(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)), Log: slog.New(slog.DiscardHandler),
		Effects: func(r *render.Registry) error { return errors.Join(effects.Register(r), calibrate.Register(r)) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	srv := httpserver.New("", api.Mount, calibrate.Mount)
	if err := srv.Mount(a); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	run := func(want string, args ...string) string {
		t.Helper()
		code, out, errs := ctl(ts.URL, append([]string{"cal"}, args...)...)
		if code != 0 {
			t.Fatalf("cal %v: exit %d: %s", args, code, errs)
		}
		if !strings.Contains(out, want) {
			t.Errorf("cal %v: output lacks %q:\n%s", args, want, out)
		}
		return out
	}
	run("not running")
	run("calibrating anchor shed-eave-mid on shed-eave", "start")
	run("shed:393", "set", "393")
	run("moved +10", "+10")
	run("moved +9", "-1")
	run("shed-eave-mid on shed-eave measured at shed:402", "confirm")
	run("3 of 4 anchors measured")
	run("calibrating gap gate-w–gate-e", "gap", "gate-w", "gate-e")
	run("measured at 1.25 m", "confirm", "1.25", "m")
	run("bands on controller yard", "bands", "controller:yard")
	run("calibration ended", "stop")
	if n := len(a.Stack.List()); n != 0 {
		t.Errorf("%d layers left after stop", n)
	}
	file, _ := os.ReadFile(filepath.Join(data, "anchors.yaml"))
	if !strings.Contains(string(file), "node: shed-eave-mid, index: 402") || !strings.Contains(string(file), "length: 1.25 m") {
		t.Errorf("anchors.yaml:\n%s", file)
	}
	if code, _, errs := ctl(ts.URL, "cal", "confirm"); code != 1 || !strings.Contains(errs, "no calibration target") {
		t.Errorf("confirm with no session: %d %s", code, errs)
	}
	if code, _, _ := ctl(ts.URL, "cal", "corner", "x"); code != 2 {
		t.Errorf("unknown target: exit %d", code)
	}
}
