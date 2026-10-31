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
