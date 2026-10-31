// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/render"
)

const exampleDir = "../../examples/fictional"

var t0 = time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)

// fixture is an App on the fictional installation with the API mounted.
type fixture struct {
	t      *testing.T
	app    *app.App
	clock  *clock.Manual
	h      http.Handler
	config string
	data   string
	pix    []color.Color // the last rendered frame
	porch  int32         // a pixel only in area porch
	shed   int32         // a pixel only in area shed
}

// copyDir copies the files of src into a new temporary folder.
func copyDir(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

// newFixture starts an App on copies of the example config and data
// folders. edit, if set, can change the config copy first.
func newFixture(t *testing.T, edit func(dir string)) *fixture {
	t.Helper()
	f := &fixture{t: t, clock: clock.NewManual(t0),
		config: copyDir(t, exampleDir+"/config"), data: copyDir(t, exampleDir+"/data")}
	if edit != nil {
		edit(f.config)
	}
	f.start()
	t.Cleanup(func() { f.app.Close() })
	return f
}

// start (re)creates the App on the fixture's folders, as after a restart.
func (f *fixture) start() {
	f.t.Helper()
	a, err := app.New(app.Options{ConfigDir: f.config, DataDir: f.data, Clock: f.clock, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		f.t.Fatal(err)
	}
	f.app = a
	srv := httpserver.New("", Mount)
	if err := srv.Mount(a); err != nil {
		f.t.Fatal(err)
	}
	f.h = srv.Handler()
	a.OnFrame(func(_ clock.Frame, buf *render.Buffer) { f.pix = append(f.pix[:0], buf.Pix...) })
	porch, _ := a.Layout.Area("porch")
	shed, _ := a.Layout.Area("shed")
	f.porch, f.shed = porch.Pixels[0], shed.Pixels[0]
}

// restart closes the App (saving state) and starts a new one.
func (f *fixture) restart() {
	f.t.Helper()
	if err := f.app.Close(); err != nil {
		f.t.Fatal(err)
	}
	f.start()
}

// do sends a request and decodes the JSON reply into a map.
func (f *fixture) do(method, path string, body any) (int, map[string]any) {
	f.t.Helper()
	var rd io.Reader
	if body != nil {
		if s, ok := body.(string); ok {
			rd = strings.NewReader(s)
		} else {
			b, err := json.Marshal(body)
			if err != nil {
				f.t.Fatal(err)
			}
			rd = bytes.NewReader(b)
		}
	}
	req := httptest.NewRequest(method, path, rd)
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	var out map[string]any
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			f.t.Fatalf("%s %s: reply isn't a JSON object: %v\n%s", method, path, err, rec.Body.String())
		}
	}
	return rec.Code, out
}

// must is do that fails the test unless the status is want.
func (f *fixture) must(want int, method, path string, body any) map[string]any {
	f.t.Helper()
	code, out := f.do(method, path, body)
	if code != want {
		f.t.Fatalf("%s %s: status %d, want %d: %v", method, path, code, want, out)
	}
	return out
}

// push pushes a solid layer with no fades and returns its id.
func (f *fixture) push(target, colour string, extra map[string]any) string {
	f.t.Helper()
	body := map[string]any{"target": target, "effect": "solid", "params": map[string]any{"color": colour},
		"fade_in": "0s", "fade_out": "0s"}
	for k, v := range extra {
		body[k] = v
	}
	return f.must(http.StatusCreated, "POST", "/api/v1/layers", body)["id"].(string)
}

// render advances the clock by d and renders a frame.
func (f *fixture) render(d time.Duration) {
	f.t.Helper()
	f.clock.Advance(d)
	if err := f.app.RenderFrame(f.app.Ticker.Next()); err != nil {
		f.t.Fatal(err)
	}
}

// ids returns the stack's layer ids, top first.
func (f *fixture) ids(path string) string {
	f.t.Helper()
	var s []string
	for _, l := range f.must(http.StatusOK, "GET", path, nil)["layers"].([]any) {
		s = append(s, l.(map[string]any)["id"].(string))
	}
	return strings.Join(s, ",")
}

// rgb describes a pixel of the last frame as r/g/b at full scale.
func (f *fixture) rgb(p int32) string {
	c := f.pix[p]
	ch := func(v float32) string {
		switch {
		case v > 0.99:
			return "1"
		case v < 0.01:
			return "0"
		}
		return "~"
	}
	return ch(c.R) + ch(c.G) + ch(c.B)
}

func (f *fixture) expect(p int32, want, what string) {
	f.t.Helper()
	if got := f.rgb(p); got != want {
		f.t.Errorf("%s: pixel %d is %s, want %s (%+v)", what, p, got, want, f.pix[p])
	}
}

func TestStackSemantics(t *testing.T) {
	f := newFixture(t, nil)

	// Push on top: the porch layer sits above the everything layer.
	red := f.push("everything", "#ff0000", nil)
	green := f.push("porch", "#00ff00", nil)
	if got := f.ids("/api/v1/layers"); got != green+","+red {
		t.Fatalf("stack %s", got)
	}
	f.render(0)
	f.expect(f.porch, "010", "porch under the green layer")
	f.expect(f.shed, "100", "shed under the red layer")

	// Edit in place keeps the position: the red layer turns blue but stays
	// under the green one.
	out := f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+red, map[string]any{"params": map[string]any{"color": "#0000ff"}})
	if out["position"].(float64) != 1 || out["params"].(map[string]any)["color"] != "#0000ff" {
		t.Errorf("edit reply %v", out)
	}
	if got := f.ids("/api/v1/layers"); got != green+","+red {
		t.Errorf("stack after edit %s", got)
	}
	f.render(time.Second)
	f.expect(f.porch, "010", "porch after editing the lower layer")
	f.expect(f.shed, "001", "shed after the edit")

	// Black is a colour: a black layer covers the porch.
	black := f.push("porch", "#000000", nil)
	f.render(time.Second)
	f.expect(f.porch, "000", "porch under a black layer")
	if f.pix[f.porch].A < 0.99 {
		t.Errorf("a black layer should cover the pixel, alpha %v", f.pix[f.porch].A)
	}

	// Removing layers reveals what's below.
	f.must(http.StatusNoContent, "DELETE", "/api/v1/layers/"+black, nil)
	f.render(time.Second)
	f.expect(f.porch, "010", "porch after removing the black layer")
	f.must(http.StatusNoContent, "DELETE", "/api/v1/layers/"+green, nil)
	f.render(time.Second)
	f.expect(f.porch, "001", "porch after removing the green layer")
	f.must(http.StatusNoContent, "DELETE", "/api/v1/layers/"+red, nil)
	f.render(time.Second)
	f.expect(f.porch, "000", "porch with no layers")
	if f.pix[f.porch].A != 0 {
		t.Errorf("an uncovered pixel should have no coverage, alpha %v", f.pix[f.porch].A)
	}
	f.must(http.StatusNotFound, "DELETE", "/api/v1/layers/"+red, nil)
}

func TestTimedLayer(t *testing.T) {
	f := newFixture(t, nil)
	base := f.push("everything", "#ff0000", nil)
	out := f.must(http.StatusCreated, "POST", "/api/v1/layers", map[string]any{
		"target": "porch", "effect": "solid", "params": map[string]any{"color": "#00ff00"},
		"fade_in": "0s", "fade_out": "0s", "for": "10 s",
	})
	timed := out["id"].(string)
	if exp, _ := time.Parse(time.RFC3339, out["expires"].(string)); !exp.Equal(t0.Add(10 * time.Second)) {
		t.Errorf("expires %v", out["expires"])
	}
	f.render(5 * time.Second)
	f.expect(f.porch, "010", "timed layer while it lasts")
	f.render(6 * time.Second)
	f.expect(f.porch, "100", "after the timed layer expired")
	if got := f.ids("/api/v1/layers"); got != base {
		t.Errorf("stack after expiry %q", got)
	}
	f.must(http.StatusNotFound, "GET", "/api/v1/layers/"+timed, nil)

	// In an edit, "for" counts from now; null makes the layer permanent.
	id := f.push("porch", "#0000ff", map[string]any{"for": "10 s"})
	f.render(8 * time.Second)
	out = f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+id, map[string]any{"for": "10 s"})
	if exp, _ := time.Parse(time.RFC3339, out["expires"].(string)); !exp.Equal(f.clock.Now().Add(10 * time.Second)) {
		t.Errorf("edited expiry %v, now %v", out["expires"], f.clock.Now())
	}
	out = f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+id, map[string]any{"lifetime": nil})
	if _, ok := out["expires"]; ok {
		t.Errorf("lifetime null should clear the expiry: %v", out)
	}
	f.render(time.Hour)
	f.expect(f.porch, "001", "permanent layer")
}

func TestPersistence(t *testing.T) {
	f := newFixture(t, nil)
	a := f.push("everything", "#ff0000", nil)
	b := f.push("porch", "#00ff00", map[string]any{"owner": "cli"})
	f.must(http.StatusOK, "PUT", "/api/v1/brightness", map[string]any{"master": 0.5, "zones": map[string]any{"porch": "25%"}})
	// Preview layers aren't saved.
	f.must(http.StatusCreated, "POST", "/api/v1/layers", map[string]any{"target": "porch", "effect": "solid", "preview": true})

	f.restart() // boot: restore
	if got := f.ids("/api/v1/layers"); got != b+","+a {
		t.Fatalf("restored stack %q", got)
	}
	if l := f.must(http.StatusOK, "GET", "/api/v1/layers/"+b, nil); l["owner"] != "cli" {
		t.Errorf("restored layer %v", l)
	}
	if got := f.ids("/api/v1/preview/layers"); got != "" {
		t.Errorf("preview layers survived a restart: %q", got)
	}
	bri := f.must(http.StatusOK, "GET", "/api/v1/brightness", nil)
	if bri["master"] != 0.5 || bri["zones"].(map[string]any)["porch"] != 0.25 {
		t.Errorf("restored brightness %v", bri)
	}
	f.render(time.Second)
	if g := f.pix[f.porch].G; g < 0.124 || g > 0.126 {
		t.Errorf("porch green %v, want 1 × 0.5 master × 0.25 zone", g)
	}

	// New layers keep counting from the restored ids.
	if c := f.push("shed", "#ffffff", nil); c == a || c == b {
		t.Errorf("new id %q clashes with a restored one", c)
	}
}

func TestBootDark(t *testing.T) {
	f := newFixture(t, func(dir string) {
		path := filepath.Join(dir, "glowstack.yaml")
		b, _ := os.ReadFile(path)
		b = bytes.Replace(b, []byte("boot: restore"), []byte("boot: dark"), 1)
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	})
	f.push("everything", "#ff0000", nil)
	f.restart()
	if got := f.ids("/api/v1/layers"); got != "" {
		t.Errorf("boot: dark restored %q", got)
	}
	f.render(time.Second)
	f.expect(f.porch, "000", "dark boot")
}

func TestValidation(t *testing.T) {
	f := newFixture(t, nil)
	cases := []struct {
		body   any
		status int
		want   string
	}{
		{map[string]any{"target": "nowhere", "effect": "solid"}, 400, `no area "nowhere" (areas: `},
		{map[string]any{"target": "porch", "effect": "glitterz"}, 400, `no effect "glitterz" (effects: "solid"`},
		{map[string]any{"target": "porch", "preset": "nope"}, 400, `no preset "nope" (presets: "slow-crawl", "glitter", "warm-white"`},
		{map[string]any{"target": "porch", "use": "nope"}, 400, `no effect or preset "nope"`},
		{map[string]any{"target": "porch", "effect": "solid", "preset": "warm-white"}, 400, "only one of"},
		{map[string]any{"target": "porch"}, 400, "needs an effect or a preset"},
		{map[string]any{"effect": "solid"}, 400, "needs a target"},
		{map[string]any{"target": "porch", "effect": "solid", "params": map[string]any{"colour": "#fff"}}, 400,
			`effect "solid" has no parameter "colour" (its parameters: color; common: mapping,`},
		{map[string]any{"target": "porch", "effect": "solid", "params": map[string]any{"color": "red"}}, 400, "invalid layer: effect solid: color:"},
		{map[string]any{"target": "porch", "effect": "solid", "opacity": 2}, 400, "opacity: 2 is outside 0–1"},
		{map[string]any{"target": "porch", "effect": "solid", "blend": "sideways"}, 400, `"sideways": want one of`},
		{map[string]any{"target": "porch", "effect": "solid", "mapping": "nope"}, 400, `no mapping "nope"`},
		{map[string]any{"target": "porch", "effect": "solid", "fade_in": "soon"}, 400, "fade_in"},
		{map[string]any{"target": "porch", "effect": "solid", "for": "-1 s"}, 400, "for"},
		{map[string]any{"target": "porch", "effect": "solid", "until": "2020-01-01T00:00:00Z"}, 400, "lifetime already ended"},
		{map[string]any{"target": "porch", "effect": "solid", "color": "#fff"}, 400, `unknown field "color" (put effect parameters in "params")`},
		{map[string]any{"target": "porch", "effect": "solid", "replace": true}, 400, "only applies to an edit"},
		{`{"target": "porch"`, 400, "want a JSON object"},
		{`[1, 2]`, 400, "want a JSON object"},
	}
	for _, c := range cases {
		code, out := f.do("POST", "/api/v1/layers", c.body)
		msg, _ := out["error"].(string)
		if code != c.status || !strings.Contains(msg, c.want) {
			t.Errorf("POST %v: %d %q, want %d containing %q", c.body, code, msg, c.status, c.want)
		}
	}
	if got := f.ids("/api/v1/layers"); got != "" {
		t.Errorf("failed pushes left layers: %q", got)
	}

	f.must(http.StatusCreated, "POST", "/api/v1/layers", map[string]any{"id": "mine", "target": "porch", "effect": "solid"})
	f.must(http.StatusConflict, "POST", "/api/v1/layers", map[string]any{"id": "mine", "target": "porch", "effect": "solid"})
	f.must(http.StatusNotFound, "GET", "/api/v1/layers/other", nil)
	f.must(http.StatusNotFound, "PATCH", "/api/v1/layers/other", map[string]any{"opacity": 0.5})
	if _, out := f.do("PATCH", "/api/v1/layers/mine", map[string]any{"id": "x"}); !strings.Contains(out["error"].(string), "can't be changed") {
		t.Errorf("edit of id: %v", out)
	}
	if code, out := f.do("PATCH", "/api/v1/layers/mine", map[string]any{"params": map[string]any{"color": "nope"}}); code != 400 {
		t.Errorf("bad edit: %d %v", code, out)
	}
	if l := f.must(http.StatusOK, "GET", "/api/v1/layers/mine", nil); l["params"] != nil {
		t.Errorf("a failed edit changed the layer: %v", l)
	}
	f.must(http.StatusNotFound, "GET", "/api/v1/nothing-here", nil)
}

func TestPresetsAndEdits(t *testing.T) {
	f := newFixture(t, nil)
	// A preset with an override, by "use".
	out := f.must(http.StatusCreated, "POST", "/api/v1/layers", map[string]any{
		"target": "porch", "use": "warm-white", "opacity": 0.5, "fade_in": "0s"})
	id := out["id"].(string)
	if out["preset"] != "warm-white" || out["effect"] != nil || out["params"].(map[string]any)["opacity"] != 0.5 {
		t.Errorf("preset push %v", out)
	}
	f.render(time.Second)
	if c := f.pix[f.porch]; c.W == 0 || c.A < 0.49 || c.A > 0.51 {
		t.Errorf("warm white at half opacity: %+v", c)
	}
	// Switching to an effect keeps common params; null removes one.
	out = f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+id, map[string]any{
		"use": "solid", "params": map[string]any{"color": "#ff0000", "opacity": nil}})
	if out["preset"] != nil || out["effect"] != "solid" || out["params"].(map[string]any)["opacity"] != nil {
		t.Errorf("switch to effect %v", out)
	}
	// replace drops everything not given.
	out = f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+id, map[string]any{"replace": true, "params": map[string]any{"color": "#00ff00"}})
	if p := out["params"].(map[string]any); len(p) != 1 || p["color"] != "#00ff00" {
		t.Errorf("replace %v", out)
	}
	// Retarget.
	out = f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+id, map[string]any{"target": "shed"})
	if out["target"] != "shed" {
		t.Errorf("retarget %v", out)
	}
}

func TestClearAndOwners(t *testing.T) {
	f := newFixture(t, nil)
	f.push("porch", "#ff0000", map[string]any{"owner": "cli"})
	keep := f.push("shed", "#ff0000", nil)
	f.push("yard", "#ff0000", map[string]any{"owner": "cli"})
	out := f.must(http.StatusOK, "DELETE", "/api/v1/layers?owner=cli", nil)
	if len(out["removed"].([]any)) != 2 || f.ids("/api/v1/layers") != keep {
		t.Errorf("clear cli: %v, left %q", out, f.ids("/api/v1/layers"))
	}
	f.must(http.StatusOK, "DELETE", "/api/v1/layers", nil)
	if got := f.ids("/api/v1/layers"); got != "" {
		t.Errorf("after clear: %q", got)
	}
}

func TestPreviewLayers(t *testing.T) {
	f := newFixture(t, nil)
	out := f.must(http.StatusCreated, "POST", "/api/v1/layers", map[string]any{
		"target": "porch", "effect": "solid", "params": map[string]any{"color": "#ff0000"}, "fade_in": "0s", "preview": true})
	id := out["id"].(string)
	if out["preview"] != true {
		t.Errorf("preview push %v", out)
	}
	if f.ids("/api/v1/layers") != "" || f.ids("/api/v1/preview/layers") != id {
		t.Errorf("preview layer on the wrong stack")
	}
	f.render(time.Second)
	f.expect(f.porch, "000", "the lights don't show preview layers")
	f.must(http.StatusOK, "PATCH", "/api/v1/preview/layers/"+id, map[string]any{"opacity": 0.5})
	f.must(http.StatusNotFound, "PATCH", "/api/v1/layers/"+id, map[string]any{"opacity": 0.5})
	f.must(http.StatusNoContent, "DELETE", "/api/v1/preview/layers/"+id, nil)
}

func TestCatalog(t *testing.T) {
	f := newFixture(t, nil)
	effects := f.must(http.StatusOK, "GET", "/api/v1/effects", nil)
	var solid map[string]any
	for _, e := range effects["effects"].([]any) {
		if e.(map[string]any)["id"] == "solid" {
			solid = e.(map[string]any)
		}
	}
	if solid == nil || solid["params"].([]any)[0].(map[string]any)["type"] != "color" {
		t.Errorf("effects: %v", effects)
	}
	if len(effects["common"].([]any)) != len(render.CommonParams) {
		t.Errorf("common params %v", effects["common"])
	}
	f.must(http.StatusOK, "GET", "/api/v1/effects/solid", nil)
	f.must(http.StatusNotFound, "GET", "/api/v1/effects/nope", nil)

	if p := f.must(http.StatusOK, "GET", "/api/v1/presets", nil)["presets"].([]any); len(p) < 2 || p[0].(map[string]any)["id"] != "slow-crawl" {
		t.Errorf("presets %v", p)
	}
	if p := f.must(http.StatusOK, "GET", "/api/v1/palettes", nil)["palettes"].([]any); len(p) == 0 {
		t.Errorf("palettes %v", p)
	}
	areas := f.must(http.StatusOK, "GET", "/api/v1/areas", nil)["areas"].([]any)
	found := false
	for _, a := range areas {
		a := a.(map[string]any)
		if a["id"] == "porch" {
			found = true
			if a["pixels"].(float64) == 0 || len(a["zones"].([]any)) != 1 || a["runs"].([]any)[0] != "porch" {
				t.Errorf("porch area %v", a)
			}
		}
	}
	if !found {
		t.Errorf("areas %v", areas)
	}
	zones := f.must(http.StatusOK, "GET", "/api/v1/zones", nil)["zones"].([]any)
	if len(zones) != 2 || zones[0].(map[string]any)["brightness"] != 1.0 {
		t.Errorf("zones %v", zones)
	}
	ms := f.must(http.StatusOK, "GET", "/api/v1/mappings", nil)
	if ms["default"] != "front-sweep" || len(ms["mappings"].([]any)) < 5 {
		t.Errorf("mappings %v", ms)
	}
	cs := f.must(http.StatusOK, "GET", "/api/v1/controllers", nil)["controllers"].([]any)
	if len(cs) != 2 || cs[0].(map[string]any)["id"] != "shed" {
		t.Errorf("controllers %v", cs)
	}
	f.must(http.StatusOK, "GET", "/api/v1/", nil)
}

func TestBrightness(t *testing.T) {
	f := newFixture(t, nil)
	f.push("everything", "#ffffff", nil)
	f.must(http.StatusOK, "PUT", "/api/v1/brightness", map[string]any{"master": "50%"})
	out := f.must(http.StatusOK, "PATCH", "/api/v1/brightness", map[string]any{"zones": map[string]any{"porch": 0.5}})
	if out["master"] != 0.5 || out["zones"].(map[string]any)["porch"] != 0.5 || out["zones"].(map[string]any)["front"] != 1.0 {
		t.Errorf("brightness %v", out)
	}
	f.render(time.Second)
	// porch is in both zones (front's area is everything): 0.5 × 1 × 0.5.
	if r := f.pix[f.porch].R; r < 0.249 || r > 0.251 {
		t.Errorf("porch %v", r)
	}
	if r := f.pix[f.shed].R; r < 0.499 || r > 0.501 {
		t.Errorf("shed %v", r)
	}
	for _, body := range []any{
		map[string]any{"master": 1.5},
		map[string]any{"master": "loud"},
		map[string]any{"zones": map[string]any{"attic": 0.5}},
		map[string]any{"zones": map[string]any{"porch": 0.1}, "master": 7},
		map[string]any{"level": 1},
	} {
		if code, _ := f.do("PUT", "/api/v1/brightness", body); code != 400 {
			t.Errorf("PUT %v: %d", body, code)
		}
	}
	if b := f.app.Brightness(); b.Zones["porch"] != 0.5 || b.Master != 0.5 {
		t.Errorf("a rejected request changed the brightness: %+v", b)
	}
}

func TestStatus(t *testing.T) {
	f := newFixture(t, nil)
	f.push("porch", "#ff0000", nil)
	f.render(time.Second)
	f.render(time.Second)
	st := f.must(http.StatusOK, "GET", "/api/v1/status", nil)
	solve := st["solve"].(map[string]any)
	if st["frames"].(float64) != 2 || st["fps"].(float64) != 40 || st["layers"].(float64) != 1 ||
		solve["pixels"].(float64) != 1084 || len(solve["runs"].([]any)) == 0 {
		t.Errorf("status %v", st)
	}
	anchors := solve["anchors"].(map[string]any)
	if anchors["measured"].(float64)+anchors["estimated"].(float64) == 0 {
		t.Errorf("anchors %v", anchors)
	}
	if _, ok := st["health"]; !ok {
		t.Error("status lacks health")
	}
}

func TestReload(t *testing.T) {
	f := newFixture(t, nil)
	keep := f.push("porch", "#ff0000", nil)
	gone := f.push("shed-north", "#00ff00", nil)
	f.render(time.Second)

	// A broken config is refused and changes nothing.
	areas := filepath.Join(f.config, "areas.yaml")
	orig, _ := os.ReadFile(areas)
	os.WriteFile(areas, []byte("schema: 1\nareas:\n  - id: porch\n    include: [no-such-run]\n"), 0o644)
	code, out := f.do("POST", "/api/v1/reload", nil)
	if code != http.StatusUnprocessableEntity || len(out["errors"].([]any)) == 0 ||
		!strings.Contains(out["errors"].([]any)[0].(string), "areas.yaml:") {
		t.Fatalf("broken reload: %d %v", code, out)
	}
	if got := f.ids("/api/v1/layers"); got != gone+","+keep {
		t.Errorf("a failed reload changed the stack: %q", got)
	}

	// Drop the shed-north area (and the segment showing it) and add a
	// preset: the layer on shed-north is dropped, the preset appears.
	fixed := strings.Replace(string(orig), "  - id: shed-north\n    include: [{ run: shed-eave, from: shed-nw, to: shed-ne }]\n", "", 1)
	fixed = strings.Replace(fixed, "      - { area: shed-north, mapping: east-west }\n", "", 1)
	if fixed == string(orig) {
		t.Fatal("test edit didn't apply to areas.yaml")
	}
	os.WriteFile(areas, []byte(fixed), 0o644)
	presets := filepath.Join(f.config, "presets.yaml")
	p, _ := os.ReadFile(presets)
	withAlarm := strings.Replace(string(p), "\npresets:\n", "\npresets:\n  - { id: alarm, effect: solid, params: { color: \"#ff0000\" } }\n", 1)
	if withAlarm == string(p) {
		t.Fatal("test edit didn't apply to presets.yaml")
	}
	os.WriteFile(presets, []byte(withAlarm), 0o644)

	out = f.must(http.StatusOK, "POST", "/api/v1/reload", nil)
	if d := out["dropped"].([]any); len(d) != 1 || !strings.Contains(d[0].(string), `layer "`+gone+`"`) {
		t.Errorf("reload dropped %v", out["dropped"])
	}
	if got := f.ids("/api/v1/layers"); got != keep {
		t.Errorf("stack after reload %q", got)
	}
	f.must(http.StatusCreated, "POST", "/api/v1/layers", map[string]any{"target": "porch", "use": "alarm"})
	f.must(http.StatusBadRequest, "POST", "/api/v1/layers", map[string]any{"target": "shed-north", "effect": "solid"})
	f.render(time.Second)
	f.expect(f.porch, "100", "porch after reload")
	if st := f.must(http.StatusOK, "GET", "/api/v1/status", nil); st["config_gen"].(float64) != 1 {
		t.Errorf("config_gen %v", st["config_gen"])
	}
}

func TestConcurrentEditsMergeIndependentParameters(t *testing.T) {
	f := newFixture(t, nil)
	id := f.must(http.StatusCreated, "POST", "/api/v1/layers", `{"target":"porch","effect":"solid"}`)["id"].(string)
	edits := map[string]any{
		"brightness": 0.5, "opacity": 0.7, "smooth": false, "reverse": true,
		"offset": "0.1 m", "blend": "add", "white": "none", "mapping": "local",
	}
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, len(edits))
	for k, v := range edits {
		go func() {
			body, _ := json.Marshal(map[string]any{"params": map[string]any{k: v}})
			req := httptest.NewRequest("PATCH", "/api/v1/layers/"+id, bytes.NewReader(body))
			rec := httptest.NewRecorder()
			<-start
			f.h.ServeHTTP(rec, req)
			results <- rec
		}()
	}
	close(start)
	for range edits {
		if rec := <-results; rec.Code != http.StatusOK {
			t.Fatalf("edit: %d %s", rec.Code, rec.Body.String())
		}
	}
	got := f.must(http.StatusOK, "GET", "/api/v1/layers/"+id, nil)["params"].(map[string]any)
	for k, v := range edits {
		if got[k] != v {
			t.Errorf("concurrent edit lost %s: got %v, want %v", k, got[k], v)
		}
	}
}

func TestRequestRejectsTrailingClosingDelimiter(t *testing.T) {
	f := newFixture(t, nil)
	for _, suffix := range []string{"]", "}"} {
		f.must(http.StatusBadRequest, "POST", "/api/v1/layers", `{"target":"porch","effect":"solid"}`+suffix)
	}
	if n := f.app.Stack.Len(); n != 0 {
		t.Fatalf("invalid requests pushed %d layers", n)
	}
}

func TestSwitchLookDropsOldEffectParameters(t *testing.T) {
	f := newFixture(t, nil)
	out := f.must(http.StatusCreated, "POST", "/api/v1/layers", `{"target":"porch","effect":"breathe","params":{"color":"#ff0000","opacity":0.5}}`)
	id := out["id"].(string)
	out = f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+id, `{"effect":"solid"}`)
	params := out["params"].(map[string]any)
	if params["color"] != nil || params["opacity"] != 0.5 {
		t.Errorf("switch retained old effect parameters or lost common ones: %v", params)
	}
	// An edit naming the current effect still merges its parameters.
	f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+id, `{"params":{"color":"#0000ff"}}`)
	out = f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+id, `{"effect":"solid","opacity":0.7}`)
	if out["params"].(map[string]any)["color"] != "#0000ff" {
		t.Errorf("same effect lost its colour: %v", out)
	}
}
