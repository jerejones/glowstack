// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package api is Glowstack's native control API: JSON over HTTP under
// /api/v1/. It manages the layer stack (push, edit, remove, clear, and the
// preview-only stack the live map renders), lists what can be used
// (effects with their parameter schemas, palettes, presets, areas, zones,
// mappings, controllers), sets master and zone brightness, reports status
// and reloads the config.
//
// Routes:
//
//	GET    /api/v1/                       index
//	GET    /api/v1/layers                 the stack, top first
//	POST   /api/v1/layers                 push a layer on top
//	DELETE /api/v1/layers[?owner=o]       remove every layer (or one owner's)
//	GET    /api/v1/layers/{id}            one layer
//	PATCH  /api/v1/layers/{id}            edit in place (keeps position)
//	DELETE /api/v1/layers/{id}            remove (fades out)
//	…      /api/v1/preview/layers[/{id}]  the same for preview-only layers
//	GET    /api/v1/effects[/{id}]         effects with parameter schemas
//	GET    /api/v1/palettes               palettes
//	GET    /api/v1/presets                presets, with source saved|config
//	GET    /api/v1/presets/{id}           one preset
//	PUT    /api/v1/presets/{id}           save a preset (presets.saved.yaml)
//	DELETE /api/v1/presets/{id}           delete a saved preset
//	GET    /api/v1/areas                  areas
//	GET    /api/v1/zones                  zones
//	GET    /api/v1/mappings               mappings
//	GET    /api/v1/controllers            controllers
//	GET    /api/v1/brightness             master and zone brightness
//	PUT    /api/v1/brightness             set either or both (PATCH too)
//	GET    /api/v1/status                 frame rate, solve summary, health
//	POST   /api/v1/reload                 re-read the config folder
//
// Errors are JSON: {"error": "...", "errors": ["file:line: ..."]}, with
// 400 for invalid input, 404 for unknown ids, 409 for a taken layer id or
// a preset that's read-only (in presets.yaml) and 422 for a config that
// doesn't load.
//
// There is no authentication: Glowstack is for a trusted LAN. The hook
// for adding it is httpserver.Server.Authorize.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/stack"
)

// Prefix is the API's URL prefix.
const Prefix = "/api/v1/"

// MaxBody is the largest request body accepted.
const MaxBody = 1 << 20

// HealthReporter supplies typed controller health from an output sink or stage.
type HealthReporter = output.HealthReporter

// API serves the control API for one App.
type API struct {
	app     *app.App
	started time.Time
	strips  stripCache // effect sprites, drawn once each
}

// Mount is an httpserver.Mount that registers the API's routes.
func Mount(a *app.App, s *httpserver.Server) error {
	api := &API{app: a, started: time.Now()}
	api.Register(s)
	return nil
}

// Register adds the routes to s.
func (api *API) Register(s *httpserver.Server) {
	h := func(pattern string, fn handlerFunc) { s.Handle(pattern, fn) }
	h("GET /api/v1/{$}", api.index)
	for _, pv := range []bool{false, true} {
		base := "/api/v1/layers"
		if pv {
			base = "/api/v1/preview/layers"
		}
		ls := layerRoutes{api: api, preview: pv}
		h("GET "+base, ls.list)
		h("POST "+base, ls.push)
		h("DELETE "+base, ls.clear)
		h("GET "+base+"/{id}", ls.get)
		h("PATCH "+base+"/{id}", ls.edit)
		h("DELETE "+base+"/{id}", ls.remove)
	}
	h("GET /api/v1/effects", api.effects)
	h("GET /api/v1/effects/{id}", api.effect)
	h("GET /api/v1/effects/{id}/strip.png", api.effectStrip)
	h("GET /api/v1/palettes", api.palettes)
	h("GET /api/v1/presets", api.presets)
	h("GET /api/v1/presets/{id}", api.preset)
	h("GET /api/v1/presets/{id}/strip.png", api.presetStrip)
	h("PUT /api/v1/presets/{id}", api.savePreset)
	h("PATCH /api/v1/presets/{id}/pin", api.pinPreset)
	h("DELETE /api/v1/presets/{id}", api.deletePreset)
	h("GET /api/v1/areas", api.areas)
	h("GET /api/v1/zones", api.zones)
	h("GET /api/v1/mappings", api.mappings)
	h("GET /api/v1/controllers", api.controllers)
	h("GET /api/v1/brightness", api.brightness)
	h("PUT /api/v1/brightness", api.setBrightness)
	h("PATCH /api/v1/brightness", api.setBrightness)
	h("GET /api/v1/status", api.status)
	h("POST /api/v1/reload", api.reload)
	h("/api/v1/", func(w http.ResponseWriter, r *http.Request) error {
		return errorf(http.StatusNotFound, "no such endpoint: %s %s", r.Method, r.URL.Path)
	})
}

func (api *API) index(w http.ResponseWriter, r *http.Request) error {
	return writeJSON(w, http.StatusOK, map[string]any{
		"name": "glowstack",
		"api":  "v1",
		"endpoints": []string{
			"layers", "preview/layers", "effects", "palettes", "presets", "areas", "zones",
			"mappings", "controllers", "brightness", "status", "reload", "calibration",
		},
	})
}

// handlerFunc is an http.Handler that returns an error to report as JSON.
type handlerFunc func(http.ResponseWriter, *http.Request) error

func (fn handlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, MaxBody)
	}
	err := fn(w, r)
	if err == nil {
		return
	}
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Status: http.StatusInternalServerError, Message: err.Error()}
	}
	_ = writeJSON(w, e.Status, e)
}

// Error is an API error as sent to the client.
type Error struct {
	Status  int      `json:"-"`
	Message string   `json:"error"`
	Details []string `json:"errors,omitempty"`
}

func (e *Error) Error() string {
	if len(e.Details) == 0 {
		return e.Message
	}
	return e.Message + ":\n  " + strings.Join(e.Details, "\n  ")
}

func errorf(status int, format string, args ...any) *Error {
	return &Error{Status: status, Message: fmt.Sprintf(format, args...)}
}

// invalid wraps err as a 400, or as a 404 for an unknown layer.
func invalid(err error) error {
	var e *Error
	switch {
	case err == nil:
		return nil
	case errors.As(err, &e):
		return e
	case errors.Is(err, stack.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Message: err.Error()}
	}
	var cerrs config.Errors
	if errors.As(err, &cerrs) {
		return configError(cerrs)
	}
	return &Error{Status: http.StatusBadRequest, Message: err.Error()}
}

func configError(errs config.Errors) *Error {
	e := &Error{Status: http.StatusUnprocessableEntity, Message: "the config has errors; nothing was changed"}
	for _, x := range errs {
		e.Details = append(e.Details, x.Error())
	}
	return e
}

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// readJSON decodes the request body into an object of raw fields.
func readJSON(r *http.Request) (map[string]json.RawMessage, error) {
	var m map[string]json.RawMessage
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&m); err != nil {
		return nil, errorf(http.StatusBadRequest, "request body: want a JSON object: %v", err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, errorf(http.StatusBadRequest, "request body: trailing data after the JSON object")
	}
	if m == nil {
		return nil, errorf(http.StatusBadRequest, "request body: want a JSON object")
	}
	return m, nil
}
