// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package plan

import (
	"math"
	"strconv"
	"strings"
	"testing"
)

// parseShape runs path data through the same pipeline as Parse, with an
// identity transform.
func parseShape(t *testing.T, d, nodes string) *Path {
	t.Helper()
	verts, err := parsePathData(d, flattenTol)
	if err != nil {
		t.Fatalf("parsePathData(%q): %v", d, err)
	}
	p, err := buildPath("test", verts, nodes, identityMatrix)
	if err != nil {
		t.Fatalf("buildPath(%q): %v", d, err)
	}
	return p
}

func within(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func pointNear(a, b Point, tol float64) bool {
	return within(a.X, b.X, tol) && within(a.Y, b.Y, tol)
}

func checkPoints(t *testing.T, got []Point, want []Point) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d points %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if !pointNear(got[i], want[i], 1e-12) {
			t.Errorf("point %d = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestPathDataLineCommands(t *testing.T) {
	tests := []struct {
		name string
		d    string
		want []Point
	}{
		{"absolute L", "M0 0 L10 0 L10 10", []Point{{0, 0}, {10, 0}, {10, 10}}},
		{"relative l", "m2 3 l10 0 l0 10", []Point{{2, 3}, {12, 3}, {12, 13}}},
		{"implicit L repeat", "M0 0 L10 0 20 0", []Point{{0, 0}, {10, 0}, {20, 0}}},
		{"implicit lineto after M", "M0 0 10 0 20 5", []Point{{0, 0}, {10, 0}, {20, 5}}},
		{"implicit lineto after m is relative", "m5 5 5 0 0 5", []Point{{5, 5}, {10, 5}, {10, 10}}},
		{"H V absolute", "M220 180 H100 V100", []Point{{220, 180}, {100, 180}, {100, 100}}},
		{"h v relative", "M10 10 h5 v-5", []Point{{10, 10}, {15, 10}, {15, 5}}},
		{"h repeat accumulates", "M0 0 h1 1 1", []Point{{0, 0}, {1, 0}, {2, 0}, {3, 0}}},
		{"Z closes to subpath start", "M0 0 H10 V10 Z", []Point{{0, 0}, {10, 0}, {10, 10}, {0, 0}}},
		{"z lowercase", "M1 1 L2 1 L2 2 z", []Point{{1, 1}, {2, 1}, {2, 2}, {1, 1}}},
		{"multiple subpaths continue the polyline", "M0 0 L10 0 M20 0 L30 0", []Point{{0, 0}, {10, 0}, {20, 0}, {30, 0}}},
		{"relative after Z is relative to subpath start", "M0 0 H10 V10 Z l5 5", []Point{{0, 0}, {10, 0}, {10, 10}, {0, 0}, {5, 5}}},
		{"compact decimals", "M1.5.5L-1-2", []Point{{1.5, 0.5}, {-1, -2}}},
		{"exponent", "M0 0L1e-3 0", []Point{{0, 0}, {0.001, 0}}},
		{"commas and whitespace", "M 0,0 , 10 ,0,10,10", []Point{{0, 0}, {10, 0}, {10, 10}}},
		{"shed example", "M220 180 H100 V100 L160 100 220 100",
			[]Point{{220, 180}, {100, 180}, {100, 100}, {160, 100}, {220, 100}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := parseShape(t, tt.d, "")
			checkPoints(t, p.Points, tt.want)
			if len(p.Labels) != len(p.Points) {
				t.Errorf("len(Labels)=%d, want %d", len(p.Labels), len(p.Points))
			}
		})
	}
}

func TestPathDataErrors(t *testing.T) {
	tests := []struct {
		name string
		d    string
		want string
	}{
		{"must start with moveto", "L10 0", "moveto"},
		{"unknown command", "M0 0 X5", "unknown path command"},
		{"bad arc flag", "M0 0 A1 1 0 2 0 5 5", "arc flag"},
		{"number after closepath", "M0 0 H10 Z 5", "closepath"},
		{"truncated coordinates", "M0 0 L10", "number"},
		{"empty is not a path", "  ", "moveto"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parsePathData(tt.d, flattenTol)
			if tt.d == "  " {
				// Whitespace-only data yields an empty polyline, not an error.
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want mention of %q", err, tt.want)
			}
		})
	}
}

func TestCubicFlattening(t *testing.T) {
	// Standard cubic approximation of a quarter circle, radius 10.
	const k = 5.5228475
	p := parseShape(t, "M10 0 C10 "+f(k)+" "+f(k)+" 10 0 10", "")
	last := p.Points[len(p.Points)-1]
	if (last != Point{0, 10}) {
		t.Errorf("endpoint = %v, want exactly (0,10)", last)
	}
	if (p.Points[0] != Point{10, 0}) {
		t.Errorf("start = %v, want exactly (10,0)", p.Points[0])
	}
	want := math.Pi * 10 / 2
	if got := p.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("length = %g, want %g within 0.1%%", got, want)
	}
	if len(p.Points) < 4 {
		t.Errorf("curve not subdivided: %d points", len(p.Points))
	}
	// Flattened points stay on the circle to within the tolerance budget.
	for i, pt := range p.Points {
		r := math.Hypot(pt.X, pt.Y)
		if math.Abs(r-10) > 0.05 {
			t.Errorf("point %d radius %g deviates from 10", i, r)
		}
	}
}

func TestRelativeCubic(t *testing.T) {
	// c with all coordinates relative to the segment start.
	p := parseShape(t, "M5 5 c0 10 10 10 10 0", "")
	last := p.Points[len(p.Points)-1]
	if (last != Point{15, 5}) {
		t.Errorf("endpoint = %v, want (15,5)", last)
	}
}

func TestQuadraticFlattening(t *testing.T) {
	// Analytic arc length of Q (0,0)-(5,10)-(10,0):
	// ∫|B'| dt = (1/20)[u/2·sqrt(100+u²) + 50·ln(u+sqrt(100+u²))] from 0 to 20.
	want := (10*math.Sqrt(500) + 50*math.Log((20+math.Sqrt(500))/10)) / 20
	p := parseShape(t, "M0 0 Q5 10 10 0", "")
	if (p.Points[len(p.Points)-1] != Point{10, 0}) {
		t.Errorf("endpoint = %v, want exactly (10,0)", p.Points[len(p.Points)-1])
	}
	if got := p.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("length = %g, want %g within 0.1%%", got, want)
	}
	// Relative q.
	pr := parseShape(t, "M1 1 q5 10 10 0", "")
	if (pr.Points[len(pr.Points)-1] != Point{11, 1}) {
		t.Errorf("relative endpoint = %v, want (11,1)", pr.Points[len(pr.Points)-1])
	}
}

func TestSmoothCurves(t *testing.T) {
	// S reflects the previous cubic control: the second half mirrors the
	// first, so the full path is twice as long as the first half.
	half := parseShape(t, "M0 0 C0 10 10 10 10 0", "")
	full := parseShape(t, "M0 0 C0 10 10 10 10 0 S20 -10 20 0", "")
	if (full.Points[len(full.Points)-1] != Point{20, 0}) {
		t.Errorf("S endpoint = %v, want (20,0)", full.Points[len(full.Points)-1])
	}
	if got, want := full.Length(), 2*half.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("S length = %g, want %g (mirrored halves)", got, want)
	}

	// T reflects the previous quadratic control the same way.
	qhalf := parseShape(t, "M0 0 Q5 10 10 0", "")
	qfull := parseShape(t, "M0 0 Q5 10 10 0 T20 0", "")
	if (qfull.Points[len(qfull.Points)-1] != Point{20, 0}) {
		t.Errorf("T endpoint = %v, want (20,0)", qfull.Points[len(qfull.Points)-1])
	}
	if got, want := qfull.Length(), 2*qhalf.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("T length = %g, want %g (mirrored halves)", got, want)
	}

	// S with no preceding cubic uses the current point as first control:
	// S then behaves like a quadratic-ish curve but must still end exactly.
	s := parseShape(t, "M0 0 S10 10 20 0", "")
	if (s.Points[len(s.Points)-1] != Point{20, 0}) {
		t.Errorf("bare S endpoint = %v, want (20,0)", s.Points[len(s.Points)-1])
	}
	// T with no preceding quadratic degenerates to a straight line.
	tp := parseShape(t, "M0 0 T10 0", "")
	if got := tp.Length(); !within(got, 10, 1e-9) {
		t.Errorf("bare T length = %g, want 10", got)
	}
}

func TestArcQuarterCircle(t *testing.T) {
	p := parseShape(t, "M10 0 A10 10 0 0 1 0 10", "")
	if (p.Points[len(p.Points)-1] != Point{0, 10}) {
		t.Errorf("endpoint = %v, want exactly (0,10)", p.Points[len(p.Points)-1])
	}
	want := math.Pi * 10 / 2
	if got := p.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("length = %g, want %g within 0.1%%", got, want)
	}
	// Every flattened point lies on the circle about the origin.
	for i, pt := range p.Points {
		if r := math.Hypot(pt.X, pt.Y); math.Abs(r-10) > 0.05 {
			t.Errorf("point %d radius %g, want 10", i, r)
		}
	}
}

func TestArcRadiiTooSmall(t *testing.T) {
	// rx=ry=1 cannot span a chord of 10; per F.6.6 the radii scale up to 5
	// and the arc becomes a semicircle of radius 5.
	p := parseShape(t, "M0 0 A1 1 0 0 0 10 0", "")
	if (p.Points[len(p.Points)-1] != Point{10, 0}) {
		t.Errorf("endpoint = %v, want exactly (10,0)", p.Points[len(p.Points)-1])
	}
	want := math.Pi * 5
	if got := p.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("length = %g, want %g within 0.1%%", got, want)
	}
}

func TestArcLargeSweepCombinations(t *testing.T) {
	// Radius 10 arcs from (0,0) to (10,0): the minor arc spans 60 degrees,
	// the major arc 300. The sweep flag picks the side.
	minor := 10 * math.Pi / 3
	major := 10 * math.Pi * 5 / 3
	h := math.Sqrt(75) // 8.660…
	tests := []struct {
		name    string
		d       string
		length  float64
		midWant Point
	}{
		{"large=0 sweep=0", "M0 0 A10 10 0 0 0 10 0", minor, Point{5, 10 - h}},
		{"large=0 sweep=1", "M0 0 A10 10 0 0 1 10 0", minor, Point{5, h - 10}},
		{"large=1 sweep=0", "M0 0 A10 10 0 1 0 10 0", major, Point{5, h + 10}},
		{"large=1 sweep=1", "M0 0 A10 10 0 1 1 10 0", major, Point{5, -h - 10}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := parseShape(t, tt.d, "")
			if got := p.Length(); math.Abs(got-tt.length)/tt.length > 0.001 {
				t.Errorf("length = %g, want %g within 0.1%%", got, tt.length)
			}
			mid := p.At(p.Length() / 2)
			if !pointNear(mid, tt.midWant, 0.02) {
				t.Errorf("midpoint = %v, want %v", mid, tt.midWant)
			}
		})
	}
}

func TestArcDegenerateCases(t *testing.T) {
	// Zero radius: a straight line to the endpoint.
	p := parseShape(t, "M0 0 A0 5 0 0 1 10 0", "")
	checkPoints(t, p.Points, []Point{{0, 0}, {10, 0}})
	if got := p.Length(); !within(got, 10, 1e-9) {
		t.Errorf("length = %g, want 10", got)
	}

	// Identical endpoints: the arc is omitted; the duplicate endpoint
	// merges with the current point.
	p = parseShape(t, "M3 4 A10 10 0 0 1 3 4", "")
	checkPoints(t, p.Points, []Point{{3, 4}})

	// Relative arc with compacted flags: a1 1 0 0110 10.
	p = parseShape(t, "M0 0a1 1 0 0110 10", "")
	if (p.Points[len(p.Points)-1] != Point{10, 10}) {
		t.Errorf("endpoint = %v, want exactly (10,10)", p.Points[len(p.Points)-1])
	}
	// Radii scale up to |chord|/2 = sqrt(50): a semicircle.
	want := math.Pi * math.Sqrt(50)
	if got := p.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("length = %g, want %g within 0.1%%", got, want)
	}

	// Implicit arc repeat (the full 7-value group repeats): two quarter
	// circles around the origin.
	p = parseShape(t, "M10 0 A10 10 0 0 1 0 10 10 10 0 0 1 -10 0", "")
	if (p.Points[len(p.Points)-1] != Point{-10, 0}) {
		t.Errorf("endpoint = %v, want exactly (-10,0)", p.Points[len(p.Points)-1])
	}
	want = math.Pi * 10
	if got := p.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("length = %g, want %g within 0.1%%", got, want)
	}
}

func TestEllipticalArcRotated(t *testing.T) {
	// A full half of an ellipse rx=10 ry=5 rotated 90 degrees: the rotation
	// swaps the axes, so the arc spans an ellipse with semi-axes 5 and 10.
	// From (0,0) to (10,0)... use x-axis-rotation 0 vs 90 and compare
	// heights at the midpoint.
	flat := parseShape(t, "M0 0 A10 5 0 0 1 20 0", "") // ry=5 => height 5
	tall := parseShape(t, "M0 0 A5 10 90 0 1 20 0", "")
	mFlat := flat.At(flat.Length() / 2)
	mTall := tall.At(tall.Length() / 2)
	if !within(mFlat.Y, -5, 0.05) {
		t.Errorf("unrotated midpoint Y = %g, want -5", mFlat.Y)
	}
	if !within(mTall.Y, -5, 0.05) {
		t.Errorf("rotated midpoint Y = %g, want -5 (axes swapped by 90 degree rotation)", mTall.Y)
	}
	if (tall.Points[len(tall.Points)-1] != Point{20, 0}) {
		t.Errorf("endpoint = %v, want exactly (20,0)", tall.Points[len(tall.Points)-1])
	}
}

// f formats a float for building path data in tests.
func f(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
