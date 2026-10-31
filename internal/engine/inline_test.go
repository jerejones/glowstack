// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package engine

import (
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

// An inline mapping with the same fields as a named one gives the same
// coordinates, is solved once per content, and survives state.json.
func TestInlineMappingMatchesNamed(t *testing.T) {
	e, s, c := setup(t)
	for _, tt := range []struct {
		named  string
		inline map[string]any
	}{
		{"from-gate", map[string]any{"origin": "gate-w", "unreached": "dark"}},
		{"from-gate", map[string]any{"kind": "flow", "id": "copied", "origin": "gate-w", "unreached": "dark"}},
		{"east-west", map[string]any{"kind": "axis", "angle": "0 deg"}},
	} {
		named, err := s.Push(stack.Layer{Target: "yard", Effect: "solid", Params: map[string]any{"mapping": tt.named}})
		if err != nil {
			t.Fatal(err)
		}
		inline, err := s.Push(stack.Layer{Target: "yard", Effect: "solid", Params: map[string]any{"mapping": tt.inline}})
		if err != nil {
			t.Fatal(err)
		}
		var want, got *render.Layer
		for _, l := range e.Resolve(s.Frame(c.Now(), nil), nil) {
			switch l.ID {
			case named.ID:
				want = l
			case inline.ID:
				got = l
			}
		}
		if !strings.HasPrefix(got.Common.Mapping, config.InlinePrefix) {
			t.Errorf("inline mapping id %q", got.Common.Mapping)
		}
		if len(got.Geometry.U) != len(want.Geometry.U) || len(got.Geometry.Dark) != len(want.Geometry.Dark) {
			t.Fatalf("%v: %d u, %d dark; want %d, %d", tt.inline, len(got.Geometry.U), len(got.Geometry.Dark), len(want.Geometry.U), len(want.Geometry.Dark))
		}
		for i := range want.Geometry.U {
			if got.Geometry.U[i] != want.Geometry.U[i] || got.Geometry.Pixels[i] != want.Geometry.Pixels[i] {
				t.Fatalf("%v: pixel %d u %v, want %v", tt.inline, got.Geometry.Pixels[i], got.Geometry.U[i], want.Geometry.U[i])
			}
		}
		s.Remove(named.ID)
		s.Remove(inline.ID)
	}
	// The two flows differ only in kind and id, so they share one solve.
	if len(e.inline) != 2 {
		t.Errorf("%d inline mappings cached, want 2", len(e.inline))
	}

	l, err := s.Push(stack.Layer{Target: "porch", Effect: "solid", Params: map[string]any{"mapping": map[string]any{"origin": "porch-w"}}})
	if err != nil {
		t.Fatal(err)
	}
	data, err := s.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if warnings, err := s.Restore(data); err != nil || len(warnings) != 0 {
		t.Fatalf("restore: %v, %v", warnings, err)
	}
	if got, ok := s.Get(l.ID); !ok || got.Params["mapping"].(map[string]any)["origin"] != "porch-w" {
		t.Errorf("restored %+v", got)
	}
}

func TestInlineMappingErrors(t *testing.T) {
	_, s, _ := setup(t)
	for _, tt := range []struct {
		mapping any
		want    string
	}{
		{map[string]any{"origin": "nowhere"}, `unknown origin node "nowhere"`},
		{map[string]any{"origin": "gate-w", "pase": "average"}, `inline mapping: unknown field "pase"`},
		{map[string]any{"origin": "gate-w", "pace": "fastest"}, `inline mapping: pace "fastest": want one of`},
		{map[string]any{"angle": "0 deg"}, "inline mapping: give a kind"},
		{map[string]any{"kind": "spiral"}, `inline mapping: kind "spiral": want one of`},
		{map[string]any{"kind": "radial"}, "missing center"},
		{map[string]any{"kind": "axis", "angle": "sideways"}, "inline mapping: bad angle"},
		{42, "want a mapping id or an inline mapping object"},
	} {
		_, err := s.Push(stack.Layer{Target: "yard", Effect: "solid", Params: map[string]any{"mapping": tt.mapping}})
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("mapping %v: %v, want %q", tt.mapping, err, tt.want)
		}
	}
}
