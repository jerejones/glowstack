// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package ctl

import (
	"fmt"
	"strconv"
	"strings"
)

const calUsage = `usage: glowstack ctl cal [command]

  cal                                 show the session: target, cursor, progress
  cal start [<target>]                start, at <target> or the first unmeasured anchor
  cal stop                            end the session; the house look comes back
  cal <target>                        calibrate something else:
      anchor <run> <node>             which pixel is at a node
      end <run> first|last            a run's first or last pixel
      link <node> <node>              a link's two nodes, which should line up
      gap <node> <node>               a gap (confirm with its length)
      dead <controller> <first> [<last>]   mark dead pixels
      bands <run> | bands controller:<id>  the coarse band view
  cal next | prev                     the next (previous) unmeasured anchor
  cal +1 | -1 | +10 | -10 | +N | -N   nudge the cursor along the run
  cal set <index>                     put the cursor at a controller index
  cal side <n>                        which cursor moves (links, gaps, dead ranges)
  cal confirm [<length>] [--next]     record it in anchors.yaml (a gap needs its length)
  cal forget [<target>]               drop a measurement (default: the current target)
`

// calState is the part of the calibration state the CLI shows.
type calState struct {
	Active  bool            `json:"active"`
	Label   string          `json:"label"`
	Cursors []calCursor     `json:"cursors"`
	Side    int             `json:"side"`
	Length  *float64        `json:"length"`
	Ctls    []calController `json:"controllers"`
	Warning string          `json:"warning"`
	Message string          `json:"message"`
	Items   []calItem       `json:"progress"`
	Done    int             `json:"measured"`
	Total   int             `json:"anchors"`
	File    string          `json:"file"`
}

type calCursor struct {
	Label      string `json:"label"`
	Run        string `json:"run"`
	Controller string `json:"controller"`
	Index      int    `json:"index"`
	Estimate   int    `json:"estimate"`
	Source     string `json:"source"`
	Fixed      bool   `json:"fixed"`
}

type calController struct {
	ID      string `json:"id"`
	Sending *bool  `json:"sending"`
}

type calItem struct {
	Target map[string]any `json:"target"`
	Label  string         `json:"label"`
	Index  *int           `json:"index"`
	Source string         `json:"source"`
	Done   bool           `json:"done"`
	Length *float64       `json:"length"`
}

func (c *client) calibrate(args []string) error {
	path, body := "calibration", any(nil)
	method := "GET"
	post := func(p string, b any) { method, path, body = "POST", "calibration/"+p, b }
	if len(args) > 0 {
		cmd, rest := args[0], args[1:]
		switch {
		case cmd == "help":
			fmt.Fprint(c.out, calUsage)
			return nil
		case cmd == "start":
			b := map[string]any{}
			if len(rest) > 0 {
				t, err := calTarget(rest)
				if err != nil {
					return err
				}
				b["target"] = t
			}
			post("start", b)
		case cmd == "stop":
			post("end", map[string]any{})
		case cmd == "next" || cmd == "prev":
			post("next", map[string]any{"back": cmd == "prev"})
		case strings.HasPrefix(cmd, "+") || strings.HasPrefix(cmd, "-"):
			n, err := strconv.Atoi(cmd)
			if err != nil || len(rest) > 0 {
				return usagef("cal %s: want +N or -N, e.g. +1 or -10", cmd)
			}
			post("nudge", map[string]any{"by": n})
		case cmd == "set":
			if len(rest) != 1 {
				return usagef("cal set <index>")
			}
			n, err := strconv.Atoi(rest[0])
			if err != nil {
				return usagef("cal set: %q isn't an index", rest[0])
			}
			post("set", map[string]any{"index": n})
		case cmd == "side":
			if len(rest) != 1 {
				return usagef("cal side <n>")
			}
			n, err := strconv.Atoi(rest[0])
			if err != nil {
				return usagef("cal side: %q isn't a number", rest[0])
			}
			post("side", map[string]any{"side": n})
		case cmd == "confirm":
			b := map[string]any{}
			var length []string
			for _, a := range rest {
				if a == "--next" || a == "-next" {
					b["next"] = true
				} else {
					length = append(length, a)
				}
			}
			if len(length) > 0 {
				b["length"] = strings.Join(length, " ")
			}
			post("confirm", b)
		case cmd == "forget":
			b := map[string]any{}
			if len(rest) > 0 {
				t, err := calTarget(rest)
				if err != nil {
					return err
				}
				b["target"] = t
			}
			post("forget", b)
		default:
			t, err := calTarget(args)
			if err != nil {
				return err
			}
			post("target", t)
		}
	}
	var st calState
	raw, err := c.call(method, path, body, &st)
	if err != nil {
		return err
	}
	c.show(raw, func() { c.showCal(&st) })
	return nil
}

// calTarget parses a target: anchor <run> <node>, end <run> first|last,
// link|gap <node> <node>, dead <controller> <first> [<last>], bands <run>
// or bands controller:<id>.
func calTarget(args []string) (map[string]any, error) {
	kind, rest := args[0], args[1:]
	need := func(n int, form string) error {
		if len(rest) != n {
			return usagef("cal %s %s", kind, form)
		}
		return nil
	}
	switch kind {
	case "anchor":
		if err := need(2, "<run> <node>"); err != nil {
			return nil, err
		}
		return map[string]any{"kind": kind, "run": rest[0], "node": rest[1]}, nil
	case "end":
		if err := need(2, "<run> first|last"); err != nil {
			return nil, err
		}
		return map[string]any{"kind": kind, "run": rest[0], "end": rest[1]}, nil
	case "link", "gap":
		if err := need(2, "<node> <node>"); err != nil {
			return nil, err
		}
		return map[string]any{"kind": kind, "from": rest[0], "to": rest[1]}, nil
	case "dead":
		if len(rest) < 2 || len(rest) > 3 {
			return nil, usagef("cal dead <controller> <first> [<last>]")
		}
		var idx []int
		for _, s := range rest[1:] {
			n, err := strconv.Atoi(s)
			if err != nil {
				return nil, usagef("cal dead: %q isn't an index", s)
			}
			idx = append(idx, n)
		}
		return map[string]any{"kind": kind, "controller": rest[0], "indices": idx}, nil
	case "bands":
		if err := need(1, "<run> | controller:<id>"); err != nil {
			return nil, err
		}
		if id, ok := strings.CutPrefix(rest[0], "controller:"); ok {
			return map[string]any{"kind": kind, "controller": id}, nil
		}
		return map[string]any{"kind": kind, "run": strings.TrimPrefix(rest[0], "run:")}, nil
	}
	return nil, usagef("cal: unknown command or target %q (see `glowstack ctl cal help`)", kind)
}

func (c *client) showCal(st *calState) {
	w := c.out
	switch {
	case !st.Active:
		fmt.Fprintln(w, "calibration: not running (`glowstack ctl cal start`)")
	case st.Label == "":
		fmt.Fprintln(w, "calibrating: nothing picked yet")
	default:
		fmt.Fprintf(w, "calibrating %s\n", st.Label)
	}
	if st.Active && len(st.Cursors) > 0 {
		tw := c.table()
		for i, cur := range st.Cursors {
			mark := " "
			if i == st.Side && len(st.Cursors) > 1 {
				mark = ">"
			}
			at := "no pixel"
			if cur.Index >= 0 {
				at = fmt.Sprintf("%s:%d", cur.Controller, cur.Index)
			}
			layout := fmt.Sprintf("layout %d, %s", cur.Estimate, cur.Source)
			if d := cur.Index - cur.Estimate; d != 0 {
				layout += fmt.Sprintf(", moved %+d", d)
			}
			if cur.Fixed {
				layout += ", fixed"
			}
			fmt.Fprintf(tw, " %s %s\t%s\t(%s)\n", mark, cur.Label, at, layout)
		}
		tw.Flush()
	}
	if st.Length != nil {
		fmt.Fprintf(w, "  length now %.3f m\n", *st.Length)
	}
	if len(st.Ctls) > 0 {
		var parts []string
		for _, ct := range st.Ctls {
			switch {
			case ct.Sending == nil:
				parts = append(parts, ct.ID)
			case *ct.Sending:
				parts = append(parts, ct.ID+" (sending)")
			default:
				parts = append(parts, ct.ID+" (not sending)")
			}
		}
		fmt.Fprintf(w, "  lights: %s\n", strings.Join(parts, ", "))
	}
	if st.Warning != "" {
		fmt.Fprintf(w, "  warning: %s\n", st.Warning)
	}
	if st.Message != "" && st.Message != "calibrating "+st.Label {
		fmt.Fprintf(w, "  %s\n", st.Message)
	}
	fmt.Fprintf(w, "progress: %d of %d anchors measured", st.Done, st.Total)
	if st.File != "" {
		fmt.Fprintf(w, " (%s)", st.File)
	}
	fmt.Fprintln(w)
	tw := c.table()
	for _, it := range st.Items {
		done := "·"
		if it.Done {
			done = "✓"
		}
		val := ""
		switch {
		case it.Index != nil:
			val = strconv.Itoa(*it.Index)
		case it.Length != nil:
			val = fmt.Sprintf("%.3f m", *it.Length)
		}
		fmt.Fprintf(tw, "  %s %s\t%s\t%s\n", done, it.Label, val, it.Source)
	}
	tw.Flush()
}
