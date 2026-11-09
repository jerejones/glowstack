// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/fakewled"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/ddp"
)

// Undo puts the live stack back exactly as it was before the marked change.
func TestUndoRestoresTheStackExactly(t *testing.T) {
	f := newFixture(t, nil)
	f.must(http.StatusNotFound, "GET", "/api/v1/undo", nil)
	f.must(http.StatusNotFound, "POST", "/api/v1/undo", map[string]any{"id": "x"})
	f.push("porch", "#ff0000", map[string]any{"brightness": 0.4})
	f.clock.Advance(time.Second)
	f.push("shed", "#00ff00", map[string]any{"for": "1 h"})
	f.clock.Advance(time.Second)
	before := f.must(http.StatusOK, "GET", "/api/v1/layers", nil)
	levels := f.must(http.StatusOK, "GET", "/api/v1/brightness", nil)

	// Mark, then "apply" a third look, edit one and remove another.
	mark := f.must(http.StatusOK, "PUT", "/api/v1/undo", nil)
	if mark["layers"].(float64) != 2 || mark["id"] == "" {
		t.Fatalf("mark = %v", mark)
	}
	third := f.push("all", "#0000ff", nil)
	ids := f.ids("/api/v1/layers")
	first := before["layers"].([]any)[1].(map[string]any)["id"].(string)
	second := before["layers"].([]any)[0].(map[string]any)["id"].(string)
	f.must(http.StatusOK, "PATCH", "/api/v1/layers/"+first, map[string]any{"brightness": 0.9, "target": "shed"})
	f.must(http.StatusNoContent, "DELETE", "/api/v1/layers/"+second, nil)
	if got := f.must(http.StatusOK, "GET", "/api/v1/undo", nil); got["id"] != mark["id"] {
		t.Errorf("GET undo = %v, want the mark %v", got, mark)
	}
	f.clock.Advance(3 * time.Second)

	out := f.must(http.StatusOK, "POST", "/api/v1/undo", map[string]any{"id": mark["id"]})
	if w := out["warnings"].([]any); len(w) != 0 {
		t.Errorf("warnings: %v", w)
	}
	after := f.must(http.StatusOK, "GET", "/api/v1/layers", nil)
	if !reflect.DeepEqual(before, after) {
		t.Errorf("the stack after undo differs from the stack before the change\nbefore: %v\nafter:  %v (ids while changed: %s, third %s)", before, after, ids, third)
	}
	// Zone and master brightness are not part of undo.
	if got := f.must(http.StatusOK, "GET", "/api/v1/brightness", nil); !reflect.DeepEqual(levels, got) {
		t.Errorf("undo changed brightness: %v, was %v", got, levels)
	}
	// One level, used once.
	f.must(http.StatusNotFound, "POST", "/api/v1/undo", map[string]any{"id": mark["id"]})
	f.must(http.StatusNotFound, "GET", "/api/v1/undo", nil)
}

// After a second apply the first is no longer undoable.
func TestUndoIsOneLevel(t *testing.T) {
	f := newFixture(t, nil)
	f.push("porch", "#ff0000", nil)
	one := f.must(http.StatusOK, "PUT", "/api/v1/undo", nil)
	f.push("shed", "#00ff00", nil)
	afterFirst := f.must(http.StatusOK, "GET", "/api/v1/layers", nil)
	two := f.must(http.StatusOK, "PUT", "/api/v1/undo", nil)
	f.push("all", "#0000ff", nil)
	if code, _ := f.do("POST", "/api/v1/undo", map[string]any{"id": one["id"]}); code != http.StatusConflict {
		t.Errorf("undoing the first apply after a second: status %d, want 409", code)
	}
	// The refused request changed nothing, and the second is still undoable.
	if n := len(f.must(http.StatusOK, "GET", "/api/v1/layers", nil)["layers"].([]any)); n != 3 {
		t.Errorf("%d layers after a refused undo, want 3", n)
	}
	f.must(http.StatusOK, "POST", "/api/v1/undo", map[string]any{"id": two["id"]})
	if got := f.must(http.StatusOK, "GET", "/api/v1/layers", nil); !reflect.DeepEqual(afterFirst, got) {
		t.Errorf("undoing the second apply: %v, want %v", got, afterFirst)
	}
	f.must(http.StatusBadRequest, "POST", "/api/v1/undo", map[string]any{})
}

// An undo point taken with nothing on the lights restores an empty stack,
// and a layer that stayed live through the change does not fade in again.
func TestUndoToEmptyAndWithoutABlink(t *testing.T) {
	f := newFixture(t, nil)
	mark := f.must(http.StatusOK, "PUT", "/api/v1/undo", nil)
	f.push("porch", "#ff0000", nil)
	f.must(http.StatusOK, "POST", "/api/v1/undo", map[string]any{"id": mark["id"]})
	if n := len(f.must(http.StatusOK, "GET", "/api/v1/layers", nil)["layers"].([]any)); n != 0 {
		t.Fatalf("%d layers after undoing to an empty stack", n)
	}
	f.render(time.Second)
	f.expect(f.porch, "000", "the porch after undoing the only look")

	// A layer with a slow fade-in, well past it; undo must not restart the fade.
	f.must(http.StatusCreated, "POST", "/api/v1/layers", map[string]any{"target": "porch", "effect": "solid",
		"params": map[string]any{"color": "#ff0000"}, "fade_in": "10 s", "fade_out": "0s"})
	f.render(20 * time.Second)
	f.expect(f.porch, "100", "the porch, faded in")
	mark = f.must(http.StatusOK, "PUT", "/api/v1/undo", nil)
	f.push("shed", "#00ff00", nil)
	f.render(time.Second)
	f.must(http.StatusOK, "POST", "/api/v1/undo", map[string]any{"id": mark["id"]})
	f.render(100 * time.Millisecond)
	f.expect(f.porch, "100", "the porch right after undo: it never left, so it does not fade in again")
	f.expect(f.shed, "000", "the shed after undo")
}

// served starts a fake controller: DDP on a free loopback UDP port, and its
// HTTP side (which keeps a log of every request) on a test server.
func served(t *testing.T, ctx context.Context, cfg fakewled.Config) (*fakewled.Device, string) {
	t.Helper()
	d, err := fakewled.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go d.ServeUDP(ctx, pc)
	srv := httptest.NewServer(d.Handler())
	t.Cleanup(srv.Close)
	return d, pc.LocalAddr().String()
}

// shows waits until d shows a frame for which ok is true and returns it.
func shows(t *testing.T, d *fakewled.Device, what string, ok func([]byte) bool) []byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		w := d.Shown()
		got, _ := d.Frame()
		if ok(got) {
			return got
		}
		select {
		case <-w:
		case <-time.After(time.Until(deadline)):
			t.Fatalf("%s: %s: frame not shown", d.Config().Name, what)
		}
	}
}

// Undo is a restore of a look stack, never a power command: against fake
// controllers, an apply and its undo send frames and nothing else, the
// lights go back to exactly what they showed, and no controller is ever
// asked to turn off.
func TestUndoNeverSendsAPowerCommand(t *testing.T) {
	ctx := t.Context()
	shed, shedAddr := served(t, ctx, fakewled.Config{Name: "shed", Pixels: 604, Channels: "rgbw"})
	yard, yardAddr := served(t, ctx, fakewled.Config{Name: "yard", Pixels: 480, Channels: "rgb"})
	mc := clock.NewManual(t0)
	a, err := app.New(app.Options{
		ConfigDir: copyDir(t, exampleDir+"/config"), Clock: mc, Log: slog.New(slog.DiscardHandler),
		NewSink: func(a *app.App) (output.Sink, error) {
			return ddp.New([]ddp.Target{{ID: "shed", Addr: shedAddr}, {ID: "yard", Addr: yardAddr}}, ddp.Options{}), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	srv := httpserver.New("", Mount)
	if err := srv.Mount(a); err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, app: a, clock: mc, h: srv.Handler()}
	frame := func() {
		t.Helper()
		mc.Advance(100 * time.Millisecond)
		if err := a.RenderFrame(a.Ticker.Next()); err != nil {
			t.Fatal(err)
		}
	}
	lit := func(b []byte) bool { return bytes.ContainsFunc(b, func(r rune) bool { return r != 0 }) }
	// The porch rail is the yard controller's pixels from 390. The power
	// limiter may scale a level down, so a color is its channel alone.
	red := func(b []byte) bool { return len(b) >= 480*3 && b[390*3] > 0 && b[390*3+1] == 0 && b[390*3+2] == 0 }
	blue := func(b []byte) bool { return len(b) >= 480*3 && b[390*3] == 0 && b[390*3+2] > 0 }

	// same compares two shown frames. The output stage dithers the last bit
	// from frame to frame, so a level may differ by one.
	same := func(x, y []byte) bool {
		if len(x) != len(y) {
			return false
		}
		for i := range x {
			if d := int(x[i]) - int(y[i]); d < -1 || d > 1 {
				return false
			}
		}
		return true
	}

	// Two looks on the lights.
	f.push("porch", "#ff0000", nil)
	f.push("shed", "#00ff00", nil)
	// The power limiter eases its scale over a few frames: let it settle.
	settle := func() {
		for range 40 {
			frame()
		}
		time.Sleep(50 * time.Millisecond) // the last packets reach the fakes
	}
	settle()
	yardBefore := append([]byte(nil), shows(t, yard, "the porch in red", red)...)
	shedBefore := append([]byte(nil), shows(t, shed, "the shed lit", lit)...)
	before := f.must(http.StatusOK, "GET", "/api/v1/layers", nil)

	// Apply a third over everything, then undo it.
	mark := f.must(http.StatusOK, "PUT", "/api/v1/undo", nil)
	f.push("all", "#0000ff", nil)
	frame()
	shows(t, yard, "the porch in blue", blue)
	f.must(http.StatusOK, "POST", "/api/v1/undo", map[string]any{"id": mark["id"]})
	settle()
	if got := shows(t, yard, "the porch in red again", red); !same(got, yardBefore) {
		t.Error("yard: the frame after undo differs from the frame before the apply")
	}
	if got := shows(t, shed, "the shed as before", func(b []byte) bool { return same(b, shedBefore) }); !same(got, shedBefore) {
		t.Error("shed: the frame after undo differs from the frame before the apply")
	}
	if after := f.must(http.StatusOK, "GET", "/api/v1/layers", nil); !reflect.DeepEqual(before, after) {
		t.Errorf("stack after undo: %v, want %v", after, before)
	}

	// Undo to an empty stack: dark frames, still no power command.
	f.must(http.StatusOK, "DELETE", "/api/v1/layers", nil)
	frame()
	mark = f.must(http.StatusOK, "PUT", "/api/v1/undo", nil)
	f.push("porch", "#ff0000", nil)
	frame()
	f.must(http.StatusOK, "POST", "/api/v1/undo", map[string]any{"id": mark["id"]})
	frame()
	shows(t, yard, "dark after undoing to an empty stack", func(b []byte) bool { return len(b) > 0 && !lit(b) })

	for _, d := range []*fakewled.Device{shed, yard} {
		for _, r := range d.Requests() {
			if r.PowerOff() {
				t.Errorf("%s was sent a power-off: %s %s %s", d.Config().Name, r.Method, r.Path, r.Body)
			}
			if r.Method != http.MethodGet {
				t.Errorf("%s was sent %s %s: an apply and its undo send frames only", d.Config().Name, r.Method, r.Path)
			}
		}
	}
	// The log itself works: a power-off sent to a fake is seen as one.
	rec := httptest.NewRecorder()
	yard.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/json/state", bytes.NewReader([]byte(`{"on":false}`))))
	reqs := yard.Requests()
	if n := len(reqs); n == 0 || !reqs[n-1].PowerOff() {
		t.Fatalf("the fake did not record a power-off sent to it: %v", reqs)
	}
	if (fakewled.Request{Method: "POST", Path: "/json/state", Body: `{"on":true,"bri":128}`}).PowerOff() {
		t.Error("turning on is not a power-off")
	}
}
