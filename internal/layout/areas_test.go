// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"slices"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/plan"
)

func node(id string) *config.NodeOrIndex          { return &config.NodeOrIndex{Node: id} }
func index(i int) *config.NodeOrIndex             { return &config.NodeOrIndex{Index: i, IsIndex: true} }
func areaOf(parts ...config.AreaPart) config.Area { return config.Area{ID: "x", Include: parts} }

// offsets lists an area's pixels as positions along run r.
func offsets(l *Layout, a *Area, run string) []int {
	ri, _ := l.RunIndex(run)
	r := &l.Runs[ri]
	var ks []int
	for _, p := range a.Pixels {
		ks = append(ks, r.Offset(int(l.Pixels[p].Index)))
	}
	slices.Sort(ks)
	return ks
}

func span(from, to int) []int {
	var ks []int
	for k := from; k <= to; k++ {
		ks = append(ks, k)
	}
	return ks
}

func TestAreaRangeEnds(t *testing.T) {
	// Run "r" has 20 pixels: a at 0, b at 5, c at 12, d at 19. The reversed
	// run "q" is wired from its far end, so its offsets count down in index.
	tests := []struct {
		name string
		part config.AreaPart
		want []int
	}{
		{"inclusive", config.AreaPart{Run: "r", From: node("b"), To: node("c")}, span(5, 12)},
		{"after", config.AreaPart{Run: "r", After: node("b"), To: node("c")}, span(6, 12)},
		{"before", config.AreaPart{Run: "r", From: node("b"), Before: node("c")}, span(5, 11)},
		{"both exclusive", config.AreaPart{Run: "r", After: node("b"), Before: node("c")}, span(6, 11)},
		{"after to the end", config.AreaPart{Run: "r", After: node("c")}, span(13, 19)},
		{"start before", config.AreaPart{Run: "r", Before: node("b")}, span(0, 4)},
		{"run end nodes", config.AreaPart{Run: "r", After: node("a"), Before: node("d")}, span(1, 18)},
		{"indices", config.AreaPart{Run: "r", After: index(2), Before: index(4)}, []int{3}},
		{"against the run", config.AreaPart{Run: "r", After: node("c"), Before: node("b")}, span(6, 11)},
		{"against the run, inclusive end", config.AreaPart{Run: "r", After: node("c"), To: node("b")}, span(5, 11)},
		{"one pixel", config.AreaPart{Run: "r", From: node("b"), To: node("b")}, []int{5}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := newGraph(t).run("r", 20, "a", "b@5", "c@12", "d")
			g.cfg.Areas = []config.Area{areaOf(tt.part)}
			l := g.build()
			a, _ := l.Area("x")
			if got := offsets(l, a, "r"); !slices.Equal(got, tt.want) {
				t.Errorf("offsets = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAreaRangeReversedRun(t *testing.T) {
	// Indices 19…0 in run direction: offset k is index 19-k.
	g := newGraph(t).run("-q", 20, "a", "b@5", "c@12", "d")
	g.cfg.Areas = []config.Area{areaOf(config.AreaPart{Run: "q", After: node("b"), Before: index(19 - 12)})}
	l := g.build()
	a, _ := l.Area("x")
	if got := offsets(l, a, "q"); !slices.Equal(got, span(6, 11)) {
		t.Errorf("offsets = %v", got)
	}
}

func TestAreasMeetAtANode(t *testing.T) {
	g := newGraph(t).run("r", 20, "a", "b@5", "c")
	g.cfg.Areas = []config.Area{
		{ID: "left", Include: []config.AreaPart{{Run: "r", To: node("b")}}},
		{ID: "right", Include: []config.AreaPart{{Run: "r", After: node("b")}}},
	}
	l := g.build()
	left, _ := l.Area("left")
	right, _ := l.Area("right")
	if len(left.Pixels)+len(right.Pixels) != 20 || slices.Contains(right.Pixels, left.Pixels[len(left.Pixels)-1]) {
		t.Errorf("left %v right %v", left.Pixels, right.Pixels)
	}
}

func TestAreaRangeEmpty(t *testing.T) {
	for _, part := range []config.AreaPart{
		{Run: "r", After: node("b"), Before: index(6)},
		{Run: "r", After: node("d")},
		{Run: "r", Before: node("a")},
	} {
		g := newGraph(t).run("r", 20, "a", "b@5", "c@12", "d")
		g.cfg.Areas = []config.Area{areaOf(part)}
		if err := g.cfg.Validate(); err != nil {
			t.Fatal(err)
		}
		_, err := BuildWith(g.cfg, func(string) (*plan.Drawing, error) { return nil, nil })
		if err == nil || !strings.Contains(err.Error(), "range on run r is empty") {
			t.Errorf("%+v: err = %v", part, err)
		}
	}
}
