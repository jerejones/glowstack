// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"slices"
	"sort"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/preset"
)

// Preset sources.
const (
	SourceConfig = "config" // presets.yaml in the config folder: read-only
	SourceSaved  = "saved"  // presets.saved.yaml in the data folder
)

// Preset is a preset as the API lists it: the effective presets, where a
// saved preset replaces a configured one with the same id.
type Preset struct {
	Pinned bool           `json:"pinned"`
	ID     string         `json:"id"`
	Name   string         `json:"name,omitempty"`
	Effect string         `json:"effect"`
	Params map[string]any `json:"params,omitempty"`
	// Source is "saved" for presets saved through the API (or written into
	// presets.saved.yaml), "config" for presets.yaml's, which the API can't
	// change.
	Source string `json:"source"`
	// Shadows is true for a saved preset that hides a configured one with
	// the same id. Deleting it brings that one back.
	Shadows bool `json:"shadows,omitempty"`
}

func toPreset(cfg *config.Config, p config.Preset) Preset {
	out := Preset{Pinned: cfg.PresetPins[p.ID], ID: p.ID, Name: p.Name, Effect: p.Effect, Params: p.Params, Source: SourceConfig}
	if p.Saved {
		out.Source = SourceSaved
		out.Shadows = slices.ContainsFunc(cfg.Presets, func(q config.Preset) bool { return q.ID == p.ID && !q.Saved })
	}
	return out
}

func (api *API) presets(w http.ResponseWriter, r *http.Request) error {
	cfg := api.app.Current().Config
	var list []Preset
	for _, p := range preset.New(cfg.Presets).List() {
		list = append(list, toPreset(cfg, p))
	}
	return writeJSON(w, http.StatusOK, map[string]any{"presets": nonNil(list)})
}

func (api *API) preset(w http.ResponseWriter, r *http.Request) error {
	cfg := api.app.Current().Config
	p, ok := cfg.Preset(r.PathValue("id"))
	if !ok {
		return errorf(http.StatusNotFound, "no preset %q", r.PathValue("id"))
	}
	return writeJSON(w, http.StatusOK, toPreset(cfg, *p))
}

// Fields of a PUT /api/v1/presets/{id} body. Either
//
//	effect      effect id, with params as its parameters, or
//	from_layer  a layer id: save that layer's effect and params (a layer
//	            showing a preset saves the preset expanded), with params
//	            merged over them (null removes one)
//	preview     with from_layer: the layer is on the preview stack (a
//	            layer that's only there is found anyway)
//	name        display name
//	params      parameter values, common ones (blend, mapping, …) too
//	id          optional; must match the path
var presetFields = []string{"id", "name", "effect", "params", "from_layer", "preview", "pinned"}

// SavedPreset is the reply to a save or delete.
type SavedPreset struct {
	Preset
	// Dropped lists layers that used the preset by id and no longer
	// validate, so the reload dropped them.
	Dropped []string `json:"dropped,omitempty"`
}

func (api *API) savePreset(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	var unknown []string
	for k := range body {
		if !slices.Contains(presetFields, k) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return errorf(http.StatusBadRequest, "unknown field %s (fields: %s)", quoteList(unknown), quoteList(presetFields))
	}
	var req struct {
		ID        string         `json:"id"`
		Name      string         `json:"name"`
		Effect    string         `json:"effect"`
		Params    map[string]any `json:"params"`
		FromLayer string         `json:"from_layer"`
		Preview   bool           `json:"preview"`
		Pinned    *bool          `json:"pinned"`
	}
	b, _ := json.Marshal(body)
	if err := json.Unmarshal(b, &req); err != nil {
		return errorf(http.StatusBadRequest, "request body: %v", err)
	}
	if req.ID != "" && req.ID != id {
		return errorf(http.StatusBadRequest, "id %q doesn't match the path's %q", req.ID, id)
	}
	p := config.Preset{ID: id, Name: req.Name, Effect: req.Effect, Params: map[string]any{}}
	switch {
	case req.FromLayer != "" && req.Effect != "":
		return errorf(http.StatusBadRequest, "give effect or from_layer, not both")
	case req.FromLayer != "":
		l, ok := api.stackFor(req.Preview).Get(req.FromLayer)
		if !ok && !req.Preview {
			// Preview ids (p1, …) can't clash with house layers'.
			l, ok = api.stackFor(true).Get(req.FromLayer)
		}
		if !ok {
			return errorf(http.StatusNotFound, "no layer %q", req.FromLayer)
		}
		effect, params, err := api.app.Current().Engine.Expand(&l)
		if err != nil {
			return errorf(http.StatusBadRequest, "layer %s: %v", l.ID, err)
		}
		p.Effect = effect
		maps.Copy(p.Params, params)
	case req.Preview:
		return errorf(http.StatusBadRequest, "preview only applies with from_layer")
	case req.Effect == "":
		return errorf(http.StatusBadRequest, "a preset needs an effect or from_layer (effects: %s)", quoteList(api.effectIDs()))
	}
	for k, v := range req.Params {
		if v == nil {
			delete(p.Params, k)
		} else {
			p.Params[k] = v
		}
	}
	if len(p.Params) == 0 {
		p.Params = nil
	}
	created, res, err := api.app.SavePreset(p, app.PresetOptions{Library: r.URL.Query().Get("library") == "true", Pinned: req.Pinned})
	if err != nil {
		return presetError(err)
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	cfg := res.Config
	saved, _ := cfg.Preset(id)
	return writeJSON(w, status, SavedPreset{Preset: toPreset(cfg, *saved), Dropped: res.Dropped})
}

func (api *API) deletePreset(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	res, err := api.app.DeletePreset(id, app.PresetOptions{Library: r.URL.Query().Get("library") == "true"})
	if err != nil {
		return presetError(err)
	}
	out := map[string]any{"deleted": id, "dropped": nonNil(res.Dropped)}
	// A configured preset with the same id is in effect again.
	cfg := res.Config
	if p, ok := cfg.Preset(id); ok {
		out["now"] = toPreset(cfg, *p)
	}
	return writeJSON(w, http.StatusOK, out)
}

// presetError maps App.SavePreset and DeletePreset errors to statuses.
func presetError(err error) error {
	var cerrs config.Errors
	switch {
	case errors.Is(err, app.ErrBadPreset):
		return &Error{Status: http.StatusBadRequest, Message: err.Error()}
	case errors.Is(err, app.ErrNoSavedPreset):
		return &Error{Status: http.StatusNotFound, Message: err.Error()}
	case errors.Is(err, app.ErrReadOnlyPreset), errors.Is(err, app.ErrNoDataDir):
		return &Error{Status: http.StatusConflict, Message: err.Error()}
	case errors.As(err, &cerrs):
		e := configError(cerrs)
		e.Message = "the presets weren't changed: there are config errors"
		return e
	}
	return err
}

func (api *API) pinPreset(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	raw, ok := body["pinned"]
	var pinned *bool
	if !ok || len(body) != 1 || json.Unmarshal(raw, &pinned) != nil || pinned == nil {
		return errorf(http.StatusBadRequest, "expected pinned: true or false")
	}
	res, err := api.app.PinPreset(r.PathValue("id"), *pinned)
	if err != nil {
		return presetError(err)
	}
	p, _ := res.Config.Preset(r.PathValue("id"))
	return writeJSON(w, http.StatusOK, toPreset(res.Config, *p))
}
