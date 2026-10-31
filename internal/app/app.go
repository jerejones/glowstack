// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package app wires Glowstack together: config → layout → mappings →
// palettes and effects → stack (restored from state.json) → engine →
// compositor → output stage → sinks, driven by the frame clock.
//
// Seams for work that lives elsewhere:
//
//   - Options.Sink (or Options.NewSink) and Options.Stage: the output stage
//     and DDP senders. App.Stage returns the stage in use; the default,
//     output.Pipeline, reports power estimates (output.PowerReporter).
//     A stage or sink that implements Rebuilder is rebuilt after Reload.
//   - Options.Services: long-running parts that need the App, such as the
//     HTTP API, the WLED-compatible devices and the live map. Each runs
//     in its own goroutine for the life of Run.
//   - App.OnFrame: per-frame observers (the live map).
//   - App.OnReload: told after a config reload replaced the layout.
//   - App.Preview: a second stack for "try before applying" layers that
//     only the live map renders.
//   - Options.Effects: effect registration (default effects.Register).
//
// Brightness (App.SetMaster, App.SetZoneBrightness) and Reload are safe to
// call from any goroutine; they take effect from the next frame.
package app

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/engine"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/preset"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
	"github.com/jerejones/glowstack/internal/storage"
)

// Boot modes (glowstack.yaml `boot`).
const (
	BootRestore = "restore"
	BootDark    = "dark"
)

// SaveInterval is how often stack changes are written at most.
const SaveInterval = time.Second

// Service is a long-running part started by Run, such as an HTTP server.
// It should return when ctx is done.
type Service func(ctx context.Context, a *App) error

// Options configures New.
type Options struct {
	ConfigDir string
	DataDir   string  // "" keeps state in memory only
	FPS       float64 // 0 = glowstack.yaml's fps
	Clock     clock.Source
	Sink      output.Sink  // nil = NewSink, else output.Discard
	Stage     output.Stage // nil = output.NewPipeline
	Effects   func(*render.Registry) error
	Services  []Service
	Log       *slog.Logger

	// NewSink makes the sink once the layout is known, when Sink is nil.
	NewSink func(*App) (output.Sink, error)
}

// App is a running Glowstack. Its exported fields are read-only after New,
// except that Reload replaces Config, Layout, Mappings, Palettes, Engine
// and Compositor. Code on other goroutines that may run during a reload
// should read those through Current.
type App struct {
	Config     *config.Config
	Layout     *layout.Layout
	Mappings   *layout.Mappings
	Palettes   *palette.Registry
	Effects    *render.Registry
	Stack      *stack.Stack
	Engine     *engine.Engine
	Compositor *render.Compositor
	Ticker     *clock.Ticker
	Clock      clock.Source
	Store      storage.Store
	Log        *slog.Logger
	// Restored lists warnings from restoring state.json.
	Restored []string
	// Preview holds preview-only layers: validated like Stack's, never
	// saved, and rendered only by the live map, not to the outputs.
	Preview *stack.Stack

	opts   Options
	saver  *storage.Saver
	sink   output.Sink
	stage  output.Stage
	buf    *render.Buffer
	frames []output.Frame
	active []stack.Active
	layers []*render.Layer

	// mu guards the fields Reload replaces (see Current) and gen.
	mu       sync.RWMutex
	gen      uint64     // increases on every reload
	reloadMu sync.Mutex // one Reload at a time

	levels levels
	stats  stats
	// Frame-loop state: the reload generation and brightness version the
	// outputs and gains were last set up for.
	outGen, gainGen, gainLevels uint64

	obsMu     sync.RWMutex
	observers []func(clock.Frame, *render.Buffer)
	onReload  []func()
}

// New loads the config and data folders, solves the layout and mappings,
// and restores the stack.
func New(opts Options) (*App, error) {
	a := &App{opts: opts, Log: cmp.Or(opts.Log, slog.Default()), Clock: opts.Clock}
	if a.Clock == nil {
		a.Clock = clock.Real{}
	}
	var err error
	if a.Config, err = config.Load(opts.ConfigDir, opts.DataDir); err != nil {
		return nil, err
	}
	if a.Layout, err = layout.Build(a.Config); err != nil {
		return nil, err
	}
	if a.Mappings, err = layout.SolveMappings(a.Layout, a.Config); err != nil {
		return nil, err
	}
	a.Palettes = palette.NewRegistry(a.Config.Palettes)
	a.Effects = render.NewRegistry()
	register := opts.Effects
	if register == nil {
		register = effects.Register
	}
	if err := register(a.Effects); err != nil {
		return nil, err
	}
	if err := effects.RegisterComposites(a.Effects, a.Config.Composites); err != nil {
		return nil, err
	}
	for _, err := range preset.New(a.Config.Presets).Check(a.Effects, a.Palettes, a.Layout.Pitch) {
		a.Log.Warn("preset can't be used", "err", err)
	}
	a.Engine = engine.New(a.Config, a.Layout, a.Mappings, a.Effects, a.Palettes)
	a.Engine.OnError = func(id string, err error) { a.Log.Error("layer can't be rendered", "layer", id, "err", err) }

	s := a.Config.Settings
	fades := stack.Fades{In: time.Duration(*s.Fade.In), Out: time.Duration(*s.Fade.Out)}
	a.Stack = stack.New(a.Clock, fades)
	a.Preview = stack.New(a.Clock, fades)
	// Validate through Current so a reload's new engine takes over.
	validate := func(l *stack.Layer) error { return a.Current().Engine.Check(l) }
	a.Stack.Validate, a.Preview.Validate = validate, validate
	if opts.DataDir != "" {
		a.Store = storage.Dir(opts.DataDir)
	} else {
		a.Store = &storage.Memory{}
	}
	if s.Boot != BootDark {
		if a.Restored, err = a.Stack.Load(a.Store); err != nil {
			return nil, err
		}
	}
	a.saver = storage.NewSaver(SaveInterval, func() error { return a.Stack.Save(a.Store) },
		func(err error) { a.Log.Error("saving the stack", "err", err) })
	a.Stack.OnChange(a.saver.Trigger)
	if err := a.loadLevels(); err != nil {
		return nil, err
	}

	a.stage = opts.Stage
	if a.stage == nil {
		if a.stage, err = output.NewPipeline(a.Layout, a.Config); err != nil {
			return nil, err
		}
	}
	a.sink = opts.Sink
	if a.sink == nil && opts.NewSink != nil {
		if a.sink, err = opts.NewSink(a); err != nil {
			return nil, err
		}
	}
	if a.sink == nil {
		a.sink = output.Discard{}
	}
	n := len(a.Layout.Pixels)
	a.Compositor = render.NewCompositor(n)
	a.buf = render.NewBuffer(n)
	a.frames = output.Frames(a.Layout)
	a.Ticker = clock.NewTicker(cmp.Or(opts.FPS, s.FPS), a.Clock)
	return a, nil
}

// OnFrame registers fn to see every rendered frame, on the frame loop's
// goroutine. fn must be quick and must not keep buf after returning.
func (a *App) OnFrame(fn func(clock.Frame, *render.Buffer)) {
	a.obsMu.Lock()
	a.observers = append(a.observers, fn)
	a.obsMu.Unlock()
}

// RenderFrame renders, observes and sends one frame. Run calls it on each
// tick; tests call it directly.
func (a *App) RenderFrame(f clock.Frame) error {
	start := time.Now()
	// Take this frame's view; a concurrent Reload swaps in a new one for
	// the next frame and never touches these.
	a.mu.RLock()
	gen, eng, comp, buf, frames, stage := a.gen, a.Engine, a.Compositor, a.buf, a.frames, a.stage
	cfg, lay := a.Config, a.Layout
	a.mu.RUnlock()
	if gen != a.outGen {
		a.outGen = gen
		a.rebuildOutputs(stage, cfg, lay)
	}
	a.applyLevels(gen, comp, cfg, lay)

	a.active = a.Stack.Frame(f.Time, a.active[:0])
	a.layers = eng.Resolve(a.active, a.layers[:0])
	comp.Render(f, a.layers, buf)
	a.obsMu.RLock()
	for _, fn := range a.observers {
		fn(f, buf)
	}
	a.obsMu.RUnlock()
	stage.Process(f, buf, frames)
	var errs []error
	for i := range frames {
		if err := a.sink.Send(&frames[i]); err != nil {
			errs = append(errs, err)
		}
	}
	a.stats.record(start, time.Now())
	return errors.Join(errs...)
}

// Run runs the frame loop and services until ctx is done, then saves the
// stack and closes the sink.
func (a *App) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	errc := make(chan error, len(a.opts.Services))
	for _, svc := range a.opts.Services {
		wg.Go(func() {
			if err := svc(ctx, a); err != nil && ctx.Err() == nil {
				errc <- err
				cancel()
			}
		})
	}
	var lastErr time.Time
	// The loop only ends when ctx is done; that's a normal stop unless a
	// service failed and cancelled it.
	_ = a.Ticker.Run(ctx, func(f clock.Frame) {
		if err := a.RenderFrame(f); err != nil && f.Time.Sub(lastErr) > 10*time.Second {
			lastErr = f.Time
			a.Log.Warn("sending frame", "err", err)
		}
	})
	wg.Wait()
	close(errc)
	return errors.Join(<-errc, a.Close())
}

// Close saves pending stack changes and closes the sink.
func (a *App) Close() error {
	return errors.Join(a.saver.Close(), a.levels.saver.Close(), a.sink.Close())
}

// Summary writes a human-readable description of the installation.
func (a *App) Summary(w io.Writer) {
	l := a.Layout
	fmt.Fprintf(w, "config %s, data %s\n", a.Config.Dir, cmp.Or(a.Config.DataDir, "(none: state is not saved)"))
	fmt.Fprintf(w, "%d pixels on %d controllers, %d runs, %d areas, %.0f fps\n",
		len(l.Pixels), len(l.Controllers), len(l.Runs), len(l.Areas), a.Ticker.FPS())
	for _, c := range l.Controllers {
		fmt.Fprintf(w, "  controller %-10s %s:%d  %4d px  global %d–%d  %s\n", c.ID, c.Config.Host, c.Config.Port,
			c.Pixels, c.Base, int(c.Base)+c.Pixels-1, c.Config.Channels)
	}
	for i := range l.Runs {
		r := &l.Runs[i]
		measured, estimated := 0, 0
		for _, an := range r.Anchors {
			switch an.Source {
			case layout.SourceMeasured:
				measured++
			case layout.SourceEstimated:
				estimated++
			}
		}
		fmt.Fprintf(w, "  run %-12s %-6s %4d px  anchors %d measured, %d estimated  %s\n",
			r.ID, l.Controllers[r.Controller].ID, r.Count, measured, estimated, r.LengthReport(l))
	}
	fmt.Fprintf(w, "mappings: %v (default %s)\n", a.Mappings.IDs(), a.Mappings.Default)
	fmt.Fprintf(w, "effects: %d, palettes: %d, presets: %d, zones: %d\n",
		len(a.Effects.All()), len(a.Palettes.All()), len(a.Config.Presets), len(a.Config.Zones))
	boot := cmp.Or(a.Config.Settings.Boot, BootRestore)
	fmt.Fprintf(w, "stack: %d layers (boot: %s)\n", len(a.Stack.List()), boot)
	var warnings []string
	for _, e := range l.Warnings {
		warnings = append(warnings, e.Error())
	}
	for _, e := range a.Mappings.Warnings {
		warnings = append(warnings, e.Error())
	}
	warnings = append(warnings, a.Restored...)
	if len(warnings) > 0 {
		fmt.Fprintf(w, "%d warnings:\n", len(warnings))
		for _, s := range warnings {
			fmt.Fprintf(w, "  %s\n", s)
		}
	}
}
