// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/render"
)

// Prefix is where the calibration API lives, under the control API.
const Prefix = "/api/v1/calibration"

// Register adds the calibration effect to r. Do it with the other effects
// (app.Options.Effects), before the frame loop starts.
func Register(r *render.Registry) error { return r.Register(Effect()) }

// Mount is an httpserver.Mount for the calibration API. It also keeps the
// session's layers on top of the stack while a session is active.
func Mount(a *app.App, s *httpserver.Server) error {
	if _, ok := a.Effects.Get(EffectID); !ok {
		return errors.New("calibrate: the calibration effect isn't registered (calibrate.Register)")
	}
	m := New(a)
	m.Routes(s)
	s.Go(func(ctx context.Context) error {
		t := time.NewTicker(500 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				m.End()
				return nil
			case <-t.C:
				if err := m.Keep(); err != nil {
					a.Log.Warn("calibration", "err", err)
				}
			}
		}
	})
	return nil
}

// Routes registers the calibration API on s:
//
//	GET    /api/v1/calibration            the session: target, cursors, progress
//	POST   /api/v1/calibration/start      start, at {"target": {...}} or the first unmeasured anchor
//	POST   /api/v1/calibration/end        end: remove the calibration layers
//	POST   /api/v1/calibration/target     calibrate {kind, run, node, end, from, to, controller, indices}
//	POST   /api/v1/calibration/next       the next unmeasured anchor ({"back": true}: the previous)
//	POST   /api/v1/calibration/nudge      {"by": ±1 | ±10, "side": n}: move along the run
//	POST   /api/v1/calibration/set        {"index": i, "side": n}: put a cursor at a controller index
//	POST   /api/v1/calibration/side       {"side": n}: which cursor nudges move
//	POST   /api/v1/calibration/confirm    record it in anchors.yaml and re-solve ({"length": "1.2 m"} for gaps, "next": true)
//	POST   /api/v1/calibration/forget     drop a measurement ({"target": {...}}, default the current one)
//
// Every reply is the session's state. Errors are {"error": "...",
// "errors": ["anchors.yaml:3: ..."]}: 400 bad input, 404 unknown run,
// node or controller, 409 nothing to do (no session, nothing measured), 422
// a measurement that doesn't fit the layout (nothing is written).
func (m *Manager) Routes(s *httpserver.Server) {
	h := func(pattern string, fn func(r *http.Request) (State, error)) {
		s.Handle(pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
			st, err := fn(r)
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, st)
		}))
	}
	h("GET "+Prefix, func(*http.Request) (State, error) { return m.State(), nil })
	h("POST "+Prefix+"/start", func(r *http.Request) (State, error) {
		var b struct {
			Target *Target `json:"target"`
		}
		if err := decode(r, &b); err != nil {
			return State{}, err
		}
		return m.Start(b.Target)
	})
	h("POST "+Prefix+"/end", func(*http.Request) (State, error) { return m.End(), nil })
	h("POST "+Prefix+"/target", func(r *http.Request) (State, error) {
		var t Target
		if err := decode(r, &t); err != nil {
			return State{}, err
		}
		if t.Kind == "" {
			return State{}, invalidf("target: missing kind")
		}
		return m.Select(t)
	})
	h("POST "+Prefix+"/next", func(r *http.Request) (State, error) {
		var b struct {
			Back bool `json:"back"`
		}
		if err := decode(r, &b); err != nil {
			return State{}, err
		}
		if b.Back {
			return m.Next(-1)
		}
		return m.Next(1)
	})
	h("POST "+Prefix+"/nudge", func(r *http.Request) (State, error) {
		b := struct {
			By   *int `json:"by"`
			Side *int `json:"side"`
		}{}
		if err := decode(r, &b); err != nil {
			return State{}, err
		}
		if b.By == nil {
			return State{}, invalidf("nudge: give \"by\", e.g. 1, -1, 10 or -10")
		}
		return m.Nudge(side(b.Side), *b.By)
	})
	h("POST "+Prefix+"/set", func(r *http.Request) (State, error) {
		b := struct {
			Index *int `json:"index"`
			Side  *int `json:"side"`
		}{}
		if err := decode(r, &b); err != nil {
			return State{}, err
		}
		if b.Index == nil {
			return State{}, invalidf("set: give \"index\", a controller pixel index")
		}
		return m.Set(side(b.Side), *b.Index)
	})
	h("POST "+Prefix+"/side", func(r *http.Request) (State, error) {
		b := struct {
			Side *int `json:"side"`
		}{}
		if err := decode(r, &b); err != nil {
			return State{}, err
		}
		if b.Side == nil {
			return State{}, invalidf("side: give \"side\", 0 or 1")
		}
		return m.SetSide(*b.Side)
	})
	h("POST "+Prefix+"/confirm", func(r *http.Request) (State, error) {
		var b ConfirmOptions
		if err := decode(r, &b); err != nil {
			return State{}, err
		}
		return m.Confirm(b)
	})
	h("POST "+Prefix+"/forget", func(r *http.Request) (State, error) {
		var b struct {
			Target *Target `json:"target"`
		}
		if err := decode(r, &b); err != nil {
			return State{}, err
		}
		return m.Forget(b.Target)
	})
	s.Handle(Prefix+"/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, &Error{Status: http.StatusNotFound, Message: "no such endpoint: " + r.Method + " " + r.URL.Path})
	}))
}

func side(p *int) int {
	if p == nil {
		return -1
	}
	return *p
}

// decode reads an optional JSON body into v. Unknown fields are errors.
func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil && !errors.Is(err, io.EOF) {
		return invalidf("request body: %v", err)
	}
	return nil
}

func writeError(w http.ResponseWriter, err error) {
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Status: http.StatusInternalServerError, Message: err.Error()}
	}
	writeJSON(w, e.Status, struct {
		Error  string   `json:"error"`
		Errors []string `json:"errors,omitempty"`
	}{e.Message, e.Details})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}
