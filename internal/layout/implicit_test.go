// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import "testing"

func TestImplicitRunAndControllerAreas(t *testing.T) {
	_, l, _ := loadExample(t, exampleData)
	porch, ok := l.Area("run:porch")
	if !ok || len(porch.Pixels) != 90 {
		t.Fatalf("run:porch = %v, %v", porch, ok)
	}
	first, _ := l.PixelID("yard", 390)
	if porch.Pixels[0] != first || porch.Pixels[89] != first+89 {
		t.Errorf("run:porch pixels %d…%d, want sorted from %d", porch.Pixels[0], porch.Pixels[89], first)
	}
	shed, ok := l.Area("controller:shed")
	if !ok || len(shed.Pixels) != 604 {
		t.Fatalf("controller:shed = %v", ok)
	}
	if _, ok := l.Area("run:nope"); ok {
		t.Error("unknown run resolved")
	}
	for _, a := range l.Areas {
		if a.ID == "run:porch" || a.ID == "controller:shed" {
			t.Errorf("implicit area %s listed in Areas", a.ID)
		}
	}
}
