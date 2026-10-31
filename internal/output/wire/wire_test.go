// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wire

import (
	"bytes"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/fakewled"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/output"
)

type fake struct {
	dev        *fakewled.Device
	udp, httpP int
}

// startFake serves a fake controller's DDP and HTTP on loopback, on ports
// of their own.
func startFake(t *testing.T, name string, pixels int) fake {
	t.Helper()
	d, err := fakewled.New(fakewled.Config{Name: name, Pixels: pixels, Channels: "rgb"})
	if err != nil {
		t.Fatal(err)
	}
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go d.ServeUDP(t.Context(), pc)
	srv := httptest.NewServer(d.Handler())
	t.Cleanup(srv.Close)
	_, hp, _ := net.SplitHostPort(srv.Listener.Addr().String())
	httpPort, _ := strconv.Atoi(hp)
	return fake{dev: d, udp: pc.LocalAddr().(*net.UDPAddr).Port, httpP: httpPort}
}

func testLayout(fs map[string]fake, ids ...string) *layout.Layout {
	l := &layout.Layout{}
	base := int32(0)
	for _, id := range ids {
		f := fs[id]
		n := len(must(f.dev.Frame())) / 3
		c := &config.Controller{ID: id, Host: "127.0.0.1", Port: f.udp, HTTPPort: f.httpP, Pixels: n, Channels: "rgb", White: "explicit"}
		l.Controllers = append(l.Controllers, layout.Controller{ID: id, Base: base, Pixels: n, Config: c})
		base += int32(n)
	}
	return l
}

func must(b []byte, _ fakewled.Stats) []byte { return b }

func waitFor(t *testing.T, d *fakewled.Device, want []byte) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		w := d.Shown()
		if got, _ := d.Frame(); bytes.Equal(got, want) {
			return
		}
		select {
		case <-w:
		case <-deadline:
			got, _ := d.Frame()
			t.Fatalf("shows %v, want %v", got, want)
		}
	}
}

func send(t *testing.T, o *Outputs, l *layout.Layout, v byte) {
	t.Helper()
	for _, f := range output.Frames(l) {
		for i := range f.Data {
			f.Data[i] = v
		}
		if err := o.Send(&f); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOutputsRebuildAndHealth(t *testing.T) {
	fs := map[string]fake{"shed": startFake(t, "shed", 4), "tower": startFake(t, "tower", 2)}
	l := testLayout(fs, "shed")
	o, err := New(l, Options{Select: "all", Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer o.Close()
	send(t, o, l, 7)
	waitFor(t, fs["shed"].dev, bytes.Repeat([]byte{7}, 12))
	o.monitor.Check(t.Context())
	r := o.Report()
	if len(r) != 1 || !r["shed"].Reachable || r["shed"].Count != 4 || r["shed"].Frames == 0 {
		t.Fatalf("report %+v", r)
	}

	// A reload adds tower.
	l2 := testLayout(fs, "shed", "tower")
	if err := o.Rebuild(nil, l2); err != nil {
		t.Fatal(err)
	}
	send(t, o, l2, 9)
	waitFor(t, fs["tower"].dev, bytes.Repeat([]byte{9}, 6))
	waitFor(t, fs["shed"].dev, bytes.Repeat([]byte{9}, 12))
	o.monitor.Check(t.Context())
	r = o.Report()
	if len(r) != 2 || !r["tower"].Reachable || r["tower"].Count != 2 {
		t.Errorf("after rebuild %+v", r)
	}
}

func TestSelectNoneAndLoopback(t *testing.T) {
	l := &layout.Layout{Controllers: []layout.Controller{
		{ID: "shed", Pixels: 1, Config: &config.Controller{Host: "192.0.2.10", Port: 4048, HTTPPort: 80}},
		{ID: "tower", Pixels: 1, Config: &config.Controller{Host: "192.0.2.11", Port: 4048, HTTPPort: 80}},
	}}
	if d, h := Endpoints(l.Controllers[1], 1, 40481); d != "127.0.0.1:40482" || h != d {
		t.Errorf("loopback endpoints %s %s", d, h)
	}
	if d, h := Endpoints(l.Controllers[0], 0, 0); d != "192.0.2.10:4048" || h != "192.0.2.10:80" {
		t.Errorf("endpoints %s %s", d, h)
	}
	o, err := New(l, Options{Select: "none", Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer o.Close()
	if r := o.Report(); len(r) != 0 {
		t.Errorf("none selected but report %+v", r)
	}
	if _, err := New(l, Options{Select: "shed,nope"}); err == nil {
		t.Error("unknown controller accepted")
	}
}

func TestRebuildFailureStopsOldTargets(t *testing.T) {
	fs := map[string]fake{"shed": startFake(t, "shed", 4), "tower": startFake(t, "tower", 2)}
	l := testLayout(fs, "shed", "tower")
	o, err := New(l, Options{Select: "shed,tower", Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer o.Close()
	send(t, o, l, 7)
	waitFor(t, fs["shed"].dev, bytes.Repeat([]byte{7}, 12))
	// The app has accepted a new layout. If one selected id vanished,
	// keeping the old sender would send new frames to stale endpoints.
	if err := o.Rebuild(nil, testLayout(fs, "shed")); err == nil {
		t.Fatal("missing selected controller should report an error")
	}
	if r := o.Report(); len(r) != 0 {
		t.Fatalf("failed rebuild left old outputs active: %+v", r)
	}
	// A subsequent valid reload can enable the explicitly selected set.
	if err := o.Rebuild(nil, l); err != nil {
		t.Fatal(err)
	}
	send(t, o, l, 9)
	waitFor(t, fs["shed"].dev, bytes.Repeat([]byte{9}, 12))
}
