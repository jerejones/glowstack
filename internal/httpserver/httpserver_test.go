// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package httpserver_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/api"
	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/httpserver"
)

// TestServeWhileRendering runs the frame loop and the API on a real
// listener, pushes, edits and reloads concurrently (for the race
// detector), then checks the server shuts down with the app.
func TestServeWhileRendering(t *testing.T) {
	srv := httpserver.New("127.0.0.1:0", api.Mount)
	srv.Authorize = func(r *http.Request) error {
		if r.Header.Get("X-Test-Deny") != "" {
			return errors.New("denied")
		}
		return nil
	}
	a, err := app.New(app.Options{ConfigDir: "../../examples/fictional/config", FPS: 200,
		Services: []app.Service{srv.Service()}, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()

	wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
	defer wcancel()
	addr, err := srv.ListenAddr(wctx)
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + addr.String() + "/api/v1/"
	call := func(method, path, body string) (int, string) {
		req, _ := http.NewRequest(method, base+path, strings.NewReader(body))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Error(err)
			return 0, ""
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}

	var wg sync.WaitGroup
	for i := range 4 {
		wg.Go(func() {
			for range 10 {
				if code, body := call("POST", "layers", `{"target": "porch", "effect": "solid", "opacity": 0.5}`); code != 201 {
					t.Errorf("push: %d %s", code, body)
				}
				call("PATCH", "layers/1", `{"opacity": 0.25}`)
				call("PUT", "brightness", `{"master": 0.8, "zones": {"porch": 0.5}}`)
				call("GET", "status", "")
				if i == 0 {
					if code, body := call("POST", "reload", ""); code != 200 {
						t.Errorf("reload: %d %s", code, body)
					}
				}
			}
		})
	}
	wg.Wait()
	req, _ := http.NewRequest("GET", base+"status", nil)
	req.Header.Set("X-Test-Deny", "1")
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusUnauthorized {
		t.Errorf("Authorize hook: %v %v", res, err)
	}
	if a.Stats().Frames == 0 {
		t.Error("no frames rendered")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("app didn't stop")
	}
	if _, err := http.Get(base + "status"); err == nil {
		t.Error("server still answering after shutdown")
	}
}

// TestListenError: a bad address fails the service, and so the app.
func TestListenError(t *testing.T) {
	a, err := app.New(app.Options{ConfigDir: "../../examples/fictional/config", Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := httpserver.New("127.0.0.1:bad-port").Service()(t.Context(), a); err == nil {
		t.Error("listened on a bad address")
	}
}
