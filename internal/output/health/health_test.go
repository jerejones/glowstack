// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package health_test

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jerejones/glowstack/internal/fakewled"
	"github.com/jerejones/glowstack/internal/output/health"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func server(t *testing.T, cfg fakewled.Config) *httptest.Server {
	t.Helper()
	d, err := fakewled.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var writes atomic.Int32
	h := d.Handler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes.Add(1)
		}
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		srv.Close()
		if writes.Load() != 0 {
			t.Error("health checker wrote to the controller")
		}
	})
	return srv
}

func TestGoodController(t *testing.T) {
	srv := server(t, fakewled.Config{Name: "shed", Pixels: 604, Channels: "rgbw"})
	m := &health.Monitor{Log: quiet(), Targets: []health.Target{
		{ID: "shed", URL: srv.URL, Pixels: 604, Channels: "rgbw", White: "explicit"},
	}}
	m.Check(t.Context())
	st := m.Status()[0]
	if !st.Reachable || st.Version != "0.15.0-fake" || st.Count != 604 || len(st.Mismatches) != 0 {
		t.Errorf("%+v", st)
	}
}

func TestMisconfiguredController(t *testing.T) {
	srv := server(t, fakewled.Config{Name: "yard", Pixels: 500, Channels: "rgbw", AutoWhite: 2, LedMaps: 1,
		Live: &fakewled.Live{Enabled: false, MainSegmentOnly: true, RespectLedMaps: true, Timeout: 650, DMXAddress: 9}})
	m := &health.Monitor{Log: quiet(), Targets: []health.Target{
		{ID: "yard", URL: srv.URL, Pixels: 480, Channels: "rgbw", White: "explicit"},
	}}
	m.Check(t.Context())
	got := strings.Join(m.Status()[0].Mismatches, "\n")
	for _, want := range []string{
		"reports 500 LEDs, controllers.yaml says 480",
		"realtime receive is off",
		"main segment only",
		"timeout is infinite",
		"gamma correction is on",
		"Force max brightness",
		"LED map",
		"DMX start address 9 shifts DDP data by 2 pixels",
		`auto-white "accurate"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	// With white: auto the controller is meant to compute W.
	m.Targets[0].White = "auto"
	m2 := &health.Monitor{Log: quiet(), Targets: m.Targets}
	m2.Check(t.Context())
	if got := strings.Join(m2.Status()[0].Mismatches, "\n"); strings.Contains(got, "auto-white") {
		t.Errorf("auto-white flagged under white: auto")
	}
}

func TestRebootAndUnreachable(t *testing.T) {
	var uptime atomic.Int64
	var cfgReads atomic.Int32
	uptime.Store(100)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/json/info":
			fmt.Fprintf(w, `{"ver":"0.15.0","uptime":%d,"leds":{"count":10}}`, uptime.Load())
		case "/json/cfg":
			cfgReads.Add(1)
			fmt.Fprint(w, `{"if":{"live":{"en":true,"mso":false,"timeout":25,"maxbri":true,"no-gc":true}}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	m := &health.Monitor{Log: quiet(), Targets: []health.Target{{ID: "a", URL: srv.URL, Pixels: 10, Channels: "rgb", White: "explicit"}}}
	m.Check(t.Context())
	uptime.Store(160)
	m.Check(t.Context())
	if st := m.Status()[0]; st.Reboots != 0 || cfgReads.Load() != 1 {
		t.Errorf("no reboot yet: %+v, cfg reads %d", st, cfgReads.Load())
	}
	uptime.Store(5)
	m.Check(t.Context())
	if st := m.Status()[0]; st.Reboots != 1 || cfgReads.Load() != 2 || len(st.Mismatches) != 0 {
		t.Errorf("after reboot: %+v, cfg reads %d", st, cfgReads.Load())
	}
	srv.Close()
	m.Check(t.Context())
	if st := m.Status()[0]; st.Reachable || st.Err == "" {
		t.Errorf("closed server still reachable: %+v", st)
	}
}
