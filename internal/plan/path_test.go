// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package plan

import (
	"math"
	"reflect"
	"testing"
)

func testPath() *Path {
	// An L-shaped run: 10 right, 10 down. Total length 20.
	return &Path{
		ID:     "ell",
		Points: []Point{{0, 0, 0}, {10, 0, 0}, {10, 10, 0}},
		Labels: []string{"start", "corner", "end"},
	}
}

func TestLengthAndCumulative(t *testing.T) {
	p := testPath()
	if got := p.Length(); !within(got, 20, 1e-12) {
		t.Errorf("Length = %g, want 20", got)
	}
	cum := p.Cumulative()
	if !reflect.DeepEqual(cum, []float64{0, 10, 20}) {
		t.Errorf("Cumulative = %v, want [0 10 20]", cum)
	}
	if len(cum) != len(p.Points) {
		t.Errorf("len(Cumulative) = %d, want %d", len(cum), len(p.Points))
	}
	// Cached: same backing slice on repeat calls.
	if &cum[0] != &p.Cumulative()[0] {
		t.Error("Cumulative is recomputed on every call")
	}

	empty := &Path{ID: "empty"}
	if got := empty.Length(); got != 0 {
		t.Errorf("empty Length = %g, want 0", got)
	}
	if got := empty.Cumulative(); len(got) != 0 {
		t.Errorf("empty Cumulative = %v, want empty", got)
	}
}

func TestAt(t *testing.T) {
	p := testPath()
	tests := []struct {
		dist float64
		want Point
	}{
		{-5, Point{0, 0, 0}},  // clamped low
		{0, Point{0, 0, 0}},   // start
		{5, Point{5, 0, 0}},   // mid first segment
		{10, Point{10, 0, 0}}, // exactly at the corner
		{15, Point{10, 5, 0}}, // mid second segment (overall midpoint is the corner at 10)
		{20, Point{10, 10, 0}},
		{100, Point{10, 10, 0}}, // clamped high
	}
	for _, tt := range tests {
		if got := p.At(tt.dist); !pointNear(got, tt.want, 1e-12) {
			t.Errorf("At(%g) = %v, want %v", tt.dist, got, tt.want)
		}
	}
	if got := p.At(p.Length() / 2); !pointNear(got, Point{10, 0, 0}, 1e-12) {
		t.Errorf("At(midpoint) = %v, want the corner (10,0)", got)
	}

	single := &Path{Points: []Point{{3, 4, 0}}, Labels: []string{""}}
	if got := single.At(7); got != (Point{3, 4, 0}) {
		t.Errorf("single-point At = %v, want (3,4)", got)
	}
	empty := &Path{}
	if got := empty.At(1); got != (Point{}) {
		t.Errorf("empty At = %v, want zero Point", got)
	}
}

func TestReversed(t *testing.T) {
	p := testPath()
	r := p.Reversed()
	if r == p {
		t.Fatal("Reversed must return a new Path")
	}
	checkPoints(t, r.Points, []Point{{10, 10, 0}, {10, 0, 0}, {0, 0, 0}})
	if !reflect.DeepEqual(r.Labels, []string{"end", "corner", "start"}) {
		t.Errorf("reversed Labels = %v", r.Labels)
	}
	if r.ID != p.ID {
		t.Errorf("reversed ID = %q, want %q", r.ID, p.ID)
	}
	if !within(r.Length(), p.Length(), 1e-12) {
		t.Errorf("reversed Length = %g, want %g", r.Length(), p.Length())
	}
	// A vertex at distance d sits at Length-d on the reverse.
	_, d, ok := p.Vertex("corner")
	_, rd, rok := r.Vertex("corner")
	if !ok || !rok || !within(rd, p.Length()-d, 1e-12) {
		t.Errorf("corner at %g reversed to %g, want %g", d, rd, p.Length()-d)
	}
	if got := r.At(0); !pointNear(got, Point{10, 10, 0}, 1e-12) {
		t.Errorf("reversed At(0) = %v, want old end", got)
	}
	// The original is untouched.
	checkPoints(t, p.Points, []Point{{0, 0, 0}, {10, 0, 0}, {10, 10, 0}})
}

func TestVertex(t *testing.T) {
	p := testPath()
	idx, dist, ok := p.Vertex("corner")
	if !ok || idx != 1 || !within(dist, 10, 1e-12) {
		t.Errorf("Vertex(corner) = (%d, %g, %v), want (1, 10, true)", idx, dist, ok)
	}
	idx, dist, ok = p.Vertex("end")
	if !ok || idx != 2 || !within(dist, 20, 1e-12) {
		t.Errorf("Vertex(end) = (%d, %g, %v), want (2, 20, true)", idx, dist, ok)
	}
	if _, _, ok := p.Vertex("nope"); ok {
		t.Error("Vertex(nope) found a match")
	}
	// The empty string never matches an unlabeled vertex.
	u := &Path{Points: []Point{{0, 0, 0}, {1, 0, 0}}, Labels: []string{"", ""}}
	if _, _, ok := u.Vertex(""); ok {
		t.Error(`Vertex("") matched an unlabeled vertex`)
	}
}

func TestEndToEndDistances(t *testing.T) {
	// A labeled run through a transform: distances are in plan units.
	d := parseSVG(t, `<svg viewBox="0 0 400 300">
		<g transform="scale(2)">
			<path id="porch" d="M0 0 H50 V30" data-nodes="porch-w,porch-e,porch-se"/>
		</g>
	</svg>`)
	p := mustPath(t, d, "porch")
	if got := p.Length(); !within(got, 160, 1e-9) {
		t.Errorf("Length = %g, want 160 (scaled by 2)", got)
	}
	idx, dist, ok := p.Vertex("porch-e")
	if !ok || idx != 1 || !within(dist, 100, 1e-9) {
		t.Errorf("Vertex(porch-e) = (%d, %g, %v), want (1, 100, true)", idx, dist, ok)
	}
	if got := p.At(130); !pointNear(got, Point{100, 30, 0}, 1e-9) {
		t.Errorf("At(130) = %v, want (100,30)", got)
	}
	if got := math.Abs(p.At(1e9).X - 100); got > 1e-9 {
		t.Errorf("clamped end X off by %g", got)
	}
}
