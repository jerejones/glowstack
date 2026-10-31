// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package ctl

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/api"
	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/httpserver"
)

// serve starts an App on the fictional example with the API behind an
// httptest server.
func serve(t *testing.T) (*app.App, string) {
	t.Helper()
	data := t.TempDir()
	b, err := os.ReadFile("../../examples/fictional/data/anchors.yaml")
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(data, "anchors.yaml"), b, 0o644)
	a, err := app.New(app.Options{ConfigDir: "../../examples/fictional/config", DataDir: data,
		Clock: clock.NewManual(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)), Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	srv := httpserver.New("", api.Mount)
	if err := srv.Mount(a); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return a, ts.URL
}

// ctl runs the CLI and returns its exit code, stdout and stderr.
func ctl(url string, args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := Main(append([]string{"--server", url}, args...), &out, &errb)
	return code, out.String(), errb.String()
}

func TestCommands(t *testing.T) {
	a, url := serve(t)
	run := func(want string, args ...string) string {
		t.Helper()
		code, out, errs := ctl(url, args...)
		if code != 0 || !strings.Contains(out, want) {
			t.Errorf("ctl %v: exit %d, stdout %q, stderr %q; want %q", args, code, out, errs, want)
		}
		return out
	}
	run("no layers", "layers")
	run("pushed layer 1: solid on porch", "push", "porch", "solid", "color=#ff0000", "opacity=0.5", "for=10s")
	run("pushed layer 2: preset:warm-white on shed", "push", "shed", "warm-white", "brightness=50%")
	l, _ := a.Stack.Get("1")
	if l.Owner != "cli" || l.Params["color"] != "#ff0000" || l.Params["opacity"] != 0.5 || l.Lifetime.For != 10e9 {
		t.Errorf("pushed %+v", l)
	}
	out := run("preset:warm-white", "layers")
	if strings.Index(out, "\n2 ") > strings.Index(out, "\n1 ") {
		t.Errorf("layers not top first:\n%s", out)
	}
	run("edited layer 1: solid on porch color=#00ff00", "edit", "1", "color=#00ff00", "opacity=")
	if l, _ := a.Stack.Get("1"); l.Params["opacity"] != nil || l.Params["color"] != "#00ff00" {
		t.Errorf("edited %+v", l)
	}
	run("pushed layer p1", "push", "--preview", "porch", "solid", `color="#0000ff"`)
	if len(a.Preview.List()) != 1 || len(a.Stack.List()) != 2 {
		t.Error("--preview pushed to the wrong stack")
	}
	run("removed layer p1", "rm", "--preview", "p1")
	run("removed layer 1", "rm", "1")
	run("master 100%", "bri")
	run("master 40%", "bri", "0.4")
	run("zone porch 50%", "bri", "porch", "50%")
	if b := a.Brightness(); b.Master != 0.4 || b.Zones["porch"] != 0.5 {
		t.Errorf("brightness %+v", b)
	}
	run("common to every layer: mapping", "effects")
	run("color", "effects", "solid")
	run("warm-white", "presets")
	run("porch", "areas")
	run("Glowstack Porch", "zones")
	run("default: front-sweep", "mappings")
	run("192.0.2.", "controllers")
	run("1084 pixels", "status")
	run("reloaded: 1084 pixels (was 1084)", "reload")
	run("removed 1 layers", "rm", "--all")

	// --json prints the server's reply.
	_, out, _ = ctl(url, "--json", "bri")
	var b map[string]any
	if err := json.Unmarshal([]byte(out), &b); err != nil || b["master"] != 0.4 {
		t.Errorf("--json bri: %q %v", out, err)
	}
}

func TestErrors(t *testing.T) {
	_, url := serve(t)
	for _, c := range []struct {
		args []string
		code int
		want string
	}{
		{[]string{"push", "nowhere", "solid"}, 1, `no area "nowhere"`},
		{[]string{"push", "porch", "solid", "colour=#fff"}, 1, `has no parameter "colour"`},
		{[]string{"push", "porch"}, 2, "want <area>"},
		{[]string{"push", "porch", "solid", "color"}, 2, "want key=value"},
		{[]string{"edit", "9", "opacity=1"}, 1, `no layer "9"`},
		{[]string{"rm", "9"}, 1, "9: no such layer"},
		{[]string{"bri", "loud"}, 2, "want 0–1"},
		{[]string{"bri", "1.5"}, 1, "brightness must be 0–1"},
		{[]string{"frobnicate"}, 2, `unknown command "frobnicate"`},
	} {
		code, _, errs := ctl(url, c.args...)
		if code != c.code || !strings.Contains(errs, c.want) {
			t.Errorf("ctl %v: exit %d, stderr %q; want %d containing %q", c.args, code, errs, c.code, c.want)
		}
	}
	if code, _, errs := ctl("http://127.0.0.1:1", "status"); code != 1 || errs == "" {
		t.Errorf("unreachable server: %d %q", code, errs)
	}
}

func TestBody(t *testing.T) {
	c := &client{now: func() time.Time { return time.Date(2026, 1, 1, 22, 0, 0, 0, time.UTC) }}
	body, err := c.body([]string{"color=#ff0000", "speed=1 px/8s", "reverse=true", `bands=[{"color":"#fff","width":"2 px"}]`,
		"target=porch", "until=21:30", "for=5 s"}, false)
	if err != nil {
		t.Fatal(err)
	}
	p := body["params"].(map[string]any)
	if p["color"] != "#ff0000" || p["speed"] != "1 px/8s" || p["reverse"] != true || len(p["bands"].([]any)) != 1 {
		t.Errorf("params %v", p)
	}
	if body["target"] != "porch" || body["until"] != "2026-01-02T21:30:00Z" || body["for"] != "5 s" {
		t.Errorf("body %v", body)
	}
	if _, err := c.body([]string{"color="}, false); err == nil {
		t.Error("empty value accepted in a push")
	}
	body, _ = c.body([]string{"color="}, true)
	if v, ok := body["params"].(map[string]any)["color"]; !ok || v != nil {
		t.Errorf("edit removal %v", body)
	}
}
