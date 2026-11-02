// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/fakewled"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/wire"
)

func TestControllerHealthAPI(t *testing.T) {
	for _, selection := range []string{"discard", "none", "shed"} {
		t.Run(selection, func(t *testing.T) {
			dev, err := fakewled.New(fakewled.Config{Name: "shed", Pixels: 2, Channels: "rgb"})
			if err != nil {
				t.Fatal(err)
			}
			srv := httptest.NewServer(dev.Handler())
			defer srv.Close()
			_, port, err := net.SplitHostPort(srv.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			pc, err := net.ListenPacket("udp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer pc.Close()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			go dev.ServeUDP(ctx, pc)
			dir := t.TempDir()
			files := map[string]string{
				"controllers.yaml": fmt.Sprintf(`schema: 1
controllers:
  - {id: shed, host: 127.0.0.1, port: %d, http_port: %s, pixels: 2}
  - {id: spare, host: 192.0.2.2, pixels: 1}
`, pc.LocalAddr().(*net.UDPAddr).Port, port),
				"layout.yaml": `schema: 1
pitch: 1 cm
runs:
  - {id: eave, controller: shed, indices: [0, 1], path: [a, b]}
`,
			}
			for name, body := range files {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			var out *wire.Outputs
			opts := app.Options{ConfigDir: dir, DataDir: t.TempDir(), Log: slog.New(slog.DiscardHandler)}
			if selection != "discard" {
				opts.NewSink = func(a *app.App) (output.Sink, error) {
					var err error
					out, err = wire.New(a.Layout, wire.Options{Select: selection, Log: a.Log})
					return out, err
				}
			}
			a, err := app.New(opts)
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			mux := httpserver.New("", Mount)
			if err := mux.Mount(a); err != nil {
				t.Fatal(err)
			}
			get := func(path string) map[string]any {
				t.Helper()
				r := httptest.NewRecorder()
				mux.Handler().ServeHTTP(r, httptest.NewRequest("GET", path, nil))
				if r.Code != http.StatusOK {
					t.Fatalf("%s: %s", path, r.Body.String())
				}
				var body map[string]any
				if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				return body
			}
			readHealth := func() map[string]any {
				return get("/api/v1/status")["health"].(map[string]any)["controllers"].(map[string]any)
			}
			initial := readHealth()
			if len(initial) != 2 {
				t.Fatalf("missing controllers: %v", initial)
			}
			for id, value := range initial {
				h := value.(map[string]any)
				for key, want := range map[string]any{"reachable": nil, "last_seen": nil, "send_errors": float64(0), "last_error": "", "sending": selection == id} {
					if got, ok := h[key]; !ok || got != want {
						t.Errorf("%s.%s = %v (present %t), want %v", id, key, got, ok, want)
					}
				}
			}
			if selection == "shed" {
				done := make(chan struct{})
				go func() { defer close(done); _ = out.Run(ctx) }()
				defer func() { cancel(); <-done }()
				if err := a.RenderFrame(a.Ticker.Next()); err != nil {
					t.Fatal(err)
				}
				deadline := time.Now().Add(2 * time.Second)
				for {
					h := readHealth()["shed"].(map[string]any)
					if h["reachable"] == true && h["frames"].(float64) > 0 {
						if _, err := time.Parse(time.RFC3339Nano, h["last_seen"].(string)); err != nil {
							t.Fatal(err)
						}
						if h["sending"] != true || h["send_errors"] != float64(0) || h["last_error"] != "" {
							t.Fatalf("health %v", h)
						}
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("controller did not become reachable: %v", h)
					}
					time.Sleep(5 * time.Millisecond)
				}
			}
			listed := get("/api/v1/controllers")
			health := listed["health"].(map[string]any)["controllers"].(map[string]any)
			for _, entry := range listed["controllers"].([]any) {
				c := entry.(map[string]any)
				if !reflect.DeepEqual(c["health"], health[c["id"].(string)]) {
					t.Errorf("controller health differs: %v", c)
				}
			}
			if h := health["spare"].(map[string]any); h["reachable"] != nil || h["sending"] != false {
				t.Fatalf("unselected controller: %v", h)
			}
		})
	}
}
