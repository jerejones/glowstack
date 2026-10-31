// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
)

func TestSolid(t *testing.T) {
	r := render.NewRegistry()
	if err := Register(r); err != nil {
		t.Fatal(err)
	}
	d, ok := r.ByWLED(0)
	if !ok || d.ID != "solid" {
		t.Fatalf("ByWLED(0) = %v", d)
	}
	v, err := render.Resolve(d.Params, map[string]any{"color": "#ffffff/ff"}, render.Env{Pitch: 0.1})
	if err != nil {
		t.Fatal(err)
	}
	out := make([]color.Color, 3)
	d.New().Render(&render.Context{Params: v, Pixels: []int32{0, 1, 2}}, out)
	for _, c := range out {
		if c != (color.Color{R: 1, G: 1, B: 1, W: 1, A: 1}) {
			t.Errorf("colour = %+v", c)
		}
	}
}
