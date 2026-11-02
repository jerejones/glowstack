// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package plan

import (
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
)

// inkscapeNS is the XML namespace of the inkscape:label attribute.
const inkscapeNS = "http://www.inkscape.org/namespaces/inkscape"

// dedupEps is the coordinate tolerance below which consecutive points are
// considered duplicates (zero-length segments) and merged.
const dedupEps = 1e-9

// Point is a point in plan units. Z is 0 for SVG drawings; scene models
// (package scene) supply it.
type Point struct{ X, Y, Z float64 }

type shapeEntry struct {
	path  *Path // ID is id, falling back to label
	id    string
	label string
}

// Drawing is a parsed SVG plan.
type Drawing struct {
	ViewBox [4]float64 // min-x, min-y, width, height of the root <svg>; all zero if absent

	shapes []shapeEntry
}

// Parse reads an SVG document and extracts every <path>, <polyline>,
// <polygon> and <line> that has an id or inkscape:label, flattening each to
// a polyline in plan units. See the package documentation for details.
func Parse(r io.Reader) (*Drawing, error) {
	dec := xml.NewDecoder(r)
	d := &Drawing{}
	stack := []matrix{identityMatrix}
	rootSeen := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("plan: parsing SVG: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			m := stack[len(stack)-1]
			if tf, ok := plainAttr(t, "transform"); ok {
				tm, err := parseTransform(tf)
				if err != nil {
					return nil, fmt.Errorf("plan: element <%s>: %w", t.Name.Local, err)
				}
				m = m.mul(tm)
			}
			stack = append(stack, m)
			if t.Name.Local == "svg" && !rootSeen {
				rootSeen = true
				if vb, ok := plainAttr(t, "viewBox"); ok {
					if err := parseViewBox(vb, &d.ViewBox); err != nil {
						return nil, fmt.Errorf("plan: %w", err)
					}
				}
			}
			switch t.Name.Local {
			case "path", "polyline", "polygon", "line":
				if err := d.addShape(t, m); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	return d, nil
}

// ParseFile reads and parses the SVG plan at name.
func ParseFile(name string) (*Drawing, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, fmt.Errorf("plan: %w", err)
	}
	defer f.Close()
	d, err := Parse(f)
	if err != nil {
		return nil, fmt.Errorf("%w (file %s)", err, name)
	}
	return d, nil
}

// Path returns the shape whose id attribute equals id; if none, the first
// shape whose inkscape:label equals id. It returns an error mentioning id
// if no shape matches.
func (d *Drawing) Path(id string) (*Path, error) {
	for _, s := range d.shapes {
		if s.id != "" && s.id == id {
			return s.path, nil
		}
	}
	for _, s := range d.shapes {
		if s.label != "" && s.label == id {
			return s.path, nil
		}
	}
	return nil, fmt.Errorf("plan: no shape with id or label %q", id)
}

// PathIDs lists the ids of all extracted shapes, in document order. A shape
// without an id attribute is listed under its inkscape:label.
func (d *Drawing) PathIDs() []string {
	ids := make([]string, len(d.shapes))
	for i, s := range d.shapes {
		ids[i] = s.path.ID
	}
	return ids
}

// plainAttr returns the value of the unprefixed attribute local.
func plainAttr(e xml.StartElement, local string) (string, bool) {
	for _, a := range e.Attr {
		if a.Name.Space == "" && a.Name.Local == local {
			return a.Value, true
		}
	}
	return "", false
}

// inkscapeLabel returns the inkscape:label attribute, matched either in the
// Inkscape namespace or by the literal "inkscape" prefix (when the
// namespace is not declared, encoding/xml reports the raw prefix as Space).
func inkscapeLabel(e xml.StartElement) string {
	for _, a := range e.Attr {
		if a.Name.Local == "label" && (a.Name.Space == inkscapeNS || a.Name.Space == "inkscape") {
			return a.Value
		}
	}
	return ""
}

func parseViewBox(s string, out *[4]float64) error {
	sc := &scanner{s: s}
	vals, err := sc.numberList()
	if err != nil || len(vals) != 4 {
		return fmt.Errorf("invalid viewBox %q", s)
	}
	copy(out[:], vals)
	return nil
}

// addShape extracts one shape element. m is the composed transform of the
// element and all its ancestors.
func (d *Drawing) addShape(e xml.StartElement, m matrix) error {
	id, _ := plainAttr(e, "id")
	label := inkscapeLabel(e)
	if id == "" && label == "" {
		return nil // anonymous shapes are decoration, not LED runs
	}
	name := id
	if name == "" {
		name = label
	}

	// Flatten in local coordinates, with the tolerance tightened by the
	// transform's maximum scale so the deviation bound holds in plan units.
	tol := flattenTol / max(m.maxScale(), 1e-12)

	var verts []vertex
	var err error
	switch e.Name.Local {
	case "path":
		data, _ := plainAttr(e, "d")
		verts, err = parsePathData(data, tol)
	case "polyline", "polygon":
		pts, _ := plainAttr(e, "points")
		verts, err = parsePointsList(pts, e.Name.Local == "polygon")
	case "line":
		verts, err = parseLine(e)
	}
	if err != nil {
		return fmt.Errorf("plan: shape %q: %w", name, err)
	}

	nodes, _ := plainAttr(e, "data-nodes")
	p, err := buildPath(name, verts, nodes, m)
	if err != nil {
		return err
	}
	d.shapes = append(d.shapes, shapeEntry{path: p, id: id, label: label})
	return nil
}

// parsePointsList parses a polyline/polygon points attribute. For a polygon
// the first point is repeated at the end to close the shape.
func parsePointsList(s string, closed bool) ([]vertex, error) {
	sc := &scanner{s: s}
	vals, err := sc.numberList()
	if err != nil {
		return nil, err
	}
	if len(vals)%2 != 0 {
		return nil, fmt.Errorf("points attribute has an odd number of coordinates (%d)", len(vals))
	}
	verts := make([]vertex, 0, len(vals)/2+1)
	for i := 0; i+1 < len(vals); i += 2 {
		verts = append(verts, vertex{p: Point{X: vals[i], Y: vals[i+1]}, drawn: true})
	}
	if closed && len(verts) > 0 {
		verts = append(verts, vertex{p: verts[0].p, drawn: true})
	}
	return verts, nil
}

func parseLine(e xml.StartElement) ([]vertex, error) {
	coord := func(name string) (float64, error) {
		v, ok := plainAttr(e, name)
		if !ok || strings.TrimSpace(v) == "" {
			return 0, nil // SVG default
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0, fmt.Errorf("invalid %s attribute %q", name, v)
		}
		return f, nil
	}
	x1, err := coord("x1")
	if err != nil {
		return nil, err
	}
	y1, err := coord("y1")
	if err != nil {
		return nil, err
	}
	x2, err := coord("x2")
	if err != nil {
		return nil, err
	}
	y2, err := coord("y2")
	if err != nil {
		return nil, err
	}
	return []vertex{
		{p: Point{X: x1, Y: y1}, drawn: true},
		{p: Point{X: x2, Y: y2}, drawn: true},
	}, nil
}

// buildPath assigns data-nodes labels to drawn vertices, applies the
// transform, and drops consecutive duplicate points.
func buildPath(id string, verts []vertex, nodes string, m matrix) (*Path, error) {
	var entries []string
	if nodes != "" {
		entries = strings.Split(nodes, ",")
		for i := range entries {
			entries[i] = strings.TrimSpace(entries[i])
		}
	}

	drawn := 0
	for _, v := range verts {
		if v.drawn {
			drawn++
		}
	}
	if len(entries) > drawn {
		return nil, fmt.Errorf("plan: shape %q: data-nodes has %d entries but the shape has %d drawn vertices", id, len(entries), drawn)
	}
	seen := make(map[string]bool, len(entries))
	for _, l := range entries {
		if l == "" {
			continue
		}
		if seen[l] {
			return nil, fmt.Errorf("plan: shape %q: label %q used more than once", id, l)
		}
		seen[l] = true
	}

	points := make([]Point, 0, len(verts))
	labels := make([]string, 0, len(verts))
	k := 0
	for _, v := range verts {
		var l string
		if v.drawn {
			if k < len(entries) {
				l = entries[k]
			}
			k++
		}
		p := m.apply(v.p)
		if math.IsNaN(p.X) || math.IsNaN(p.Y) || math.IsInf(p.X, 0) || math.IsInf(p.Y, 0) {
			return nil, fmt.Errorf("plan: shape %q: non-finite coordinate after transform", id)
		}
		if n := len(points); n > 0 && samePoint(points[n-1], p) {
			// Zero-length segment: keep one point, merge labels.
			if l != "" {
				if prev := labels[n-1]; prev != "" && prev != l {
					return nil, fmt.Errorf("plan: shape %q: coincident vertices carry different labels %q and %q", id, prev, l)
				}
				labels[n-1] = l
			}
			continue
		}
		points = append(points, p)
		labels = append(labels, l)
	}

	p := &Path{ID: id, Points: points, Labels: labels}
	if math.IsInf(p.Length(), 0) || math.IsNaN(p.Length()) {
		return nil, fmt.Errorf("plan: shape %q: non-finite path length", id)
	}
	return p, nil
}

func samePoint(a, b Point) bool {
	dx, dy := a.X-b.X, a.Y-b.Y
	if dx < 0 {
		dx = -dx
	}
	if dy < 0 {
		dy = -dy
	}
	return dx <= dedupEps && dy <= dedupEps
}
