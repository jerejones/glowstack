// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

const exampleConfig = "../../examples/fictional/config"

// recorder is a Sink keeping the last frame per controller.
type recorder struct {
	mu     sync.Mutex
	last   map[string][]byte
	sent   int
	closed bool
}

func (r *recorder) Send(f *output.Frame) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.last == nil {
		r.last = map[string][]byte{}
	}
	r.last[f.ID] = append([]byte(nil), f.Data...)
	r.sent++
	return nil
}

func (r *recorder) Close() error { r.closed = true; return nil }

func dataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	b, err := os.ReadFile("../../examples/fictional/data/anchors.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "anchors.yaml"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestEndToEnd(t *testing.T) {
	data := dataDir(t)
	c := clock.NewManual(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC))
	sink := &recorder{}
	a, err := New(Options{ConfigDir: exampleConfig, DataDir: data, Clock: c, Sink: sink})
	if err != nil {
		t.Fatal(err)
	}
	var observed int
	a.OnFrame(func(f clock.Frame, buf *render.Buffer) { observed++ })

	// Light the porch (yard controller indices 390–479) red, no fade.
	if _, err := a.Stack.Push(stack.Layer{Owner: stack.OwnerCLI, Target: "porch", Effect: "solid",
		Params: map[string]any{"color": "#ff0000", "fade_in": "0s"}}); err != nil {
		t.Fatal(err)
	}
	if err := a.RenderFrame(a.Ticker.Next()); err != nil {
		t.Fatal(err)
	}
	yard := sink.last["yard"]
	if len(yard) != 480*3 || len(sink.last["shed"]) != 604*4 {
		t.Fatalf("frame sizes %d %d", len(yard), len(sink.last["shed"]))
	}
	if yard[389*3] != 0 || yard[390*3] != 255 || yard[479*3] != 255 || yard[479*3+1] != 0 {
		t.Errorf("porch pixels: %v %v %v", yard[389*3:389*3+3], yard[390*3:390*3+3], yard[479*3:])
	}
	if observed != 1 || sink.sent != 2 {
		t.Errorf("observed %d, sent %d", observed, sink.sent)
	}

	var sum strings.Builder
	a.Summary(&sum)
	for _, want := range []string{"1084 pixels on 2 controllers", "controller shed", "run shed-eave", "front-sweep", "stack: 1 layers"} {
		if !strings.Contains(sum.String(), want) {
			t.Errorf("summary lacks %q:\n%s", want, sum.String())
		}
	}

	// Close saves state.json; a new App restores it.
	if err := a.Close(); err != nil || !sink.closed {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(data, "state.json")); err != nil {
		t.Fatal(err)
	}
	b, err := New(Options{ConfigDir: exampleConfig, DataDir: data, Clock: c})
	if err != nil {
		t.Fatal(err)
	}
	if ls := b.Stack.List(); len(ls) != 1 || ls[0].Target != "porch" || len(b.Restored) != 0 {
		t.Errorf("restored %+v %v", ls, b.Restored)
	}
}

func TestRunStopsServices(t *testing.T) {
	a, err := New(Options{ConfigDir: exampleConfig, FPS: 200})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	a.opts.Services = []Service{func(ctx context.Context, a *App) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := a.Run(ctx); err != nil {
		t.Fatal(err)
	}
	<-started
	if a.Ticker.FPS() != 200 {
		t.Errorf("fps %v", a.Ticker.FPS())
	}
}
