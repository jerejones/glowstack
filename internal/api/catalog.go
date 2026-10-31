// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"net/http"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
)

// Param is a parameter declaration as the API lists it.
type Param struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Default any      `json:"default,omitempty"`
	Doc     string   `json:"doc,omitempty"`
	Enum    []string `json:"enum,omitempty"`
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Measure string   `json:"measure,omitempty"` // length: flow | physical
	Fields  []Param  `json:"fields,omitempty"`  // list: fields of each element
}

// Effect is an effect definition as the API lists it.
type Effect struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Coords   []string `json:"coords"`
	Stateful bool     `json:"stateful,omitempty"`
	Params   []Param  `json:"params"`
	WLED     *WLED    `json:"wled,omitempty"`
}

// WLED is an effect's WLED binding.
type WLED struct {
	FX       int       `json:"fx"`
	Name     string    `json:"name"`
	Bindings []Binding `json:"bindings,omitempty"`
}

// Binding maps a WLED control to a parameter.
type Binding struct {
	Slider string `json:"slider"`
	Param  string `json:"param"`
	Curve  string `json:"curve,omitempty"`
	Min    any    `json:"min,omitempty"`
	Max    any    `json:"max,omitempty"`
}

func toParams(ps []render.Param) []Param {
	out := make([]Param, len(ps))
	for i, p := range ps {
		out[i] = Param{Name: p.Name, Type: string(p.Type), Default: p.Default, Doc: p.Doc, Enum: p.Enum,
			Min: p.Min, Max: p.Max, Fields: toParams(p.Fields)}
		if p.Type == render.TLength {
			out[i].Measure = string(p.Measure)
			if p.Measure == "" {
				out[i].Measure = string(render.MeasureFlow)
			}
		}
		if len(out[i].Fields) == 0 {
			out[i].Fields = nil
		}
	}
	return out
}

func toEffect(d *render.Def) Effect {
	e := Effect{ID: d.ID, Name: d.Name, Stateful: d.Stateful, Params: toParams(d.Params), Coords: []string{}}
	for _, c := range []struct {
		bit  render.Coords
		name string
	}{{render.CoordU, "u"}, {render.CoordXY, "xy"}, {render.CoordIndex, "index"}} {
		if d.Coords&c.bit != 0 {
			e.Coords = append(e.Coords, c.name)
		}
	}
	if w := d.WLED; w != nil {
		e.WLED = &WLED{FX: w.FX, Name: w.Name}
		for _, b := range w.Bindings {
			e.WLED.Bindings = append(e.WLED.Bindings, Binding{Slider: string(b.Slider), Param: b.Param, Curve: string(b.Curve), Min: b.Min, Max: b.Max})
		}
	}
	return e
}

func (api *API) effects(w http.ResponseWriter, r *http.Request) error {
	var list []Effect
	for _, d := range api.app.Effects.All() {
		list = append(list, toEffect(d))
	}
	return writeJSON(w, http.StatusOK, map[string]any{
		"effects": nonNil(list),
		"common":  toParams(render.CommonParams),
	})
}

func (api *API) effect(w http.ResponseWriter, r *http.Request) error {
	d, ok := api.app.Effects.Get(r.PathValue("id"))
	if !ok {
		return errorf(http.StatusNotFound, "no effect %q (effects: %s)", r.PathValue("id"), quoteList(api.effectIDs()))
	}
	return writeJSON(w, http.StatusOK, toEffect(d))
}

// Palette is a palette as the API lists it.
type Palette struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	WLED        *int    `json:"wled,omitempty"` // WLED palette id
	Stops       [][]any `json:"stops"`          // [position, "#rrggbb"]
	Interpolate string  `json:"interpolate"`    // linear | step
	Wrap        bool    `json:"wrap"`
}

func (api *API) palettes(w http.ResponseWriter, r *http.Request) error {
	var list []Palette
	for _, p := range api.app.Current().Palettes.All() {
		out := Palette{ID: p.ID, Name: p.Name, Wrap: p.Wrap, Interpolate: "linear", Stops: [][]any{}}
		if p.Step {
			out.Interpolate = "step"
		}
		if p.WLED >= 0 {
			id := p.WLED
			out.WLED = &id
		}
		for _, s := range p.Stops {
			out.Stops = append(out.Stops, []any{s.At, s.Color.String()})
		}
		list = append(list, out)
	}
	return writeJSON(w, http.StatusOK, map[string]any{"palettes": nonNil(list)})
}

// Area is an area as the API lists it.
type Area struct {
	ID     string   `json:"id"`
	Pixels int      `json:"pixels"`
	Runs   []string `json:"runs"`  // runs with pixels in the area
	Zones  []string `json:"zones"` // zones whose device shows the area (as the zone or a segment)
}

func (api *API) areas(w http.ResponseWriter, r *http.Request) error {
	v := api.app.Current()
	var list []Area
	for _, a := range v.Layout.Areas {
		out := Area{ID: a.ID, Pixels: len(a.Pixels), Runs: areaRuns(v.Layout, a.Pixels), Zones: []string{}}
		for _, z := range v.Config.Zones {
			if zoneShows(&z, a.ID) {
				out.Zones = append(out.Zones, z.ID)
			}
		}
		list = append(list, out)
	}
	return writeJSON(w, http.StatusOK, map[string]any{"areas": nonNil(list)})
}

func areaRuns(l *layout.Layout, pixels []int32) []string {
	seen := map[int32]bool{}
	runs := []string{}
	for _, p := range pixels {
		if r := l.Pixels[p].Run; r >= 0 && !seen[r] {
			seen[r] = true
			runs = append(runs, l.Runs[r].ID)
		}
	}
	return runs
}

func zoneShows(z *config.Zone, area string) bool {
	if z.Area == area {
		return true
	}
	for _, s := range z.Segments {
		if s.Area == area {
			return true
		}
	}
	return false
}

// Zone is a zone (a virtual WLED device) as the API lists it.
type Zone struct {
	ID         string    `json:"id"`
	Area       string    `json:"area"`
	Name       string    `json:"name"`
	IP         string    `json:"ip,omitempty"`
	MAC        string    `json:"mac,omitempty"`
	Mapping    string    `json:"mapping,omitempty"`
	Segments   []Segment `json:"segments"`
	Brightness float64   `json:"brightness"`
}

// Segment is a zone's WLED segment.
type Segment struct {
	Area    string `json:"area"`
	Mapping string `json:"mapping,omitempty"`
}

func (api *API) zones(w http.ResponseWriter, r *http.Request) error {
	cfg := api.app.Current().Config
	bri := api.app.Brightness()
	var list []Zone
	for _, z := range cfg.Zones {
		out := Zone{ID: z.ID, Area: z.Area, Name: z.Device.Name, IP: z.Device.IP, MAC: z.Device.MAC,
			Mapping: z.Mapping, Segments: []Segment{}, Brightness: bri.Zones[z.ID]}
		for _, s := range z.Segments {
			out.Segments = append(out.Segments, Segment{Area: s.Area, Mapping: s.Mapping})
		}
		list = append(list, out)
	}
	return writeJSON(w, http.StatusOK, map[string]any{"zones": nonNil(list)})
}

// Mapping is a solved mapping as the API lists it.
type Mapping struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Summary   string   `json:"summary"`
	Origin    string   `json:"origin,omitempty"`    // flows
	Unreached []string `json:"unreached,omitempty"` // flows: runs with no path from the origin
}

func (api *API) mappings(w http.ResponseWriter, r *http.Request) error {
	v := api.app.Current()
	var list []Mapping
	for _, id := range v.Mappings.IDs() {
		m, _ := v.Mappings.Get(id)
		out := Mapping{ID: m.ID, Kind: m.Kind, Summary: m.Describe(v.Layout)}
		if f := m.Flow; f != nil {
			if f.Origin >= 0 && f.Origin < len(v.Layout.Nodes) {
				out.Origin = v.Layout.Nodes[f.Origin].ID
			}
			out.Unreached = f.Unreached
		}
		list = append(list, out)
	}
	return writeJSON(w, http.StatusOK, map[string]any{"default": v.Mappings.Default, "mappings": nonNil(list)})
}

// Controller is a controller as the API lists it.
type Controller struct {
	ID        string  `json:"id"`
	Host      string  `json:"host"`
	Port      int     `json:"port"`
	Transport string  `json:"transport"`
	Pixels    int     `json:"pixels"`
	Channels  string  `json:"channels"`
	MaxFPS    float64 `json:"max_fps,omitempty"`
	Outputs   int     `json:"outputs"`
	// Base is the controller's first global pixel id.
	Base int32 `json:"base"`
}

func (api *API) controllers(w http.ResponseWriter, r *http.Request) error {
	v := api.app.Current()
	var list []Controller
	for _, c := range v.Layout.Controllers {
		cc := c.Config
		list = append(list, Controller{ID: c.ID, Host: cc.Host, Port: cc.Port, Transport: cc.Transport,
			Pixels: c.Pixels, Channels: cc.Channels, MaxFPS: cc.MaxFPS, Outputs: len(cc.Outputs), Base: c.Base})
	}
	return writeJSON(w, http.StatusOK, map[string]any{"controllers": nonNil(list), "health": api.health()})
}

// health asks the output sink, then the stage, for controller health.
func (api *API) health() any {
	for _, x := range []any{api.app.Sink(), api.app.Stage()} {
		if h, ok := x.(HealthReporter); ok {
			return h.Health()
		}
	}
	return nil
}
