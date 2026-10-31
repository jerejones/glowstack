// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package app

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"sync"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/storage"
)

// LevelsFile holds the master and zone brightness in the data folder, so
// a restart doesn't jump back to full brightness.
const LevelsFile = "brightness.json"

// Brightness is the global master and per-zone brightness, each 0–1. They
// multiply: a pixel's gain is master × the brightness of every zone whose
// area contains it.
type Brightness struct {
	Master float64            `json:"master"`
	Zones  map[string]float64 `json:"zones"`
}

// levels is the App's brightness state, safe for concurrent use.
type levels struct {
	mu      sync.Mutex
	master  float64
	zones   map[string]float64 // only zones not at 1
	version uint64
	saver   *storage.Saver
}

type levelsFile struct {
	Schema int                `json:"schema"`
	Master float64            `json:"master"`
	Zones  map[string]float64 `json:"zones,omitempty"`
}

func (a *App) loadLevels() error {
	lv := &a.levels
	// Version 1 makes the first frame compute the gains.
	lv.master, lv.zones, lv.version = 1, map[string]float64{}, 1
	lv.saver = storage.NewSaver(SaveInterval, a.saveLevels,
		func(err error) { a.Log.Error("saving brightness", "err", err) })
	data, err := a.Store.Read(LevelsFile)
	if storage.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var f levelsFile
	if err := json.Unmarshal(data, &f); err != nil {
		return fmt.Errorf("%s: %w", LevelsFile, err)
	}
	if f.Schema != 1 {
		return fmt.Errorf("%s: schema %d, want 1", LevelsFile, f.Schema)
	}
	if validLevel(f.Master) == nil {
		lv.master = f.Master
	}
	for z, v := range f.Zones {
		if validLevel(v) == nil && hasZone(a.Config, z) {
			lv.zones[z] = v
		}
	}
	return nil
}

func (a *App) saveLevels() error {
	a.levels.mu.Lock()
	f := levelsFile{Schema: 1, Master: a.levels.master, Zones: maps.Clone(a.levels.zones)}
	a.levels.mu.Unlock()
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return a.Store.Write(LevelsFile, data)
}

func validLevel(v float64) error {
	if math.IsNaN(v) || v < 0 || v > 1 {
		return fmt.Errorf("brightness %v is outside 0–1", v)
	}
	return nil
}

func hasZone(cfg *config.Config, id string) bool {
	for i := range cfg.Zones {
		if cfg.Zones[i].ID == id {
			return true
		}
	}
	return false
}

// Brightness returns the master brightness and every configured zone's
// brightness.
func (a *App) Brightness() Brightness {
	cfg := a.Current().Config
	a.levels.mu.Lock()
	defer a.levels.mu.Unlock()
	b := Brightness{Master: a.levels.master, Zones: map[string]float64{}}
	for _, z := range cfg.Zones {
		b.Zones[z.ID] = 1
		if v, ok := a.levels.zones[z.ID]; ok {
			b.Zones[z.ID] = v
		}
	}
	return b
}

// SetMaster sets the global master brightness, 0–1.
func (a *App) SetMaster(v float64) error {
	if err := validLevel(v); err != nil {
		return err
	}
	a.levels.mu.Lock()
	a.levels.master = v
	a.levels.version++
	a.levels.mu.Unlock()
	a.levels.saver.Trigger()
	return nil
}

// SetZoneBrightness sets a zone's brightness (its WLED device's `bri`),
// 0–1.
func (a *App) SetZoneBrightness(zone string, v float64) error {
	if err := validLevel(v); err != nil {
		return err
	}
	if !hasZone(a.Current().Config, zone) {
		return fmt.Errorf("no zone %q", zone)
	}
	a.levels.mu.Lock()
	if v == 1 {
		delete(a.levels.zones, zone)
	} else {
		a.levels.zones[zone] = v
	}
	a.levels.version++
	a.levels.mu.Unlock()
	a.levels.saver.Trigger()
	return nil
}

// applyLevels sets comp's master and per-pixel gain from the brightness
// levels. It runs on the frame loop and recomputes the gains only when
// the levels or the layout changed.
func (a *App) applyLevels(gen uint64, comp *render.Compositor, cfg *config.Config, l *layout.Layout) {
	lv := &a.levels
	lv.mu.Lock()
	defer lv.mu.Unlock()
	comp.Master = float32(lv.master)
	if gen == a.gainGen && lv.version == a.gainLevels {
		return
	}
	a.gainGen, a.gainLevels = gen, lv.version
	comp.Gain = zoneGains(cfg, l, lv.zones, comp.Gain)
}

// zoneGains returns the per-pixel product of zone brightnesses, or nil if
// every zone is at 1.
func zoneGains(cfg *config.Config, l *layout.Layout, zones map[string]float64, dst []float32) []float32 {
	if len(zones) == 0 {
		return nil
	}
	if len(dst) != len(l.Pixels) {
		dst = make([]float32, len(l.Pixels))
	}
	for i := range dst {
		dst[i] = 1
	}
	for _, z := range cfg.Zones {
		v, ok := zones[z.ID]
		if !ok {
			continue
		}
		if area, ok := l.Area(z.Area); ok {
			for _, p := range area.Pixels {
				dst[p] *= float32(v)
			}
		}
	}
	return dst
}
