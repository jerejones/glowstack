// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package plan

import "math"

const (
	// flattenTol is the target maximum deviation, in plan units, of the
	// flattened polyline from the true curve. Tighter than the documented
	// ~0.05 so chord-length error stays well under 0.1%.
	flattenTol = 0.01

	// maxFlattenDepth caps recursive Bézier subdivision at 2^depth
	// segments per curve.
	maxFlattenDepth = 10

	// maxArcSegments caps the number of line segments per arc command.
	maxArcSegments = 1024
)

func mid(a, b Point) Point {
	return Point{X: (a.X + b.X) / 2, Y: (a.Y + b.Y) / 2}
}

// segDist is the distance from p to the segment a-b.
func segDist(p, a, b Point) float64 {
	dx, dy := b.X-a.X, b.Y-a.Y
	l2 := dx*dx + dy*dy
	if l2 == 0 {
		return math.Hypot(p.X-a.X, p.Y-a.Y)
	}
	t := ((p.X-a.X)*dx + (p.Y-a.Y)*dy) / l2
	t = math.Max(0, math.Min(1, t))
	return math.Hypot(p.X-(a.X+t*dx), p.Y-(a.Y+t*dy))
}

// flattenCubic appends the interior points of the flattened cubic Bézier
// cur→c1→c2→end. The caller appends end itself (as a drawn vertex).
func flattenCubic(verts *[]vertex, p0, c1, c2, p3 Point, tol float64) {
	subCubic(verts, p0, c1, c2, p3, tol, maxFlattenDepth)
}

func subCubic(verts *[]vertex, p0, c1, c2, p3 Point, tol float64, depth int) {
	// The curve lies in the convex hull of its control points, so if both
	// controls are within tol of the chord, the chord is a valid segment.
	if depth <= 0 || (segDist(c1, p0, p3) <= tol && segDist(c2, p0, p3) <= tol) {
		return
	}
	p01, p12, p23 := mid(p0, c1), mid(c1, c2), mid(c2, p3)
	p012, p123 := mid(p01, p12), mid(p12, p23)
	m := mid(p012, p123)
	subCubic(verts, p0, p01, p012, m, tol, depth-1)
	*verts = append(*verts, vertex{p: m})
	subCubic(verts, m, p123, p23, p3, tol, depth-1)
}

// flattenQuad appends the interior points of the flattened quadratic Bézier
// p0→c→p2. The caller appends p2 itself.
func flattenQuad(verts *[]vertex, p0, c, p2 Point, tol float64) {
	subQuad(verts, p0, c, p2, tol, maxFlattenDepth)
}

func subQuad(verts *[]vertex, p0, c, p2 Point, tol float64, depth int) {
	if depth <= 0 || segDist(c, p0, p2) <= tol {
		return
	}
	q0, q1 := mid(p0, c), mid(c, p2)
	m := mid(q0, q1)
	subQuad(verts, p0, q0, m, tol, depth-1)
	*verts = append(*verts, vertex{p: m})
	subQuad(verts, m, q1, p2, tol, depth-1)
}

// vecAngle returns the signed angle from vector u to vector v (SVG F.6.5.4).
func vecAngle(ux, uy, vx, vy float64) float64 {
	dot := ux*vx + uy*vy
	den := math.Hypot(ux, uy) * math.Hypot(vx, vy)
	if den == 0 {
		return 0
	}
	cos := math.Max(-1, math.Min(1, dot/den))
	a := math.Acos(cos)
	if ux*vy-uy*vx < 0 {
		a = -a
	}
	return a
}

// flattenArc appends the interior points of the flattened elliptical arc
// from p0 to p1 (SVG endpoint parameterization, appendix F.6.5). The caller
// appends p1 itself. Per the SVG spec: identical endpoints omit the arc,
// a zero radius degenerates to a straight line, negative radii use their
// absolute values, and too-small radii are scaled up uniformly.
func flattenArc(verts *[]vertex, p0 Point, rx, ry, rotDeg float64, large, sweep bool, p1 Point, tol float64) {
	if p0 == p1 {
		return
	}
	rx, ry = math.Abs(rx), math.Abs(ry)
	if rx == 0 || ry == 0 {
		return // straight line: just the endpoint, no interior points
	}
	phi := rotDeg * math.Pi / 180
	sinPhi, cosPhi := math.Sincos(phi)

	// F.6.5.1: transform to the ellipse-aligned frame.
	dx, dy := (p0.X-p1.X)/2, (p0.Y-p1.Y)/2
	x1p := cosPhi*dx + sinPhi*dy
	y1p := -sinPhi*dx + cosPhi*dy

	// F.6.6.2–3: scale radii up if the endpoints are too far apart.
	lambda := x1p*x1p/(rx*rx) + y1p*y1p/(ry*ry)
	if lambda > 1 {
		s := math.Sqrt(lambda)
		rx *= s
		ry *= s
	}

	// F.6.5.2: center in the aligned frame.
	numer := rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p
	denom := rx*rx*y1p*y1p + ry*ry*x1p*x1p
	if numer < 0 {
		numer = 0 // numerical noise when lambda == 1
	}
	co := math.Sqrt(numer / denom)
	if large == sweep {
		co = -co
	}
	cxp := co * rx * y1p / ry
	cyp := -co * ry * x1p / rx

	// F.6.5.3: center in user space.
	cx := cosPhi*cxp - sinPhi*cyp + (p0.X+p1.X)/2
	cy := sinPhi*cxp + cosPhi*cyp + (p0.Y+p1.Y)/2

	// F.6.5.5–6: start angle and sweep.
	theta1 := vecAngle(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry)
	dTheta := vecAngle((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry)
	if !sweep && dTheta > 0 {
		dTheta -= 2 * math.Pi
	}
	if sweep && dTheta < 0 {
		dTheta += 2 * math.Pi
	}

	// Chord sagitta r*(1-cos(d/2)) <= tol gives the max angular step.
	rmax := math.Max(rx, ry)
	var dmax float64
	if tol >= rmax {
		dmax = math.Pi
	} else {
		dmax = 2 * math.Acos(1-tol/rmax)
	}
	if dmax < 1e-6 {
		dmax = 1e-6
	}
	n := int(math.Ceil(math.Abs(dTheta) / dmax))
	if n < 1 {
		n = 1
	}
	if n > maxArcSegments {
		n = maxArcSegments
	}
	for i := 1; i < n; i++ {
		th := theta1 + dTheta*float64(i)/float64(n)
		sinTh, cosTh := math.Sincos(th)
		*verts = append(*verts, vertex{p: Point{
			X: cx + rx*cosTh*cosPhi - ry*sinTh*sinPhi,
			Y: cy + rx*cosTh*sinPhi + ry*sinTh*cosPhi,
		}})
	}
}
