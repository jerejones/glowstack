// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"fmt"
	"math"
)

// DensityTolerance is how far a stretch's pixel density may stray from
// its run's average before the layout warns: a stretch with more than
// 1.25× or fewer than 0.75× the pixels its share of the drawing implies.
const DensityTolerance = 0.25

// densityMinPixels keeps short stretches, where a pixel or two is a big
// fraction, from warning.
const densityMinPixels = 4

// DensityIssue is a stretch of a run, between two of its fixed points
// (ends and measured anchors) with at least one a measured anchor, whose
// pixels don't match its share of the drawing. The usual cause is an
// anchor saved on the wrong node, e.g. the opposite corner of a loop.
type DensityIssue struct {
	Run      string
	From, To string   // node ids
	Pixels   float64  // pixel cells between them
	Expected float64  // what the stretch's drawn length implies at the run's average
	Ratio    float64  // Pixels / Expected
	Measured []string // the measured anchors at its ends
}

func (d DensityIssue) String() string {
	return fmt.Sprintf("run %s: %s–%s has %.0f pixels where its drawn length implies about %.0f (%.2f× the run's density); "+
		"check that the anchor at %s is on the right node", d.Run, d.From, d.To, d.Pixels, d.Expected, d.Ratio, joinOr(d.Measured))
}

func joinOr(s []string) string {
	switch len(s) {
	case 0:
		return ""
	case 1:
		return s[0]
	}
	return s[0] + " or " + s[1]
}

// checkDensity compares each stretch next to a measured anchor with the
// run's average pixels per drawn length. Estimated anchors are placed in
// proportion to the drawing, so only measured ones can make a stretch
// stray. Comparing with the run's own average, rather than the pitch, keeps
// a drawing that is off in scale overall from warning everywhere.
func (b *builder) checkDensity(ri int) {
	r := &b.l.Runs[ri]
	if r.PlanPath == nil || r.DrawnLength <= 0 {
		return
	}
	type knot struct {
		at, drawn float64
		node      int
		measured  bool
		pos       Anchor
	}
	var ks []knot
	for j, a := range r.Anchors {
		var d float64
		switch {
		case a.Source == SourceEnd && j == 0:
			d = 0
		case a.Source == SourceEnd:
			d = r.DrawnLength
		case a.Source != SourceMeasured:
			continue
		default:
			_, dd, ok := r.PlanPath.Vertex(b.l.Nodes[a.Node].ID)
			if !ok {
				continue
			}
			d = dd
		}
		ks = append(ks, knot{at: a.At, drawn: d, node: a.Node, measured: a.Source == SourceMeasured, pos: a})
	}
	avg := float64(r.Count) / r.DrawnLength
	for i := 1; i < len(ks); i++ {
		p, q := ks[i-1], ks[i]
		if !p.measured && !q.measured || q.drawn <= p.drawn {
			continue
		}
		px, want := q.at-p.at, (q.drawn-p.drawn)*avg
		if math.Abs(px-want) < densityMinPixels || math.Abs(px/want-1) <= DensityTolerance {
			continue
		}
		d := DensityIssue{Run: r.ID, From: b.l.Nodes[p.node].ID, To: b.l.Nodes[q.node].ID, Pixels: px, Expected: want, Ratio: px / want}
		pos := r.Config.Pos
		if p.measured {
			d.Measured, pos = append(d.Measured, d.From), p.pos.Pos
		}
		if q.measured {
			d.Measured, pos = append(d.Measured, d.To), q.pos.Pos
		}
		b.l.Density = append(b.l.Density, d)
		b.warnf(pos, "%s", d)
	}
}
