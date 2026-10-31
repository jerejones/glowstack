// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jerejones/glowstack/internal/stack"
)

func TestReloadSwapsDeviceAddresses(t *testing.T) {
	f := newFixture(t)
	// Reserve two loopback ports, then put them into the fictional config.
	var ports []int
	var reservations []net.Listener
	for range 2 {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		reservations = append(reservations, ln)
		ports = append(ports, ln.Addr().(*net.TCPAddr).Port)
	}
	path := filepath.Join(f.config, "areas.yaml")
	base, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	write := func(front, porch int) {
		t.Helper()
		body := strings.ReplaceAll(string(base), "ip: 192.0.2.50,", fmt.Sprintf("ip: 127.0.0.1, port: %d,", front))
		body = strings.ReplaceAll(body, "ip: 192.0.2.51,", fmt.Sprintf("ip: 127.0.0.1, port: %d,", porch))
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := f.a.Reload(); err != nil {
			t.Fatal(err)
		}
	}
	write(ports[0], ports[1])
	// Release the reservations immediately before starting the listeners.
	for _, ln := range reservations {
		ln.Close()
	}
	defer f.d.stopAll()
	f.d.sync(context.Background())
	if len(f.d.Addrs()) != 2 {
		t.Fatal("initial listeners did not start")
	}
	write(ports[1], ports[0])
	f.d.sync(context.Background())
	for zone, port := range map[string]int{"front": ports[1], "porch": ports[0]} {
		addr := f.d.Addrs()[zone]
		if addr == nil || addr.(*net.TCPAddr).Port != port {
			t.Errorf("%s after reload: %v, want loopback port %d", zone, addr, port)
		}
	}
}

func TestReloadRemovesMainSegment(t *testing.T) {
	f := newFixture(t)
	f.post(`{"mainseg":2}`)
	path := filepath.Join(f.config, "areas.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body = []byte(strings.Replace(string(body), "      - { area: yard }\n", "", 1))
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.a.Reload(); err != nil {
		t.Fatal(err)
	}
	st := f.post(`{"ps":2}`)
	if num(st["mainseg"]) != 0 || num(st["ps"]) != 2 || !seg(st, 0)["on"].(bool) {
		t.Errorf("removed main segment: mainseg=%v, ps=%v, seg0.on=%v", st["mainseg"], st["ps"], seg(st, 0)["on"])
	}
}

func TestServiceReloadAndShutdown(t *testing.T) {
	f := newFixture(t)
	d := New(Options{Bind: "127.0.0.1:0"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	done := make(chan error, 1)
	go func() { done <- d.Service()(ctx, f.a) }()
	t.Cleanup(func() { cancel(); <-done })
	if err := d.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	initial := d.Addrs()
	conn, _, err := websocket.Dial(ctx, "ws://"+initial["porch"].String()+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(f.config, "areas.yaml")
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(original)
	start := strings.Index(body, "zones:\n") + len("zones:\n")
	porch := start + strings.Index(body[start:], "  - id: porch\n")
	write := func(body []byte, count int) {
		t.Helper()
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := f.a.Reload(); err != nil {
			t.Fatal(err)
		}
		for len(d.Addrs()) != count {
			select {
			case <-ctx.Done():
				t.Fatal("device listeners did not follow reload")
			case <-time.After(5 * time.Millisecond):
			}
		}
		if addr := d.Addrs()["porch"]; addr == nil || addr.String() != initial["porch"].String() {
			t.Fatalf("unchanged porch listener moved: %v", addr)
		}
	}
	write([]byte(body[:start]+body[porch:]), 1)
	if c, err := net.DialTimeout("tcp", initial["front"].String(), time.Second); err == nil {
		c.Close()
		t.Error("removed device still accepts connections")
	}
	write(original, 2)
	cancel()
	// The websocket remains open through unrelated device reloads, then
	// closes when the service shuts down, including its hijacked handler.
	readCtx, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer readCancel()
	for {
		if _, _, err := conn.Read(readCtx); err != nil {
			if readCtx.Err() != nil {
				t.Error("shutdown did not close the websocket")
			}
			break
		}
	}
}

func TestConcurrentDeviceChanges(t *testing.T) {
	f := newFixture(t)
	jobs := []func() error{
		func() error {
			_, err := f.d.apply("front", []byte(`{"seg":{"id":0,"on":true,"fx":65,"sx":71}}`))
			return err
		},
		func() error { _, _, err := f.d.message("front"); return err },
		func() error { _, err := f.a.Reload(); return err },
		func() error { return f.a.SetZoneBrightness("front", 0.5) },
		func() error {
			l, err := f.a.Stack.Push(stack.Layer{Owner: stack.OwnerAPI, Target: "porch", Effect: "solid"})
			if err != nil {
				return err
			}
			return f.a.Stack.Remove(l.ID)
		},
	}
	var wg sync.WaitGroup
	for _, job := range jobs {
		wg.Go(func() {
			for range 20 {
				if err := job(); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	wg.Wait()
	if st := f.post(`{}`); num(seg(st, 0)["fx"]) != 65 || !seg(st, 0)["on"].(bool) {
		t.Errorf("concurrent changes lost the WLED segment: %v", seg(st, 0))
	}
}
