// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package engine

import (
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

// counter is a stateful test effect that counts its frames.
type counter struct{ frames int }

func (c *counter) Render(_ *render.Context, out []color.Color) {
	c.frames++
	for i := range out {
		out[i] = color.Black
	}
}

func setup(t *testing.T) (*Engine, *stack.Stack, *clock.Manual) {
	t.Helper()
	cfg, err := config.Load("../../examples/fictional/config", "../../examples/fictional/data")
	if err != nil {
		t.Fatal(err)
	}
	l, err := layout.Build(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ms, err := layout.SolveMappings(l, cfg)
	if err != nil {
		t.Fatal(err)
	}
	reg := render.NewRegistry()
	if err := effects.Register(reg); err != nil {
		t.Fatal(err)
	}
	reg.MustRegister(&render.Def{ID: "count", Stateful: true, Coords: render.CoordU, New: func() render.Effect { return &counter{} }})
	e := New(cfg, l, ms, reg, palette.NewRegistry(cfg.Palettes))
	c := clock.NewManual(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC))
	s := stack.New(c, stack.Fades{})
	s.Validate = e.Check
	return e, s, c
}

func TestMappingPrecedence(t *testing.T) {
	e, _, _ := setup(t)
	tests := []struct {
		l    stack.Layer
		want string
	}{
		{stack.Layer{Target: "porch"}, "porch-local"},                                  // the porch zone's segment, then zone
		{stack.Layer{Target: "shed-north"}, "east-west"},                               // segment override
		{stack.Layer{Target: "yard"}, "front-sweep"},                                   // the front zone
		{stack.Layer{Target: "yard", Owner: stack.WLEDOwner("porch", 1)}, "east-west"}, // owner's segment wins
		{stack.Layer{Target: "yard", Owner: stack.WLEDOwner("porch", 0)}, "porch-local"},
		{stack.Layer{Target: "yard", Owner: stack.WLEDOwner("porch", 9)}, "porch-local"},
	}
	for _, tt := range tests {
		if got := e.Mapping(&tt.l); got != tt.want {
			t.Errorf("%s/%s: %s, want %s", tt.l.Owner, tt.l.Target, got, tt.want)
		}
	}
}

func TestCheck(t *testing.T) {
	_, s, _ := setup(t)
	for _, tt := range []struct {
		l    stack.Layer
		want string
	}{
		{stack.Layer{Target: "barn", Effect: "solid"}, `no area "barn"`},
		{stack.Layer{Target: "yard", Effect: "fire"}, `no effect "fire"`},
		{stack.Layer{Target: "yard", Preset: "nope"}, `no preset "nope"`},
		{stack.Layer{Target: "yard", Preset: "slow-crawl"}, `no effect "bands"`},
		{stack.Layer{Target: "yard", Effect: "solid", Params: map[string]any{"colour": "#fff"}}, `unknown parameter "colour"`},
		{stack.Layer{Target: "yard", Effect: "solid", Params: map[string]any{"mapping": "sideways"}}, `no mapping "sideways"`},
		{stack.Layer{Target: "yard", Effect: "solid", Params: map[string]any{"opacity": 3}}, "opacity"},
	} {
		if _, err := s.Push(tt.l); err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("push %+v: %v, want %q", tt.l, err, tt.want)
		}
	}
	if _, err := s.Push(stack.Layer{Target: "porch", Preset: "warm-white", Params: map[string]any{"opacity": 0.5}}); err != nil {
		t.Error(err)
	}
}

func TestResolveCachesAndKeepsState(t *testing.T) {
	e, s, c := setup(t)
	a, err := s.Push(stack.Layer{Target: "shed", Effect: "count"})
	if err != nil {
		t.Fatal(err)
	}
	s.Push(stack.Layer{Target: "porch", Preset: "warm-white", Params: map[string]any{"opacity": 0.5, "reverse": true}})

	ls := e.Resolve(s.Frame(c.Now(), nil), nil)
	if len(ls) != 2 || ls[0].ID != "2" || ls[1].ID != "1" {
		t.Fatalf("resolved %v", ls)
	}
	porch := ls[0]
	if porch.Common.Opacity != 0.5 || !porch.Common.Reverse || porch.Common.Mapping != "porch-local" || porch.Def.ID != "solid" {
		t.Errorf("porch layer %+v", porch.Common)
	}
	if n := len(porch.Geometry.Pixels); n != 90 {
		t.Errorf("porch has %d pixels", n)
	}
	if want := 1.0 / 30; porch.Pitch != want {
		t.Errorf("pitch %v", porch.Pitch)
	}
	inst := ls[1].Effect.(*counter)

	// Same layers next frame: the same render layers.
	again := e.Resolve(s.Frame(c.Now(), nil), nil)
	if again[0] != porch {
		t.Error("unchanged layer was rebuilt")
	}

	// An edit rebuilds the layer but keeps the effect instance.
	c.Advance(time.Second)
	s.Edit(a.ID, func(l *stack.Layer) { l.Params["opacity"] = 0.25 })
	ls = e.Resolve(s.Frame(c.Now(), nil), nil)
	if ls[1].Common.Opacity != 0.25 || ls[1].Effect.(*counter) != inst {
		t.Error("edit lost the effect instance or the change")
	}

	// Removed layers leave the cache.
	s.Remove("2")
	c.Advance(time.Hour)
	ls = e.Resolve(s.Frame(c.Now(), nil), nil)
	if len(ls) != 1 || len(e.cache) != 1 {
		t.Errorf("after removal: %d layers, %d cached", len(ls), len(e.cache))
	}
}
