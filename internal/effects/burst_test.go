// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
)

// burstLine is 100 pixels along x at 0.1 m spacing, so pixel k is k/10 m
// from the origin.
func burstLine() *render.Context {
	n := 100
	c := &render.Context{Pitch: 0.1, Smooth: true, Seed: 7, Count: n}
	for k := range n {
		c.Pixels = append(c.Pixels, int32(k))
		c.U = append(c.U, float32(k)*0.1)
		c.X = append(c.X, float32(k)*0.1)
		c.Y = append(c.Y, 0)
		c.Z = append(c.Z, 0)
		c.Dl = append(c.Dl, 0.1)
		c.Stretch = append(c.Stretch, 1)
		c.Index = append(c.Index, int32(k))
	}
	return c
}

func TestBurstShellExpands(t *testing.T) {
	d := Burst()
	// One burst per 100 s slot, so exactly one is live, from the origin.
	v := resolve(t, d, map[string]any{"rate": "0.01 /s", "speed": "1 m/s", "width": "0.2 m", "life": "20 s",
		"glow": 0, "scatter": "0 m", "palette": "Party"}, 0.1)
	fx := d.New()
	ctx := burstLine()
	ctx.Params = v
	// Find the burst's start by scanning for the first lit frame.
	var t0 float64 = -1
	out := make([]color.Color, 100)
	for tm := 0.0; tm < 100 && t0 < 0; tm += 0.25 {
		ctx.T = tm
		fx.Render(ctx, out)
		for _, c := range out {
			if c.A > 0.05 {
				t0 = tm
				break
			}
		}
	}
	if t0 < 0 {
		t.Fatal("no burst in 100 s")
	}
	peak := func(tm float64) int {
		ctx.T = tm
		fx.Render(ctx, out)
		best, at := float32(0), -1
		for i, c := range out {
			if c.A > best {
				best, at = c.A, i
			}
		}
		return at
	}
	a, b := peak(t0+1), peak(t0+4)
	if b-a < 25 || b-a > 35 {
		t.Fatalf("shell moved from pixel %d to %d in 3 s at 1 m/s; want about 30 pixels", a, b)
	}
	// Dead after life.
	ctx.T = t0 + 25
	fx.Render(ctx, out)
	for i, c := range out {
		if c.A > 0 {
			t.Fatalf("pixel %d still lit %v after the burst's life", i, c.A)
		}
	}
	// Deterministic: the same seed and time give the same frame.
	ctx.T = t0 + 2
	fx.Render(ctx, out)
	again := make([]color.Color, 100)
	d.New().Render(ctx, again)
	for i := range out {
		if !near(out[i], again[i], 0) {
			t.Fatalf("pixel %d differs between renders", i)
		}
	}
}

func TestBurstNoPositions(t *testing.T) {
	d := Burst()
	v := resolve(t, d, nil, 0.1)
	ctx := burstLine()
	ctx.X, ctx.Y, ctx.Z = nil, nil, nil
	ctx.Params = v
	out := make([]color.Color, 100)
	d.New().Render(ctx, out)
	for _, c := range out {
		if c.A != 0 {
			t.Fatal("without positions a burst should paint nothing")
		}
	}
}
