// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package names

import (
	"encoding/json"
	"os"
	"testing"
)

func TestHumanizeTable(t *testing.T) {
	b, err := os.ReadFile("testdata/humanize.json")
	if err != nil {
		t.Fatal(err)
	}
	var table [][2]string
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	for _, c := range table {
		if got := Humanize(c[0]); got != c[1] {
			t.Errorf("Humanize(%q) = %q, want %q", c[0], got, c[1])
		}
	}
}

func TestRun(t *testing.T) {
	if got := Run("unassigned-side-yard"); got != "Side yard" {
		t.Error(got)
	}
	if got := Run("unassigned"); got != "Unassigned" {
		t.Error(got)
	}
	if got := Run("shed-eave"); got != "Shed eave" {
		t.Error(got)
	}
}

func TestNode(t *testing.T) {
	cases := []struct{ id, label, want string }{
		{"shed-sw", "", "Shed SW"},
		{"shed-ne", "shed NE corner", "Shed NE corner"},
		{"post-1", "post-a-1: garden post bend (site estimate)", "Post a 1"},
		{"post-1", "Garden post (site estimate)", "Garden post"},
	}
	for _, c := range cases {
		if got := Node(c.id, c.label); got != c.want {
			t.Errorf("Node(%q, %q) = %q, want %q", c.id, c.label, got, c.want)
		}
	}
}

func TestZone(t *testing.T) {
	cases := []struct{ id, name, want string }{
		{"front", "Glowstack Front", "Front"},
		{"front", "glowstack-front yard", "front yard"},
		{"porch", "", "Porch"},
		{"porch", "porch", "Porch"},
		{"porch", "Glowstack", "Porch"},
		{"shed", "Shed lights", "Shed lights"},
	}
	for _, c := range cases {
		if got := Zone(c.id, c.name); got != c.want {
			t.Errorf("Zone(%q, %q) = %q, want %q", c.id, c.name, got, c.want)
		}
	}
}

func TestInternalArea(t *testing.T) {
	for id, want := range map[string]bool{"status-broken": true, "_all": true, "porch": false, "statusy": false} {
		if got := InternalArea(id); got != want {
			t.Errorf("InternalArea(%q) = %v", id, got)
		}
	}
}
