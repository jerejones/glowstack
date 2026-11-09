// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package palette

import (
	"math"
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/units"
)

func near(a, b float32) bool { return math.Abs(float64(a-b)) < 1e-5 }

func TestPaletteAt(t *testing.T) {
	red, blue := units.Color{R: 255}, units.Color{B: 255}
	p := New("p", "P", []Stop{{0, red}, {0.5, blue}}, false, true)
	// Halfway between red (0) and blue (0.5).
	if c := p.At(0.25); !near(c.R, 0.5) || !near(c.B, 0.5) || c.A != 1 {
		t.Errorf("At(0.25) = %+v", c)
	}
	// Wrapping: 0.75 is halfway from blue back round to red.
	if c := p.At(0.75); !near(c.R, 0.5) || !near(c.B, 0.5) {
		t.Errorf("At(0.75) = %+v", c)
	}
	if c := p.At(1.25); !near(c.R, 0.5) {
		t.Errorf("At(1.25) = %+v", c)
	}
	clamped := New("q", "Q", []Stop{{0.2, red}, {0.8, blue}}, false, false)
	if c := clamped.At(0.9); c.B != 1 || c.R != 0 {
		t.Errorf("clamped At(0.9) = %+v", c)
	}
	if c := clamped.At(0.1); c.R != 1 {
		t.Errorf("clamped At(0.1) = %+v", c)
	}
	step := New("s", "S", []Stop{{0, red}, {0.5, blue}}, true, true)
	if c := step.At(0.49); c.R != 1 || c.B != 0 {
		t.Errorf("step At(0.49) = %+v", c)
	}
}

func TestRegistry(t *testing.T) {
	saved := Builtins
	defer func() { Builtins = saved }()
	b := New("rainbow", "Rainbow", []Stop{{0, units.Color{R: 255}}}, false, true)
	b.WLED = 11
	Builtins = []*Palette{b}
	tr := true
	r := NewRegistry([]config.Palette{{ID: "ember", Name: "Ember", Wrap: &tr, Stops: []config.Stop{{At: 0, Color: units.Color{R: 255}}}}})
	if p, ok := r.Get("ember"); !ok || p.Name != "Ember" {
		t.Errorf("Get(ember) = %v", p)
	}
	if p, ok := r.Get("RAINBOW"); !ok || p.ID != "rainbow" {
		t.Errorf("Get by name = %v", p)
	}
	if p, ok := r.ByWLED(11); !ok || p.ID != "rainbow" {
		t.Errorf("ByWLED = %v", p)
	}
	if len(r.All()) != 2 {
		t.Errorf("All = %d", len(r.All()))
	}
	p, err := r.Parse([]any{[]any{0.0, "#ff0000"}, []any{1, "#0000ff"}})
	if err != nil || len(p.Stops) != 2 {
		t.Errorf("inline = %v, %v", p, err)
	}
	if _, err := r.Parse("nope"); err == nil {
		t.Error("unknown palette: want error")
	}
}

func TestColorRoundTrip(t *testing.T) {
	c := color.Linear(units.Color{R: 128, G: 255, W: 64, HasW: true})
	if c.G != 1 || !near(c.R, float32(math.Pow(128.0/255, 2.8))) {
		t.Errorf("linear = %+v", c)
	}
	if a := c.Authored(); a.R != 128 || a.G != 255 || a.W != 64 {
		t.Errorf("authored = %+v", a)
	}
}

func TestRandomPaletteCacheIndependentOfRenderHistory(t *testing.T) {
	p, _ := NewRegistry(nil).ByWLED(1)
	const base = 1_790_000_000.0 // a random-cycle boundary
	var house, preview Cache
	house.Resolve(p, nil, base+0.001, nil)
	// The house already rendered within this 10 ms window. A freshly
	// scrubbed preview at the same time must still get the same colors.
	a := house.Resolve(p, nil, base+0.009, nil)
	b := preview.Resolve(p, nil, base+0.009, nil)
	for _, pos := range []float64{0, 0.25, 0.5, 0.75} {
		if ca, cb := a.At(pos), b.At(pos); ca != cb {
			t.Errorf("position %v: house %+v, preview %+v", pos, ca, cb)
		}
	}
}

// A palette with its own stops never reads the look's colors, and the color
// palettes read only the ones they use: what the Tweak form says about each.
func TestResolveUsesTheLookColorsOnlyWhenBuiltFromThem(t *testing.T) {
	red, green := color.Color{R: 1, A: 1}, color.Color{G: 1, A: 1}
	inline := New("inline", "Inline", []Stop{{0, units.Color{R: 255, G: 128}}, {1, units.Color{R: 255, G: 255}}}, false, true)
	if got := inline.Resolve([]color.Color{red, green}, 0, nil); got != inline {
		t.Fatalf("inline palette resolved to a different palette: %v", got)
	}
	first := &Palette{Special: SpecialColor1}
	if got, other := first.Resolve([]color.Color{red, green}, 0, nil).At(0.5), first.Resolve([]color.Color{red, red}, 0, nil).At(0.5); got != other {
		t.Fatalf("Color 1 depended on Color 2: %v vs %v", got, other)
	}
}
