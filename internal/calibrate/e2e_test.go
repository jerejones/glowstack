// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
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
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/fakewled"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/wire"
	"github.com/jerejones/glowstack/internal/render"
)

// fake is a fake WLED controller on loopback.
type fake struct {
	dev           *fakewled.Device
	udp, httpPort int
}

func startFake(t *testing.T, name string, pixels int, channels string) *fake {
	t.Helper()
	d, err := fakewled.New(fakewled.Config{Name: name, Pixels: pixels, Channels: channels})
	if err != nil {
		t.Fatal(err)
	}
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go d.ServeUDP(t.Context(), pc)
	hs := httptest.NewServer(d.Handler())
	t.Cleanup(hs.Close)
	_, port, _ := net.SplitHostPort(hs.Listener.Addr().String())
	f := &fake{dev: d, udp: pc.LocalAddr().(*net.UDPAddr).Port}
	fmt.Sscan(port, &f.httpPort)
	return f
}

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

// TestEndToEndWithFakes runs a calibration session through the HTTP API
// on the fictional installation, with its two controllers replaced by
// fakes on loopback and only `shed` selected for output, and checks the
// pixels the fakes receive.
func TestEndToEndWithFakes(t *testing.T) {
	shed := startFake(t, "shed", 604, "rgbw")
	yard := startFake(t, "yard", 480, "rgb")
	cfgDir := copyDir(t, "../../examples/fictional/config")
	data := copyDir(t, "../../examples/fictional/data")
	p := filepath.Join(cfgDir, config.ControllersFileName)
	b, _ := os.ReadFile(p)
	s := strings.Replace(string(b), "host: 192.0.2.21", "host: 127.0.0.1", 1)
	s = strings.Replace(s, "port: 4048", fmt.Sprintf("port: %d\n    http_port: %d", shed.udp, shed.httpPort), 1)
	s = strings.Replace(s, "host: 192.0.2.22", fmt.Sprintf("host: 127.0.0.1\n    port: %d\n    http_port: %d", yard.udp, yard.httpPort), 1)
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}

	clk := clock.NewManual(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC))
	a, err := app.New(app.Options{
		ConfigDir: cfgDir, DataDir: data, Clock: clk, Log: slog.New(slog.DiscardHandler),
		Effects: func(r *render.Registry) error {
			if err := effects.Register(r); err != nil {
				return err
			}
			return calibrate.Register(r)
		},
		NewSink: func(a *app.App) (output.Sink, error) {
			return wire.New(a.Layout, wire.Options{Select: "shed", Log: slog.New(slog.DiscardHandler)})
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	srv := httpserver.New("", api.Mount, calibrate.Mount)
	if err := srv.Mount(a); err != nil {
		t.Fatal(err)
	}
	h := srv.Handler()
	call := func(path string, body any) calibrate.State {
		t.Helper()
		method := http.MethodPost
		if body == nil {
			method = http.MethodGet
		}
		raw, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, path, bytes.NewReader(raw)))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body)
		}
		var st calibrate.State
		if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
			t.Fatal(err)
		}
		return st
	}
	// frame renders until the shed fake has shown a frame from after the
	// last change, and returns it.
	frame := func() []byte {
		t.Helper()
		var got []byte
		for range 3 { // a frame or two may be coalesced on the way
			shown := shed.dev.Shown()
			clk.Advance(50 * time.Millisecond)
			if err := a.RenderFrame(clock.Frame{Time: clk.Now(), T: clock.Seconds(clk.Now())}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-shown:
			case <-time.After(2 * time.Second):
				t.Fatal("the shed fake never showed a frame")
			}
			got, _ = shed.dev.Frame()
		}
		return got
	}
	rgbw := func(f []byte, i int) [4]byte { return [4]byte(f[i*4 : i*4+4]) }

	st := call(calibrate.Prefix+"/start", map[string]any{
		"target": map[string]any{"kind": "anchor", "run": "shed-eave", "node": "shed-eave-mid"}})
	est := st.Cursors[0].Index
	if len(st.Controllers) != 1 || st.Controllers[0].ID != "shed" || st.Controllers[0].Sending == nil || !*st.Controllers[0].Sending {
		t.Errorf("controllers = %+v", st.Controllers)
	}
	f := frame()
	if got := rgbw(f, est); got != [4]byte{255, 255, 255, 0} {
		t.Errorf("estimated pixel shed:%d = %v, want white", est, got)
	}
	if got := rgbw(f, est+10); got != [4]byte{0, 255, 0, 0} {
		t.Errorf("shed:%d = %v, want a green ruler mark", est+10, got)
	}
	if got := rgbw(f, est-20); got != [4]byte{255, 0, 0, 0} {
		t.Errorf("shed:%d = %v, want a red ruler mark", est-20, got)
	}
	if got := rgbw(f, 550); got != [4]byte{} {
		t.Errorf("tower pixel shed:550 = %v, want dark (no house layers)", got)
	}

	call(calibrate.Prefix+"/nudge", map[string]any{"by": 10})
	st = call(calibrate.Prefix+"/nudge", map[string]any{"by": -1})
	if st.Cursors[0].Index != est+9 {
		t.Fatalf("cursor = %d, want %d", st.Cursors[0].Index, est+9)
	}
	f = frame()
	if got := rgbw(f, est+9); got != [4]byte{255, 255, 255, 0} {
		t.Errorf("nudged pixel shed:%d = %v, want white", est+9, got)
	}
	st = call(calibrate.Prefix+"/confirm", map[string]any{})
	if st.Cursors[0].Source != "measured" || st.Measured != 3 {
		t.Errorf("after confirm: %+v, %d measured", st.Cursors[0], st.Measured)
	}
	file, _ := os.ReadFile(filepath.Join(data, config.AnchorsFileName))
	if want := fmt.Sprintf("  - { run: shed-eave, node: shed-eave-mid, offset: %d, pixels: 482, source: measured }\n", est+9); !strings.Contains(string(file), want) {
		t.Errorf("anchors.yaml:\n%s\nwant a line %q", file, want)
	}
	// The house API sees the re-solved layout.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("status: %d", rec.Code)
	}

	call(calibrate.Prefix+"/end", map[string]any{})
	f = frame()
	if got := rgbw(f, est+9); got != [4]byte{} {
		t.Errorf("after end shed:%d = %v, want dark again", est+9, got)
	}
	// The yard isn't selected by --output, so it never got a frame.
	if _, stats := yard.dev.Frame(); stats.Frames != 0 || stats.Packets != 0 {
		t.Errorf("the yard fake got %d frames", stats.Frames)
	}
}
