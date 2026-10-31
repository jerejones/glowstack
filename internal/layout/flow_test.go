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

// All graphs use pitch 0.1 m: a 10-pixel run is 1 m, and pixel k of a run
// sits at (k + 0.5) × 0.1 m along it.

func TestFlowBranchOutward(t *testing.T) {
	// o ── j ──┬── x      (x's run is wired from x back to j)
	//          └──── y
	l, m := newGraph(t).
		run("a", 10, "o", "j").
		run("b", 10, "x", "j").
		run("c", 20, "j", "y").
		mustFlow(config.Flow{ID: "f", Origin: "o"})
	checkNodes(t, l, m, map[string]float64{"o": 0, "j": 1, "x": 2, "y": 3})
	checkPix(t, l, m, "a", 0, 0.05, 1)
	checkPix(t, l, m, "a", 9, 0.95, 1)
	// Run b starts at x, so its pixel 0 is the farthest from the origin.
	checkPix(t, l, m, "b", 0, 1.95, 1)
	checkPix(t, l, m, "b", 9, 1.05, 1)
	checkPix(t, l, m, "c", 19, 2.95, 1)
}

func TestFlowReversedIndices(t *testing.T) {
	// The same run wired either way gives the same u per position.
	for _, id := range []string{"a", "-a"} {
		l, m := newGraph(t).run(id, 10, "o", "x").mustFlow(config.Flow{ID: "f", Origin: "o"})
		checkPix(t, l, m, "a", 0, 0.05, 1)
		checkPix(t, l, m, "a", 9, 0.95, 1)
	}
}

func TestFlowIntoSyncPoint(t *testing.T) {
	// o ── m  (m = top, linked)    l ──► top ◄── r
	g := func() *graph {
		return newGraph(t).
			run("main", 10, "o", "m").
			run("left", 10, "l", "top").
			run("right", 20, "r", "top").
			link("top", "m")
	}
	// Default: u flows away from the sync point down both sides.
	l, m := g().mustFlow(config.Flow{ID: "f", Origin: "o"})
	checkNodes(t, l, m, map[string]float64{"m": 1, "top": 1, "l": 2, "r": 3})
	// Oriented into top: both sides count up towards it and arrive together.
	l, m = g().mustFlow(config.Flow{ID: "f", Origin: "o", Orient: []config.Orient{
		{Edge: [2]string{"l", "top"}, Into: "top"},
		{Edge: [2]string{"top", "r"}, Into: "top"},
	}})
	checkNodes(t, l, m, map[string]float64{"top": 1, "l": 0, "r": -1})
	checkPix(t, l, m, "left", 0, 0.05, 1)
	checkPix(t, l, m, "left", 9, 0.95, 1)
	checkPix(t, l, m, "right", 0, -0.95, 1)
	checkPix(t, l, m, "right", 19, 0.95, 1)
}

func TestFlowIntoNodeReachedFirst(t *testing.T) {
	// An orient override holds whichever end is reached first: here the
	// far end x is settled first, and u still increases towards it.
	l, m := newGraph(t).
		run("a", 10, "o", "j").
		run("b", 10, "j", "x").
		mustFlow(config.Flow{ID: "f", Origin: "o", Orient: []config.Orient{{Edge: [2]string{"j", "o"}, Into: "o"}}})
	checkNodes(t, l, m, map[string]float64{"o": 0, "j": -1, "x": 0})
	checkPix(t, l, m, "a", 0, -0.05, 1)
}

func TestFlowGap(t *testing.T) {
	l, m := newGraph(t).
		run("a", 10, "o", "g1").
		gap("g1", "g2", 1.5).
		run("b", 10, "g2", "e").
		mustFlow(config.Flow{ID: "f", Origin: "o"})
	checkNodes(t, l, m, map[string]float64{"g1": 1, "g2": 2.5, "e": 3.5})
	checkPix(t, l, m, "b", 0, 2.55, 1)
	for ei, e := range l.Edges {
		if e.Kind == Gap && !approx(m.Flow.EdgeStretch[ei], 1) {
			t.Errorf("gap stretch = %v", m.Flow.EdgeStretch[ei])
		}
	}
}

func TestFlowLinkBetweenDisconnectedParts(t *testing.T) {
	g := func() *graph {
		return newGraph(t).
			run("eave", 20, "o", "mid@9", "end").
			run("tower", 10, "t1", "t2")
	}
	l, m := g().link("t1", "mid").mustFlow(config.Flow{ID: "f", Origin: "o"})
	checkNodes(t, l, m, map[string]float64{"mid": 0.95, "t1": 0.95, "t2": 1.95, "end": 2})
	checkPix(t, l, m, "tower", 0, 1.0, 1)
	if len(m.Flow.Unreached) != 0 {
		t.Errorf("unreached = %v", m.Flow.Unreached)
	}
	// Without the link the tower is unreached.
	l, m = g().mustFlow(config.Flow{ID: "f", Origin: "o", Unreached: config.UnreachedDark})
	if len(m.Flow.Unreached) != 1 || !math.IsNaN(pixU(l, m, "tower", 0)) {
		t.Errorf("unreached = %v, u = %v", m.Flow.Unreached, pixU(l, m, "tower", 0))
	}
}

func TestFlowParallelPace(t *testing.T) {
	// Lower (1 m) and upper (1.5 m) eaves linked at both ends.
	g := func() *graph {
		return newGraph(t).
			run("lower", 10, "p", "q").
			run("upper", 15, "p2", "q2").
			link("p", "p2").link("q", "q2")
	}
	tests := []struct {
		pace         string
		ref          string
		du           float64
		lower, upper float64 // stretch
	}{
		{config.PaceReference, "lower", 1, 1, 1.5},
		{config.PaceReference, "upper", 1.5, 2.0 / 3, 1},
		{config.PaceReference, "", 1.25, 0.8, 1.2}, // no reference: average
		{config.PaceLongest, "", 1.5, 2.0 / 3, 1},
		{config.PaceShortest, "", 1, 1, 1.5},
		{config.PaceAverage, "", 1.25, 0.8, 1.2},
	}
	for _, tt := range tests {
		t.Run(tt.pace+"/"+tt.ref, func(t *testing.T) {
			f := config.Flow{ID: "f", Origin: "p", Pace: tt.pace}
			if tt.ref != "" {
				f.Reference = []config.EdgeRef{{Run: tt.ref}}
			}
			l, m := g().mustFlow(f)
			checkNodes(t, l, m, map[string]float64{"p2": 0, "q": tt.du, "q2": tt.du})
			// Pixel centres at 0.05 m on each run: u = 0.05 / stretch.
			checkPix(t, l, m, "lower", 0, 0.05/tt.lower, tt.lower)
			checkPix(t, l, m, "upper", 0, 0.05/tt.upper, tt.upper)
			// Upper's middle pixel (7, at 0.75 of 1.5 m) is halfway in u.
			checkPix(t, l, m, "upper", 7, tt.du/2, tt.upper)
		})
	}
}

func TestFlowReferencePathWins(t *testing.T) {
	// o ─eave1(1 m)─ a ─eave2(1 m)─ b, plus a 0.5 m shortcut o─b. a and b
	// are sync points; otherwise b would be inside the chain a─b─o and the
	// two routes o…a would simply be parallel paths.
	g := func() *graph {
		return newGraph(t).
			run("eave1", 10, "o", "a").
			run("eave2", 10, "a", "b").
			run("fence", 5, "o", "b").
			sync("a", "b")
	}
	// The reference path sets u(b) = 2; the shortcut stretches to match.
	l, m := g().mustFlow(config.Flow{ID: "f", Origin: "o", Reference: []config.EdgeRef{{Run: "eave1"}, {Run: "eave2"}}})
	checkNodes(t, l, m, map[string]float64{"a": 1, "b": 2})
	checkPix(t, l, m, "fence", 0, 0.05*4, 0.25)
	// Without a reference the shortcut wins and eave2 is the loop.
	l, m = g().mustFlow(config.Flow{ID: "f", Origin: "o", Pace: config.PaceAverage})
	checkNodes(t, l, m, map[string]float64{"a": 1, "b": 0.5})
	checkPix(t, l, m, "eave2", 0, 1-0.05*0.5, 2)
}

func TestFlowLoops(t *testing.T) {
	// Triangle o─a (1 m), a─b (1 m), b─o (1.5 m); a and b are sync points.
	// Pass 1 settles a at 1 and b at 1.5, so a─b closes the loop.
	g := func() *graph {
		return newGraph(t).
			run("oa", 10, "o", "a").
			run("ab", 10, "a", "b").
			run("bo", 15, "b", "o").
			sync("a", "b")
	}
	t.Run("stretch", func(t *testing.T) {
		l, m := g().mustFlow(config.Flow{ID: "f", Origin: "o", Loops: config.LoopsStretch})
		checkNodes(t, l, m, map[string]float64{"a": 1, "b": 1.5})
		checkPix(t, l, m, "ab", 0, 1.025, 2)
		checkPix(t, l, m, "ab", 9, 1.475, 2)
		checkPix(t, l, m, "bo", 0, 1.45, 1)
	})
	t.Run("meet", func(t *testing.T) {
		l, m := g().mustFlow(config.Flow{ID: "f", Origin: "o", Loops: config.LoopsMeet})
		// From a: 1 + d. From b: 1.5 + (1 - d). They meet at d = 0.75, u = 1.75.
		checkPix(t, l, m, "ab", 4, 1.45, 1)
		checkPix(t, l, m, "ab", 7, 1.75, 1)
		checkPix(t, l, m, "ab", 9, 1.55, 1)
		e := l.Runs[1].Edges[0]
		if m.Flow.EdgeMode[e] != "meet" {
			t.Errorf("mode = %q", m.Flow.EdgeMode[e])
		}
	})
	t.Run("error", func(t *testing.T) {
		_, _, _, err := g().flow(config.Flow{ID: "f", Origin: "o", Loops: config.LoopsError})
		errContains(t, err, "loop: ab a–b is reached from both ends")
	})
}

func TestFlowRing(t *testing.T) {
	// One run round a building back to its start: the ring meets opposite
	// the origin under every policy except error.
	g := func() *graph { return newGraph(t).run("ring", 20, "o", "m@9", "o") }
	for _, loops := range []string{config.LoopsStretch, config.LoopsMeet} {
		l, m, warn, err := g().flow(config.Flow{ID: "f", Origin: "o", Loops: loops})
		if err != nil {
			t.Fatal(err)
		}
		if (loops == config.LoopsStretch) != (len(warn) == 1) {
			t.Errorf("%s: warnings = %v", loops, warn)
		}
		checkPix(t, l, m, "ring", 4, 0.45, 1)
		checkPix(t, l, m, "ring", 9, 0.95, 1)
		checkPix(t, l, m, "ring", 15, 0.45, 1)
	}
	_, _, _, err := g().flow(config.Flow{ID: "f", Origin: "o", Loops: config.LoopsError})
	errContains(t, err, "loop:")
}

func TestFlowUnreached(t *testing.T) {
	g := func() *graph { return newGraph(t).run("a", 10, "o", "x").run("island", 10, "p", "q") }
	l, m := g().mustFlow(config.Flow{ID: "f", Origin: "o", Unreached: config.UnreachedLocal})
	checkPix(t, l, m, "island", 3, 0.35, 1)
	if strings.Join(m.Flow.Unreached, ",") != "island" {
		t.Errorf("unreached = %v", m.Flow.Unreached)
	}
	l, m = g().mustFlow(config.Flow{ID: "f", Origin: "o", Unreached: config.UnreachedDark})
	if u := pixU(l, m, "island", 3); !math.IsNaN(u) {
		t.Errorf("dark u = %v", u)
	}
	checkPix(t, l, m, "a", 3, 0.35, 1)
	_, _, _, err := g().flow(config.Flow{ID: "f", Origin: "o", Unreached: config.UnreachedError})
	errContains(t, err, "runs [island] have no path from origin o")
}

func TestFlowPins(t *testing.T) {
	g := func() *graph { return newGraph(t).run("oa", 10, "o", "a").run("ab", 20, "a", "b") }
	// A pin in the middle: o─a stretched to fit, a─b carries on from it.
	l, m := g().mustFlow(config.Flow{ID: "f", Origin: "o", Pin: []config.Pin{{Node: "a", U: units.Length{Value: 5}}}})
	checkNodes(t, l, m, map[string]float64{"o": 0, "a": 5, "b": 7})
	checkPix(t, l, m, "oa", 0, 0.25, 0.2)
	checkPix(t, l, m, "ab", 0, 5.05, 1)
	// A second start: b pinned at 0 as well, a a sync point. a is settled
	// from o (nearer), and a─b runs between two pins, so it's interpolated
	// from 1 down to 0.
	l, m = g().sync("a").mustFlow(config.Flow{ID: "f", Origin: "o", Pin: []config.Pin{{Node: "b", U: units.Length{}}}})
	checkNodes(t, l, m, map[string]float64{"a": 1, "b": 0})
	checkPix(t, l, m, "ab", 0, 1-0.05/2, 2)
}

func TestFlowMaxStretch(t *testing.T) {
	g := func() *graph {
		return newGraph(t).run("lower", 10, "p", "q").run("upper", 16, "p2", "q2").link("p", "p2").link("q", "q2")
	}
	f := config.Flow{ID: "f", Origin: "p", Reference: []config.EdgeRef{{Run: "lower"}}, MaxStretch: 1.5}
	_, _, warn, err := g().flow(f)
	if err != nil || len(warn) != 1 || !strings.Contains(warn[0].Msg, "stretch 1.60 on upper p2–q2 exceeds max_stretch 1.50") {
		t.Errorf("warn = %v, err = %v", warn, err)
	}
	// Compression counts too: 1.0 against a 1.6 m reference is 0.625 < 1/1.5.
	f.Reference = []config.EdgeRef{{Run: "upper"}}
	f.Strict = true
	_, _, _, err = g().flow(f)
	errContains(t, err, "stretch 0.62 on lower p–q exceeds max_stretch")
	f.MaxStretch = 2
	if _, _, warn, err = g().flow(f); err != nil || len(warn) != 0 {
		t.Errorf("within limit: warn = %v, err = %v", warn, err)
	}
}

func TestFlowSmoothWarp(t *testing.T) {
	// One 3 m run with pinned sync points: o=0, a (0.95 m) = 1, b (1.95 m)
	// = 3, then free to the end. Linear stretch steps 0.95 → 0.5 → 1.
	g := func() *graph { return newGraph(t).run("r", 30, "o", "a@9", "b@19", "e") }
	pins := []config.Pin{{Node: "a", U: units.Length{Value: 1}}, {Node: "b", U: units.Length{Value: 3}}}
	l, lin := g().mustFlow(config.Flow{ID: "f", Origin: "o", Pin: pins})
	checkPix(t, l, lin, "r", 8, 0.85/0.95, 0.95)
	checkPix(t, l, lin, "r", 10, 1.2, 0.5)
	l, sm := g().mustFlow(config.Flow{ID: "f", Origin: "o", Pin: pins, Warp: config.WarpSmooth})
	// Sync points hold exactly: pixels 9 and 19 sit on a and b.
	for k, want := range map[int]float64{9: 1, 19: 3} {
		if got := pixU(l, sm, "r", k); !approx(got, want) {
			t.Errorf("smooth u[%d] = %v, want %v", k, got, want)
		}
	}
	// Monotone, and stretch changes gradually across a.
	prev := math.Inf(-1)
	for k := range 30 {
		u := pixU(l, sm, "r", k)
		if u <= prev {
			t.Errorf("not monotone at %d: %v after %v", k, u, prev)
		}
		prev = u
	}
	jumpLin := math.Abs(pixStretch(l, lin, "r", 10) - pixStretch(l, lin, "r", 8))
	jumpSm := math.Abs(pixStretch(l, sm, "r", 10) - pixStretch(l, sm, "r", 8))
	if jumpSm > jumpLin*0.6 {
		t.Errorf("stretch jump across a: smooth %.3f, linear %.3f", jumpSm, jumpLin)
	}
}

func TestFlowParallelThroughDegreeTwoNode(t *testing.T) {
	// Without sync at b, the two routes between o and a are parallel paths
	// (eave1, and eave2+fence) and pace reconciles them.
	l, m := newGraph(t).
		run("eave1", 10, "o", "a").
		run("eave2", 10, "a", "b").
		run("fence", 5, "o", "b").
		sync("a").
		mustFlow(config.Flow{ID: "f", Origin: "o", Reference: []config.EdgeRef{{Run: "eave1"}}})
	checkNodes(t, l, m, map[string]float64{"a": 1, "b": 1.0 / 3})
	checkPix(t, l, m, "fence", 0, 0.05/1.5, 1.5)
	checkPix(t, l, m, "eave2", 0, 1-0.05/1.5, 1.5)
}

func TestFlowErrors(t *testing.T) {
	g := func() *graph { return newGraph(t).run("a", 10, "o", "x") }
	tests := []struct {
		f    config.Flow
		want string
	}{
		{config.Flow{ID: "f", Origin: "nope"}, `unknown origin node "nope"`},
		{config.Flow{ID: "f", Origin: "o", Orient: []config.Orient{{Edge: [2]string{"o", "q"}, Into: "q"}}}, `unknown node "q"`},
		{config.Flow{ID: "f", Origin: "o", Reference: []config.EdgeRef{{Run: "zz"}}}, `unknown run "zz"`},
		{config.Flow{ID: "f", Origin: "o", Pin: []config.Pin{{Node: "zz"}}}, `unknown node "zz"`},
	}
	for _, tt := range tests {
		_, _, _, err := g().flow(tt.f)
		errContains(t, err, tt.want)
	}
}
