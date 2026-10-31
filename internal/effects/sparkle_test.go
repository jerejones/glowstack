// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"math"
	"testing"

	"github.com/jerejones/glowstack/internal/color"
)

// TestSparkleEventCount checks the number of sparkle starts against
// density × length × time, on pixels of mixed physical sizes.
func TestSparkleEventCount(t *testing.T) {
	sp := sparkler{density: 2, life: 0.08, decay: 0.3, seed: 7}
	sp.init()
	const t0, dur = epoch, 50.0
	length, n := 0.0, 0
	for p := range 3000 {
		dl := 1.0 / 60
		if p%2 == 1 {
			dl = 1.0 / 30
		}
		length += dl
		for k := int64(math.Floor(t0/sp.slot)) - 1; float64(k)*sp.slot < t0+dur; k++ {
			sp.events(uint64(p), dl, k, func(start, _ float64) {
				if start >= t0 && start < t0+dur {
					n++
				}
			})
		}
	}
	want := sp.density * length * dur
	if math.Abs(float64(n)-want) > 4*math.Sqrt(want) {
		t.Errorf("%d sparkles, want %.0f ± %.0f", n, want, 4*math.Sqrt(want))
	}
}

// TestSparkleCoverage renders sparkle over 50 m of strip at two frame
// rates and two stretches, with different pixel sizes, and checks the
// time-averaged number of lit sparkles per metre (weighted by alpha)
// against density × the average lit time of one sparkle.
func TestSparkleCoverage(t *testing.T) {
	raw := map[string]any{"density": "2 /m/s", "lifetime": "80 ms", "decay": "300 ms"}
	gamma := color.DecodeGamma
	want := 2 * (0.08 + 0.3/(gamma+1)) // sparkles lit at once, per metre
	for _, tc := range []struct {
		pixels         int
		pitch, stretch float64
		fps            float64
	}{
		{3000, 1.0 / 60, 1, 30},
		{1500, 1.0 / 30, 2.5, 97},
		{3000, 1.0 / 60, 0.4, 60},
	} {
		s := newStrip(tc.pixels, tc.pitch, tc.stretch)
		v := resolve(t, Sparkle(), raw, tc.pitch)
		fx := Sparkle().New()
		out := make([]color.Color, tc.pixels)
		const dur = 20.0
		frames := int(dur * tc.fps)
		lit := 0.0
		for f := range frames {
			ctx := s.ctx(v, epoch+float64(f)/tc.fps)
			fx.Render(ctx, out)
			for _, c := range out {
				lit += float64(c.A)
			}
		}
		got := lit / float64(frames) / (float64(tc.pixels) * tc.pitch)
		t.Logf("%+v: %.4f (want %.4f)", tc, got, want)
		if math.Abs(got-want)/want > 0.1 {
			t.Errorf("%+v: %.4f lit per metre, want %.4f", tc, got, want)
		}
	}
}

func TestSparkleIgnoresStretch(t *testing.T) {
	raw := map[string]any{"density": "20 /m/s"}
	a := newStrip(500, 0.02, 1).render(t, Sparkle(), raw, epoch+0.3)
	b := newStrip(500, 0.02, 3).render(t, Sparkle(), raw, epoch+0.3)
	lit := 0
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("pixel %d differs with stretch: %+v vs %+v", i, a[i], b[i])
		}
		if a[i].A > 0 {
			lit++
		}
	}
	if lit == 0 {
		t.Error("nothing sparkled")
	}
}

func TestSparkleColours(t *testing.T) {
	s := newStrip(2000, 0.02, 1)
	out := s.render(t, Sparkle(), map[string]any{"density": "50 /m/s", "color": "#00ff00"}, epoch)
	green := lin("#00ff00")
	for i, c := range out {
		if c.A > 0 && !near(c.WithAlpha(1), green, 1e-6) {
			t.Fatalf("pixel %d = %+v", i, c)
		}
	}
	out = s.render(t, Sparkle(), map[string]any{"density": "50 /m/s", "palette": "Rainbow"}, epoch)
	hues := map[color.Color]bool{}
	for _, c := range out {
		if c.A > 0 {
			hues[c.WithAlpha(1)] = true
		}
	}
	if len(hues) < 10 {
		t.Errorf("palette sparkles: only %d colours", len(hues))
	}
}
