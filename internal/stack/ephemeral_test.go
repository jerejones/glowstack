// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package stack

import (
	"strings"
	"testing"
)

func TestEphemeralLayersAreNeverSaved(t *testing.T) {
	s, _ := newStack()
	if _, err := s.Push(Layer{Owner: OwnerAPI, Target: "fence", Effect: "solid"}); err != nil {
		t.Fatal(err)
	}
	cal, err := s.Push(Layer{ID: "cal1", Owner: OwnerCalibration, Target: "run:fence", Effect: "calibration", Ephemeral: true})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Edit(cal.ID, func(l *Layer) { l.Params = map[string]any{"focus": 3} }); !got.Ephemeral {
		t.Error("edit lost Ephemeral")
	}
	data, err := s.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "cal1") {
		t.Errorf("state.json has the ephemeral layer:\n%s", data)
	}
	// A state.json that has one anyway (edited by hand) doesn't bring it back.
	data = []byte(`{"schema": 1, "layers": [{"id": "cal1", "owner": "calibration", "target": "a", "effect": "solid", "ephemeral": true}]}`)
	s2, _ := newStack()
	if _, err := s2.Restore(data); err != nil {
		t.Fatal(err)
	}
	if s2.Len() != 0 {
		t.Errorf("restored %d layers, want 0", s2.Len())
	}
}

// Reinstate puts a snapshot back exactly and leaves ephemeral layers alone.
func TestSnapshotAndReinstate(t *testing.T) {
	s, _ := newStack()
	a, _ := s.Push(Layer{Owner: OwnerAPI, Target: "fence", Effect: "solid", Params: map[string]any{"brightness": 0.5}})
	b, _ := s.Push(Layer{Owner: OwnerAPI, Target: "fence", Effect: "solid"})
	snap := s.Snapshot()
	if len(snap) != 2 || snap[0].ID != a.ID || snap[1].ID != b.ID {
		t.Fatalf("snapshot = %+v, want %s then %s (bottom first)", snap, a.ID, b.ID)
	}
	// Change everything: a new layer, an edit, a removal, and a calibration layer on top.
	c, _ := s.Push(Layer{Owner: OwnerAPI, Target: "fence", Effect: "solid"})
	if _, err := s.Edit(a.ID, func(l *Layer) { l.Params["brightness"] = 0.9 }); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Push(Layer{ID: "cal1", Owner: OwnerCalibration, Target: "run:fence", Effect: "calibration", Ephemeral: true}); err != nil {
		t.Fatal(err)
	}
	// The snapshot is its own copy: the edit did not reach into it.
	if got := snap[0].Params["brightness"]; got != 0.5 {
		t.Errorf("the snapshot's brightness is %v after an edit, want 0.5", got)
	}
	if w := s.Reinstate(snap); len(w) != 0 {
		t.Errorf("warnings: %v", w)
	}
	list := s.List() // top first
	if len(list) != 3 || list[0].ID != "cal1" || list[1].ID != b.ID || list[2].ID != a.ID {
		t.Fatalf("after Reinstate: %+v, want cal1, %s, %s", list, b.ID, a.ID)
	}
	for i, want := range []Layer{b, a} {
		got := list[i+1]
		if got.Seed != want.Seed || !got.Created.Equal(want.Created) || !got.Updated.Equal(want.Updated) || got.Target != want.Target {
			t.Errorf("layer %s came back changed: %+v, want %+v", want.ID, got, want)
		}
	}
	if got := list[2].Params["brightness"]; got != 0.5 {
		t.Errorf("brightness after Reinstate = %v, want 0.5", got)
	}
	if _, ok := s.Get(c.ID); ok {
		t.Errorf("layer %s, pushed after the snapshot, is still live", c.ID)
	}
	// Ids are not reused after a reinstate.
	d, _ := s.Push(Layer{Owner: OwnerAPI, Target: "fence", Effect: "solid"})
	if d.ID == a.ID || d.ID == b.ID || d.ID == c.ID {
		t.Errorf("a new layer reused id %s", d.ID)
	}
}
