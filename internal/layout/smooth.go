// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import "math"

// smooth applies `warp: smooth` along each run: a monotone cubic Hermite
// spline through (distance along run, u) at the run's ends and at every
// break point on it. Intervals in a meet or unreached chain stay linear.
// At a knot where u turns around, or next to such an interval, each side
// keeps its own linear slope, so the curve never overshoots.
func (s *flowSolver) smooth(m *Mapping) {
	l, info := s.l, m.Flow
	s.smoothStretch = map[int][2]float64{}
	for ri := range l.Runs {
		r := &l.Runs[ri]
		var knotAnchor []int
		for j, a := range r.Anchors {
			if j == 0 || j == len(r.Anchors)-1 || s.bp[s.group[a.Node]] {
				knotAnchor = append(knotAnchor, j)
			}
		}
		n := len(knotAnchor)
		if n < 3 {
			continue // a single interval: already linear, nothing to blend
		}
		ks := make([]float64, n)
		ku := make([]float64, n)
		for i, j := range knotAnchor {
			ks[i], ku[i] = r.Anchors[j].Dist, info.NodeU[r.Anchors[j].Node]
		}
		// Interval i spans edges knotAnchor[i] … knotAnchor[i+1]-1.
		ok := make([]bool, n-1)
		slope := make([]float64, n-1)
		for i := range n - 1 {
			ok[i] = !math.IsNaN(ku[i]) && !math.IsNaN(ku[i+1]) && ks[i+1] > ks[i]
			for j := knotAnchor[i]; j < knotAnchor[i+1]; j++ {
				if info.EdgeMode[r.Edges[j]] != "flow" {
					ok[i] = false
				}
			}
			if ok[i] {
				slope[i] = (ku[i+1] - ku[i]) / (ks[i+1] - ks[i])
			}
		}
		// Derivatives at each knot: dLeft ends interval i-1, dRight starts i.
		dLeft, dRight := make([]float64, n), make([]float64, n)
		for i := range n {
			if i > 0 {
				dLeft[i] = slope[i-1]
			}
			if i < n-1 {
				dRight[i] = slope[i]
			}
			if i == 0 || i == n-1 || !ok[i-1] || !ok[i] || slope[i-1]*slope[i] <= 0 {
				continue
			}
			h0, h1 := ks[i]-ks[i-1], ks[i+1]-ks[i]
			w1, w2 := 2*h1+h0, h1+2*h0
			d := (w1 + w2) / (w1/slope[i-1] + w2/slope[i])
			dLeft[i], dRight[i] = d, d
		}
		for i := range n - 1 {
			if !ok[i] {
				continue
			}
			h, u0, u1, d0, d1 := ks[i+1]-ks[i], ku[i], ku[i+1], dRight[i], dLeft[i+1]
			for j := knotAnchor[i]; j < knotAnchor[i+1]; j++ {
				t0 := (r.Anchors[j].Dist - ks[i]) / h
				t1 := (r.Anchors[j+1].Dist - ks[i]) / h
				s.smoothStretch[r.Edges[j]] = splineStretchBounds(u0, u1, h, d0, d1, t0, t1)
				for _, g := range l.Edges[r.Edges[j]].Pixels {
					t := (float64(l.Pixels[g].RunDist) - ks[i]) / h
					t2, t3 := t*t, t*t*t
					u := (2*t3-3*t2+1)*u0 + (t3-2*t2+t)*h*d0 + (-2*t3+3*t2)*u1 + (t3-t2)*h*d1
					du := ((6*t2-6*t)*u0+(-6*t2+6*t)*u1)/h + (3*t2-4*t+1)*d0 + (3*t2-2*t)*d1
					m.U[g] = float32(u)
					m.Stretch[g] = float32(math.Min(1/math.Abs(du), 1e6))
				}
			}
		}
	}
}

// splineStretchBounds gives exact dl/du extrema on a Hermite interval's
// subspan. Its derivative is quadratic, so only endpoints and its vertex
// can attain extrema; a zero derivative means infinite stretch.
func splineStretchBounds(u0, u1, h, d0, d1, t0, t1 float64) [2]float64 {
	a := 6*(u0-u1)/h + 3*(d0+d1)
	b := -6*(u0-u1)/h - 4*d0 - 2*d1
	du := func(t float64) float64 { return (a*t+b)*t + d0 }
	lo, hi := math.Min(du(t0), du(t1)), math.Max(du(t0), du(t1))
	if a != 0 {
		t := -b / (2 * a)
		if t > t0 && t < t1 {
			lo, hi = math.Min(lo, du(t)), math.Max(hi, du(t))
		}
	}
	minAbs, maxAbs := math.Min(math.Abs(lo), math.Abs(hi)), math.Max(math.Abs(lo), math.Abs(hi))
	if lo <= 0 && hi >= 0 {
		minAbs = 0
	}
	return [2]float64{1 / maxAbs, 1 / minAbs}
}
