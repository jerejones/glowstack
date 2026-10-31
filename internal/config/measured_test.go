// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const measuredLayout = "schema: 1\npitch: 1/60 m\nruns:\n" +
	"  - { id: a, controller: shed, indices: [0, 49], path: [x, y] }\n" +
	"  - { id: b, controller: shed, indices: [60, 89], path: [z, w] }\n" +
	"edges:\n  - { kind: gap, from: y, to: z, length: 1 m }\n"

func writeData(t *testing.T, body string) string {
	t.Helper()
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(data, AnchorsFileName), []byte("schema: 1\n"+body), 0o644); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestMeasuredEndsGapsAndDeadOverrideLayout(t *testing.T) {
	dir := writeConfig(t, map[string]string{LayoutFileName: measuredLayout})
	data := writeData(t, "ends:\n  - { run: a, last: 52 }\n  - { run: b, first: 58 }\n"+
		"gaps:\n  - { from: z, to: y, length: 1.25 m }\n"+
		"dead:\n  - { controller: shed, indices: [53, 57] }\n")
	c, err := Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Layout.Runs[0].Indices; got != [2]int{0, 52} {
		t.Errorf("run a indices = %v, want [0 52]", got)
	}
	if got := c.Layout.Runs[1].Indices; got != [2]int{58, 89} {
		t.Errorf("run b indices = %v, want [58 89]", got)
	}
	if got := c.Layout.Edges[0].Length.Value; got != 1.25 {
		t.Errorf("gap length = %v, want 1.25", got)
	}
	if len(c.Layout.Dead) != 1 || c.Layout.Dead[0].Indices != [2]int{53, 57} || c.Layout.Dead[0].Pos.File != AnchorsFileName {
		t.Errorf("dead = %+v", c.Layout.Dead)
	}
	if len(c.Ends) != 2 || len(c.Gaps) != 1 || len(c.MeasuredDead) != 1 {
		t.Errorf("kept overrides: %+v %+v %+v", c.Ends, c.Gaps, c.MeasuredDead)
	}
}

func TestMeasuredOverridesReportTheirLine(t *testing.T) {
	for _, tt := range []struct{ name, body, want string }{
		{"unknown run", "ends:\n  - { run: nope, last: 5 }\n", `anchors.yaml:3: ends: unknown run "nope"`},
		{"no end", "ends:\n  - { run: a }\n", "give first, last or both"},
		{"end outside controller", "ends:\n  - { run: a, last: 100 }\n", `anchors.yaml:3: run "a": index 100 outside controller`},
		{"no such gap", "gaps:\n  - { from: x, to: w, length: 1 m }\n", `no gap edge between "x" and "w"`},
		{"bad gap length", "gaps:\n  - { from: y, to: z, length: 0 m }\n", "positive length"},
		{"bad dead", "dead:\n  - { controller: shed, indices: [5, 200] }\n", "anchors.yaml:3: dead: bad index range"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := writeConfig(t, map[string]string{LayoutFileName: measuredLayout})
			_, err := Load(dir, writeData(t, tt.body))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}
