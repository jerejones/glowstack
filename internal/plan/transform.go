// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package plan

import (
	"fmt"
	"math"
)

// matrix is a 2-D affine transform in SVG order:
//
//	x' = a*x + c*y + e
//	y' = b*x + d*y + f
type matrix struct {
	a, b, c, d, e, f float64
}

var identityMatrix = matrix{a: 1, d: 1}

// mul returns the composition m∘n: n is applied to the point first, then m.
func (m matrix) mul(n matrix) matrix {
	return matrix{
		a: m.a*n.a + m.c*n.b,
		b: m.b*n.a + m.d*n.b,
		c: m.a*n.c + m.c*n.d,
		d: m.b*n.c + m.d*n.d,
		e: m.a*n.e + m.c*n.f + m.e,
		f: m.b*n.e + m.d*n.f + m.f,
	}
}

func (m matrix) apply(p Point) Point {
	return Point{
		X: m.a*p.X + m.c*p.Y + m.e,
		Y: m.b*p.X + m.d*p.Y + m.f,
	}
}

// maxScale returns the largest singular value of the linear part of m: the
// factor by which the transform can stretch a distance.
func (m matrix) maxScale() float64 {
	t := m.a*m.a + m.b*m.b + m.c*m.c + m.d*m.d
	det := m.a*m.d - m.b*m.c
	disc := t*t - 4*det*det
	if disc < 0 {
		disc = 0
	}
	return math.Sqrt((t + math.Sqrt(disc)) / 2)
}

func rotationMatrix(deg float64) matrix {
	rad := deg * math.Pi / 180
	s, c := math.Sincos(rad)
	return matrix{a: c, b: s, c: -s, d: c}
}

// parseTransform parses an SVG transform attribute: one or more of
// matrix, translate, scale, rotate, skewX, skewY, separated by optional
// whitespace and/or commas. Functions compose left to right (the leftmost
// is outermost).
func parseTransform(s string) (matrix, error) {
	m := identityMatrix
	sc := &scanner{s: s}
	for {
		sc.skipSep()
		if sc.eof() {
			return m, nil
		}
		name := sc.ident()
		if name == "" {
			return m, fmt.Errorf("invalid transform %q: expected function name at offset %d", s, sc.i)
		}
		sc.skipSep()
		if !sc.expect('(') {
			return m, fmt.Errorf("invalid transform %q: expected '(' after %q", s, name)
		}
		var args []float64
		for {
			sc.skipSep()
			if sc.expect(')') {
				break
			}
			if sc.eof() {
				return m, fmt.Errorf("invalid transform %q: unterminated %q", s, name)
			}
			v, err := sc.number()
			if err != nil {
				return m, fmt.Errorf("invalid transform %q: %v", s, err)
			}
			args = append(args, v)
		}
		fm, err := transformFunc(name, args)
		if err != nil {
			return m, fmt.Errorf("invalid transform %q: %v", s, err)
		}
		m = m.mul(fm)
	}
}

func transformFunc(name string, args []float64) (matrix, error) {
	switch name {
	case "matrix":
		if len(args) != 6 {
			return identityMatrix, fmt.Errorf("matrix needs 6 arguments, got %d", len(args))
		}
		return matrix{args[0], args[1], args[2], args[3], args[4], args[5]}, nil
	case "translate":
		switch len(args) {
		case 1:
			return matrix{a: 1, d: 1, e: args[0]}, nil
		case 2:
			return matrix{a: 1, d: 1, e: args[0], f: args[1]}, nil
		}
		return identityMatrix, fmt.Errorf("translate needs 1 or 2 arguments, got %d", len(args))
	case "scale":
		switch len(args) {
		case 1:
			return matrix{a: args[0], d: args[0]}, nil
		case 2:
			return matrix{a: args[0], d: args[1]}, nil
		}
		return identityMatrix, fmt.Errorf("scale needs 1 or 2 arguments, got %d", len(args))
	case "rotate":
		switch len(args) {
		case 1:
			return rotationMatrix(args[0]), nil
		case 3:
			t1 := matrix{a: 1, d: 1, e: args[1], f: args[2]}
			t2 := matrix{a: 1, d: 1, e: -args[1], f: -args[2]}
			return t1.mul(rotationMatrix(args[0])).mul(t2), nil
		}
		return identityMatrix, fmt.Errorf("rotate needs 1 or 3 arguments, got %d", len(args))
	case "skewX":
		if len(args) != 1 {
			return identityMatrix, fmt.Errorf("skewX needs 1 argument, got %d", len(args))
		}
		return matrix{a: 1, c: math.Tan(args[0] * math.Pi / 180), d: 1}, nil
	case "skewY":
		if len(args) != 1 {
			return identityMatrix, fmt.Errorf("skewY needs 1 argument, got %d", len(args))
		}
		return matrix{a: 1, b: math.Tan(args[0] * math.Pi / 180), d: 1}, nil
	}
	return identityMatrix, fmt.Errorf("unknown transform function %q", name)
}
