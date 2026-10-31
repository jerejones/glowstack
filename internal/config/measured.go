// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

// applyMeasured applies anchors.yaml's ends, gaps and dead pixels to the
// layout, so everything downstream (validation, the layout solver, areas)
// sees the measured installation. Anchors are applied by the layout solver
// itself (Config.Anchors), because they need the solved path.
//
// Overrides that point at nothing are errors at their anchors.yaml line:
// a run end for an unknown run, or a gap length with no matching gap edge
// in layout.yaml. Calibration doesn't add runs or edges, only measures
// them.
func (c *Config) applyMeasured() error {
	v := &validator{}
	runs := map[string]*Run{}
	for i := range c.Layout.Runs {
		runs[c.Layout.Runs[i].ID] = &c.Layout.Runs[i]
	}
	seenEnds := map[string]Pos{}
	for _, e := range c.Ends {
		if !v.required(e.Pos, "run", e.Run) {
			continue
		}
		if prev, ok := seenEnds[e.Run]; ok {
			v.errorf(e.Pos, "duplicate ends for run %q (first at %s)", e.Run, prev)
			continue
		}
		seenEnds[e.Run] = e.Pos
		r, ok := runs[e.Run]
		if !ok {
			v.errorf(e.Pos, "ends: unknown run %q", e.Run)
			continue
		}
		if e.First == nil && e.Last == nil {
			v.errorf(e.Pos, "ends for run %q: give first, last or both", e.Run)
			continue
		}
		if e.First != nil {
			r.Indices[0] = *e.First
		}
		if e.Last != nil {
			r.Indices[1] = *e.Last
		}
		// Subsequent validation and solving must name the measurement that
		// supplied these indices, rather than the overridden layout entry.
		r.Pos = e.Pos
		if r.Indices[0] == r.Indices[1] {
			v.errorf(e.Pos, "ends for run %q: first and last are both %d", e.Run, r.Indices[0])
		}
	}
	seenGaps := map[[2]string]Pos{}
	for _, g := range c.Gaps {
		if !v.required(g.Pos, "from", g.From) || !v.required(g.Pos, "to", g.To) {
			continue
		}
		key := [2]string{min(g.From, g.To), max(g.From, g.To)}
		if prev, ok := seenGaps[key]; ok {
			v.errorf(g.Pos, "duplicate gap length for %s–%s (first at %s)", g.From, g.To, prev)
			continue
		}
		seenGaps[key] = g.Pos
		if g.Length.PX || g.Length.Value <= 0 {
			v.errorf(g.Pos, "gap %s–%s needs a positive length in meters", g.From, g.To)
			continue
		}
		found := false
		for i := range c.Layout.Edges {
			e := &c.Layout.Edges[i]
			if e.Kind == EdgeGap && (e.From == g.From && e.To == g.To || e.From == g.To && e.To == g.From) {
				e.Length, found = g.Length, true
			}
		}
		if !found {
			v.errorf(g.Pos, "gaps: layout.yaml has no gap edge between %q and %q", g.From, g.To)
		}
	}
	// Validate checks dead ranges, with their anchors.yaml positions.
	c.Layout.Dead = append(c.Layout.Dead, c.MeasuredDead...)
	return v.errs.Err()
}
