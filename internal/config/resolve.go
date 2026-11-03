// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"fmt"
	"slices"
	"strings"
)

// Nothing on disk names a controller index. Runs name outputs, and
// anchors, ends, dead ranges and area ranges count from a run's first LED
// (or an output's), so changing one output's count moves nothing else.
// resolve derives the controller indices everything downstream works in.

// outputStarts numbers c's outputs, lays them end to end and sets
// c.Pixels to their total. Without outputs (a Config built in code),
// c.Pixels is left as set.
func outputStarts(c *Controller) {
	if len(c.Outputs) == 0 {
		return
	}
	start := 0
	for i := range c.Outputs {
		o := &c.Outputs[i]
		if o.Number == 0 {
			o.Number = i + 1
		}
		o.Start = start
		start += max(o.Count, 0)
	}
	c.Pixels = start
}

// outputRange returns the controller index range of outputs first…last
// (1-based, inclusive), or false.
func outputRange(c *Controller, first, last int) (lo, hi int, ok bool) {
	if first < 1 || last < first || last > len(c.Outputs) {
		return 0, 0, false
	}
	return c.Outputs[first-1].Start, c.Outputs[last-1].Start + c.Outputs[last-1].Count - 1, true
}

// resolve derives every controller index from layout.yaml's and
// anchors.yaml's run and output references. Load calls it after decoding
// and before applyMeasured.
func (c *Config) resolve() error {
	v := &validator{}
	for i := range c.Controllers {
		outputStarts(&c.Controllers[i])
	}
	runs := map[string]*Run{}
	for i := range c.Layout.Runs {
		r := &c.Layout.Runs[i]
		v.resolveRun(c, r)
		if r.ID != "" {
			runs[r.ID] = r
		}
	}
	for i := range c.Layout.Dead {
		v.resolveDead(c, runs, &c.Layout.Dead[i], false)
	}

	// anchors.yaml
	stale := map[string]*staleRun{}
	var staleOrder []string
	measuredAt := func(r *Run, pixels int, pos Pos) {
		if pixels == 0 {
			v.errorf(pos, "run %q: missing pixels (the run's LED count when this was measured)", r.ID)
			return
		}
		if pixels == r.Count() {
			return
		}
		s := stale[r.ID]
		if s == nil {
			s = &staleRun{run: r.ID, pos: pos, now: r.Count()}
			stale[r.ID] = s
			staleOrder = append(staleOrder, r.ID)
		}
		s.n++
		if !slices.Contains(s.then, pixels) {
			s.then = append(s.then, pixels)
		}
	}
	for i := range c.Anchors {
		a := &c.Anchors[i]
		r := runs[a.Run]
		if r == nil {
			continue // Validate reports unknown runs
		}
		lo, _ := r.Span()
		a.Index = lo + a.Offset
		measuredAt(r, a.Pixels, a.Pos)
	}
	for i := range c.Ends {
		e := &c.Ends[i]
		r := runs[e.Run]
		if r == nil {
			continue // applyMeasured reports unknown runs
		}
		lo, _ := r.Span()
		if e.First != nil {
			x := lo + *e.First
			e.FirstIndex = &x
		}
		if e.Last != nil {
			x := lo + *e.Last
			e.LastIndex = &x
		}
		measuredAt(r, e.Pixels, e.Pos)
	}
	for i := range c.MeasuredDead {
		d := &c.MeasuredDead[i]
		if v.resolveDead(c, runs, d, true) && d.Run != "" {
			measuredAt(runs[d.Run], d.Pixels, d.Pos)
		}
	}
	for _, id := range staleOrder {
		c.Warnings = append(c.Warnings, stale[id].warning())
	}
	return v.errs.Err()
}

// staleRun collects anchors.yaml entries measured when a run had a
// different LED count.
type staleRun struct {
	run  string
	pos  Pos
	n    int
	then []int
	now  int
}

func (s *staleRun) warning() *Error {
	then := make([]string, len(s.then))
	for i, p := range s.then {
		then[i] = fmt.Sprint(p)
	}
	what := "1 measurement in anchors.yaml was"
	if s.n > 1 {
		what = fmt.Sprintf("%d measurements in anchors.yaml were", s.n)
	}
	return Errorf(s.pos, "run %s: %s taken when it had %s LEDs; it now has %d. "+
		"If LEDs were added or removed at its far end, `glowstack anchors accept %s`; otherwise "+
		"`glowstack anchors shift %s AT N` or `glowstack anchors clear %s`",
		s.run, what, strings.Join(then, " or "), s.now, s.run, s.run, s.run)
}

// resolveRun derives r.Indices from its outputs and LEDs.
func (v *validator) resolveRun(c *Config, r *Run) {
	ctl, ok := c.Controller(r.Controller)
	if !ok {
		return // Validate reports it
	}
	first, last := r.Output, r.Output
	switch {
	case r.Output != 0 && r.Outputs != nil:
		v.errorf(r.Pos, "run %q: give output or outputs, not both", r.ID)
		return
	case r.Outputs != nil:
		if len(r.Outputs) == 0 {
			v.errorf(r.Pos, "run %q: outputs is empty", r.ID)
			return
		}
		for i := 1; i < len(r.Outputs); i++ {
			if r.Outputs[i] != r.Outputs[i-1]+1 {
				v.errorf(r.Pos, "run %q: outputs %v aren't consecutive", r.ID, r.Outputs)
				return
			}
		}
		first, last = r.Outputs[0], r.Outputs[len(r.Outputs)-1]
	case r.Output == 0:
		v.errorf(r.Pos, "run %q: missing output (WLED's output number, from 1)", r.ID)
		return
	}
	lo, hi, ok := outputRange(ctl, first, last)
	if !ok {
		v.errorf(r.Pos, "run %q: controller %q has no output %d (it has %d)", r.ID, ctl.ID, max(first, last), len(ctl.Outputs))
		return
	}
	if r.LEDs != nil {
		a, b := r.LEDs[0], r.LEDs[1]
		if a < 0 || b < a || lo+b > hi {
			v.errorf(r.Pos, "run %q: leds [%d, %d] outside the output's 0–%d (low to high; reverse sets direction)", r.ID, a, b, hi-lo)
			return
		}
		lo, hi = lo+a, lo+b
	}
	r.span = &[2]int{lo, hi}
	r.Indices = [2]int{lo, hi}
	if r.Reverse {
		r.Indices = [2]int{hi, lo}
	}
	for j := range r.Anchors {
		a := &r.Anchors[j]
		if a.Offset == nil {
			continue
		}
		if *a.Offset < 0 || *a.Offset > hi-lo {
			v.errorf(a.Pos, "anchor %q: offset %d outside run %q's 0–%d", a.Node, *a.Offset, r.ID, hi-lo)
			continue
		}
		idx := lo + *a.Offset
		a.Index = &idx
	}
}

// resolveDead derives d.Controller and d.Indices. measured says d is from
// anchors.yaml. It returns false if d couldn't be resolved.
func (v *validator) resolveDead(c *Config, runs map[string]*Run, d *Dead, measured bool) bool {
	switch {
	case d.Run != "" && (d.Controller != "" || d.Output != 0 || d.LEDs != nil):
		v.errorf(d.Pos, "dead: give {run, offsets} or {controller, output, leds}, not both")
	case d.Run != "":
		r := runs[d.Run]
		if r == nil {
			v.errorf(d.Pos, "dead: unknown run %q", d.Run)
			return false
		}
		if d.Offsets == nil {
			v.errorf(d.Pos, "dead on run %q: missing offsets", d.Run)
			return false
		}
		lo, hi := r.Span()
		a, b := d.Offsets[0], d.Offsets[1]
		if a < 0 || b < a || lo+b > hi {
			v.errorf(d.Pos, "dead: offsets [%d, %d] outside run %q's 0–%d", a, b, d.Run, hi-lo)
			return false
		}
		d.Controller, d.Indices = r.Controller, [2]int{lo + a, lo + b}
		return true
	case d.Controller != "":
		if measured && d.Pixels != 0 {
			v.errorf(d.Pos, "dead: pixels applies to run ranges only")
		}
		ctl, ok := c.Controller(d.Controller)
		if !ok {
			v.errorf(d.Pos, "dead: unknown controller %q", d.Controller)
			return false
		}
		if d.LEDs == nil || d.Output == 0 {
			v.errorf(d.Pos, "dead on controller %q: give output and leds", d.Controller)
			return false
		}
		lo, hi, ok := outputRange(ctl, d.Output, d.Output)
		if !ok {
			v.errorf(d.Pos, "dead: controller %q has no output %d", d.Controller, d.Output)
			return false
		}
		a, b := d.LEDs[0], d.LEDs[1]
		if a < 0 || b < a || lo+b > hi {
			v.errorf(d.Pos, "dead: leds [%d, %d] outside %s's 0–%d", a, b, ctl.Outputs[d.Output-1].Name(), hi-lo)
			return false
		}
		d.Indices = [2]int{lo + a, lo + b}
		return true
	default:
		v.errorf(d.Pos, "dead: give {run, offsets} or {controller, output, leds}")
	}
	return false
}
