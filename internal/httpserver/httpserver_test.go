// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package httpserver

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestRunServesAndStops(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	s := New(addr, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	// Routes may be registered after the server starts.
	s.HandleFunc("GET /hello", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "hi") })

	var body []byte
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		resp, err := http.Get("http://" + addr + "/hello")
		if err != nil {
			continue
		}
		body, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
		break
	}
	if string(body) != "hi" {
		t.Fatalf("got %q", body)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := New(addr+"x", nil).Run(context.Background()); err == nil {
		t.Error("bad address accepted")
	}
}
