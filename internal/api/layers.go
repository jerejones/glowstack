// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
	"github.com/jerejones/glowstack/internal/units"
)

// Layer is a stack layer as the API returns it.
type Layer struct {
	stack.Layer
	// Position is the layer's place in the stack: 0 is the top.
	Position int `json:"position"`
	// Expires is when the layer removes itself, if it has a lifetime.
	Expires *time.Time `json:"expires,omitempty"`
	// Preview is true for preview-only layers (rendered on the live map,
	// not sent to the lights).
	Preview bool `json:"preview,omitempty"`
}

// Request fields for push and edit, besides the common parameters (mapping,
// blend, opacity, brightness, fade_in, …), which may be given at the top
// level as well as in params.
//
//	id        push only: choose the layer id (default: the next number)
//	owner     push only: api (default) | cli | wled-device:<zone>/<n>
//	target    area id
//	effect    effect id, with params as its parameters; or
//	preset    preset id, with params as overrides; or
//	use       an effect or preset id (effects win a clash)
//	params    parameter values; in an edit they're merged, and null
//	          removes an override
//	replace   edit only: params replace the old ones instead of merging
//	lifetime  {"for": "10 s"} and/or {"until": RFC 3339}; null in an edit
//	          makes the layer permanent
//	for       shorthand for lifetime.for. In an edit it counts from now.
//	until     shorthand for lifetime.until
//	preview   push only: put the layer on the preview stack
var requestFields = []string{"id", "owner", "target", "effect", "preset", "use", "params", "replace", "lifetime", "for", "until", "preview"}

type layerRoutes struct {
	api     *API
	preview bool
}

func (ls layerRoutes) stack() *stack.Stack { return ls.api.stackFor(ls.preview) }

func (api *API) stackFor(preview bool) *stack.Stack {
	if preview {
		return api.app.Preview
	}
	return api.app.Stack
}

func (ls layerRoutes) path(id string) string {
	if ls.preview {
		return Prefix + "preview/layers/" + id
	}
	return Prefix + "layers/" + id
}

// layers returns s's layers, top first, as the API shows them.
func layers(s *stack.Stack, preview bool) []Layer {
	list := s.List()
	out := make([]Layer, len(list))
	for i, l := range list {
		out[i] = toLayer(l, i, preview)
	}
	return out
}

func toLayer(l stack.Layer, pos int, preview bool) Layer {
	out := Layer{Layer: l, Position: pos, Preview: preview}
	if t, ok := l.Lifetime.Expires(l.Created); ok {
		out.Expires = &t
	}
	return out
}

func (ls layerRoutes) list(w http.ResponseWriter, r *http.Request) error {
	return writeJSON(w, http.StatusOK, map[string]any{"layers": layers(ls.stack(), ls.preview)})
}

func (ls layerRoutes) find(id string) (Layer, error) {
	for _, l := range layers(ls.stack(), ls.preview) {
		if l.ID == id {
			return l, nil
		}
	}
	return Layer{}, errorf(http.StatusNotFound, "no layer %q", id)
}

func (ls layerRoutes) get(w http.ResponseWriter, r *http.Request) error {
	l, err := ls.find(r.PathValue("id"))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, l)
}

func (ls layerRoutes) push(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	req, err := parseRequest(body, false)
	if err != nil {
		return err
	}
	preview := ls.preview || req.preview
	routes := layerRoutes{api: ls.api, preview: preview}
	l := stack.Layer{
		ID: req.id, Owner: cmpOr(req.owner, stack.OwnerAPI), Target: req.target,
		Params: map[string]any{},
	}
	if l.Target == "" {
		return errorf(http.StatusBadRequest, "a layer needs a target area")
	}
	if err := ls.api.setLook(&l, req); err != nil {
		return err
	}
	for k, v := range req.params {
		if v != nil {
			l.Params[k] = v
		}
	}
	if req.lifetime != nil {
		l.Lifetime = *req.lifetime
	}
	if l.ID != "" {
		if _, ok := routes.stack().Get(l.ID); ok {
			return errorf(http.StatusConflict, "layer %q already exists", l.ID)
		}
	}
	if err := ls.api.check(&l); err != nil {
		return err
	}
	pushed, err := routes.stack().Push(l)
	if err != nil {
		return invalid(err)
	}
	w.Header().Set("Location", routes.path(pushed.ID))
	return writeJSON(w, http.StatusCreated, toLayer(pushed, 0, preview))
}

func (ls layerRoutes) edit(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	req, err := parseRequest(body, true)
	if err != nil {
		return err
	}
	old, ok := ls.stack().Get(id)
	if !ok {
		return errorf(http.StatusNotFound, "no layer %q", id)
	}
	next := old
	next.Params = maps.Clone(old.Params)
	if next.Params == nil || req.replace {
		next.Params = map[string]any{}
	}
	if req.target != "" {
		next.Target = req.target
	}
	if req.effect != "" || req.preset != "" || req.use != "" {
		if err := ls.api.setLook(&next, req); err != nil {
			return err
		}
		if !req.replace {
			ls.api.dropForeign(&next)
		}
	}
	for k, v := range req.params {
		if v == nil {
			delete(next.Params, k)
		} else {
			next.Params[k] = v
		}
	}
	if req.lifetimeSet {
		next.Lifetime = stack.Lifetime{}
		if req.lifetime != nil {
			next.Lifetime = *req.lifetime
		}
		// In an edit, "for" counts from now, not from creation.
		if d := next.Lifetime.For; d > 0 {
			until := ls.api.app.Clock.Now().Add(time.Duration(d))
			if next.Lifetime.Until.IsZero() || until.Before(next.Lifetime.Until) {
				next.Lifetime.Until = until
			}
			next.Lifetime.For = 0
		}
	}
	if err := ls.api.check(&next); err != nil {
		return err
	}
	edited, err := ls.stack().Edit(id, func(l *stack.Layer) {
		l.Target, l.Effect, l.Preset, l.Params, l.Lifetime = next.Target, next.Effect, next.Preset, next.Params, next.Lifetime
	})
	if err != nil {
		return invalid(err)
	}
	l, err := ls.find(edited.ID)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, l)
}

func (ls layerRoutes) remove(w http.ResponseWriter, r *http.Request) error {
	if err := ls.stack().Remove(r.PathValue("id")); err != nil {
		return invalid(err)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// clear removes every layer, or only those of ?owner=.
func (ls layerRoutes) clear(w http.ResponseWriter, r *http.Request) error {
	s := ls.stack()
	owner, filtered := r.URL.Query()["owner"]
	var removed []string
	if !filtered {
		for _, l := range s.List() {
			removed = append(removed, l.ID)
		}
		s.Clear()
	} else {
		for _, l := range s.ByOwner(strings.Join(owner, "")) {
			if s.Remove(l.ID) == nil {
				removed = append(removed, l.ID)
			}
		}
	}
	return writeJSON(w, http.StatusOK, map[string]any{"removed": nonNil(removed)})
}

// request is a parsed push or edit body.
type request struct {
	id, owner, target   string
	effect, preset, use string
	params              map[string]any // nil values delete (edit)
	replace, preview    bool
	lifetime            *stack.Lifetime
	lifetimeSet         bool // lifetime, for or until was given (null clears, in an edit)
}

func parseRequest(body map[string]json.RawMessage, edit bool) (*request, error) {
	req := &request{params: map[string]any{}}
	str := func(name string, dst *string) error {
		raw, ok := body[name]
		if !ok || string(raw) == "null" {
			return nil
		}
		if err := json.Unmarshal(raw, dst); err != nil {
			return errorf(http.StatusBadRequest, "%s: want a string", name)
		}
		return nil
	}
	flag := func(name string, dst *bool) error {
		raw, ok := body[name]
		if !ok || string(raw) == "null" {
			return nil
		}
		if err := json.Unmarshal(raw, dst); err != nil {
			return errorf(http.StatusBadRequest, "%s: want true or false", name)
		}
		return nil
	}
	pushOnly := map[string]bool{"id": true, "owner": true, "preview": true}
	editOnly := map[string]bool{"replace": true}
	var unknown []string
	for k := range body {
		switch {
		case render.IsCommon(k):
		case !slices.Contains(requestFields, k):
			unknown = append(unknown, k)
		case edit && pushOnly[k]:
			return nil, errorf(http.StatusBadRequest, "%s can't be changed by an edit", k)
		case !edit && editOnly[k]:
			return nil, errorf(http.StatusBadRequest, "%s only applies to an edit", k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, errorf(http.StatusBadRequest, "unknown field %s (put effect parameters in \"params\")", quoteList(unknown))
	}
	for name, dst := range map[string]*string{"id": &req.id, "owner": &req.owner, "target": &req.target,
		"effect": &req.effect, "preset": &req.preset, "use": &req.use} {
		if err := str(name, dst); err != nil {
			return nil, err
		}
	}
	for name, dst := range map[string]*bool{"replace": &req.replace, "preview": &req.preview} {
		if err := flag(name, dst); err != nil {
			return nil, err
		}
	}
	n := 0
	for _, s := range []string{req.effect, req.preset, req.use} {
		if s != "" {
			n++
		}
	}
	if n > 1 {
		return nil, errorf(http.StatusBadRequest, "give only one of effect, preset or use")
	}
	if !edit && n == 0 {
		return nil, errorf(http.StatusBadRequest, "a layer needs an effect or a preset")
	}
	if raw, ok := body["params"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &req.params); err != nil {
			return nil, errorf(http.StatusBadRequest, "params: want an object of parameter values")
		}
	}
	// Common parameters at the top level override params.
	for k, raw := range body {
		if render.IsCommon(k) {
			var v any
			if err := json.Unmarshal(raw, &v); err != nil {
				return nil, errorf(http.StatusBadRequest, "%s: %v", k, err)
			}
			req.params[k] = v
		}
	}
	if err := parseLifetime(body, req); err != nil {
		return nil, err
	}
	return req, nil
}

func parseLifetime(body map[string]json.RawMessage, req *request) error {
	var lt stack.Lifetime
	set, any := false, false
	if raw, ok := body["lifetime"]; ok {
		set = true
		if string(raw) != "null" {
			if err := json.Unmarshal(raw, &lt); err != nil {
				return errorf(http.StatusBadRequest, `lifetime: want {"for": "10 s"} or {"until": "2026-01-01T23:00:00Z"}: %v`, err)
			}
			any = true
		}
	}
	if raw, ok := body["for"]; ok && string(raw) != "null" {
		var d units.Duration
		if err := json.Unmarshal(raw, &d); err != nil {
			return errorf(http.StatusBadRequest, `for: want a duration such as "10 s": %v`, err)
		}
		lt.For, set, any = d, true, true
	}
	if raw, ok := body["until"]; ok && string(raw) != "null" {
		var t time.Time
		if err := json.Unmarshal(raw, &t); err != nil {
			return errorf(http.StatusBadRequest, `until: want an RFC 3339 time such as "2026-01-01T23:00:00Z"`)
		}
		lt.Until, set, any = t, true, true
	}
	if lt.For < 0 {
		return errorf(http.StatusBadRequest, "lifetime: for must be positive")
	}
	req.lifetimeSet = set
	if any {
		req.lifetime = &lt
	}
	return nil
}

// setLook sets l's effect or preset from req, resolving "use".
func (api *API) setLook(l *stack.Layer, req *request) error {
	v := api.app.Current()
	effect, preset := req.effect, req.preset
	if req.use != "" {
		if _, ok := api.app.Effects.Get(req.use); ok {
			effect = req.use
		} else if _, ok := v.Config.Preset(req.use); ok {
			preset = req.use
		} else {
			return errorf(http.StatusBadRequest, "no effect or preset %q (effects: %s; presets: %s)",
				req.use, quoteList(api.effectIDs()), quoteList(presetIDs(v)))
		}
	}
	if effect != "" {
		if _, ok := api.app.Effects.Get(effect); !ok {
			return errorf(http.StatusBadRequest, "no effect %q (effects: %s)", effect, quoteList(api.effectIDs()))
		}
	}
	if preset != "" {
		if _, ok := v.Config.Preset(preset); !ok {
			return errorf(http.StatusBadRequest, "no preset %q (presets: %s)", preset, quoteList(presetIDs(v)))
		}
	}
	l.Effect, l.Preset = effect, preset
	return nil
}

// dropForeign removes params that l's (new) effect doesn't take, keeping
// the common ones, so switching effect in an edit doesn't trip over the
// old effect's parameters.
func (api *API) dropForeign(l *stack.Layer) {
	def := api.layerEffect(l)
	if def == nil {
		return
	}
	for k := range l.Params {
		if !render.IsCommon(k) && !slices.ContainsFunc(def.Params, func(p render.Param) bool { return p.Name == k }) {
			delete(l.Params, k)
		}
	}
}

// layerEffect returns the effect a layer uses, through its preset.
func (api *API) layerEffect(l *stack.Layer) *render.Def {
	id := l.Effect
	if l.Preset != "" {
		p, ok := api.app.Current().Config.Preset(l.Preset)
		if !ok {
			return nil
		}
		id = p.Effect
	}
	def, _ := api.app.Effects.Get(id)
	return def
}

// check validates a layer with friendlier messages than the engine's for
// the common mistakes (an unknown area or parameter), then with the
// engine itself.
func (api *API) check(l *stack.Layer) error {
	v := api.app.Current()
	if _, ok := v.Layout.Area(l.Target); !ok {
		var ids []string
		for _, a := range v.Layout.Areas {
			ids = append(ids, a.ID)
		}
		return errorf(http.StatusBadRequest, "no area %q (areas: %s)", l.Target, quoteList(ids))
	}
	if def := api.layerEffect(l); def != nil {
		var unknown []string
		for k := range l.Params {
			if !render.IsCommon(k) && !slices.ContainsFunc(def.Params, func(p render.Param) bool { return p.Name == k }) {
				unknown = append(unknown, k)
			}
		}
		if len(unknown) > 0 {
			sort.Strings(unknown)
			var names []string
			for _, p := range def.Params {
				names = append(names, p.Name)
			}
			return errorf(http.StatusBadRequest, "effect %q has no parameter %s (its parameters: %s; common: %s)",
				def.ID, quoteList(unknown), orNone(names), commonNames())
		}
	}
	if err := v.Engine.Check(l); err != nil {
		return errorf(http.StatusBadRequest, "invalid layer: %v", err)
	}
	return nil
}

func (api *API) effectIDs() []string {
	var ids []string
	for _, d := range api.app.Effects.All() {
		ids = append(ids, d.ID)
	}
	return ids
}

func presetIDs(v app.View) []string {
	var ids []string
	for _, p := range v.Config.Presets {
		ids = append(ids, p.ID)
	}
	return ids
}

func commonNames() string {
	var names []string
	for _, p := range render.CommonParams {
		names = append(names, p.Name)
	}
	return strings.Join(names, ", ")
}

func quoteList(s []string) string {
	if len(s) == 0 {
		return "none"
	}
	q := make([]string, len(s))
	for i, x := range s {
		q[i] = fmt.Sprintf("%q", x)
	}
	return strings.Join(q, ", ")
}

func orNone(s []string) string {
	if len(s) == 0 {
		return "none"
	}
	return strings.Join(s, ", ")
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
