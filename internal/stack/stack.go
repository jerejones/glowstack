// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package stack is the ordered list of active layers: push, edit in place,
// remove with a fade-out, lifetimes, and persistence to state.json.
//
// The stack stores layers as the API describes them (target area, effect or
// preset, raw params). It knows nothing about pixels or effects; the engine
// resolves layers into render layers and checks them through Validate.
package stack

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/storage"
	"github.com/jerejones/glowstack/internal/units"
)

// Owners. A WLED device owns its segments' layers as
// "wled-device:<zone>/<segment>".
const (
	OwnerAPI         = "api"
	OwnerCLI         = "cli"
	OwnerCalibration = "calibration"
	OwnerWLEDPrefix  = "wled-device:"
)

// WLEDOwner returns the owner string for a WLED device segment.
func WLEDOwner(zone string, segment int) string {
	return OwnerWLEDPrefix + zone + "/" + strconv.Itoa(segment)
}

// Layer is one stack entry as stored and as the API sees it.
type Layer struct {
	Name   string `json:"name,omitempty"` // display name retained when a library edit detaches a preset
	ID     string `json:"id"`
	Owner  string `json:"owner,omitempty"`
	Target string `json:"target"`           // area id
	Effect string `json:"effect,omitempty"` // effect id; or
	Preset string `json:"preset,omitempty"` // preset id, with Params as overrides
	// Params holds effect params and the common params (mapping, blend,
	// opacity, brightness, fade_in, …) as raw values. Treat it as
	// immutable: Edit replaces it rather than changing it in place.
	Params   map[string]any `json:"params,omitempty"`
	Lifetime Lifetime       `json:"lifetime,omitzero"`
	Seed     uint64         `json:"seed"`
	Created  time.Time      `json:"created"`
	Updated  time.Time      `json:"updated"`
	// Revision identifies a mutation independently of clock precision.
	Revision uint64 `json:"-"`
	// Ephemeral layers are never written to state.json, so they don't
	// survive a restart (calibration's layers).
	Ephemeral bool `json:"ephemeral,omitempty"`
	// ResolvedFades is filled by Validate after preset expansion. A negative
	// duration uses the stack default. It is recalculated on every change
	// and restore, so persisted Params remain the caller's overrides.
	ResolvedFades *Fades `json:"-"`
}

// Lifetime says when a layer removes itself. The zero value means "until
// removed".
type Lifetime struct {
	For   units.Duration `json:"for,omitzero"`   // from Created
	Until time.Time      `json:"until,omitzero"` // wall-clock time
}

// Expires returns when a layer with this lifetime, created at created,
// expires, and false if it never does.
func (lt Lifetime) Expires(created time.Time) (time.Time, bool) {
	var t time.Time
	if lt.For > 0 {
		t = created.Add(time.Duration(lt.For))
	}
	if !lt.Until.IsZero() && (t.IsZero() || lt.Until.Before(t)) {
		t = lt.Until
	}
	return t, !t.IsZero()
}

// Active is a layer as rendered this frame.
type Active struct {
	Layer
	// Fade is the fade-in/fade-out level, 0–1. It multiplies opacity.
	Fade float32
	// Removing is true while the layer fades out after removal.
	Removing bool
}

// Fades holds the default fade durations (glowstack.yaml `fade`).
type Fades struct{ In, Out time.Duration }

// ErrNotFound is returned for an unknown layer id.
var ErrNotFound = errors.New("no such layer")

type entry struct {
	Layer
	shown     time.Time // fade-in starts here (creation, or restore)
	removedAt time.Time // zero while live
	fadeIn    time.Duration
	fadeOut   time.Duration
	fromFade  float32 // fade level when removal started
}

// Stack is the layer stack. It's safe for concurrent use.
type Stack struct {
	mu       sync.Mutex
	clock    clock.Source
	fades    Fades
	entries  []*entry // bottom first
	nextID   int
	version  uint64
	onChange []func()

	// Validate, if set, checks a layer before it's pushed, edited or
	// restored. The engine sets it.
	Validate func(*Layer) error
}

// New returns an empty stack.
func New(src clock.Source, fades Fades) *Stack {
	return &Stack{clock: src, fades: fades, nextID: 1}
}

// OnChange registers fn to run (without the lock held) after every change
// that should be persisted.
func (s *Stack) OnChange(fn func()) {
	s.mu.Lock()
	s.onChange = append(s.onChange, fn)
	s.mu.Unlock()
}

// Version increases on every change, including fades finishing.
func (s *Stack) Version() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.version
}

func (s *Stack) changed() {
	s.version++
	fns := slices.Clone(s.onChange)
	s.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
	s.mu.Lock()
}

// Push puts a new layer on top and returns it with its id, seed and times
// filled in. A caller-chosen id must be unused.
func (s *Stack) Push(l Layer) (Layer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	if l.ID == "" {
		for s.hasID(strconv.Itoa(s.nextID)) {
			s.nextID++
		}
		l.ID = strconv.Itoa(s.nextID)
		s.nextID++
	} else if s.hasID(l.ID) {
		return Layer{}, fmt.Errorf("layer %q already exists", l.ID)
	}
	if l.Seed == 0 {
		l.Seed = rand.Uint64() | 1
	}
	l.Params = cloneParams(l.Params)
	l.Created, l.Updated = now, now
	l.Revision = s.version + 1
	if err := s.check(&l, now); err != nil {
		return Layer{}, err
	}
	e := &entry{Layer: l, shown: now}
	if err := s.setFades(e); err != nil {
		return Layer{}, err
	}
	s.entries = append(s.entries, e)
	s.changed()
	return l, nil
}

// Edit changes a live layer in place, keeping its position, id, owner,
// seed and creation time. fn gets a copy to change (with its own Params
// map).
func (s *Stack) Edit(id string, fn func(*Layer)) (Layer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.find(id)
	if i < 0 {
		return Layer{}, fmt.Errorf("%w: %q", ErrNotFound, id)
	}
	e := s.entries[i]
	l := e.Layer
	l.Params = cloneParams(l.Params)
	if l.Params == nil {
		l.Params = map[string]any{}
	}
	fn(&l)
	l.ID, l.Owner, l.Seed, l.Created = e.ID, e.Owner, e.Seed, e.Created
	now := s.clock.Now()
	l.Updated = now
	l.Revision = s.version + 1
	if err := s.check(&l, now); err != nil {
		return Layer{}, err
	}
	next := *e
	next.Layer = l
	if err := s.setFades(&next); err != nil {
		return Layer{}, err
	}
	*e = next
	s.changed()
	return l, nil
}

// Remove starts a layer's fade-out. It disappears from Get and List at
// once and from frames when the fade ends.
func (s *Stack) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.find(id)
	if i < 0 {
		return fmt.Errorf("%w: %q", ErrNotFound, id)
	}
	s.remove(s.entries[i], s.clock.Now())
	s.changed()
	return nil
}

// Clear removes every layer (each fading out).
func (s *Stack) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	for _, e := range s.entries {
		if e.removedAt.IsZero() {
			s.remove(e, now)
		}
	}
	s.changed()
}

// Prune drops live layers that check rejects, at once and without a
// fade (they can no longer be rendered), and returns a warning for each.
// A config reload uses it to drop layers whose area, effect, preset or
// mapping no longer exists.
func (s *Stack) Prune(check func(*Layer) error) (warnings []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.entries[:0]
	for _, e := range s.entries {
		if e.removedAt.IsZero() {
			if err := check(&e.Layer); err != nil {
				warnings = append(warnings, fmt.Sprintf("layer %q: %v; dropped", e.ID, err))
				continue
			}
		}
		kept = append(kept, e)
	}
	clear(s.entries[len(kept):])
	s.entries = kept
	if len(warnings) > 0 {
		s.changed()
	}
	return warnings
}

// SetFades changes the default fade durations for layers that don't set
// their own. Layers already on the stack keep theirs until edited.
func (s *Stack) SetFades(f Fades) {
	s.mu.Lock()
	s.fades = f
	s.mu.Unlock()
}

func (s *Stack) remove(e *entry, now time.Time) {
	e.fromFade = e.fade(now)
	e.removedAt = now
}

// Get returns a live layer.
func (s *Stack) Get(id string) (Layer, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i := s.find(id); i >= 0 {
		return s.entries[i].Layer, true
	}
	return Layer{}, false
}

// List returns the live layers, top first.
func (s *Stack) List() []Layer {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Layer
	for _, e := range slices.Backward(s.entries) {
		if e.removedAt.IsZero() {
			out = append(out, e.Layer)
		}
	}
	return out
}

// Len is the number of live layers.
func (s *Stack) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, e := range s.entries {
		if e.removedAt.IsZero() {
			n++
		}
	}
	return n
}

// ByOwner returns the live layers with the given owner, top first.
func (s *Stack) ByOwner(owner string) []Layer {
	var out []Layer
	for _, l := range s.List() {
		if l.Owner == owner {
			out = append(out, l)
		}
	}
	return out
}

// Frame expires layers whose lifetime has ended, drops finished fade-outs
// and appends the layers to render at now, top first, to dst.
func (s *Stack) Frame(now time.Time, dst []Active) []Active {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	kept := s.entries[:0]
	for _, e := range s.entries {
		if e.removedAt.IsZero() {
			if t, ok := e.Lifetime.Expires(e.Created); ok && !now.Before(t) {
				s.remove(e, t)
				changed = true
			}
		}
		if !e.removedAt.IsZero() && e.fade(now) <= 0 {
			changed = true
			continue
		}
		kept = append(kept, e)
	}
	clear(s.entries[len(kept):])
	s.entries = kept
	for _, e := range slices.Backward(s.entries) {
		dst = append(dst, Active{Layer: e.Layer, Fade: e.fade(now), Removing: !e.removedAt.IsZero()})
	}
	if changed {
		s.changed()
	}
	return dst
}

func (e *entry) fade(now time.Time) float32 {
	in := ramp(now.Sub(e.shown), e.fadeIn)
	if e.removedAt.IsZero() {
		return in
	}
	out := e.fromFade * (1 - ramp(now.Sub(e.removedAt), e.fadeOut))
	return min(in, out)
}

// ramp is elapsed/d clamped to 0–1 (1 when d is 0).
func ramp(elapsed, d time.Duration) float32 {
	if d <= 0 || elapsed >= d {
		return 1
	}
	if elapsed <= 0 {
		return 0
	}
	return float32(elapsed.Seconds() / d.Seconds())
}

// hasID includes removed layers until their fade-out has finished.
func (s *Stack) hasID(id string) bool {
	return slices.ContainsFunc(s.entries, func(e *entry) bool { return e.ID == id })
}

func (s *Stack) find(id string) int {
	return slices.IndexFunc(s.entries, func(e *entry) bool { return e.ID == id && e.removedAt.IsZero() })
}

func (s *Stack) check(l *Layer, now time.Time) error {
	l.ResolvedFades = nil
	if l.Target == "" {
		return errors.New("layer needs a target area")
	}
	if (l.Effect == "") == (l.Preset == "") {
		return errors.New("layer needs exactly one of effect or preset")
	}
	if l.Lifetime.For < 0 {
		return errors.New("lifetime must be positive")
	}
	if t, ok := l.Lifetime.Expires(l.Created); ok && !t.After(now) {
		return fmt.Errorf("lifetime already ended at %s", t.Format(time.RFC3339))
	}
	if s.Validate != nil {
		return s.Validate(l)
	}
	return nil
}

// setFades reads fade_in and fade_out from the layer's params, falling
// back to the stack defaults.
func (s *Stack) setFades(e *entry) error {
	var err error
	if e.fadeIn, err = durationParam(e.Params, "fade_in", s.fades.In); err != nil {
		return err
	}
	e.fadeOut, err = durationParam(e.Params, "fade_out", s.fades.Out)
	if err != nil {
		return err
	}
	if f := e.ResolvedFades; f != nil {
		if f.In >= 0 {
			e.fadeIn = f.In
		}
		if f.Out >= 0 {
			e.fadeOut = f.Out
		}
	}
	return nil
}

func durationParam(params map[string]any, name string, def time.Duration) (time.Duration, error) {
	v, ok := params[name]
	if !ok || v == nil {
		return def, nil
	}
	var d time.Duration
	switch v := v.(type) {
	case string:
		u, err := units.ParseDuration(v)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", name, err)
		}
		d = time.Duration(u)
	case float64:
		d = time.Duration(v * float64(time.Second))
	case int:
		d = time.Duration(v) * time.Second
	default:
		return 0, fmt.Errorf("%s: want a duration such as \"2s\", got %v", name, v)
	}
	if d < 0 {
		return 0, fmt.Errorf("%s: negative duration", name)
	}
	return d, nil
}

// cloneParams copies the raw YAML/JSON tree, so editing a nested list or
// mapping cannot mutate an active layer before validation succeeds.
func cloneParams(params map[string]any) map[string]any {
	if params == nil {
		return nil
	}
	out := make(map[string]any, len(params))
	for k, v := range params {
		out[k] = cloneParam(v)
	}
	return out
}

func cloneParam(v any) any {
	switch v := v.(type) {
	case map[string]any:
		return cloneParams(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = cloneParam(item)
		}
		return out
	default:
		return v
	}
}

// SchemaVersion is the state.json schema.
const SchemaVersion = 1

// StateFile is the stack's file in the data folder.
const StateFile = config.StateFileName

// state is state.json: the live layers, bottom first.
type state struct {
	Schema int     `json:"schema"`
	Layers []Layer `json:"layers"`
}

// Marshal returns the live stack as state.json. Layers fading out are left
// out: they're already gone as far as anyone is concerned.
func (s *Stack) Marshal() ([]byte, error) {
	s.mu.Lock()
	st := state{Schema: SchemaVersion, Layers: []Layer{}}
	for _, e := range s.entries {
		if e.removedAt.IsZero() && !e.Ephemeral {
			st.Layers = append(st.Layers, e.Layer)
		}
	}
	s.mu.Unlock()
	return json.MarshalIndent(st, "", "  ")
}

// Restore replaces the stack with state.json's layers. Layers that no
// longer validate (say, their area was deleted from the config) or whose
// lifetime has ended are dropped with a warning. Restored layers fade in.
func (s *Stack) Restore(data []byte) (warnings []string, err error) {
	var st state
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("state: %w", err)
	}
	if st.Schema != SchemaVersion {
		return nil, fmt.Errorf("state: schema %d, want %d", st.Schema, SchemaVersion)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	s.entries = s.entries[:0]
	seen := map[string]bool{}
	for _, l := range st.Layers {
		if l.Ephemeral {
			continue // never saved; a hand-edited state.json may still have one
		}
		if seen[l.ID] || l.ID == "" {
			warnings = append(warnings, fmt.Sprintf("layer %q: duplicate or missing id; dropped", l.ID))
			continue
		}
		if err := s.check(&l, now); err != nil {
			warnings = append(warnings, fmt.Sprintf("layer %q: %v; dropped", l.ID, err))
			continue
		}
		l.Revision = s.version + 1
		e := &entry{Layer: l, shown: now}
		if err := s.setFades(e); err != nil {
			warnings = append(warnings, fmt.Sprintf("layer %q: %v; dropped", l.ID, err))
			continue
		}
		seen[l.ID] = true
		s.entries = append(s.entries, e)
		if n, err := strconv.Atoi(l.ID); err == nil {
			s.nextID = max(s.nextID, n+1)
		}
	}
	s.changed()
	return warnings, nil
}

// Snapshot returns the live layers that are saved (not the ephemeral ones),
// bottom first, exactly as they are: ids, seeds, times, order and their own
// copies of the parameters. Reinstate puts a snapshot back.
func (s *Stack) Snapshot() []Layer {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Layer{}
	for _, e := range s.entries {
		if e.removedAt.IsZero() && !e.Ephemeral {
			l := e.Layer
			l.Params = cloneParams(l.Params)
			out = append(out, l)
		}
	}
	return out
}

// Reinstate makes the live, saved layers exactly a snapshot's (bottom
// first): the same layers, order, targets, parameters, seeds and times. A
// layer that is still live keeps its place in its fade, so putting the
// stack back doesn't blink what never left; one that had been removed
// fades in again; live layers the snapshot doesn't have fade out, as Remove
// does. Ephemeral layers (calibration's) are not part of a snapshot and
// stay on top. A snapshot layer that no longer validates, or whose
// lifetime has ended, is dropped with a warning. It only changes the
// stack: like any other change, the frames that follow carry it.
func (s *Stack) Reinstate(layers []Layer) (warnings []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	live := map[string]*entry{}
	for _, e := range s.entries {
		if e.removedAt.IsZero() && !e.Ephemeral {
			live[e.ID] = e
		}
	}
	var kept, fading, ephemeral []*entry
	seen := map[string]bool{}
	for _, l := range layers {
		if l.Ephemeral || l.ID == "" || seen[l.ID] {
			continue
		}
		l.Params = cloneParams(l.Params)
		if err := s.check(&l, now); err != nil {
			warnings = append(warnings, fmt.Sprintf("layer %q: %v; dropped", l.ID, err))
			continue
		}
		l.Revision = s.version + 1
		e := &entry{Layer: l, shown: now}
		if old, ok := live[l.ID]; ok {
			next := *old
			next.Layer = l
			e = &next
		}
		if err := s.setFades(e); err != nil {
			warnings = append(warnings, fmt.Sprintf("layer %q: %v; dropped", l.ID, err))
			continue
		}
		seen[l.ID] = true
		kept = append(kept, e)
	}
	for _, e := range s.entries {
		switch {
		case !e.removedAt.IsZero():
			fading = append(fading, e)
		case e.Ephemeral:
			ephemeral = append(ephemeral, e)
		case !seen[e.ID]:
			s.remove(e, now)
			fading = append(fading, e)
		}
	}
	// Layers on their way out draw beneath what is live, as they fade.
	s.entries = append(append(fading, kept...), ephemeral...)
	s.changed()
	return warnings
}

// Save writes state.json to st.
func (s *Stack) Save(st storage.Store) error {
	data, err := s.Marshal()
	if err != nil {
		return err
	}
	return st.Write(StateFile, data)
}

// Load restores state.json from st. A missing file is an empty stack.
func (s *Stack) Load(st storage.Store) (warnings []string, err error) {
	data, err := st.Read(StateFile)
	if storage.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.Restore(data)
}

// FreezePreset keeps the rendered specification of existing looks when their
// saved preset is edited/deleted. IDs, timing, fades and seeds stay intact.
func (s *Stack) FreezePreset(id, name string, expand func(*Layer) (string, map[string]any, error)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, e := range s.entries {
		if e.Preset != id {
			continue
		}
		effect, params, err := expand(&e.Layer)
		if err != nil {
			continue
		}
		e.Effect, e.Params, e.Preset, e.Name = effect, cloneParams(params), "", name
		e.Revision = s.version + 1
		changed = true
	}
	if changed {
		s.changed()
	}
}
