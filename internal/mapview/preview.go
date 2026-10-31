// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/stack"
)

// Preview speed limits.
const (
	MinSpeed = 0.1
	MaxSpeed = 10
)

// OwnerPreview owns preview-only layers.
const OwnerPreview = "live-map"

// previewIDPrefix renames preview layers in the preview pass, keeping
// them apart from house layer ids in the preview engine's cache and in
// Snapshot.Layers.
const previewIDPrefix = "preview:"

// House ids are also namespaced in the preview pass, since callers may
// choose any id, including one beginning with previewIDPrefix.
const houseIDPrefix = "house:"

// PreviewState is the preview clock and layers as the page sees them.
type PreviewState struct {
	// Following: the preview clock is in step with the house, so with no
	// preview layers the map shows house frames.
	Following  bool          `json:"following"`
	Previewing bool          `json:"previewing"` // the map renders its own frames
	Paused     bool          `json:"paused"`
	Speed      float64       `json:"speed"`
	T          float64       `json:"t"`       // preview time, Unix seconds
	HouseT     float64       `json:"house_t"` // house time, Unix seconds
	Offset     float64       `json:"offset"`  // T - HouseT, seconds
	Layers     []stack.Layer `json:"layers"`  // preview layers, top first
}

// PreviewControl is a POST /api/map/preview body.
type PreviewControl struct {
	// Action is pause, resume, step, speed, seek or live.
	Action string `json:"action"`
	// Seconds is step's amount (default one house frame; negative steps
	// back). Stepping pauses.
	Seconds *float64 `json:"seconds,omitempty"`
	// Speed for speed, clamped to 0.1–10.
	Speed float64 `json:"speed,omitempty"`
	// T (Unix seconds) or Offset (seconds from the current preview time)
	// for seek.
	T      *float64 `json:"t,omitempty"`
	Offset *float64 `json:"offset,omitempty"`
}

// Control applies a preview clock action. It never touches the house.
func (m *Map) Control(c PreviewControl) error {
	p := m.preview
	switch c.Action {
	case "pause":
		p.Pause()
	case "resume":
		p.Resume()
	case "step":
		d := 1 / m.app.Ticker.FPS()
		if c.Seconds != nil {
			d = *c.Seconds
		}
		if math.IsNaN(d) || math.Abs(d) > 24*3600 {
			return fmt.Errorf("bad step %v", d)
		}
		p.Pause()
		p.Step(time.Duration(d * float64(time.Second)))
	case "speed":
		if !(c.Speed > 0) {
			return fmt.Errorf("speed must be positive, got %v", c.Speed)
		}
		p.SetSpeed(min(max(c.Speed, MinSpeed), MaxSpeed))
	case "seek":
		switch {
		case c.T != nil && !math.IsNaN(*c.T) && !math.IsInf(*c.T, 0):
			sec, frac := math.Modf(*c.T)
			p.Seek(time.Unix(int64(sec), int64(frac*1e9)))
		case c.Offset != nil && !math.IsNaN(*c.Offset) && math.Abs(*c.Offset) < 1e9:
			p.Seek(p.Now().Add(time.Duration(*c.Offset * float64(time.Second))))
		default:
			return errors.New("seek needs t or offset")
		}
	case "live":
		p.Live()
		m.following.Store(true)
		return nil
	default:
		return fmt.Errorf("unknown action %q (pause, resume, step, speed, seek, live)", c.Action)
	}
	m.following.Store(false)
	return nil
}

// State reports the preview clock and layers.
func (m *Map) State() PreviewState {
	now, house := m.preview.Now(), m.app.Clock.Now()
	layers := m.app.Preview.List()
	if layers == nil {
		layers = []stack.Layer{}
	}
	return PreviewState{
		Following: m.following.Load(), Previewing: m.previewing(), Paused: m.preview.Paused(),
		Speed: m.preview.Speed(), T: clock.Seconds(now), HouseT: clock.Seconds(house),
		Offset: now.Sub(house).Seconds(), Layers: layers,
	}
}

// Push adds a layer on top of the app's preview stack (App.Preview, the
// same stack as the control API's preview layers).
func (m *Map) Push(l stack.Layer) (stack.Layer, error) {
	l.ID = ""
	l.Owner = OwnerPreview
	return m.app.PushPreview(l)
}

// RemovePreview removes one preview layer.
func (m *Map) RemovePreview(id string) error { return m.app.Preview.Remove(id) }

// ClearPreview removes every preview layer, whoever pushed it.
func (m *Map) ClearPreview() { m.app.Preview.Clear() }

// Promote moves preview layers onto the house stack, so the lights show
// them: the layers with ids (top first, as listed), or every preview
// layer if ids is empty. They keep their order, look, lifetime and seed
// (so sparkles fall where the preview showed them), go on top of the house
// stack, and get new house ids, owner OwnerPreview and a new creation time
// (a `for` lifetime starts again). Each is removed from the preview once
// it's on the house stack. If one can't be pushed, Promote stops and
// returns the ones already moved with the error. An unknown id moves
// nothing.
func (m *Map) Promote(ids []string) ([]stack.Layer, error) {
	all := m.app.Preview.List()
	pick := all
	if len(ids) > 0 {
		pick = nil
		for _, l := range all {
			if slices.Contains(ids, l.ID) {
				pick = append(pick, l)
			}
		}
		for _, id := range ids {
			if !slices.ContainsFunc(pick, func(l stack.Layer) bool { return l.ID == id }) {
				return nil, fmt.Errorf("%w: preview layer %q", stack.ErrNotFound, id)
			}
		}
	}
	var moved []stack.Layer
	// Bottom first, so the top preview layer ends up on top.
	for i := len(pick) - 1; i >= 0; i-- {
		p := pick[i]
		l, err := m.app.Stack.Push(stack.Layer{
			Owner: OwnerPreview, Target: p.Target, Effect: p.Effect, Preset: p.Preset,
			Params: p.Params, Lifetime: p.Lifetime, Seed: p.Seed,
		})
		if err != nil {
			return moved, fmt.Errorf("preview layer %q: %w", p.ID, err)
		}
		moved = append(moved, l)
		m.app.Preview.Remove(p.ID)
	}
	slices.Reverse(moved) // top first, like List
	return moved, nil
}

func (m *Map) handlePreviewState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, m.State())
}

func (m *Map) handlePreviewControl(w http.ResponseWriter, r *http.Request) {
	var c PreviewControl
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&c); err != nil {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	if err := m.Control(c); err != nil {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	writeJSON(w, m.State())
}

func (m *Map) handlePreviewLayers(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, m.State().Layers)
}

// previewLayerJSON is a POST /api/map/preview/layers body: a layer
// without id or owner.
type previewLayerJSON struct {
	Target string         `json:"target"`
	Effect string         `json:"effect,omitempty"`
	Preset string         `json:"preset,omitempty"`
	Params map[string]any `json:"params,omitempty"`
	Seed   uint64         `json:"seed,omitempty"`
}

func (m *Map) handlePreviewPush(w http.ResponseWriter, r *http.Request) {
	var b previewLayerJSON
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&b); err != nil {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	l, err := m.Push(stack.Layer{Target: b.Target, Effect: b.Effect, Preset: b.Preset, Params: b.Params, Seed: b.Seed})
	if err != nil {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	writeJSON(w, l)
}

func (m *Map) handlePreviewRemove(w http.ResponseWriter, r *http.Request) {
	if err := m.RemovePreview(r.PathValue("id")); err != nil {
		httpError(w, http.StatusNotFound, "%v", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// promoteJSON is a POST /api/map/preview/promote body. No ids (or no
// body) promotes every preview layer.
type promoteJSON struct {
	IDs []string `json:"ids,omitempty"`
}

func (m *Map) handlePreviewPromote(w http.ResponseWriter, r *http.Request) {
	var b promoteJSON
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&b); err != nil && !errors.Is(err, io.EOF) {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	moved, err := m.Promote(b.IDs)
	if moved == nil {
		moved = []stack.Layer{}
	}
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, stack.ErrNotFound) && len(moved) == 0 {
			code = http.StatusNotFound
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "layers": moved})
		return
	}
	writeJSON(w, map[string]any{"layers": moved})
}

func (m *Map) handlePreviewClear(w http.ResponseWriter, r *http.Request) {
	m.ClearPreview()
	w.WriteHeader(http.StatusNoContent)
}
