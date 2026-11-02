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
//	GET  /api/map/geometry            pixel table, runs, nodes, edges, areas, zones, plans, map settings
//	GET  /api/map/plans/{n}           plan SVG n, or the scene model (.glb), the map's background
//	GET  /api/map/mappings/{id}       per-pixel u and stretch, plus flow diagnostics
//	GET  /api/map/pixels/{id}         inspect one pixel
//	GET  /api/map/power               estimated current per output, limit scale
//	GET  /api/map/ws                  websocket frame stream (see frame.go)
//	GET  /api/map/preview             preview clock and preview layers
//	POST /api/map/preview             pause, resume, step, speed, seek, live
//	GET  /api/map/preview/layers      preview-only layers
//	POST /api/map/preview/layers      push one
//	DELETE /api/map/preview/layers[/{id}]
//	POST /api/map/preview/promote     move preview layers to the house stack
//
// # House frames and preview frames
//
// While the preview clock follows the house and there are no preview
// layers, the map streams the house's own frames (App.OnFrame). As soon
// as the preview clock is paused, stepped, scrubbed or sped up, or a
// layer is on the preview stack (App.Preview, shared with the control
// API's `preview: true`), the map renders its own frames with a second
// engine and compositor on the preview clock: the house stack's live
// layers with the preview layers on top. The house output never sees any
// of it.
//
// Each viewer chooses what it's shown (Subscription.Show, and ?show= on
// the pixel and power endpoints): the default follows the rule above,
// and ShowHouse always gets the house's frames, preview or not, so a
// dashboard can show what the lights show while someone designs. The two
// kinds of frame are kept as separate feeds and only rendered while
// someone wants them.
//
// The preview pass reads both stacks with Stack.List, not Stack.Frame, so
// scrubbing never expires or drops layers. Layers show at full fade in the
// preview, layers whose lifetime has ended at the preview time are left
// out, and zone and master brightness (Compositor.Gain, Master) aren't
// applied to the preview.
//
// # Reloads
//
// After App.Reload the map rebuilds its geometry and preview engine from
// App.Current. Snapshots carry the reload generation; the stream re-sends
// "subscribed" with the new generation, and the page reloads its geometry.
//
// There is one preview per Glowstack, shared by every open map: it's a
// design tool, and a shared preview keeps a phone and a laptop in step.
package mapview

import (
	"cmp"
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/engine"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/output"
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
	// Power, if set, reports the output stage's power limiting. nil uses
	// the app's stage when it's an output.PowerReporter (the default
	// output.Pipeline is); otherwise the map shows only its own estimate
	// and "n/a" for the limit scale.
	Power func() *PowerReport
}

// Map is the live map. Create it with New and run it with Run, or use
// Service.
type Map struct {
	app  *app.App
	opts Options
	log  *slog.Logger
	st   atomic.Pointer[state]

	preview   *clock.Preview
	following atomic.Bool // preview clock follows the house
	// The preview pass, on Run's goroutine.
	pgen    uint64 // reload generation pengine and pcomp were built for
	pengine *engine.Engine
	pcomp   *render.Compositor
	pbuf    *render.Buffer
	pactive []stack.Active
	players []*render.Layer
	pseq    uint64
	pprev   time.Time
	pkey    previewKey // what the last paused preview frame showed

	clients        atomic.Int32 // websocket clients
	houseClients   atomic.Int32 // of which ShowHouse
	wantUntil      atomic.Int64 // UnixNano
	wantHouseUntil atomic.Int64 // UnixNano, for ShowHouse requests
	lastHouse      time.Time    // frame goroutine only

	mu    sync.Mutex
	house *Snapshot     // latest house frame
	prev  *Snapshot     // latest preview frame; nil once the preview ends
	seq   uint32        // shared by both feeds, so a client switching sees a new number
	ready chan struct{} // closed and replaced when a snapshot is published
}

// What a viewer is shown.
const (
	ShowAuto  = ""      // preview frames while previewing, else house frames
	ShowHouse = "house" // always the house's frames
)

func validShow(s string) bool { return s == ShowAuto || s == ShowHouse }

// state is the config the map describes: the app's view and the
// geometry JSON built from it. It's replaced whole after a reload.
type state struct {
	app.View
	geom []byte
}

func (m *Map) state() *state { return m.st.Load() }

// New builds the map for a.
func New(a *app.App, opts Options) (*Map, error) {
	if opts.FPS <= 0 {
		opts.FPS = DefaultFPS
	}
	if opts.Power == nil {
		opts.Power = func() *PowerReport {
			if pr, ok := a.Stage().(output.PowerReporter); ok {
				return FromStage(pr.Power())
			}
			return nil
		}
	}
	m := &Map{
		app: a, opts: opts, log: cmp.Or(a.Log, slog.Default()),
		preview: clock.NewPreview(a.Clock),
		ready:   make(chan struct{}),
	}
	m.following.Store(true)
	if err := m.load(a.Current()); err != nil {
		return nil, err
	}
	a.OnReload(func() {
		if err := m.load(a.Current()); err != nil {
			m.log.Error("live map: rebuilding geometry after reload", "err", err)
		}
	})
	a.OnFrame(m.onFrame)
	return m, nil
}

// load builds the geometry for v and makes it current.
func (m *Map) load(v app.View) error {
	geom, err := json.Marshal(m.geometry(v))
	if err != nil {
		return err
	}
	m.st.Store(&state{View: v, geom: geom})
	return nil
}

// Mount is an httpserver.Mount: it builds the map, registers its routes
// and runs it for the life of the app.
func Mount(opts Options) httpserver.Mount {
	return func(a *app.App, s *httpserver.Server) error {
		m, err := New(a, opts)
		if err != nil {
			return err
		}
		m.Register(s)
		s.Go(m.Run)
		return nil
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
		if m.previewing() && m.wantedAuto() {
			m.renderPreview()
		}
	}
}

// previewing reports whether the map shows its own render rather than
// the house's.
func (m *Map) previewing() bool {
	return !m.following.Load() || m.app.Preview.Len() > 0
}

// wantedAuto reports whether anyone is looking at ShowAuto frames.
func (m *Map) wantedAuto() bool {
	return m.clients.Load() > m.houseClients.Load() || time.Now().UnixNano() < m.wantUntil.Load()
}

// wantedHouse reports whether house frames are needed.
func (m *Map) wantedHouse() bool {
	if m.previewing() {
		return m.houseClients.Load() > 0 || time.Now().UnixNano() < m.wantHouseUntil.Load()
	}
	return m.clients.Load() > 0 || time.Now().UnixNano() < max(m.wantUntil.Load(), m.wantHouseUntil.Load())
}

// touch keeps the frames show wants coming for a while, for API requests.
func (m *Map) touch(show string) {
	until := time.Now().Add(wantFor).UnixNano()
	if show == ShowHouse {
		m.wantHouseUntil.Store(until)
	} else {
		m.wantUntil.Store(until)
	}
}

// onFrame captures house frames at up to the stream rate. It runs on the
// frame goroutine.
func (m *Map) onFrame(f clock.Frame, buf *render.Buffer) {
	if !m.wantedHouse() {
		return
	}
	period := time.Duration(float64(time.Second) / m.opts.FPS)
	if d := f.Time.Sub(m.lastHouse); d >= 0 && d < period-period/8 {
		return
	}
	o := m.app.Observed()
	st := m.state()
	if o.Gen != st.Gen {
		return // reloaded; the map catches up in OnReload
	}
	m.lastHouse = f.Time
	m.publish(m.capture(f, st.View, buf, o.Compositor, false))
}

// previewKey identifies what a paused preview frame shows, so an
// unchanged paused view isn't rendered again.
type previewKey struct {
	t                  time.Time
	house, layers, gen uint64
}

// renderPreview renders one frame at the preview clock's time.
func (m *Map) renderPreview() {
	st := m.state()
	if m.pengine == nil || m.pgen != st.Gen {
		v := st.View
		m.pgen = v.Gen
		m.pengine = engine.New(v.Config, v.Layout, v.Mappings, m.app.Effects, v.Palettes)
		m.pengine.OnError = func(id string, err error) { m.log.Warn("preview layer can't be rendered", "layer", id, "err", err) }
		m.pcomp = render.NewCompositor(len(v.Layout.Pixels))
		m.pbuf = render.NewBuffer(len(v.Layout.Pixels))
		m.pkey = previewKey{}
	}
	now := m.preview.Now()
	paused := m.preview.Paused()
	key := previewKey{now, m.app.Stack.Version(), m.app.Preview.Version(), st.Gen}
	if paused && key == m.pkey {
		m.mu.Lock()
		have := m.prev != nil
		m.mu.Unlock()
		if have {
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
	s := m.capture(f, st.View, m.pbuf, m.pcomp, true)
	s.Paused = paused
	m.publish(s)
}

// previewActive lists what the preview renders at now, top first: the
// preview layers, then the house stack's live layers. Preview layers are
// renamed (previewIDPrefix + id) because the two stacks' ids may clash and
// the engine caches by id.
func (m *Map) previewActive(now time.Time, dst []stack.Active) []stack.Active {
	live := func(l stack.Layer) bool {
		t, ok := l.Lifetime.Expires(l.Created)
		return !ok || now.Before(t)
	}
	for _, l := range m.app.Preview.List() {
		if live(l) {
			l.ID = previewIDPrefix + l.ID
			dst = append(dst, stack.Active{Layer: l, Fade: 1})
		}
	}
	for _, l := range m.app.Stack.List() {
		if live(l) {
			l.ID = houseIDPrefix + l.ID
			dst = append(dst, stack.Active{Layer: l, Fade: 1})
		}
	}
	return dst
}

// publish makes s the latest snapshot of its feed and wakes the stream
// writers.
func (m *Map) publish(s *Snapshot) {
	previewing := m.previewing()
	m.mu.Lock()
	m.seq++
	s.Seq = m.seq
	if s.Preview {
		m.prev = s
	} else {
		m.house = s
		if !previewing {
			// The preview is over; don't show its last frame when the
			// next one starts.
			m.prev = nil
		}
	}
	close(m.ready)
	m.ready = make(chan struct{})
	m.mu.Unlock()
}

// latest returns the latest snapshot for show (nil before the first) and
// a channel closed when the next snapshot of either feed is published.
// ShowAuto gets preview frames while previewing, falling back to the last
// house frame until the first preview frame is rendered.
func (m *Map) latest(show string) (*Snapshot, <-chan struct{}) {
	previewing := show == ShowAuto && m.previewing()
	m.mu.Lock()
	defer m.mu.Unlock()
	if previewing && m.prev != nil {
		return m.prev, m.ready
	}
	return m.house, m.ready
}
