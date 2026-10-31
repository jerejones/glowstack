// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package stack

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/storage"
	"github.com/jerejones/glowstack/internal/units"
)

var t0 = time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)

func newStack() (*Stack, *clock.Manual) {
	c := clock.NewManual(t0)
	return New(c, Fades{In: time.Second, Out: 2 * time.Second}), c
}

func ids(as []Active) string {
	var s []string
	for _, a := range as {
		s = append(s, a.ID)
	}
	return strings.Join(s, ",")
}

func TestPushEditRemove(t *testing.T) {
	s, c := newStack()
	changes := 0
	s.OnChange(func() { changes++ })
	a, err := s.Push(Layer{Owner: OwnerAPI, Target: "fence", Effect: "solid", Params: map[string]any{"color": "#ff0000"}})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := s.Push(Layer{Target: "porch", Effect: "solid", Params: map[string]any{"fade_in": "0s"}})
	if a.ID != "1" || b.ID != "2" || a.Seed == 0 || !a.Created.Equal(t0) {
		t.Fatalf("pushed %+v %+v", a, b)
	}
	f := s.Frame(t0.Add(500*time.Millisecond), nil)
	if ids(f) != "2,1" || f[1].Fade != 0.5 || f[0].Fade != 1 {
		t.Errorf("frame: %s %+v", ids(f), f)
	}

	// Edits keep position, id and creation time.
	c.Advance(time.Second)
	e, err := s.Edit("1", func(l *Layer) { l.Params["color"] = "#00ff00"; l.ID = "x"; l.Seed = 9 })
	if err != nil || e.ID != "1" || e.Seed != a.Seed || !e.Created.Equal(t0) || !e.Updated.Equal(t0.Add(time.Second)) {
		t.Fatalf("edit: %+v %v", e, err)
	}
	if a.Params["color"] != "#ff0000" {
		t.Error("edit changed the pushed layer's params")
	}
	if l := s.List(); len(l) != 2 || l[1].Params["color"] != "#00ff00" {
		t.Errorf("list: %+v", l)
	}

	// Removing fades out over 2 s, then drops the layer.
	if err := s.Remove("2"); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Get("2"); ok || len(s.List()) != 1 {
		t.Error("removed layer still listed")
	}
	f = s.Frame(c.Now().Add(time.Second), nil)
	if ids(f) != "2,1" || !f[0].Removing || f[0].Fade != 0.5 {
		t.Errorf("fading: %+v", f)
	}
	if f = s.Frame(c.Now().Add(2*time.Second), nil); ids(f) != "1" {
		t.Errorf("after fade: %s", ids(f))
	}
	if err := s.Remove("2"); !errors.Is(err, ErrNotFound) {
		t.Errorf("remove twice: %v", err)
	}
	if changes != 5 {
		t.Errorf("%d changes", changes)
	}
}

func TestLifetime(t *testing.T) {
	s, c := newStack()
	s.Push(Layer{Target: "fence", Effect: "solid", Lifetime: Lifetime{For: units.Duration(10 * time.Second)}})
	s.Push(Layer{Target: "fence", Effect: "solid", Lifetime: Lifetime{Until: t0.Add(5 * time.Second)}})
	if _, err := s.Push(Layer{Target: "fence", Effect: "solid", Lifetime: Lifetime{Until: t0}}); err == nil {
		t.Error("pushed a layer that has already expired")
	}
	c.Advance(6 * time.Second)
	if f := s.Frame(c.Now(), nil); ids(f) != "2,1" || !f[0].Removing || f[0].Fade != 0.5 {
		t.Errorf("at 6s: %+v", f)
	}
	if f := s.Frame(t0.Add(11*time.Second), nil); ids(f) != "1" || !f[0].Removing || f[0].Fade != 0.5 {
		t.Errorf("at 11s: %+v", f)
	}
	if f := s.Frame(t0.Add(12*time.Second), nil); len(f) != 0 {
		t.Errorf("at 12s: %+v", f)
	}
}

func TestValidation(t *testing.T) {
	s, _ := newStack()
	s.Validate = func(l *Layer) error {
		if l.Target != "fence" && l.Target != "porch" {
			return errors.New("no such area")
		}
		return nil
	}
	for _, l := range []Layer{
		{Target: "barn", Effect: "solid"},
		{Target: "fence"},
		{Target: "fence", Effect: "solid", Preset: "warm"},
		{Target: "fence", Effect: "solid", Params: map[string]any{"fade_in": "soon"}},
	} {
		if _, err := s.Push(l); err == nil {
			t.Errorf("pushed %+v", l)
		}
	}
	s.Push(Layer{ID: "front", Target: "fence", Preset: "warm"})
	if _, err := s.Push(Layer{ID: "front", Target: "fence", Preset: "warm"}); err == nil {
		t.Error("duplicate id")
	}
	if _, err := s.Edit("front", func(l *Layer) { l.Target = "barn" }); err == nil {
		t.Error("edit skipped validation")
	}
	if l, _ := s.Get("front"); l.Target != "fence" {
		t.Error("failed edit changed the layer")
	}
}

func TestPersistence(t *testing.T) {
	s, c := newStack()
	s.Push(Layer{Owner: WLEDOwner("front", 1), Target: "porch", Effect: "solid", Params: map[string]any{"color": "#ffa000", "opacity": 0.5}})
	s.Push(Layer{Target: "fence", Preset: "slow-crawl", Lifetime: Lifetime{For: units.Duration(time.Hour)}})
	s.Push(Layer{Target: "gone", Effect: "solid"})
	s.Remove("1")
	st := &storage.Memory{}
	if err := s.Save(st); err != nil {
		t.Fatal(err)
	}

	c.Advance(time.Minute)
	r, _ := newStack()
	r.Validate = func(l *Layer) error {
		if l.Target == "gone" {
			return errors.New("no such area")
		}
		return nil
	}
	warnings, err := r.Load(st)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], `"3"`) {
		t.Errorf("warnings %v", warnings)
	}
	got := r.List()
	if len(got) != 1 || got[0].ID != "2" || got[0].Lifetime.For != units.Duration(time.Hour) || !got[0].Created.Equal(t0) {
		t.Fatalf("restored %+v", got)
	}
	// New ids continue after restored ones.
	if l, _ := r.Push(Layer{Target: "fence", Effect: "solid"}); l.ID != "3" {
		t.Errorf("next id %q", l.ID)
	}
	// A missing file is an empty stack.
	if w, err := New(c, Fades{}).Load(&storage.Memory{}); err != nil || w != nil {
		t.Errorf("empty load: %v %v", w, err)
	}
	if _, err := r.Restore([]byte(`{"schema": 2, "layers": []}`)); err == nil {
		t.Error("accepted schema 2")
	}
}

func TestWLEDOwner(t *testing.T) {
	s, _ := newStack()
	s.Push(Layer{Owner: WLEDOwner("front", 0), Target: "fence", Effect: "solid"})
	s.Push(Layer{Owner: OwnerAPI, Target: "fence", Effect: "solid"})
	if got := s.ByOwner("wled-device:front/0"); len(got) != 1 || got[0].ID != "1" {
		t.Errorf("by owner: %+v", got)
	}
}

func TestPushReservesIDDuringFadeOut(t *testing.T) {
	s, c := newStack()
	l := Layer{ID: "chosen", Target: "porch", Effect: "solid"}
	if _, err := s.Push(l); err != nil {
		t.Fatal(err)
	}
	c.Advance(time.Second)
	if err := s.Remove(l.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Push(l); err == nil {
		t.Fatal("accepted an ID still used by a fading layer")
	}
	c.Advance(2 * time.Second)
	s.Frame(c.Now(), nil)
	if _, err := s.Push(l); err != nil {
		t.Fatalf("ID should be available after the fade finishes: %v", err)
	}
}
