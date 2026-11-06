// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"math"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/units"
)

// routeGrid is a 2 m × 1 m rectangle route at height 3 with a crossing
// strip through its middle, sticking out 1 m on each side.
func routeGrid() (*Layout, map[string]int) {
	l := &Layout{}
	at := map[string]int{}
	add := func(name string, x, y float32) {
		at[name] = len(l.Pixels)
		l.Pixels = append(l.Pixels, Pixel{X: x, Y: y, Z: 3, Run: -1, Edge: -1})
	}
	add("start", 0, 0)
	add("bottom-mid", 1, 0.05) // within snap
	add("right-mid", 2, 0.5)
	add("top-mid", 1, 1)
	add("spill-in", 1, -0.25)  // on the crossing strip, 0.25 m out
	add("spill-edge", 1, -0.6) // 0.6 m out: past snap + spread
	l.Pixels = append(l.Pixels, Pixel{Plan: -1, Run: -1, Edge: -1})
	return l, at
}

func routeMapping(lap float64) *config.Mapping {
	m := func(v float64) units.Length { return units.Length{Value: v} }
	pt := func(x, y float64) config.PointRef {
		return config.PointRef{X: m(x), Y: m(y), Z: m(3), HasZ: true}
	}
	closed := true
	snap, spread := m(0.1), m(0.4)
	cm := &config.Mapping{ID: "loop", Kind: config.KindRoute, Closed: &closed, Snap: &snap, Spread: &spread,
		Points: []config.PointRef{pt(0, 0), pt(2, 0), pt(2, 1), pt(0, 1)}}
	if lap > 0 {
		l := m(lap)
		cm.Lap = &l
	}
	return cm
}

func TestRouteMapping(t *testing.T) {
	l, at := routeGrid()
	mp, err := SolveSpatial(l, routeMapping(0))
	if err != nil {
		t.Fatal(err)
	}
	u := func(name string) float64 { return float64(mp.U[at[name]]) }
	gain := func(name string) float64 { return float64(mp.Gain[at[name]]) }
	for name, want := range map[string]float64{"start": 0, "bottom-mid": 1, "right-mid": 2.5, "top-mid": 4} {
		if !approx(u(name), want) || gain(name) != 1 {
			t.Errorf("%s: u %v gain %v, want u %v gain 1", name, u(name), gain(name), want)
		}
	}
	// Spill trails the crossing by its distance past snap, so a forward
	// pattern reaches it after the crossing, and it fades.
	if !approx(u("spill-in"), 1+0.15) || !(gain("spill-in") > 0 && gain("spill-in") < 1) {
		t.Errorf("spill-in: u %v gain %v", u("spill-in"), gain("spill-in"))
	}
	if !math.IsNaN(u("spill-edge")) || !math.IsNaN(float64(mp.U[len(l.Pixels)-1])) {
		t.Errorf("outside the route: %v, no position: %v", u("spill-edge"), mp.U[len(l.Pixels)-1])
	}

	// spill_speed slows the spread out along a crossing strip: at a
	// quarter speed the pattern takes four times as long to get there.
	quarter := routeMapping(0)
	ss := 0.25
	quarter.SpillSpeed = &ss
	if mq, err := SolveSpatial(l, quarter); err != nil {
		t.Fatal(err)
	} else if got := float64(mq.U[at["spill-in"]]); !approx(got, 1+0.15/ss) || !approx(float64(mq.Spill[at["spill-in"]]), 0.15) || mq.Spill[at["top-mid"]] != 0 {
		t.Errorf("spill_speed: u %v, spill %v / %v", got, mq.Spill[at["spill-in"]], mq.Spill[at["top-mid"]])
	}

	// lap scales u so one trip round is lap meters; stretch is the inverse.
	mp, err = SolveSpatial(l, routeMapping(3))
	if err != nil {
		t.Fatal(err)
	}
	if got := float64(mp.U[at["top-mid"]]); !approx(got, 4*3.0/6) {
		t.Errorf("lap: top-mid u %v", got)
	}
	if got := float64(mp.Stretch[at["top-mid"]]); !approx(got, 2) {
		t.Errorf("lap: stretch %v", got)
	}
}

func TestRouteValidation(t *testing.T) {
	m, err := config.ParseInlineMapping(map[string]any{"kind": "route", "points": []any{[]any{0, 0}, []any{1, 0}}})
	if err != nil {
		t.Fatal(err)
	}
	if !*m.Mapping.Closed || m.Mapping.Snap.Value != 0.15 || m.Mapping.Spread.Value != 0.5 || m.Mapping.Lap != nil {
		t.Errorf("defaults: %+v", m.Mapping)
	}
	for want, raw := range map[string]map[string]any{
		"want at least two points":         {"kind": "route", "points": []any{[]any{0, 0}}},
		"apply only to route mappings":     {"kind": "radial", "center": []any{0, 0}, "spread": "1 m"},
		"lap must be positive":             {"kind": "route", "points": []any{[]any{0, 0}, []any{1, 0}}, "lap": "0 m"},
		"spread must be in meters, not px": {"kind": "route", "points": []any{[]any{0, 0}, []any{1, 0}}, "spread": "3 px"},
		"spill_speed must be positive":     {"kind": "route", "points": []any{[]any{0, 0}, []any{1, 0}}, "spill_speed": 0},
	} {
		if _, err := config.ParseInlineMapping(raw); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%v: got %v, want %q", raw, err, want)
		}
	}
}
