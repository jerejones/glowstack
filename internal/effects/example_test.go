// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects_test

import (
	"math"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

// TestExamplePresetsRender puts every example preset on every area of the
// fictional installation (flows with stretch, unreached pixels, spatial
// mappings) and renders frames through the real pipeline.
func TestExamplePresetsRender(t *testing.T) {
	c := clock.NewManual(time.Date(2026, 10, 31, 20, 0, 0, 0, time.UTC))
	a, err := app.New(app.Options{ConfigDir: "../../examples/fictional/config", Clock: c})
	if err != nil {
		t.Fatal(err)
	}
	var lit int
	a.OnFrame(func(_ clock.Frame, b *render.Buffer) {
		for i, p := range b.Pix {
			for _, v := range []float32{p.R, p.G, p.B, p.W, p.A} {
				if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) || v < 0 {
					t.Fatalf("pixel %d = %+v", i, p)
				}
			}
			if p.R+p.G+p.B+p.W > 0 {
				lit++
			}
		}
	})
	for _, p := range a.Config.Presets {
		for _, area := range a.Layout.Areas {
			a.Stack.Clear()
			if _, err := a.Stack.Push(stack.Layer{Target: area.ID, Preset: p.ID}); err != nil {
				t.Fatalf("%s on %s: %v", p.ID, area.ID, err)
			}
			for f := range 3 {
				c.Advance(time.Second)
				if err := a.RenderFrame(clock.Frame{Seq: uint64(f), Time: c.Now(), T: clock.Seconds(c.Now()), Dt: 1}); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if lit == 0 {
		t.Error("nothing was lit")
	}
}
