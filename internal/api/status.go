// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/units"
)

// Status is GET /api/v1/status.
type Status struct {
	Started time.Time `json:"started"`
	Uptime  string    `json:"uptime"`
	Frames  uint64    `json:"frames"`
	// FPS is the target frame rate; MeasuredFPS what the loop achieves.
	FPS         float64 `json:"fps"`
	MeasuredFPS float64 `json:"measured_fps"`
	// FrameMS is the smoothed time to render and send a frame, and
	// MaxFrameMS the longest in the last few seconds, in milliseconds.
	FrameMS    float64 `json:"frame_ms"`
	MaxFrameMS float64 `json:"max_frame_ms"`
	// LateFrames counts frames that started after the next was due.
	LateFrames    uint64         `json:"late_frames"`
	Layers        int            `json:"layers"`
	PreviewLayers int            `json:"preview_layers"`
	Brightness    app.Brightness `json:"brightness"`
	Solve         Solve          `json:"solve"`
	// Health is controller health from the output stage, when it reports
	// it; null otherwise.
	Health any `json:"health"`
	// ConfigGen counts config reloads.
	ConfigGen uint64 `json:"config_gen"`
}

// Solve summarises the solved layout.
type Solve struct {
	Pixels      int `json:"pixels"`
	Controllers int `json:"controllers"`
	Areas       int `json:"areas"`
	Zones       int `json:"zones"`
	Mappings    int `json:"mappings"`
	// Anchors counts interior anchors by source (measured, estimated).
	Anchors  Anchors  `json:"anchors"`
	Runs     []Run    `json:"runs"`
	Warnings []string `json:"warnings"`
}

// Anchors counts anchors by where they came from.
type Anchors struct {
	Measured  int `json:"measured"`
	Estimated int `json:"estimated"`
}

// Run is one run in the solve summary.
type Run struct {
	ID         string  `json:"id"`
	Controller string  `json:"controller"`
	Pixels     int     `json:"pixels"`
	Length     float64 `json:"length_m"`
	// Drawn is the run's length on the plan in meters (0 without a
	// drawing), and Mismatch drawn/physical − 1.
	Drawn    float64 `json:"drawn_m,omitempty"`
	Mismatch float64 `json:"mismatch,omitempty"`
	Anchors  Anchors `json:"anchors"`
}

func (api *API) status(w http.ResponseWriter, r *http.Request) error {
	a := api.app
	v := a.Current()
	st := a.Stats()
	s := Status{
		Started:       api.started.UTC(),
		Uptime:        time.Since(api.started).Round(time.Second).String(),
		Frames:        st.Frames,
		FPS:           a.Ticker.FPS(),
		MeasuredFPS:   round(st.FPS, 2),
		FrameMS:       round(st.FrameTime.Seconds()*1000, 3),
		MaxFrameMS:    round(st.MaxFrame.Seconds()*1000, 3),
		LateFrames:    a.Ticker.Late(),
		Layers:        len(a.Stack.List()),
		PreviewLayers: len(a.Preview.List()),
		Brightness:    a.Brightness(),
		Solve:         solve(v),
		Health:        api.health(),
		ConfigGen:     v.Gen,
	}
	return writeJSON(w, http.StatusOK, s)
}

func solve(v app.View) Solve {
	l := v.Layout
	s := Solve{Pixels: len(l.Pixels), Controllers: len(l.Controllers), Areas: len(l.Areas),
		Zones: len(v.Config.Zones), Mappings: len(v.Mappings.IDs()), Runs: []Run{}, Warnings: []string{}}
	for i := range l.Runs {
		r := &l.Runs[i]
		out := Run{ID: r.ID, Controller: l.Controllers[r.Controller].ID, Pixels: r.Count,
			Length: round(r.Length, 3), Drawn: round(r.DrawnMeters, 3), Mismatch: round(r.LengthMismatch, 3)}
		for _, an := range r.Anchors {
			switch an.Source {
			case layout.SourceMeasured:
				out.Anchors.Measured++
			case layout.SourceEstimated:
				out.Anchors.Estimated++
			}
		}
		s.Anchors.Measured += out.Anchors.Measured
		s.Anchors.Estimated += out.Anchors.Estimated
		s.Runs = append(s.Runs, out)
	}
	for _, e := range l.Warnings {
		s.Warnings = append(s.Warnings, e.Error())
	}
	for _, e := range v.Mappings.Warnings {
		s.Warnings = append(s.Warnings, e.Error())
	}
	return s
}

func round(x float64, places int) float64 {
	k := math.Pow(10, float64(places))
	return math.Round(x*k) / k
}

func (api *API) brightness(w http.ResponseWriter, r *http.Request) error {
	return writeJSON(w, http.StatusOK, api.app.Brightness())
}

// setBrightness sets the master, zones, or both:
// {"master": 0.5, "zones": {"porch": "30%"}}. Values are 0–1 or a
// percentage string.
func (api *API) setBrightness(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	for k := range body {
		if k != "master" && k != "zones" {
			return errorf(http.StatusBadRequest, "unknown field %q (want master and/or zones)", k)
		}
	}
	var master *float64
	if raw, ok := body["master"]; ok {
		v, err := level(raw)
		if err != nil {
			return errorf(http.StatusBadRequest, "master: %v", err)
		}
		master = &v
	}
	zones := map[string]float64{}
	if raw, ok := body["zones"]; ok {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			return errorf(http.StatusBadRequest, `zones: want {"zone-id": 0.5, …}`)
		}
		cfg := api.app.Current().Config
		for z, raw := range m {
			v, err := level(raw)
			if err != nil {
				return errorf(http.StatusBadRequest, "zones.%s: %v", z, err)
			}
			if !hasZone(cfg, z) {
				return errorf(http.StatusBadRequest, "no zone %q", z)
			}
			zones[z] = v
		}
	}
	// Everything is checked; now apply.
	if master != nil {
		if err := api.app.SetMaster(*master); err != nil {
			return invalid(err)
		}
	}
	for z, v := range zones {
		if err := api.app.SetZoneBrightness(z, v); err != nil {
			return invalid(err)
		}
	}
	return writeJSON(w, http.StatusOK, api.app.Brightness())
}

// level parses a brightness: a number 0–1 or a fraction string ("50%").
func level(raw json.RawMessage) (float64, error) {
	var x any
	if err := json.Unmarshal(raw, &x); err != nil {
		return 0, err
	}
	var v float64
	switch x := x.(type) {
	case float64:
		v = x
	case string:
		f, err := units.ParseFraction(x)
		if err != nil {
			return 0, err
		}
		v = float64(f)
	default:
		return 0, errors.New(`want a number 0–1 or a percentage such as "50%"`)
	}
	if v < 0 || v > 1 || math.IsNaN(v) {
		return 0, errors.New("brightness must be 0–1")
	}
	return v, nil
}

func hasZone(cfg *config.Config, id string) bool {
	for _, z := range cfg.Zones {
		if z.ID == id {
			return true
		}
	}
	return false
}

func (api *API) reload(w http.ResponseWriter, r *http.Request) error {
	res, err := api.app.Reload()
	if err != nil {
		var cerrs config.Errors
		if errors.As(err, &cerrs) {
			return configError(cerrs)
		}
		return &Error{Status: http.StatusUnprocessableEntity, Message: "reload failed; nothing was changed: " + err.Error()}
	}
	res.Dropped, res.Warnings = nonNil(res.Dropped), nonNil(res.Warnings)
	return writeJSON(w, http.StatusOK, res)
}
