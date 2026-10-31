// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"fmt"
	"math"
	"strings"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/plan"
)

// pathAnchor is a path node being solved.
type pathAnchor struct {
	node   int
	at     float64 // cell position; NaN until known
	source string
	drawn  float64 // distance along the drawn path; NaN if the drawing doesn't label it
	pos    config.Pos
	guess  bool // estimated in this solve, so not a knot for other estimates
}

func (b *builder) run(cr *config.Run) {
	ci := -1
	for i, c := range b.l.Controllers {
		if c.ID == cr.Controller {
			ci = i
		}
	}
	if ci < 0 {
		return // reported by config validation
	}
	r := Run{
		ID: cr.ID, Controller: ci, First: cr.Indices[0], Last: cr.Indices[1], Step: 1,
		Pitch: b.l.Pitch, Plan: -1, Config: cr,
	}
	if r.Last < r.First {
		r.Step = -1
	}
	r.Count = (r.Last-r.First)*r.Step + 1
	if cr.Pitch != nil {
		r.Pitch = cr.Pitch.Value
	}
	b.claimIDs = append(b.claimIDs, r.ID)
	if !b.claimPixels(&r, len(b.claimIDs)-1) {
		return
	}

	if cr.Plan != nil {
		r.Plan, r.PlanPath = b.runPlan(cr)
		if r.PlanPath != nil {
			r.DrawnLength = r.PlanPath.Length()
		}
	}
	anchors := b.runPath(cr, &r)
	if anchors == nil {
		return
	}
	if !b.solveAnchors(cr, &r, anchors) {
		return
	}

	ri := len(b.l.Runs)
	b.l.runByID[r.ID] = ri
	b.l.Runs = append(b.l.Runs, r)
	b.stripEdges(cr, ri, anchors)
}

// claimPixels marks the run's pixels as owned by claim number ci (an index
// into b.claimIDs), reporting overlaps.
func (b *builder) claimPixels(r *Run, ci int) bool {
	c := b.l.Controllers[r.Controller]
	overlapStart, overlapWith := -1, int32(-1)
	ok := true
	flush := func(end int) {
		if overlapStart >= 0 {
			lo, hi := min(overlapStart, end), max(overlapStart, end)
			b.errorf(r.Config.Pos, "run %s overlaps run %s at %s:%d–%d", r.ID, b.claimIDs[overlapWith], c.ID, lo, hi)
			overlapStart, ok = -1, false
		}
	}
	for k := range r.Count {
		idx := r.First + k*r.Step
		g := c.Base + int32(idx)
		if prev := b.owner[g]; prev >= 0 {
			if overlapStart < 0 || prev != overlapWith {
				flush(idx - r.Step)
				overlapStart, overlapWith = idx, prev
			}
			continue
		}
		flush(idx - r.Step)
		b.owner[g] = int32(ci)
	}
	flush(r.Last)
	return ok
}

// runPlan loads the run's drawn path, oriented in run direction.
func (b *builder) runPlan(cr *config.Run) (int, *plan.Path) {
	file, id, ok := strings.Cut(cr.Plan.SVG, "#")
	if !ok || id == "" || file == "" {
		b.errorf(cr.Plan.Pos, "run %s: plan svg %q: want file.svg#path-id", cr.ID, cr.Plan.SVG)
		return -1, nil
	}
	pi := b.plan(file, cr.Plan.Pos)
	if pi < 0 {
		return -1, nil
	}
	p, err := b.l.Plans[pi].Drawing.Path(id)
	if err != nil {
		b.errorf(cr.Plan.Pos, "run %s: %v", cr.ID, err)
		return -1, nil
	}
	if cr.Plan.Reverse {
		p = p.Reversed()
	}
	if p.Length() == 0 {
		b.errorf(cr.Plan.Pos, "run %s: drawn path %q has no length", cr.ID, id)
		return -1, nil
	}
	return pi, p
}

// runPath works out the run's node sequence and returns one pathAnchor per
// node, with ends placed and drawn distances filled in.
func (b *builder) runPath(cr *config.Run, r *Run) []pathAnchor {
	ids := cr.Path
	pp := r.PlanPath
	if len(ids) == 0 {
		if pp == nil {
			b.errorf(cr.Pos, "run %s: no path, and no drawing to take one from", cr.ID)
			return nil
		}
		for _, lb := range pp.Labels {
			if lb != "" {
				ids = append(ids, lb)
			}
		}
		if len(ids) == 0 || pp.Labels[0] == "" {
			ids = append([]string{cr.ID + ":start"}, ids...)
		}
		if pp.Labels[len(pp.Labels)-1] == "" || len(ids) == 1 {
			ids = append(ids, cr.ID+":end")
		}
	} else if pp != nil {
		first, last := pp.Labels[0], pp.Labels[len(pp.Labels)-1]
		if first == ids[len(ids)-1] && last == ids[0] && first != last {
			b.errorf(cr.Plan.Pos, "run %s: the drawing runs from %s to %s, against the run's direction; set `reverse: true`", cr.ID, first, last)
			return nil
		}
		if first != "" && first != ids[0] {
			b.warnf(cr.Plan.Pos, "run %s: drawing starts at %q but the run's path starts at %q", cr.ID, first, ids[0])
		}
		if last != "" && last != ids[len(ids)-1] {
			b.warnf(cr.Plan.Pos, "run %s: drawing ends at %q but the run's path ends at %q", cr.ID, last, ids[len(ids)-1])
		}
	}

	seen := map[string]bool{}
	anchors := make([]pathAnchor, len(ids))
	for j, id := range ids {
		if seen[id] && !(j == len(ids)-1 && id == ids[0]) {
			b.errorf(cr.Pos, "run %s: node %q appears twice in its path", cr.ID, id)
			return nil
		}
		seen[id] = true
		anchors[j] = pathAnchor{node: b.node(id), at: math.NaN(), drawn: math.NaN(), pos: cr.Pos}
		if pp != nil {
			if _, d, ok := pp.Vertex(id); ok {
				anchors[j].drawn = d
			}
		}
	}
	last := len(anchors) - 1
	anchors[0].at, anchors[0].source = 0, SourceEnd
	anchors[last].at, anchors[last].source = float64(r.Count), SourceEnd
	if pp != nil {
		// The drawing's ends are the run's ends, labelled or not.
		anchors[0].drawn, anchors[last].drawn = 0, pp.Length()
	}
	return anchors
}

// solveAnchors applies explicit anchors, estimates the rest from the
// drawing, and checks they're strictly increasing along the run.
func (b *builder) solveAnchors(cr *config.Run, r *Run, anchors []pathAnchor) bool {
	byNode := map[string]int{}
	for j := 1; j < len(anchors)-1; j++ {
		byNode[b.l.Nodes[anchors[j].node].ID] = j
	}
	ok := true
	set := func(node string, index int, source string, pos config.Pos) {
		j, found := byNode[node]
		if !found {
			if node == b.l.Nodes[anchors[0].node].ID || node == b.l.Nodes[anchors[len(anchors)-1].node].ID {
				b.errorf(pos, "run %s: %q is an end of the run; its ends are fixed at the first and last pixel", cr.ID, node)
			} else {
				b.errorf(pos, "run %s: anchor node %q isn't on the run's path", cr.ID, node)
			}
			ok = false
			return
		}
		k := r.Offset(index)
		if k < 0 {
			b.errorf(pos, "run %s: anchor %q index %d is outside the run", cr.ID, node, index)
			ok = false
			return
		}
		anchors[j].at, anchors[j].source, anchors[j].pos = float64(k)+0.5, source, pos
	}
	for _, a := range cr.Anchors {
		if a.Index != nil {
			set(a.Node, *a.Index, a.Source, a.Pos)
		} else if _, found := byNode[a.Node]; !found {
			set(a.Node, r.First, "", a.Pos) // reports the error
		}
	}
	for _, a := range b.cfg.Anchors {
		if a.Run == cr.ID {
			set(a.Node, a.Index, a.Source, a.Pos)
		}
	}
	if !ok {
		return false
	}

	// Explicit anchors must be strictly increasing.
	prev := 0
	for j := 1; j < len(anchors); j++ {
		if math.IsNaN(anchors[j].at) {
			continue
		}
		if anchors[j].at <= anchors[prev].at {
			b.errorf(anchors[j].pos, "run %s: anchors aren't in order along the run: %s (index %d) comes at or before %s (index %d)",
				cr.ID, b.l.Nodes[anchors[j].node].ID, r.indexAt(anchors[j].at), b.l.Nodes[anchors[prev].node].ID, r.indexAt(anchors[prev].at))
			return false
		}
		prev = j
	}

	// Estimate the rest, piecewise between known anchors that the drawing
	// also labels.
	for j := 1; j < len(anchors)-1; j++ {
		a := &anchors[j]
		if !math.IsNaN(a.at) {
			continue
		}
		name := b.l.Nodes[a.node].ID
		if math.IsNaN(a.drawn) {
			if r.PlanPath == nil {
				b.errorf(cr.Pos, "run %s: node %q has no anchor index and the run has no drawing to estimate it from", cr.ID, name)
			} else {
				b.errorf(cr.Pos, "run %s: node %q has no anchor index and the drawing doesn't label it (data-nodes)", cr.ID, name)
			}
			return false
		}
		lo, hi := j-1, j+1
		knot := func(k int) bool {
			return !math.IsNaN(anchors[k].at) && !math.IsNaN(anchors[k].drawn) && !anchors[k].guess
		}
		for !knot(lo) {
			lo--
		}
		for !knot(hi) {
			hi++
		}
		dl, dh := anchors[lo].drawn, anchors[hi].drawn
		if a.drawn < dl || a.drawn > dh {
			b.errorf(cr.Plan.Pos, "run %s: the drawing labels %q out of order relative to %q and %q", cr.ID, name,
				b.l.Nodes[anchors[lo].node].ID, b.l.Nodes[anchors[hi].node].ID)
			return false
		}
		at := anchors[lo].at
		if dh > dl {
			at += (a.drawn - dl) / (dh - dl) * (anchors[hi].at - anchors[lo].at)
		}
		k := int(math.Round(at - 0.5))
		k = max(0, min(r.Count-1, k))
		a.at, a.source, a.guess = float64(k)+0.5, SourceEstimated, true
	}

	// Estimates may collide with a neighbour after rounding; nudge them.
	for j := 1; j < len(anchors)-1; j++ {
		a := &anchors[j]
		if a.at > anchors[j-1].at {
			continue
		}
		if !a.guess {
			b.errorf(a.pos, "run %s: anchor %q collides with an estimated anchor before it; measure that one too", cr.ID, b.l.Nodes[a.node].ID)
			return false
		}
		a.at = math.Floor(anchors[j-1].at) + 1.5
		if a.at >= anchors[j+1].at {
			b.errorf(cr.Pos, "run %s: no room for node %q between its neighbours; the run is too short for its path", cr.ID, b.l.Nodes[a.node].ID)
			return false
		}
	}
	return true
}

// indexAt returns the controller index of the pixel at cell position at.
func (r *Run) indexAt(at float64) int {
	k := max(0, min(r.Count-1, int(math.Floor(at))))
	return r.First + k*r.Step
}

// stripEdges creates the run's edges between consecutive path nodes and
// fills in its pixels.
func (b *builder) stripEdges(cr *config.Run, ri int, anchors []pathAnchor) {
	r := &b.l.Runs[ri]
	lengths := map[[2]int]float64{}
	usedLength := make([]bool, len(cr.Lengths))
	for j := 0; j+1 < len(anchors); j++ {
		key := [2]int{anchors[j].node, anchors[j+1].node}
		for li, el := range cr.Lengths {
			from, okFrom := b.l.nodeByID[el.From]
			to, okTo := b.l.nodeByID[el.To]
			if !okFrom || !okTo {
				continue
			}
			if (from == key[0] && to == key[1]) || (from == key[1] && to == key[0]) {
				lengths[key] = el.Length.Value
				usedLength[li] = true
			}
		}
	}
	for li, used := range usedLength {
		if !used {
			el := cr.Lengths[li]
			b.errorf(el.Pos, "run %s: no edge between %q and %q (they must be consecutive on its path)", cr.ID, el.From, el.To)
		}
	}

	dist := 0.0
	for j := range anchors {
		a := anchors[j]
		r.Path = append(r.Path, a.node)
		r.Anchors = append(r.Anchors, Anchor{
			Node: a.node, Index: r.indexAt(a.at), At: a.at, Dist: dist, Source: a.source, Pos: a.pos,
		})
		if j+1 == len(anchors) {
			break
		}
		next := anchors[j+1]
		span := next.at - a.at
		length, measured := lengths[[2]int{a.node, next.node}]
		if !measured {
			length = span * r.Pitch
		}
		e := Edge{
			Kind: Strip, From: a.node, To: next.node, Length: length, Measured: measured, Run: ri,
			StartAt: a.at, EndAt: next.at, StartDist: dist, Pos: cr.Pos,
		}
		lastEdge := j+2 == len(anchors)
		for k := int(math.Ceil(a.at - 0.5)); k < r.Count; k++ {
			c := float64(k) + 0.5
			if c >= next.at && !lastEdge {
				break
			}
			e.Pixels = append(e.Pixels, r.Pixel(b.l, k))
		}
		ei := b.addEdge(e)
		r.Edges = append(r.Edges, ei)
		dl := length / span
		for _, g := range e.Pixels {
			px := &b.l.Pixels[g]
			k := r.Offset(int(px.Index))
			d := (float64(k) + 0.5 - a.at) * dl
			px.Run, px.Edge = int32(ri), int32(ei)
			px.Dist, px.RunDist, px.Dl = float32(d), float32(dist+d), float32(dl)
		}
		dist += length
	}
	r.Length = dist
}

// placeRun gives the run's pixels and path nodes plan positions, piecewise
// between the anchors the drawing labels.
func (b *builder) placeRun(ri int) {
	r := &b.l.Runs[ri]
	if r.PlanPath == nil {
		return
	}
	scale := b.l.Plans[r.Plan].Scale
	// Knots: (cell position, drawn distance) for the ends and labelled nodes.
	var ats, ds []float64
	for _, a := range r.Anchors {
		var d float64
		switch {
		case a.Source == SourceEnd && len(ats) == 0:
			d = 0
		case a.Source == SourceEnd:
			d = r.DrawnLength
		default:
			_, dd, ok := r.PlanPath.Vertex(b.l.Nodes[a.Node].ID)
			if !ok {
				continue
			}
			d = dd
		}
		ats, ds = append(ats, a.At), append(ds, d)
	}
	at2drawn := func(at float64) float64 {
		for i := 1; i < len(ats); i++ {
			if at <= ats[i] || i == len(ats)-1 {
				t := (at - ats[i-1]) / (ats[i] - ats[i-1])
				return ds[i-1] + t*(ds[i]-ds[i-1])
			}
		}
		return ds[0]
	}
	for k := range r.Count {
		p := r.PlanPath.At(at2drawn(float64(k) + 0.5))
		px := &b.l.Pixels[r.Pixel(b.l, k)]
		px.X, px.Y, px.Plan = float32(p.X*scale), float32(p.Y*scale), int16(r.Plan)
	}
	for _, a := range r.Anchors {
		n := &b.l.Nodes[a.Node]
		if n.Plan >= 0 {
			continue
		}
		p := r.PlanPath.At(at2drawn(a.At))
		n.X, n.Y, n.Plan = p.X*scale, p.Y*scale, r.Plan
	}
}

// LengthReport describes a run's drawn length against its pixel length.
func (r *Run) LengthReport(l *Layout) string {
	if r.PlanPath == nil {
		return fmt.Sprintf("%s: %.2f m of pixels, not drawn", r.ID, r.Length)
	}
	note := ""
	if l.Plans[r.Plan].ScaleEstimated {
		note = " (plan scale estimated from pixel lengths)"
	}
	return fmt.Sprintf("%s: %.2f m of pixels, %.2f m drawn, %+.1f%%%s", r.ID, r.Length, r.DrawnMetres, r.LengthMismatch*100, note)
}
