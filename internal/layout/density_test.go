// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"math"
	"slices"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
)

// loopDoc is a 1 m square loop: the run starts at corner s and goes round
// c1, c2 and c3 back to s.
const loopDoc = `{"scenes":[{"extras":{"glowstack":{"schema":1,"units":"m","axes":"gltf-y-up"}}}],
 "nodes":[{"extras":{"glowstack_run":"r","points":[[0,0,0],[1,0,0],[1,0,-1],[0,0,-1],[0,0,0.001]],"nodes":"s,c1,c2,c3,e"}}]}`

// loop is a 540-pixel run round loopDoc with c1 measured at index at.
func loop(t *testing.T, at int) *Layout {
	t.Helper()
	g := sceneGraph(t)
	g.cfg.Controllers[0].Pixels = 540
	g.cfg.Layout.Runs[0].Indices = [2]int{0, 539}
	g.cfg.Layout.Runs[0].Anchors = []config.Anchor{{Node: "c1", Index: &at, Source: config.SourceMeasured}}
	l, err := buildScene(t, g, loopDoc)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestDensityRightCorner(t *testing.T) {
	if l := loop(t, 134); len(l.Density) != 0 {
		t.Errorf("density issues: %v", l.Density)
	}
}

// TestDensityWrongCorner: c1 saved at the opposite corner (270 of 540)
// puts half the pixels on a quarter of the loop: 2× there, 0.67× on the
// rest. Both stretches warn, naming the anchor.
func TestDensityWrongCorner(t *testing.T) {
	l := loop(t, 269)
	if len(l.Density) != 2 {
		t.Fatalf("density issues: %v", l.Density)
	}
	hi, lo := l.Density[0], l.Density[1]
	if hi.From != "s" || hi.To != "c1" || hi.Ratio < 1.9 || hi.Ratio > 2.1 {
		t.Errorf("first stretch: %+v", hi)
	}
	if lo.From != "c1" || lo.To != "e" || lo.Ratio < 0.6 || lo.Ratio > 0.7 {
		t.Errorf("second stretch: %+v", lo)
	}
	if !slices.Equal(hi.Measured, []string{"c1"}) {
		t.Errorf("measured = %v", hi.Measured)
	}
	n := 0
	for _, w := range l.Warnings {
		if strings.Contains(w.Error(), "check that the anchor at c1 is on the right node") {
			n++
		}
	}
	if n != 2 {
		t.Errorf("warnings = %v", l.Warnings)
	}
}

// TestSpacing: a stretch the density check flags reads as tighter or looser
// than drawn pixel by pixel, not as even (B52: Spacing mode drew a flow's
// stretch, which is 1 on most runs whatever their pixels do).
func TestSpacing(t *testing.T) {
	l := loop(t, 269) // 2× the pixels on the first stretch, 0.67× after
	sp := l.Spacing()
	if s := float64(sp[100]); math.Abs(s-0.5) > 0.03 {
		t.Errorf("flagged-tight stretch: spacing %v, want about 0.5", s)
	}
	if s := float64(sp[400]); math.Abs(s-1.5) > 0.05 {
		t.Errorf("flagged-loose stretch: spacing %v, want about 1.5", s)
	}
	even := loop(t, 134).Spacing()
	if s := float64(even[100]); math.Abs(s-1) > 0.02 {
		t.Errorf("right corner: spacing %v, want about 1", s)
	}
}

// TestDensityTolerance: 20% off doesn't warn, 30% off does.
func TestDensityTolerance(t *testing.T) {
	if l := loop(t, 134+27); len(l.Density) != 0 {
		t.Errorf("20%% off: %v", l.Density)
	}
	if l := loop(t, 134+41); len(l.Density) == 0 {
		t.Errorf("30%% off: no warning")
	}
}

// TestAllArea: "all" is every pixel on a run, whatever the areas say.
func TestAllArea(t *testing.T) {
	g := newGraph(t).run("r", 10, "a", "b").run("q", 5, "c", "d")
	g.next += 3 // three pixels in no run
	l := g.build()
	a, ok := l.Area(AreaAll)
	if !ok || len(a.Pixels) != 15 || a.Pixels[0] != 0 || a.Pixels[14] != 14 {
		t.Fatalf("all = %v %v", a, ok)
	}
}

// TestAreaOffsetsCountFromTheRun: an area's offsets count from its run's
// lowest LED, not the controller's first.
func TestAreaOffsetsCountFromTheRun(t *testing.T) {
	g := newGraph(t).run("r", 10, "a", "b").run("q", 10, "c", "d")
	g.cfg.Areas = []config.Area{areaOf(config.AreaPart{Run: "q", From: index(2), To: index(4)})}
	l := g.build()
	a, _ := l.Area("x")
	if !slices.Equal(a.Pixels, []int32{12, 13, 14}) {
		t.Errorf("pixels = %v", a.Pixels)
	}
}
