// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package plan

import (
	"fmt"
	"strconv"
)

// vertex is a flattened polyline point. drawn marks the endpoint of an SVG
// command (or a listed polyline/polygon point): the vertices eligible for a
// data-nodes label. Points introduced by curve flattening are not drawn.
type vertex struct {
	p     Point
	drawn bool
}

// scanner reads SVG number lists: path data, points attributes, transform
// arguments and viewBox values, with comma/whitespace separators and
// compact number syntax (1.5.5, 1e-3, -1-2).
type scanner struct {
	s string
	i int
}

func isNumSep(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v' || c == ','
}

func (sc *scanner) skipSep() {
	for sc.i < len(sc.s) && isNumSep(sc.s[sc.i]) {
		sc.i++
	}
}

func (sc *scanner) eof() bool {
	return sc.i >= len(sc.s)
}

// expect consumes c if it is the next byte.
func (sc *scanner) expect(c byte) bool {
	if sc.i < len(sc.s) && sc.s[sc.i] == c {
		sc.i++
		return true
	}
	return false
}

// ident consumes a run of ASCII letters.
func (sc *scanner) ident() string {
	start := sc.i
	for sc.i < len(sc.s) {
		c := sc.s[sc.i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
			sc.i++
		} else {
			break
		}
	}
	return sc.s[start:sc.i]
}

// number scans one float in SVG compact syntax.
func (sc *scanner) number() (float64, error) {
	sc.skipSep()
	s, n := sc.s, len(sc.s)
	start := sc.i
	i := sc.i
	if i < n && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digits := 0
	for i < n && s[i] >= '0' && s[i] <= '9' {
		i++
		digits++
	}
	if i < n && s[i] == '.' {
		i++
		for i < n && s[i] >= '0' && s[i] <= '9' {
			i++
			digits++
		}
	}
	if digits == 0 {
		return 0, fmt.Errorf("expected number at offset %d in %q", start, s)
	}
	if i < n && (s[i] == 'e' || s[i] == 'E') {
		j := i + 1
		if j < n && (s[j] == '+' || s[j] == '-') {
			j++
		}
		k := j
		for k < n && s[k] >= '0' && s[k] <= '9' {
			k++
		}
		if k > j {
			i = k
		}
	}
	v, err := strconv.ParseFloat(s[start:i], 64)
	if err != nil {
		return 0, fmt.Errorf("bad number %q at offset %d", s[start:i], start)
	}
	sc.i = i
	return v, nil
}

// flag scans an SVG arc flag: a single '0' or '1' (flags may be run
// together with the following number, e.g. "0110 10").
func (sc *scanner) flag() (bool, error) {
	sc.skipSep()
	if sc.i >= len(sc.s) {
		return false, fmt.Errorf("expected arc flag at offset %d in %q", sc.i, sc.s)
	}
	switch sc.s[sc.i] {
	case '0':
		sc.i++
		return false, nil
	case '1':
		sc.i++
		return true, nil
	}
	return false, fmt.Errorf("expected arc flag (0 or 1) at offset %d in %q", sc.i, sc.s)
}

// numberList scans all remaining numbers in the string.
func (sc *scanner) numberList() ([]float64, error) {
	var out []float64
	for {
		sc.skipSep()
		if sc.eof() {
			return out, nil
		}
		v, err := sc.number()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
}

// peekCmd reports the next path command letter, if the next token is one.
func (sc *scanner) peekCmd() (byte, bool) {
	sc.skipSep()
	if sc.i >= len(sc.s) {
		return 0, false
	}
	c := sc.s[sc.i]
	if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
		return c, true
	}
	return 0, false
}

// parsePathData flattens SVG path data into polyline vertices. tol is the
// maximum allowed deviation of the polyline from the true curve, in the
// path's local coordinates. Every command endpoint is a drawn vertex; a
// second or later moveto continues the polyline with a straight jump.
func parsePathData(d string, tol float64) ([]vertex, error) {
	sc := &scanner{s: d}
	var verts []vertex
	var cur, start, cubicCtrl, quadCtrl Point
	var lastCmd byte
	started := false

	drawnTo := func(p Point) {
		verts = append(verts, vertex{p: p, drawn: true})
		cur = p
	}

	for {
		sc.skipSep()
		if sc.eof() {
			return verts, nil
		}
		cmd, explicit := sc.peekCmd()
		if explicit {
			sc.i++
		} else {
			// Implicit repeat of the previous command; after a moveto the
			// implicit command is lineto.
			switch lastCmd {
			case 0:
				return nil, fmt.Errorf("path data must start with a moveto command")
			case 'M':
				cmd = 'L'
			case 'm':
				cmd = 'l'
			case 'Z', 'z':
				return nil, fmt.Errorf("unexpected number after closepath at offset %d", sc.i)
			default:
				cmd = lastCmd
			}
		}
		if !started && cmd != 'M' && cmd != 'm' {
			return nil, fmt.Errorf("path data must start with a moveto command, got %q", string(cmd))
		}

		rel := cmd >= 'a' && cmd <= 'z'
		abs := func(x, y float64) Point {
			if rel {
				return Point{X: cur.X + x, Y: cur.Y + y}
			}
			return Point{X: x, Y: y}
		}
		num := func() (float64, error) { return sc.number() }

		up := cmd
		if up >= 'a' && up <= 'z' {
			up -= 'a' - 'A'
		}
		prevCmd := lastCmd
		lastCmd = cmd

		var err error
		take := func(k int) ([]float64, error) {
			vals := make([]float64, k)
			for j := range vals {
				if vals[j], err = num(); err != nil {
					return nil, err
				}
			}
			return vals, nil
		}

		switch up {
		case 'M':
			v, err := take(2)
			if err != nil {
				return nil, err
			}
			drawnTo(abs(v[0], v[1]))
			start = cur
			started = true
		case 'Z':
			// Closepath: one drawn vertex, the return to the subpath start.
			drawnTo(start)
		case 'L':
			v, err := take(2)
			if err != nil {
				return nil, err
			}
			drawnTo(abs(v[0], v[1]))
		case 'H':
			v, err := take(1)
			if err != nil {
				return nil, err
			}
			if rel {
				drawnTo(Point{X: cur.X + v[0], Y: cur.Y})
			} else {
				drawnTo(Point{X: v[0], Y: cur.Y})
			}
		case 'V':
			v, err := take(1)
			if err != nil {
				return nil, err
			}
			if rel {
				drawnTo(Point{X: cur.X, Y: cur.Y + v[0]})
			} else {
				drawnTo(Point{X: cur.X, Y: v[0]})
			}
		case 'C', 'S':
			var c1, c2, end Point
			if up == 'C' {
				v, err := take(6)
				if err != nil {
					return nil, err
				}
				c1, c2, end = abs(v[0], v[1]), abs(v[2], v[3]), abs(v[4], v[5])
			} else {
				v, err := take(4)
				if err != nil {
					return nil, err
				}
				if prevCmd == 'C' || prevCmd == 'c' || prevCmd == 'S' || prevCmd == 's' {
					c1 = Point{X: 2*cur.X - cubicCtrl.X, Y: 2*cur.Y - cubicCtrl.Y}
				} else {
					c1 = cur
				}
				c2, end = abs(v[0], v[1]), abs(v[2], v[3])
			}
			flattenCubic(&verts, cur, c1, c2, end, tol)
			cubicCtrl = c2
			drawnTo(end)
		case 'Q', 'T':
			var ctrl, end Point
			if up == 'Q' {
				v, err := take(4)
				if err != nil {
					return nil, err
				}
				ctrl, end = abs(v[0], v[1]), abs(v[2], v[3])
			} else {
				v, err := take(2)
				if err != nil {
					return nil, err
				}
				if prevCmd == 'Q' || prevCmd == 'q' || prevCmd == 'T' || prevCmd == 't' {
					ctrl = Point{X: 2*cur.X - quadCtrl.X, Y: 2*cur.Y - quadCtrl.Y}
				} else {
					ctrl = cur
				}
				end = abs(v[0], v[1])
			}
			flattenQuad(&verts, cur, ctrl, end, tol)
			quadCtrl = ctrl
			drawnTo(end)
		case 'A':
			v, err := take(3)
			if err != nil {
				return nil, err
			}
			large, err := sc.flag()
			if err != nil {
				return nil, err
			}
			sweep, err := sc.flag()
			if err != nil {
				return nil, err
			}
			xy, err := take(2)
			if err != nil {
				return nil, err
			}
			end := abs(xy[0], xy[1])
			flattenArc(&verts, cur, v[0], v[1], v[2], large, sweep, end, tol)
			drawnTo(end)
		default:
			return nil, fmt.Errorf("unknown path command %q at offset %d", string(cmd), sc.i-1)
		}
	}
}
