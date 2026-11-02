// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package plan

import (
	"math"
	"sort"
)

// Path is a shape flattened to a polyline in plan units, all transforms
// applied. Paths from a scene model are 3-D, in meters. Callers must treat Points and Labels as read-only; Drawing
// returns the same *Path to every caller.
type Path struct {
	ID     string
	Points []Point  // polyline vertices in order
	Labels []string // len(Labels)==len(Points); node id at labeled vertices, "" elsewhere

	cum []float64 // lazily computed by Cumulative
}

// Dist is the straight-line distance between two points.
func Dist(a, b Point) float64 {
	return math.Sqrt((b.X-a.X)*(b.X-a.X) + (b.Y-a.Y)*(b.Y-a.Y) + (b.Z-a.Z)*(b.Z-a.Z))
}

// Length returns the total polyline length.
func (p *Path) Length() float64 {
	c := p.Cumulative()
	if len(c) == 0 {
		return 0
	}
	return c[len(c)-1]
}

// Cumulative returns the distance from the start of the polyline at each
// point (len == len(Points)). The slice is computed once and cached; the
// caller must not modify it.
func (p *Path) Cumulative() []float64 {
	if p.cum == nil && len(p.Points) > 0 {
		cum := make([]float64, len(p.Points))
		for i := 1; i < len(p.Points); i++ {
			a, b := p.Points[i-1], p.Points[i]
			cum[i] = cum[i-1] + Dist(a, b)
		}
		p.cum = cum
	}
	return p.cum
}

// At returns the point at distance dist along the polyline, clamping dist
// to [0, Length]. A Path with no points returns the zero Point.
func (p *Path) At(dist float64) Point {
	if len(p.Points) == 0 {
		return Point{}
	}
	cum := p.Cumulative()
	total := cum[len(cum)-1]
	if dist <= 0 {
		return p.Points[0]
	}
	if dist >= total {
		return p.Points[len(p.Points)-1]
	}
	i := sort.SearchFloat64s(cum, dist)
	if i == 0 {
		return p.Points[0]
	}
	if cum[i] == dist {
		return p.Points[i]
	}
	seg := cum[i] - cum[i-1]
	t := (dist - cum[i-1]) / seg
	a, b := p.Points[i-1], p.Points[i]
	return Point{X: a.X + t*(b.X-a.X), Y: a.Y + t*(b.Y-a.Y), Z: a.Z + t*(b.Z-a.Z)}
}

// Reversed returns a new Path with points and labels in reverse order. The
// ID is kept.
func (p *Path) Reversed() *Path {
	n := len(p.Points)
	pts := make([]Point, n)
	labels := make([]string, n)
	for i := 0; i < n; i++ {
		pts[i] = p.Points[n-1-i]
		labels[i] = p.Labels[n-1-i]
	}
	return &Path{ID: p.ID, Points: pts, Labels: labels}
}

// Vertex finds the vertex labeled label: its point index and distance
// along the path. ok is false if no vertex carries the label.
func (p *Path) Vertex(label string) (index int, dist float64, ok bool) {
	if label == "" {
		return 0, 0, false
	}
	for i, l := range p.Labels {
		if l == label {
			return i, p.Cumulative()[i], true
		}
	}
	return 0, 0, false
}
