// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package app

import (
	"cmp"
	"time"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/engine"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

// View is a consistent set of the parts a reload replaces.
type View struct {
	Config   *config.Config
	Layout   *layout.Layout
	Mappings *layout.Mappings
	Palettes *palette.Registry
	Engine   *engine.Engine
	// Gen increases on every reload.
	Gen uint64
}

// Current returns the current config, layout, mappings, palettes and
// engine. It's safe to call from any goroutine, but not from an OnFrame
// observer (which already runs inside a frame).
func (a *App) Current() View {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return View{Config: a.Config, Layout: a.Layout, Mappings: a.Mappings, Palettes: a.Palettes, Engine: a.Engine, Gen: a.gen}
}

// OnReload registers fn to run after each successful Reload, on the
// goroutine that called Reload.
func (a *App) OnReload(fn func()) {
	a.obsMu.Lock()
	a.onReload = append(a.onReload, fn)
	a.obsMu.Unlock()
}

// Rebuilder is implemented by an output stage or sink that depends on the
// layout or the controllers. After a reload, Rebuild is called on the frame
// loop's goroutine before the next frame is processed.
type Rebuilder interface {
	Rebuild(cfg *config.Config, l *layout.Layout) error
}

// ReloadResult says what a reload changed.
type ReloadResult struct {
	Pixels     int      `json:"pixels"`      // pixels in the new layout
	PixelsWere int      `json:"pixels_were"` // pixels before the reload
	Dropped    []string `json:"dropped"`     // layers dropped because they no longer validate
	Warnings   []string `json:"warnings"`    // layout and mapping warnings
}

// Reload re-reads the config and data folders and swaps in a new layout,
// mappings, palettes, presets and engine while the frame loop keeps
// running. If the new config doesn't load, nothing changes and the error
// (a config.Errors naming file and line) is returned.
//
// Everything is re-solved on every reload (it takes milliseconds), so
// palettes, presets and mappings change in place, and layout, area or
// controller changes rebuild the pixel table. Layers whose target, effect,
// preset or mapping no longer exists are dropped with a warning. Every
// layer is resolved again, so stateful effects (fire, ripples) restart.
//
// The effect registry is code and doesn't change. A custom output stage
// or sink is told through Rebuilder; the default stage is replaced.
func (a *App) Reload() (*ReloadResult, error) {
	a.reloadMu.Lock()
	defer a.reloadMu.Unlock()
	cfg, err := config.Load(a.opts.ConfigDir, a.opts.DataDir)
	if err != nil {
		return nil, err
	}
	lay, err := layout.Build(cfg)
	if err != nil {
		return nil, err
	}
	ms, err := layout.SolveMappings(lay, cfg)
	if err != nil {
		return nil, err
	}
	pal := palette.NewRegistry(cfg.Palettes)
	eng := engine.New(cfg, lay, ms, a.Effects, pal)
	eng.OnError = a.Engine.OnError
	n := len(lay.Pixels)

	a.mu.Lock()
	res := &ReloadResult{Pixels: n, PixelsWere: len(a.Layout.Pixels)}
	a.Config, a.Layout, a.Mappings, a.Palettes, a.Engine = cfg, lay, ms, pal, eng
	a.Compositor = render.NewCompositor(n)
	a.buf = render.NewBuffer(n)
	a.frames = output.Frames(lay)
	if a.opts.Stage == nil {
		a.stage = output.Quantize{Layout: lay}
	}
	a.gen++
	a.mu.Unlock()

	// Prune after the swap: Validate goes through Current, so layers
	// pushed from now on are checked by the new engine.
	res.Dropped = append(a.Stack.Prune(eng.Check), a.Preview.Prune(eng.Check)...)
	s := cfg.Settings
	fades := stack.Fades{In: time.Duration(*s.Fade.In), Out: time.Duration(*s.Fade.Out)}
	a.Stack.SetFades(fades)
	a.Preview.SetFades(fades)
	a.Ticker.SetFPS(cmp.Or(a.opts.FPS, s.FPS))
	for _, e := range lay.Warnings {
		res.Warnings = append(res.Warnings, e.Error())
	}
	for _, e := range ms.Warnings {
		res.Warnings = append(res.Warnings, e.Error())
	}
	for _, d := range res.Dropped {
		a.Log.Warn("reload dropped a layer", "detail", d)
	}
	a.Log.Info("config reloaded", "pixels", n, "dropped", len(res.Dropped), "warnings", len(res.Warnings))

	a.obsMu.RLock()
	fns := append([]func(){}, a.onReload...)
	a.obsMu.RUnlock()
	for _, fn := range fns {
		fn()
	}
	return res, nil
}

// rebuildOutputs tells a custom stage and the sink about a new layout. It
// runs on the frame loop.
func (a *App) rebuildOutputs(stage output.Stage, cfg *config.Config, l *layout.Layout) {
	for _, x := range []any{stage, a.sink} {
		if r, ok := x.(Rebuilder); ok {
			if err := r.Rebuild(cfg, l); err != nil {
				a.Log.Error("rebuilding output after reload", "err", err)
			}
		}
	}
}

// Sink returns the output sink, for services that want to ask it about
// controller health.
func (a *App) Sink() output.Sink { return a.sink }

// Stage returns the output stage.
func (a *App) Stage() output.Stage {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.stage
}
