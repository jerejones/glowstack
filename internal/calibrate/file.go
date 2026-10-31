// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate

import (
	"cmp"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/units"
)

// measurements is the content of anchors.yaml: what calibration has
// measured, overriding layout.yaml.
type measurements struct {
	Anchors []config.AnchorOverride
	Ends    []config.EndOverride
	Gaps    []config.GapOverride
	Dead    []config.Dead
}

// loaded returns the measurements the config was loaded with (deep
// copies, so they can be changed).
func loaded(cfg *config.Config) *measurements {
	m := &measurements{
		Anchors: slices.Clone(cfg.Anchors),
		Gaps:    slices.Clone(cfg.Gaps),
		Dead:    slices.Clone(cfg.MeasuredDead),
	}
	for _, e := range cfg.Ends {
		e.First, e.Last = cloneInt(e.First), cloneInt(e.Last)
		m.Ends = append(m.Ends, e)
	}
	return m
}

func cloneInt(p *int) *int {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// setAnchor records a measured anchor.
func (m *measurements) setAnchor(run, node string, index int) {
	for i := range m.Anchors {
		if a := &m.Anchors[i]; a.Run == run && a.Node == node {
			a.Index, a.Source = index, config.SourceMeasured
			return
		}
	}
	m.Anchors = append(m.Anchors, config.AnchorOverride{Run: run, Node: node, Index: index, Source: config.SourceMeasured})
}

// forgetAnchor drops a measured anchor, so layout.yaml's (or the drawing's
// estimate) applies again.
func (m *measurements) forgetAnchor(run, node string) bool {
	n := len(m.Anchors)
	m.Anchors = slices.DeleteFunc(m.Anchors, func(a config.AnchorOverride) bool { return a.Run == run && a.Node == node })
	return len(m.Anchors) < n
}

// setEnd records a run's measured first or last pixel.
func (m *measurements) setEnd(run, end string, index int) {
	i := slices.IndexFunc(m.Ends, func(e config.EndOverride) bool { return e.Run == run })
	if i < 0 {
		m.Ends = append(m.Ends, config.EndOverride{Run: run})
		i = len(m.Ends) - 1
	}
	v := index
	if end == EndFirst {
		m.Ends[i].First = &v
	} else {
		m.Ends[i].Last = &v
	}
}

func (m *measurements) forgetEnd(run, end string) bool {
	i := slices.IndexFunc(m.Ends, func(e config.EndOverride) bool { return e.Run == run })
	if i < 0 {
		return false
	}
	e := &m.Ends[i]
	found := false
	if end != EndLast && e.First != nil {
		e.First, found = nil, true
	}
	if end != EndFirst && e.Last != nil {
		e.Last, found = nil, true
	}
	if e.First == nil && e.Last == nil {
		m.Ends = slices.Delete(m.Ends, i, i+1)
	}
	return found
}

func sameGap(g config.GapOverride, from, to string) bool {
	return g.From == from && g.To == to || g.From == to && g.To == from
}

func (m *measurements) setGap(from, to string, length float64) {
	l := units.Length{Value: length}
	for i := range m.Gaps {
		if sameGap(m.Gaps[i], from, to) {
			m.Gaps[i].Length = l
			return
		}
	}
	m.Gaps = append(m.Gaps, config.GapOverride{From: from, To: to, Length: l})
}

func (m *measurements) forgetGap(from, to string) bool {
	n := len(m.Gaps)
	m.Gaps = slices.DeleteFunc(m.Gaps, func(g config.GapOverride) bool { return sameGap(g, from, to) })
	return len(m.Gaps) < n
}

// addDead marks lo–hi dead on controller c, merging with ranges it
// touches.
func (m *measurements) addDead(c string, lo, hi int) {
	kept := m.Dead[:0]
	for _, d := range m.Dead {
		if d.Controller == c && d.Indices[0] <= hi+1 && d.Indices[1] >= lo-1 {
			lo, hi = min(lo, d.Indices[0]), max(hi, d.Indices[1])
			continue
		}
		kept = append(kept, d)
	}
	m.Dead = append(kept, config.Dead{Controller: c, Indices: [2]int{lo, hi}})
}

// forgetDead un-marks lo–hi on controller c, splitting ranges as needed.
// Only calibration's own dead marks can be undone; layout.yaml's stay.
func (m *measurements) forgetDead(c string, lo, hi int) bool {
	var out []config.Dead
	found := false
	for _, d := range m.Dead {
		a, b := d.Indices[0], d.Indices[1]
		if d.Controller != c || b < lo || a > hi {
			out = append(out, d)
			continue
		}
		found = true
		if a < lo {
			out = append(out, config.Dead{Controller: c, Indices: [2]int{a, lo - 1}})
		}
		if b > hi {
			out = append(out, config.Dead{Controller: c, Indices: [2]int{hi + 1, b}})
		}
	}
	m.Dead = out
	return found
}

// Header is the comment anchors.yaml starts with.
const Header = "# Written by Glowstack's calibration mode. Overrides layout.yaml.\n" +
	"# Copy it into the site's config repo to keep it; edit with care.\n"

// format writes the measurements as anchors.yaml: one flow-style line per
// entry, in layout order (runs, then the anchors' order along their run;
// controllers for dead pixels), so the file diffs cleanly in git.
func (m *measurements) format(l *layout.Layout) []byte {
	runOrder := func(id string) int {
		if i, ok := l.RunIndex(id); ok {
			return i
		}
		return len(l.Runs)
	}
	along := func(run, node string) float64 {
		ri, ok := l.RunIndex(run)
		n, ok2 := l.NodeIndex(node)
		if ok && ok2 {
			for _, a := range l.Runs[ri].Anchors {
				if a.Node == n {
					return a.At
				}
			}
		}
		return 1e18
	}
	ctlOrder := func(id string) int {
		for i, c := range l.Controllers {
			if c.ID == id {
				return i
			}
		}
		return len(l.Controllers)
	}
	anchors := slices.Clone(m.Anchors)
	slices.SortStableFunc(anchors, func(a, b config.AnchorOverride) int {
		return cmp.Or(cmp.Compare(runOrder(a.Run), runOrder(b.Run)), strings.Compare(a.Run, b.Run),
			cmp.Compare(along(a.Run, a.Node), along(b.Run, b.Node)), strings.Compare(a.Node, b.Node))
	})
	ends := slices.Clone(m.Ends)
	slices.SortStableFunc(ends, func(a, b config.EndOverride) int {
		return cmp.Or(cmp.Compare(runOrder(a.Run), runOrder(b.Run)), strings.Compare(a.Run, b.Run))
	})
	gaps := slices.Clone(m.Gaps)
	slices.SortStableFunc(gaps, func(a, b config.GapOverride) int {
		return cmp.Or(strings.Compare(a.From, b.From), strings.Compare(a.To, b.To))
	})
	dead := slices.Clone(m.Dead)
	slices.SortStableFunc(dead, func(a, b config.Dead) int {
		return cmp.Or(cmp.Compare(ctlOrder(a.Controller), ctlOrder(b.Controller)),
			strings.Compare(a.Controller, b.Controller), cmp.Compare(a.Indices[0], b.Indices[0]))
	})

	var b strings.Builder
	b.WriteString(Header)
	b.WriteString("schema: 1\n")
	if len(anchors) > 0 {
		b.WriteString("anchors:\n")
		for _, a := range anchors {
			fmt.Fprintf(&b, "  - { run: %s, node: %s, index: %d, source: %s }\n",
				yamlString(a.Run), yamlString(a.Node), a.Index, yamlString(cmp.Or(a.Source, config.SourceMeasured)))
		}
	}
	if len(ends) > 0 {
		b.WriteString("ends:\n")
		for _, e := range ends {
			fmt.Fprintf(&b, "  - { run: %s", yamlString(e.Run))
			if e.First != nil {
				fmt.Fprintf(&b, ", first: %d", *e.First)
			}
			if e.Last != nil {
				fmt.Fprintf(&b, ", last: %d", *e.Last)
			}
			b.WriteString(" }\n")
		}
	}
	if len(gaps) > 0 {
		b.WriteString("gaps:\n")
		for _, g := range gaps {
			fmt.Fprintf(&b, "  - { from: %s, to: %s, length: %s }\n", yamlString(g.From), yamlString(g.To), formatMeters(g.Length.Value))
		}
	}
	if len(dead) > 0 {
		b.WriteString("dead:\n")
		for _, d := range dead {
			fmt.Fprintf(&b, "  - { controller: %s, indices: [%d, %d] }\n", yamlString(d.Controller), d.Indices[0], d.Indices[1])
		}
	}
	return []byte(b.String())
}

// formatMeters prints a length in meters, as briefly as it reads back.
func formatMeters(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64) + " m"
}

var plainYAML = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_./-]*$`)

// yamlString writes s as a YAML scalar that reads back as the same string:
// plain where that's safe, double-quoted (JSON syntax, which YAML accepts)
// otherwise.
func yamlString(s string) string {
	switch strings.ToLower(s) {
	case "true", "false", "yes", "no", "on", "off", "null", "y", "n":
		return strconv.Quote(s)
	}
	if plainYAML.MatchString(s) {
		return s
	}
	return strconv.Quote(s)
}
