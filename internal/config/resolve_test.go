// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"fmt"
	"strings"
	"testing"
)

// fiveOutputs is one controller with five outputs and a run on each of
// outputs 3–5; counts[i] is output i+1's count.
func fiveOutputs(counts [5]int) map[string]string {
	var outs strings.Builder
	for i, n := range counts {
		fmt.Fprintf(&outs, "      - { output: %d, count: %d }\n", i+1, n)
	}
	return map[string]string{
		ControllersFileName: "schema: 1\ncontrollers:\n  - id: shed\n    host: 192.0.2.1\n    outputs:\n" + outs.String(),
		LayoutFileName: "schema: 1\npitch: 1/60 m\nruns:\n" +
			"  - { id: eave, controller: shed, outputs: [1, 2], path: [a, b] }\n" +
			"  - { id: wall, controller: shed, output: 3, path: [c, m, d] }\n" +
			"  - { id: tower, controller: shed, output: 4, reverse: true, path: [e, n, f] }\n" +
			"  - { id: porch, controller: shed, output: 5, path: [g, p, h] }\n",
	}
}

const fiveAnchors = "anchors:\n" +
	"  - { run: wall, node: m, offset: 80, pixels: 150 }\n" +
	"  - { run: tower, node: n, offset: 50, pixels: 180 }\n" +
	"  - { run: porch, node: p, offset: 300, pixels: 500 }\n"

// outputLED is where controller index idx sits: (output number, LED
// within the output).
func outputLED(c *Controller, idx int) [2]int {
	for _, o := range c.Outputs {
		if idx >= o.Start && idx < o.Start+o.Count {
			return [2]int{o.Number, idx - o.Start}
		}
	}
	return [2]int{-1, -1}
}

func anchorsAt(t *testing.T, c *Config) map[string][2]int {
	t.Helper()
	ctl, _ := c.Controller("shed")
	out := map[string][2]int{}
	for _, a := range c.Anchors {
		out[a.Run+"/"+a.Node] = outputLED(ctl, a.Index)
	}
	return out
}

// TestOutputCountChangeMovesNothingElse: cutting output 2 from 600 to 300
// LEDs is the only edit. Every later output, run and anchor keeps its
// place within its output, and nothing warns.
func TestOutputCountChangeMovesNothingElse(t *testing.T) {
	data := writeData(t, fiveAnchors)
	before, err := Load(writeConfig(t, fiveOutputs([5]int{1000, 600, 150, 180, 500})), data)
	if err != nil {
		t.Fatal(err)
	}
	after, err := Load(writeConfig(t, fiveOutputs([5]int{1000, 300, 150, 180, 500})), data)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Warnings) > 0 {
		t.Errorf("warnings: %v", after.Warnings)
	}
	if b, a := anchorsAt(t, before), anchorsAt(t, after); fmt.Sprint(b) != fmt.Sprint(a) {
		t.Errorf("anchors moved within their outputs: %v → %v", b, a)
	}
	ctl, _ := after.Controller("shed")
	if ctl.Pixels != 1000+300+150+180+500 || ctl.Outputs[2].Start != 1300 {
		t.Errorf("pixels %d, output 3 starts at %d", ctl.Pixels, ctl.Outputs[2].Start)
	}
	want := map[string][2]int{"eave": {0, 1299}, "wall": {1300, 1449}, "tower": {1629, 1450}, "porch": {1630, 2129}}
	for _, r := range after.Layout.Runs {
		if r.Indices != want[r.ID] {
			t.Errorf("run %s indices %v, want %v", r.ID, r.Indices, want[r.ID])
		}
	}
	// The reversed tower's offset still counts from its lowest LED.
	if got := anchorsAt(t, after)["tower/n"]; got != [2]int{4, 50} {
		t.Errorf("tower anchor at %v, want output 4 LED 50", got)
	}
}

// TestFarEndChangeWarnsOnce: three LEDs added to output 5 keep its
// offsets, move the run's end, and warn once that its anchors were
// measured at another length.
func TestFarEndChangeWarnsOnce(t *testing.T) {
	data := writeData(t, fiveAnchors+"ends:\n  - { run: porch, last: 499, pixels: 500 }\n")
	c, err := Load(writeConfig(t, fiveOutputs([5]int{1000, 600, 150, 180, 503})), data)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Warnings) != 1 {
		t.Fatalf("warnings = %v, want one", c.Warnings)
	}
	w := c.Warnings[0].Error()
	for _, s := range []string{"run porch", "2 measurements", "500 LEDs", "now has 503", "glowstack anchors accept porch"} {
		if !strings.Contains(w, s) {
			t.Errorf("warning %q lacks %q", w, s)
		}
	}
	ctl, _ := c.Controller("shed")
	if got := anchorsAt(t, c)["porch/p"]; got != [2]int{5, 300} {
		t.Errorf("porch anchor at %v", got)
	}
	porch := c.Layout.Runs[3]
	if lo, hi := porch.Span(); hi-lo != 502 || porch.Indices[1] != ctl.Outputs[4].Start+499 {
		t.Errorf("porch span %d–%d, indices %v (the measured end holds)", lo, hi, porch.Indices)
	}
}

func TestRunOutputs(t *testing.T) {
	base := "schema: 1\ncontrollers:\n  - id: shed\n    host: 192.0.2.1\n    outputs:\n" +
		"      - { output: 1, gpio: 16, count: 10 }\n      - { count: 20 }\n      - { output: 3, count: 30 }\n"
	run := func(r string) map[string]string {
		return map[string]string{ControllersFileName: base, LayoutFileName: "schema: 1\npitch: 1 cm\nruns:\n  - " + r + "\n"}
	}
	for _, tt := range []struct{ name, run, want string }{
		{"two outputs", "{ id: a, controller: shed, outputs: [1, 2], path: [x, y] }", "[0 29]"},
		{"sub-range", "{ id: a, controller: shed, output: 2, leds: [5, 9], path: [x, y] }", "[15 19]"},
		{"reversed", "{ id: a, controller: shed, outputs: [2, 3], leds: [0, 39], reverse: true, path: [x, y] }", "[49 10]"},
		{"no output", "{ id: a, controller: shed, path: [x, y] }", `run "a": missing output`},
		{"both", "{ id: a, controller: shed, output: 1, outputs: [1, 2], path: [x, y] }", "give output or outputs, not both"},
		{"gap in outputs", "{ id: a, controller: shed, outputs: [1, 3], path: [x, y] }", "aren't consecutive"},
		{"no such output", "{ id: a, controller: shed, output: 4, path: [x, y] }", `controller "shed" has no output 4 (it has 3)`},
		{"leds past the end", "{ id: a, controller: shed, output: 1, leds: [5, 10], path: [x, y] }", "leds [5, 10] outside the output's 0–9"},
		{"leds backwards", "{ id: a, controller: shed, output: 1, leds: [5, 2], path: [x, y] }", "low to high; reverse sets direction"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c, err := Load(writeConfig(t, run(tt.run)), "")
			if strings.HasPrefix(tt.want, "[") {
				if err != nil {
					t.Fatal(err)
				}
				if got := fmt.Sprint(c.Layout.Runs[0].Indices); got != tt.want {
					t.Errorf("indices %s, want %s", got, tt.want)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestOutputNumbers(t *testing.T) {
	for _, tt := range []struct{ name, outputs, want string }{
		{"out of order", "[{ output: 2, count: 10 }, { output: 1, count: 10 }]", "output 2 is listed 1st; list outputs in WLED's order"},
		{"zero count", "[{ count: 0 }]", "output 1: count must be positive"},
		{"none", "[]", `controller "shed": needs outputs`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctl := "schema: 1\ncontrollers:\n  - { id: shed, host: 192.0.2.1, outputs: " + tt.outputs + " }\n"
			_, err := Load(writeConfig(t, map[string]string{ControllersFileName: ctl, LayoutFileName: "schema: 1\npitch: 1 cm\n"}), "")
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestDeadRanges(t *testing.T) {
	dir := writeConfig(t, map[string]string{LayoutFileName: measuredLayout +
		"dead:\n  - { controller: shed, output: 1, leds: [50, 59] }\n  - { run: b, offsets: [0, 1] }\n"})
	c, err := Load(dir, writeData(t, "dead:\n  - { run: a, offsets: [3, 4], pixels: 50 }\n"))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, d := range c.Layout.Dead {
		got = append(got, fmt.Sprintf("%s:%v", d.Controller, d.Indices))
	}
	if s := strings.Join(got, " "); s != "shed:[50 59] shed:[60 61] shed:[3 4]" {
		t.Errorf("dead = %s", s)
	}
}
