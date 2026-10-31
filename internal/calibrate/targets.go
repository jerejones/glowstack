// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate

import (
	"fmt"
	"slices"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
)

// Target kinds: what's being calibrated.
const (
	KindAnchor = "anchor" // which pixel sits at a node on a run
	KindEnd    = "end"    // a run's first or last pixel
	KindLink   = "link"   // the two nodes of a link edge, which should line up
	KindGap    = "gap"    // a gap edge's length, entered by hand
	KindDead   = "dead"   // a range of dead pixels on a controller
	KindBands  = "bands"  // the coarse band view over a run or a controller
)

// Run ends.
const (
	EndFirst = "first"
	EndLast  = "last"
)

// Target names what's being calibrated, in house terms.
type Target struct {
	Kind       string `json:"kind"`
	Run        string `json:"run,omitempty"`        // anchor, end, bands
	Node       string `json:"node,omitempty"`       // anchor
	End        string `json:"end,omitempty"`        // end: first | last
	From       string `json:"from,omitempty"`       // link, gap: node ids
	To         string `json:"to,omitempty"`         // link, gap
	Controller string `json:"controller,omitempty"` // dead, bands
	Indices    []int  `json:"indices,omitempty"`    // dead: first and last index (or one)
}

// String describes the target, e.g. "anchor shed-sw on shed-eave".
func (t Target) String() string {
	switch t.Kind {
	case KindAnchor:
		return fmt.Sprintf("anchor %s on %s", t.Node, t.Run)
	case KindEnd:
		return fmt.Sprintf("%s end of %s", t.End, t.Run)
	case KindLink:
		return fmt.Sprintf("link %s–%s", t.From, t.To)
	case KindGap:
		return fmt.Sprintf("gap %s–%s", t.From, t.To)
	case KindDead:
		return fmt.Sprintf("dead pixels on %s %v", t.Controller, t.Indices)
	case KindBands:
		if t.Run != "" {
			return "bands on run " + t.Run
		}
		return "bands on controller " + t.Controller
	}
	return t.Kind
}

// Cursor is one pixel being placed: an anchor, a run end, one side of a
// link or gap, one end of a dead range.
type Cursor struct {
	Label      string `json:"label"`          // node id, "first", "last", "from", "to"
	Run        string `json:"run,omitempty"`  // the run it's on, if any
	Node       string `json:"node,omitempty"` // the node it places, if any
	Controller string `json:"controller,omitempty"`
	// Index is where the cursor is now (controller index); -1 if the node
	// has no pixel (a node only gaps and links reach).
	Index int `json:"index"`
	// Estimate is where the layout puts it now; Source says why
	// (measured, estimated, end, configured).
	Estimate int    `json:"estimate"`
	Source   string `json:"source"`
	// Fixed cursors can't be nudged: a run end seen from a link or gap
	// (calibrate it as the run's end instead).
	Fixed bool `json:"fixed,omitempty"`
	Min   int  `json:"min"` // bounds for Index
	Max   int  `json:"max"`
	Moved bool `json:"moved,omitempty"` // nudged away from Estimate
}

// plan is a target resolved against the current layout.
type plan struct {
	cursors []Cursor
	// gap: its current length in meters.
	length float64
}

// resolve checks t against l and works out its cursors.
func resolve(l *layout.Layout, cfg *config.Config, t Target) (*plan, error) {
	p := &plan{}
	switch t.Kind {
	case KindAnchor:
		r, err := findRun(l, t.Run)
		if err != nil {
			return nil, err
		}
		a, ok := anchorOn(l, r, t.Node)
		if !ok {
			return nil, notFound("node %q isn't on run %s's path", t.Node, r.ID)
		}
		if a.Source == layout.SourceEnd {
			return nil, invalidf("%s is an end of run %s; calibrate it as the run's end (kind %q)", t.Node, r.ID, KindEnd)
		}
		p.cursors = []Cursor{runCursor(l, r, t.Node, a.Index, a.Source)}
	case KindEnd:
		r, err := findRun(l, t.Run)
		if err != nil {
			return nil, err
		}
		idx := r.First
		switch t.End {
		case EndFirst:
		case EndLast:
			idx = r.Last
		default:
			return nil, invalidf("end: want %q or %q, not %q", EndFirst, EndLast, t.End)
		}
		c := l.Controllers[r.Controller]
		source := "configured"
		if endMeasured(cfg, r.ID, t.End) {
			source = config.SourceMeasured
		}
		p.cursors = []Cursor{{Label: t.End, Run: r.ID, Controller: c.ID, Index: idx, Estimate: idx,
			Source: source, Min: 0, Max: c.Pixels - 1}}
	case KindLink, KindGap:
		var edge *layout.Edge
		want := layout.Link
		if t.Kind == KindGap {
			want = layout.Gap
		}
		from, ok1 := l.NodeIndex(t.From)
		to, ok2 := l.NodeIndex(t.To)
		if !ok1 || !ok2 {
			return nil, notFound("no %s between %q and %q", t.Kind, t.From, t.To)
		}
		for i := range l.Edges {
			e := &l.Edges[i]
			if e.Kind == want && (e.From == from && e.To == to || e.From == to && e.To == from) {
				edge = e
				break
			}
		}
		if edge == nil {
			return nil, notFound("no %s between %q and %q", t.Kind, t.From, t.To)
		}
		p.length = edge.Length
		for _, n := range []string{t.From, t.To} {
			p.cursors = append(p.cursors, nodeCursor(l, n, t.Kind == KindGap))
		}
	case KindDead:
		c, err := findController(l, t.Controller)
		if err != nil {
			return nil, err
		}
		if len(t.Indices) < 1 || len(t.Indices) > 2 {
			return nil, invalidf("dead: give the first and last dead index (or one)")
		}
		lo, hi := t.Indices[0], t.Indices[len(t.Indices)-1]
		for _, i := range []int{lo, hi} {
			if i < 0 || i >= c.Pixels {
				return nil, invalidf("dead: index %d outside controller %s's 0–%d", i, c.ID, c.Pixels-1)
			}
		}
		for j, idx := range []int{min(lo, hi), max(lo, hi)} {
			p.cursors = append(p.cursors, Cursor{Label: []string{"from", "to"}[j], Controller: c.ID,
				Index: idx, Estimate: idx, Source: "chosen", Min: 0, Max: c.Pixels - 1})
		}
	case KindBands:
		switch {
		case t.Run != "" && t.Controller != "":
			return nil, invalidf("bands: give a run or a controller, not both")
		case t.Run != "":
			if _, err := findRun(l, t.Run); err != nil {
				return nil, err
			}
		default:
			if _, err := findController(l, t.Controller); err != nil {
				return nil, err
			}
		}
	default:
		return nil, invalidf("unknown target kind %q (want anchor, end, link, gap, dead or bands)", t.Kind)
	}
	return p, nil
}

func findRun(l *layout.Layout, id string) (*layout.Run, error) {
	ri, ok := l.RunIndex(id)
	if !ok {
		return nil, notFound("no run %q", id)
	}
	return &l.Runs[ri], nil
}

func findController(l *layout.Layout, id string) (*layout.Controller, error) {
	for i := range l.Controllers {
		if l.Controllers[i].ID == id {
			return &l.Controllers[i], nil
		}
	}
	return nil, notFound("no controller %q", id)
}

func anchorOn(l *layout.Layout, r *layout.Run, node string) (layout.Anchor, bool) {
	n, ok := l.NodeIndex(node)
	if !ok {
		return layout.Anchor{}, false
	}
	for _, a := range r.Anchors {
		if a.Node == n {
			return a, true
		}
	}
	return layout.Anchor{}, false
}

func runCursor(l *layout.Layout, r *layout.Run, node string, index int, source string) Cursor {
	return Cursor{Label: node, Run: r.ID, Node: node, Controller: l.Controllers[r.Controller].ID,
		Index: index, Estimate: index, Source: source, Min: min(r.First, r.Last), Max: max(r.First, r.Last)}
}

// nodeCursor places a link's or gap's node: at its anchor on the run whose
// interior it's on (nudgeable), else at the run end it is (fixed), else
// nowhere.
func nodeCursor(l *layout.Layout, node string, gap bool) Cursor {
	var end *Cursor
	for i := range l.Runs {
		r := &l.Runs[i]
		a, ok := anchorOn(l, r, node)
		if !ok {
			continue
		}
		c := runCursor(l, r, node, a.Index, a.Source)
		if a.Source != layout.SourceEnd {
			c.Fixed = gap // a gap is measured with a tape, not by moving its ends
			return c
		}
		if end == nil {
			c.Fixed = true
			end = &c
		}
	}
	if end != nil {
		return *end
	}
	return Cursor{Label: node, Node: node, Index: -1, Estimate: -1, Source: "none", Fixed: true}
}

func endMeasured(cfg *config.Config, run, end string) bool {
	for _, e := range cfg.Ends {
		if e.Run == run && (end == EndFirst && e.First != nil || end == EndLast && e.Last != nil) {
			return true
		}
	}
	return false
}

// spec is one calibration layer to show.
type spec struct {
	target string // area id (run:<id> or controller:<id>)
	params map[string]any
}

// layers works out the calibration layers for target t with cursors cs,
// side being the active cursor.
func layers(l *layout.Layout, t Target, cs []Cursor, side int) []spec {
	base := func(controller string) int {
		c, _ := findController(l, controller)
		return int(c.Base)
	}
	ruler := func(r *layout.Run, focus int) map[string]any {
		return map[string]any{
			"mode": ModeRuler, "base": base(l.Controllers[r.Controller].ID), "focus": focus, "dir": r.Step,
			"lo": min(r.First, r.Last), "hi": max(r.First, r.Last),
		}
	}
	switch t.Kind {
	case KindAnchor:
		r, _ := findRun(l, cs[0].Run)
		return []spec{{layout.AreaRunPrefix + r.ID, ruler(r, cs[0].Index)}}
	case KindEnd:
		// Over the whole controller, so the ruler reaches past the run's
		// configured end; pixels outside the run are black.
		r, _ := findRun(l, cs[0].Run)
		return []spec{{layout.AreaControllerPrefix + cs[0].Controller, ruler(r, cs[0].Index)}}
	case KindLink, KindGap:
		// One layer per run involved. The active side gets the ruler; the
		// other is a plain white pixel (a second focus if they share a run).
		var out []spec
		order := []int{side}
		for i := range cs {
			if i != side {
				order = append(order, i)
			}
		}
		for _, i := range order {
			c := cs[i]
			if c.Run == "" || c.Index < 0 {
				continue
			}
			if j := slices.IndexFunc(out, func(s spec) bool { return s.target == layout.AreaRunPrefix+c.Run }); j >= 0 {
				out[j].params["also"] = c.Index
				continue
			}
			r, _ := findRun(l, c.Run)
			p := ruler(r, c.Index)
			if i != side || t.Kind == KindGap {
				p["reach"] = 0
			}
			out = append(out, spec{layout.AreaRunPrefix + r.ID, p})
		}
		return out
	case KindDead:
		p := map[string]any{"mode": ModeRuler, "base": base(t.Controller), "focus": cs[side].Index,
			"dir": 1, "mark_lo": cs[0].Index, "mark_hi": cs[1].Index}
		return []spec{{layout.AreaControllerPrefix + t.Controller, p}}
	case KindBands:
		if t.Run != "" {
			r, _ := findRun(l, t.Run)
			return []spec{{layout.AreaRunPrefix + r.ID, map[string]any{"mode": ModeBands, "base": base(l.Controllers[r.Controller].ID)}}}
		}
		return []spec{{layout.AreaControllerPrefix + t.Controller, map[string]any{"mode": ModeBands, "base": base(t.Controller)}}}
	}
	return nil
}

// controllersOf lists the controllers a target's layers light.
func controllersOf(l *layout.Layout, specs []spec) []string {
	var out []string
	for _, s := range specs {
		a, ok := l.Area(s.target)
		if !ok || len(a.Pixels) == 0 {
			continue
		}
		id := l.Controllers[l.Pixels[a.Pixels[0]].Controller].ID
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// Item is one entry in the progress list.
type Item struct {
	Target Target `json:"target"`
	Label  string `json:"label"`
	// Index is the solved index (anchors) or "" for links and gaps.
	Index  *int     `json:"index,omitempty"`
	Source string   `json:"source"` // measured | estimated (anchors); measured | configured (gaps); partial (links)
	Done   bool     `json:"done"`
	Length *float64 `json:"length,omitempty"` // gaps: meters
}

// progress lists every anchor in run order, then links and gaps.
func progress(l *layout.Layout, cfg *config.Config) []Item {
	var out []Item
	for _, r := range l.Runs {
		for _, a := range r.Anchors {
			if a.Source == layout.SourceEnd {
				continue
			}
			idx := a.Index
			node := l.Nodes[a.Node].ID
			out = append(out, Item{Target: Target{Kind: KindAnchor, Run: r.ID, Node: node},
				Label: r.ID + " · " + node, Index: &idx, Source: a.Source, Done: a.Source == layout.SourceMeasured})
		}
	}
	for _, e := range l.Edges {
		if e.Kind == layout.Strip {
			continue
		}
		from, to := l.Nodes[e.From].ID, l.Nodes[e.To].ID
		if e.Kind == layout.Link {
			done, some := true, false
			for _, n := range []string{from, to} {
				c := nodeCursor(l, n, false)
				switch {
				case c.Source == layout.SourceMeasured:
					some = true
				case c.Fixed:
				default:
					done = false
				}
			}
			src := config.SourceEstimated
			switch {
			case done:
				src = config.SourceMeasured
			case some:
				src = "partial"
			}
			out = append(out, Item{Target: Target{Kind: KindLink, From: from, To: to}, Label: "link " + from + "–" + to, Source: src, Done: done})
			continue
		}
		length := e.Length
		done := slices.ContainsFunc(cfg.Gaps, func(g config.GapOverride) bool { return sameGap(g, from, to) })
		src := "configured"
		if done {
			src = config.SourceMeasured
		}
		out = append(out, Item{Target: Target{Kind: KindGap, From: from, To: to}, Label: "gap " + from + "–" + to,
			Source: src, Done: done, Length: &length})
	}
	return out
}
