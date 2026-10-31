// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
	"github.com/jerejones/glowstack/internal/units"
)

const exampleDir = "../../examples/fictional"

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

// fixture is the fictional installation's app with its devices' handlers
// (no servers).
type fixture struct {
	t            *testing.T
	a            *app.App
	d            *Devices
	front, porch http.Handler
	config, data string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, config: copyDir(t, exampleDir+"/config"), data: copyDir(t, exampleDir+"/data")}
	f.start()
	return f
}

// start (re)creates the app and devices on the fixture's folders.
func (f *fixture) start() {
	f.t.Helper()
	a, err := app.New(app.Options{ConfigDir: f.config, DataDir: f.data,
		Clock: clock.NewManual(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)), Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { a.Close() })
	f.a = a
	f.d = New(Options{})
	f.d.init(a)
	f.front = f.d.zoneHandler("front", nil)
	f.porch = f.d.zoneHandler("porch", nil)
}

// do sends a request to h and decodes the JSON reply.
func (f *fixture) do(h http.Handler, method, path, body string) (int, any) {
	f.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, rd))
	var out any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		f.t.Fatalf("%s %s: reply isn't JSON: %v\n%s", method, path, err, rec.Body.String())
	}
	return rec.Code, out
}

// post sends a state change to the front device and returns the state.
func (f *fixture) post(body string) map[string]any {
	f.t.Helper()
	code, out := f.do(f.front, "POST", "/json/state", body)
	if code != http.StatusOK {
		f.t.Fatalf("POST %s: status %d: %v", body, code, out)
	}
	_, st := f.do(f.front, "GET", "/json/state", "")
	return st.(map[string]any)
}

func seg(st map[string]any, i int) map[string]any {
	return st["seg"].([]any)[i].(map[string]any)
}

func num(x any) int { return int(x.(float64)) }

func (f *fixture) layer(zone string, i int) *stack.Layer {
	ls := f.a.Stack.ByOwner(stack.WLEDOwner(zone, i))
	if len(ls) == 0 {
		return nil
	}
	return &ls[0]
}

func TestGetVal(t *testing.T) {
	for _, tc := range []struct {
		raw     string
		cur     int
		want    int
		wantOK  bool
		lo, hi_ int
	}{
		{``, 5, 0, false, 0, 255},
		{`null`, 5, 0, false, 0, 255},
		{`200`, 5, 200, true, 0, 255},
		{`300`, 5, 255, true, 0, 255},
		{`12.7`, 5, 12, true, 0, 255},
		{`-1`, 5, 0, false, 0, 255},
		{`"42"`, 5, 42, true, 0, 255},
		{`"~"`, 5, 6, true, 0, 255},
		{`"~-"`, 5, 4, true, 0, 255},
		{`"~10"`, 250, 255, true, 0, 255},
		{`"~-10"`, 5, 0, true, 0, 255},
		{`"w~10"`, 250, 4, true, 0, 255},
		{`"w~-1"`, 0, 255, true, 0, 255},
		{`"x"`, 5, 0, false, 0, 255},
		{`true`, 5, 0, false, 0, 255},
	} {
		got, ok := getVal(json.RawMessage(tc.raw), tc.cur, tc.lo, tc.hi_)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("getVal(%s, %d) = %d, %v; want %d, %v", tc.raw, tc.cur, got, ok, tc.want, tc.wantOK)
		}
	}
	for range 50 {
		if x, ok := getVal(json.RawMessage(`"r"`), 0, 10, 20); !ok || x < 10 || x > 20 {
			t.Fatalf(`getVal("r") = %d, %v; want 10–20`, x, ok)
		}
	}
}

func TestGetBool(t *testing.T) {
	for _, tc := range []struct {
		raw          string
		cur          bool
		want, wantOK bool
	}{
		{``, true, false, false},
		{`true`, false, true, true},
		{`false`, true, false, true},
		{`"t"`, true, false, true},
		{`"t"`, false, true, true},
		{`1`, false, true, true},
		{`0`, true, false, true},
		{`"no"`, true, false, false},
	} {
		got, ok := getBool(json.RawMessage(tc.raw), tc.cur)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("getBool(%s, %v) = %v, %v; want %v, %v", tc.raw, tc.cur, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestParseColor(t *testing.T) {
	cur := units.Color{R: 1, G: 2, B: 3}
	for _, tc := range []struct {
		raw    string
		want   units.Color
		wantOK bool
	}{
		{`[255,128,0]`, units.Color{R: 255, G: 128}, true},
		{`[10,20,30,40]`, units.Color{R: 10, G: 20, B: 30, W: 40, HasW: true}, true},
		{`[300,-5]`, units.Color{R: 255}, true},
		{`[]`, units.Color{}, false},
		{`"FF8000"`, units.Color{R: 255, G: 128}, true},
		{`"#00ff00"`, units.Color{G: 255}, true},
		{`"102030FF"`, units.Color{R: 16, G: 32, B: 48, W: 255, HasW: true}, true},
		{`{"g":200}`, units.Color{R: 1, G: 200, B: 3}, true},
		{`0`, units.Color{}, true},
		{`2700`, units.Color{}, false},
		{`"r"`, units.Color{}, false},
	} {
		got, ok := parseColor(json.RawMessage(tc.raw), cur)
		if ok != tc.wantOK || ok && got != tc.want {
			t.Errorf("parseColor(%s) = %+v, %v; want %+v, %v", tc.raw, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestInfo(t *testing.T) {
	f := newFixture(t)
	_, out := f.do(f.front, "GET", "/json/info", "")
	in := out.(map[string]any)
	for k, want := range map[string]any{
		"ver": Version, "brand": "WLED", "product": Product, "name": "Glowstack Front",
		"mac": "020000000001", "ip": "192.0.2.50",
	} {
		if in[k] != want {
			t.Errorf("info.%s = %v, want %v", k, in[k], want)
		}
	}
	leds := in["leds"].(map[string]any)
	front, _ := f.a.Layout.Area("everything")
	if num(leds["count"]) != len(front.Pixels) {
		t.Errorf("leds.count = %v, want %d", leds["count"], len(front.Pixels))
	}
	if n := len(leds["seglc"].([]any)); n != 3 {
		t.Errorf("leds.seglc has %d entries, want 3 (the zone's segments)", n)
	}
	if num(in["fxcount"]) <= 240 {
		t.Errorf("fxcount = %v; want room for the composite at 240", in["fxcount"])
	}
	if _, ok := in["fs"].(map[string]any)["pmt"]; !ok {
		t.Error("info.fs.pmt missing")
	}
	_, out = f.do(f.porch, "GET", "/json/info", "")
	if got := out.(map[string]any)["mac"]; got != "020000000002" {
		t.Errorf("porch mac = %v", got)
	}

	_, out = f.do(f.front, "GET", "/json", "")
	all := out.(map[string]any)
	for _, k := range []string{"state", "info", "effects", "palettes"} {
		if all[k] == nil {
			t.Errorf("/json has no %s", k)
		}
	}
	fx := all["effects"].([]any)
	if fx[0] != "Solid" || fx[1] != "RSVD" {
		t.Errorf("effects start %v; want Solid, then RSVD placeholders", fx[:2])
	}
	if fx[240] != "Ember glitter" {
		t.Errorf("effects[240] = %v, want the composite", fx[240])
	}
	_, out = f.do(f.front, "GET", "/json/fxdata", "")
	if data := out.([]any); len(data) != len(fx) || data[20] == "" {
		t.Errorf("fxdata: %d entries (want %d), sparkle's %q", len(data), len(fx), data[20])
	}
}

func TestSegmentOnOff(t *testing.T) {
	f := newFixture(t)
	st := f.post(`{"seg":[{"id":1,"on":true}]}`)
	l := f.layer("front", 1)
	if l == nil || l.Target != "shed" {
		t.Fatalf("segment 1 on: layer %+v, want one on shed", l)
	}
	if !seg(st, 1)["on"].(bool) || seg(st, 0)["on"].(bool) {
		t.Errorf("state: seg 0 on %v, seg 1 on %v", seg(st, 0)["on"], seg(st, 1)["on"])
	}
	// WLED's default: solid orange.
	if c := seg(st, 1)["col"].([]any)[0].([]any); num(c[0]) != 255 || num(c[1]) != 170 || num(c[2]) != 0 {
		t.Errorf("new segment color %v, want 255,170,0", c)
	}

	// Black is a color: the layer stays.
	st = f.post(`{"seg":{"id":1,"col":[[0,0,0]]}}`)
	if f.layer("front", 1) == nil || !seg(st, 1)["on"].(bool) {
		t.Fatal("black removed the layer")
	}
	if l := f.layer("front", 1); l.ID != f.a.Stack.ByOwner(stack.WLEDOwner("front", 1))[0].ID {
		t.Fatal("edit replaced the layer")
	}

	st = f.post(`{"seg":{"id":1,"on":false}}`)
	if f.layer("front", 1) != nil || seg(st, 1)["on"].(bool) {
		t.Fatal("segment off kept the layer")
	}
	// Turning it on again brings back what it showed.
	st = f.post(`{"seg":{"id":1,"on":true}}`)
	if c := seg(st, 1)["col"].([]any)[0].([]any); num(c[0])+num(c[1])+num(c[2]) != 0 {
		t.Errorf("segment came back %v, want black", c)
	}
	// "t" toggles; bri 0 turns off.
	f.post(`{"seg":{"id":1,"on":"t"}}`)
	if f.layer("front", 1) != nil {
		t.Error(`"on":"t" didn't turn the segment off`)
	}
	f.post(`{"seg":[{"id":2,"on":true}]}`)
	f.post(`{"seg":[{"id":2,"bri":0}]}`)
	if f.layer("front", 2) != nil {
		t.Error("segment bri 0 didn't turn it off")
	}

	// A layer pushed by someone else for the same owner is what's reported.
	if _, err := f.a.Stack.Push(stack.Layer{Owner: stack.WLEDOwner("porch", 0), Target: "porch", Effect: "solid",
		Params: map[string]any{"color": "#0000ff"}}); err != nil {
		t.Fatal(err)
	}
	_, out := f.do(f.porch, "GET", "/json/state", "")
	s0 := seg(out.(map[string]any), 0)
	if !s0["on"].(bool) || num(s0["col"].([]any)[0].([]any)[2]) != 255 {
		t.Errorf("porch segment 0: %v", s0)
	}
}

func TestMaster(t *testing.T) {
	f := newFixture(t)
	f.post(`{"seg":[{"id":0,"on":true}]}`)
	st := f.post(`{"bri":64}`)
	if got := f.a.Brightness().Zones["front"]; math.Abs(got-64.0/255) > 1e-9 || num(st["bri"]) != 64 || !st["on"].(bool) {
		t.Fatalf("bri 64: zone brightness %v, state %v/%v", got, st["on"], st["bri"])
	}
	st = f.post(`{"on":false}`)
	if f.a.Brightness().Zones["front"] != 0 || st["on"].(bool) {
		t.Fatal("device off didn't darken the zone")
	}
	if f.layer("front", 0) == nil || !seg(st, 0)["on"].(bool) {
		t.Fatal("device off removed the layer; it's a brightness gate")
	}
	if num(st["bri"]) != 64 {
		t.Errorf("off: bri %v, want the last one (64)", st["bri"])
	}
	st = f.post(`{"on":true}`)
	if num(st["bri"]) != 64 || math.Abs(f.a.Brightness().Zones["front"]-64.0/255) > 1e-9 {
		t.Errorf("on again: bri %v", st["bri"])
	}
	f.post(`{"on":"t"}`)
	if f.a.Brightness().Zones["front"] != 0 {
		t.Error(`"on":"t" didn't toggle off`)
	}
	f.post(`{"bri":"~10"}`) // a brightness turns it on, stepping from the last
	if num(f.post(`{}`)["bri"]) != 74 {
		t.Error(`bri "~10" from 64 isn't 74`)
	}
	// The native API's zone brightness is what's reported.
	if err := f.a.SetZoneBrightness("front", 0.5); err != nil {
		t.Fatal(err)
	}
	if st := f.post(`{}`); num(st["bri"]) != 128 {
		t.Errorf("after SetZoneBrightness(0.5): bri %v", st["bri"])
	}
	// The last brightness survives a restart.
	f.post(`{"on":false}`)
	f.a.Close()
	f.start()
	if err := f.a.SetZoneBrightness("front", 0); err != nil {
		t.Fatal(err)
	}
	if st := f.post(`{"on":true}`); num(st["bri"]) != 128 {
		t.Errorf("after restart: on at bri %v, want 128", st["bri"])
	}
}

func TestEffectControls(t *testing.T) {
	f := newFixture(t)
	// Gradient (65): sx speed, ix span, palette.
	st := f.post(`{"seg":{"id":0,"on":true,"fx":65,"sx":200,"ix":50,"pal":11,"col":[[255,0,0],[0,0,255]]}}`)
	s := seg(st, 0)
	if num(s["fx"]) != 65 || num(s["pal"]) != 11 {
		t.Fatalf("fx %v pal %v", s["fx"], s["pal"])
	}
	// Read back through the curves: within a step or two.
	if d := num(s["sx"]) - 200; d < -2 || d > 2 {
		t.Errorf("sx read back %v, want ~200", s["sx"])
	}
	if d := num(s["ix"]) - 50; d < -2 || d > 2 {
		t.Errorf("ix read back %v, want ~50", s["ix"])
	}
	l := f.layer("front", 0)
	if l.Effect != "gradient" || l.Params["speed"] == nil || l.Params["span"] == nil || l.Params["palette"] == nil {
		t.Fatalf("layer %+v", l)
	}
	// c1 isn't bound by gradient: remembered and reported as set.
	st = f.post(`{"seg":{"id":0,"c1":77,"o1":true}}`)
	if s := seg(st, 0); num(s["c1"]) != 77 || !s["o1"].(bool) {
		t.Errorf("unbound c1/o1 read back %v/%v", s["c1"], s["o1"])
	}
	// Segment brightness and reverse are common params.
	f.post(`{"seg":{"id":0,"bri":128,"rev":true}}`)
	if l := f.layer("front", 0); l.Params[render.ParamReverse] != true || l.Params[render.ParamBrightness] == nil {
		t.Errorf("bri/rev params: %v", l.Params)
	}
	// Switching effect keeps the palette and colors.
	st = f.post(`{"seg":{"id":0,"fx":20}}`)
	if s := seg(st, 0); num(s["fx"]) != 20 || num(s["pal"]) != 11 || num(s["bri"]) != 128 || !s["rev"].(bool) {
		t.Errorf("after fx 20: %v", s)
	}
	if l := f.layer("front", 0); l.Effect != "sparkle" {
		t.Errorf("effect %q, want sparkle", l.Effect)
	}
	// An effect id that isn't one is ignored.
	f.post(`{"seg":{"id":0,"fx":3}}`)
	if l := f.layer("front", 0); l.Effect != "sparkle" {
		t.Errorf("fx 3 changed the effect to %q", l.Effect)
	}
	// A layer showing a composite (not a WLED effect) reports its 240+ id.
	if _, err := f.a.Stack.Push(stack.Layer{Owner: stack.WLEDOwner("front", 2), Target: "yard", Effect: "ember-glitter"}); err != nil {
		t.Fatal(err)
	}
	if s := seg(f.post(`{}`), 2); num(s["fx"]) != 240 {
		t.Errorf("composite reports fx %v, want 240", s["fx"])
	}
}

func TestPresets(t *testing.T) {
	f := newFixture(t)
	_, out := f.do(f.front, "GET", "/presets.json", "")
	ps := out.(map[string]any)
	p1, ok := ps["1"].(map[string]any)
	if !ok || p1["n"] != "Slow crawl" {
		t.Fatalf("presets.json 1 = %v", ps["1"])
	}
	numbers := f.d.presetIDs()

	st := f.post(`{"ps":2}`)
	if l := f.layer("front", 0); l == nil || l.Preset != "glitter" {
		t.Fatalf("ps 2: layer %+v, want preset glitter", l)
	}
	if num(st["ps"]) != 2 || num(seg(st, 0)["fx"]) != 87 {
		t.Errorf("ps 2: state ps %v fx %v", st["ps"], seg(st, 0)["fx"])
	}
	// A control change makes the layer a copy of the preset.
	f.post(`{"seg":{"id":0,"sx":10}}`)
	if l := f.layer("front", 0); l.Preset != "" || l.Effect != "glitter" {
		t.Errorf("after sx: %+v", l)
	}

	// psave saves the main segment's look.
	f.post(`{"psave":20,"n":"My look"}`)
	p, ok := f.a.Current().Config.Preset("my-look")
	if !ok || p.Effect != "glitter" || p.Name != "My look" {
		t.Fatalf("psave: preset %+v, %v", p, ok)
	}
	_, out = f.do(f.front, "GET", "/presets.json", "")
	if got := out.(map[string]any)["20"]; got == nil || got.(map[string]any)["n"] != "My look" {
		t.Fatalf("presets.json 20 = %v", got)
	}
	// Saving over it again replaces it.
	f.post(`{"seg":{"id":0,"fx":0,"col":[[0,255,0]]}}`)
	f.post(`{"psave":20}`)
	if p, _ := f.a.Current().Config.Preset("my-look"); p.Effect != "solid" || p.Name != "My look" {
		t.Errorf("psave again: %+v", p)
	}
	// presets.yaml's presets can't be overwritten.
	if code, _ := f.do(f.front, "POST", "/json/state", `{"psave":1}`); code == http.StatusOK {
		t.Error("psave over a presets.yaml preset succeeded")
	}

	// Numbers are stable across restarts.
	f.a.Close()
	f.start()
	if got := f.d.presetIDs(); len(got) != len(numbers)+1 {
		t.Errorf("after restart: numbers %v, was %v + 20", got, numbers)
	}
	if n, _ := f.d.presetNumber(f.a.Current().Config, "my-look"); n != 20 {
		t.Errorf("my-look is %d after a restart, want 20", n)
	}

	f.post(`{"pdel":20}`)
	if _, ok := f.a.Current().Config.Preset("my-look"); ok {
		t.Error("pdel 20 didn't delete it")
	}
}

func TestTransition(t *testing.T) {
	f := newFixture(t)
	f.post(`{"transition":7}`)
	f.post(`{"seg":{"id":1,"on":true}}`)
	if l := f.layer("front", 1); l.Params[render.ParamFadeIn] != "0.7 s" {
		t.Errorf("fade_in %v, want 0.7 s", l.Params[render.ParamFadeIn])
	}
	if st := f.post(`{}`); num(st["transition"]) != 7 {
		t.Errorf("transition %v", st["transition"])
	}
	f.post(`{"seg":{"id":2,"on":true},"tt":0}`)
	if l := f.layer("front", 2); l.Params[render.ParamFadeIn] != "0 s" {
		t.Errorf("tt 0: fade_in %v", l.Params[render.ParamFadeIn])
	}
}

func TestBadRequests(t *testing.T) {
	f := newFixture(t)
	for _, body := range []string{`not json`, `{"seg":"x"}`, `{"psave":999}`} {
		if code, _ := f.do(f.front, "POST", "/json/state", body); code != http.StatusBadRequest {
			t.Errorf("POST %s: status %d, want 400", body, code)
		}
	}
	if code, out := f.do(f.front, "POST", "/json/state", `{"nl":{"on":true},"udpn":{"send":true},"lor":1}`); code != 200 ||
		out.(map[string]any)["success"] != true {
		t.Errorf("ignored fields: %d %v", code, out)
	}
	if code, out := f.do(f.front, "POST", "/json/state", `{"v":true}`); code != 200 || out.(map[string]any)["seg"] == nil {
		t.Errorf(`"v":true: %d %v`, code, out)
	}
}

// TestService runs the devices on loopback ports and checks a websocket
// client hears about changes, including ones made outside the device.
func TestService(t *testing.T) {
	cfg, data := copyDir(t, exampleDir+"/config"), copyDir(t, exampleDir+"/data")
	a, err := app.New(app.Options{ConfigDir: cfg, DataDir: data, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	d := New(Options{Bind: "127.0.0.1:0"})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.Service()(ctx, a) }()
	defer func() {
		cancel()
		<-done
	}()
	if err := d.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	addrs := d.Addrs()
	if len(addrs) != 2 || addrs["front"] == nil || addrs["porch"] == nil {
		t.Fatalf("addrs %v", addrs)
	}
	base := "http://" + addrs["porch"].String()
	resp, err := http.Post(base+"/json/state", "application/json", bytes.NewReader([]byte(`{"seg":[{"id":0,"on":true}]}`)))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
	defer wcancel()
	conn, _, err := websocket.Dial(wctx, "ws://"+addrs["porch"].String()+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	read := func() map[string]any {
		t.Helper()
		_, msg, err := conn.Read(wctx)
		if err != nil {
			t.Fatal(err)
		}
		var m struct {
			State map[string]any `json:"state"`
			Info  map[string]any `json:"info"`
		}
		if err := json.Unmarshal(msg, &m); err != nil || m.State == nil || m.Info == nil {
			t.Fatalf("ws message %s: %v", msg, err)
		}
		return m.State
	}
	if st := read(); !seg(st, 0)["on"].(bool) {
		t.Fatalf("first message: segment 0 off")
	}
	// Someone else removes the device's layer.
	l := a.Stack.ByOwner(stack.WLEDOwner("porch", 0))[0]
	if err := a.Stack.Remove(l.ID); err != nil {
		t.Fatal(err)
	}
	for {
		if st := read(); !seg(st, 0)["on"].(bool) {
			break
		}
	}
	// A zone brightness set through the native API.
	if err := a.SetZoneBrightness("porch", 0); err != nil {
		t.Fatal(err)
	}
	for {
		if st := read(); !st["on"].(bool) {
			break
		}
	}
}

func TestEffectSwitchColors(t *testing.T) {
	f := newFixture(t)
	f.post(`{"seg":{"id":0,"on":true,"col":[[255,0,0]]}}`)
	f.post(`{"seg":{"id":0,"fx":87}}`)
	l := f.layer("front", 0)
	if l.Effect != "glitter" {
		t.Fatalf("effect %q", l.Effect)
	}
	if c, ok := l.Params["sparkle.color"]; ok && c == "#000000" {
		t.Error("a black col2 made the sparkles black; it should keep glitter's default")
	}
	if cs, _ := l.Params["gradient.colors"].([]any); len(cs) == 0 || cs[0] != "#ff0000" {
		t.Errorf("col0 not carried over: %v", l.Params["gradient.colors"])
	}
}
