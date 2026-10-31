// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package mapview is the live map: a web page that draws every pixel on
// the floor plan and updates as Glowstack renders (see "Live map" in
// docs/design.md).
//
// It serves, on the shared HTTP server:
//
//	GET  /map/                        the page (embedded; no build step)
//	GET  /api/map/geometry            pixel table, runs, nodes, edges, areas, zones, plans
//	GET  /api/map/plans/{n}           plan SVG n, the map's background
//	GET  /api/map/mappings/{id}       per-pixel u and stretch, plus flow diagnostics
//	GET  /api/map/pixels/{id}         inspect one pixel
//	GET  /api/map/power               estimated current per output, limit scale
//	GET  /api/map/ws                  websocket frame stream (see frame.go)
//	GET  /api/map/preview             preview clock and preview layers
//	POST /api/map/preview             pause, resume, step, speed, seek, live
//	GET  /api/map/preview/layers      preview-only layers
//	POST /api/map/preview/layers      push one
//	DELETE /api/map/preview/layers[/{id}]
//
// # House frames and preview frames
//
// While the preview clock follows the house and there are no preview
// layers, the map streams the house's own frames (App.OnFrame). As soon
// as the preview clock is paused, stepped, scrubbed or sped up, or a
// preview-only layer is pushed, the map renders its own frames with a
// second engine and compositor on the preview clock: the house stack's
// live layers with the preview layers on top. The house output never
// sees any of it.
//
// The preview pass reads the house stack with Stack.List, not
// Stack.Frame, so scrubbing never expires or drops house layers. House
// layers show at full fade in the preview, layers whose lifetime has
// ended at the preview time are left out, and zone and master brightness
// (Compositor.Gain, Master) aren't applied to the preview.
//
// There is one preview per Glowstack, shared by every open map: it's a
// design tool, and a shared preview keeps a phone and a laptop in step.
package mapview

import (
	"cmp"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/engine"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

// DefaultFPS is the stream's default frame-rate cap.
const DefaultFPS = 20

// wantFor is how long an API request keeps the map capturing frames when
// no websocket client is connected (so inspect works from scripts).
const wantFor = 5 * time.Second

// Options configures the map.
type Options struct {
	// FPS caps the frame stream (default 20). Clients may ask for less.
	FPS float64
	// Power, if set, reports the output stage's power limiting. Until the
	// output stage provides it, the map shows its own estimate and "n/a"
	// for the limit scale.
	Power func() *PowerReport
}

// Map is the live map. Create it with New and run it with Run, or use
// Service.
type Map struct {
	app    *app.App
	layout *layout.Layout
	opts   Options
	log    *slog.Logger
	geom   []byte // geometry JSON, built once

	preview   *clock.Preview
	following atomic.Bool  // preview clock follows the house
	nPreview  atomic.Int32 // preview layers
	pstack    *stack.Stack
	pengine   *engine.Engine
	pcomp     *render.Compositor
	pbuf      *render.Buffer
	pactive   []stack.Active
	players   []*render.Layer
	pseq      uint64
	pprev     time.Time
	pkey      previewKey // what the last paused preview frame showed
	nextID    atomic.Int64

	clients   atomic.Int32
	wantUntil atomic.Int64 // UnixNano
	lastHouse time.Time    // frame goroutine only

	mu    sync.Mutex
	snap  *Snapshot
	seq   uint32
	ready chan struct{} // closed and replaced when a snapshot is published
}

// New builds the map for a.
func New(a *app.App, opts Options) (*Map, error) {
	if opts.FPS <= 0 {
		opts.FPS = DefaultFPS
	}
	n := len(a.Layout.Pixels)
	m := &Map{
		app: a, layout: a.Layout, opts: opts, log: cmp.Or(a.Log, slog.Default()),
		preview: clock.NewPreview(a.Clock),
		pengine: engine.New(a.Config, a.Layout, a.Mappings, a.Effects, a.Palettes),
		pcomp:   render.NewCompositor(n),
		pbuf:    render.NewBuffer(n),
		ready:   make(chan struct{}),
	}
	m.following.Store(true)
	m.pengine.OnError = func(id string, err error) { m.log.Warn("preview layer can't be rendered", "layer", id, "err", err) }
	// Preview layers appear and vanish at once: fades are for the house.
	m.pstack = stack.New(m.preview, stack.Fades{})
	m.pstack.Validate = m.pengine.Check
	var err error
	if m.geom, err = json.Marshal(m.geometry()); err != nil {
		return nil, err
	}
	a.OnFrame(m.onFrame)
	return m, nil
}

// Service returns an app.Service that registers the map's routes on mux
// and runs the map for the life of the app.
func Service(mux interface {
	Handle(string, http.Handler)
}, opts Options) app.Service {
	return func(ctx context.Context, a *app.App) error {
		m, err := New(a, opts)
		if err != nil {
			return err
		}
		m.Register(mux)
		return m.Run(ctx)
	}
}

// Run renders preview frames while the preview is active, until ctx is
// done.
func (m *Map) Run(ctx context.Context) error {
	t := time.NewTicker(time.Duration(float64(time.Second) / m.opts.FPS))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
		if m.previewing() && m.wanted() {
			m.renderPreview()
		}
	}
}

// previewing reports whether the map shows its own render rather than
// the house's.
func (m *Map) previewing() bool {
	return !m.following.Load() || m.nPreview.Load() > 0
}

// wanted reports whether anyone is looking at frames.
func (m *Map) wanted() bool {
	return m.clients.Load() > 0 || time.Now().UnixNano() < m.wantUntil.Load()
}

func (m *Map) touch() { m.wantUntil.Store(time.Now().Add(wantFor).UnixNano()) }

// onFrame captures house frames at up to the stream rate. It runs on the
// frame goroutine.
func (m *Map) onFrame(f clock.Frame, buf *render.Buffer) {
	if m.previewing() || !m.wanted() {
		return
	}
	period := time.Duration(float64(time.Second) / m.opts.FPS)
	if d := f.Time.Sub(m.lastHouse); d >= 0 && d < period-period/8 {
		return
	}
	m.lastHouse = f.Time
	m.publish(m.capture(f, buf, m.app.Compositor, false))
}

// previewKey identifies what a paused preview frame shows, so an
// unchanged paused view isn't rendered again.
type previewKey struct {
	t             time.Time
	house, layers uint64
}

// renderPreview renders one frame at the preview clock's time.
func (m *Map) renderPreview() {
	now := m.preview.Now()
	paused := m.preview.Paused()
	key := previewKey{now, m.app.Stack.Version(), m.pstack.Version()}
	if paused && key == m.pkey {
		if s, _ := m.latest(); s != nil && s.Preview {
			return
		}
	}
	m.pkey = key
	f := clock.Frame{Seq: m.pseq, Time: now, T: clock.Seconds(now)}
	if m.pseq > 0 {
		f.Dt = max(now.Sub(m.pprev).Seconds(), 0)
	}
	m.pseq++
	m.pprev = now
	m.pactive = m.previewActive(now, m.pactive[:0])
	m.players = m.pengine.Resolve(m.pactive, m.players[:0])
	m.pcomp.Render(f, m.players, m.pbuf)
	s := m.capture(f, m.pbuf, m.pcomp, true)
	s.Paused = paused
	m.publish(s)
}

// previewActive lists what the preview renders at now, top first: the
// preview layers, then the house stack's live layers.
func (m *Map) previewActive(now time.Time, dst []stack.Active) []stack.Active {
	for _, l := range m.pstack.List() {
		dst = append(dst, stack.Active{Layer: l, Fade: 1})
	}
	for _, l := range m.app.Stack.List() {
		if t, ok := l.Lifetime.Expires(l.Created); ok && !now.Before(t) {
			continue
		}
		dst = append(dst, stack.Active{Layer: l, Fade: 1})
	}
	return dst
}

// publish makes s the latest snapshot and wakes the stream writers.
func (m *Map) publish(s *Snapshot) {
	m.mu.Lock()
	m.seq++
	s.Seq = m.seq
	m.snap = s
	close(m.ready)
	m.ready = make(chan struct{})
	m.mu.Unlock()
}

// latest returns the latest snapshot (nil before the first) and a channel
// closed when the next one is published.
func (m *Map) latest() (*Snapshot, <-chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snap, m.ready
}
