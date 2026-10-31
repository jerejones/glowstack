// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package palette

import (
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/units"
)

func sameColor(a, b color.Color) bool {
	return near(a.R, b.R) && near(a.G, b.G) && near(a.B, b.B) && near(a.W, b.W)
}

func lin(x uint32) color.Color { return color.Linear(rgb(x)) }

func TestBuiltinsMatchWLED(t *testing.T) {
	if len(Builtins) != WLEDFixedCount {
		t.Fatalf("%d built-ins, want %d", len(Builtins), WLEDFixedCount)
	}
	ids := map[string]bool{}
	for i, p := range Builtins {
		if p.WLED != i {
			t.Errorf("Builtins[%d] %q has WLED id %d", i, p.Name, p.WLED)
		}
		if ids[p.ID] || p.ID == "" {
			t.Errorf("id %q repeated or empty", p.ID)
		}
		ids[p.ID] = true
		if len(p.Stops) == 0 {
			t.Errorf("%s has no stops", p.Name)
		}
	}
	for id, name := range map[int]string{
		0: "Default", 1: "* Random Cycle", 2: "* Color 1", 5: "* Colors Only", 6: "Party",
		11: "Rainbow", 12: "Rainbow Bands", 13: "Sunset", 16: "Red & Blue", 35: "Fire",
		50: "Aurora", 59: "Fairy Reaf", 72: "Fireworks",
	} {
		if Builtins[id].Name != name {
			t.Errorf("WLED palette %d = %q, want %q", id, Builtins[id].Name, name)
		}
	}
	r := NewRegistry(nil)
	if p, ok := r.Get("red-blue"); !ok || p.WLED != 16 {
		t.Errorf("Get(red-blue) = %v", p)
	}
	if p, ok := r.Get("* colors 1&2"); !ok || p.ID != "colors-1-2" || p.Special != SpecialColors12 {
		t.Errorf("Get(* Colors 1&2) = %+v", p)
	}
}

func TestWLEDPaletteData(t *testing.T) {
	r := NewRegistry(nil)
	// Gradient palettes keep their stops: Sunset starts 0:(181,0,0), 22:(218,85,0).
	sunset, _ := r.ByWLED(13)
	if c := sunset.At(0); !sameColor(c, lin(0xb50000)) {
		t.Errorf("Sunset at 0 = %+v", c)
	}
	if c := sunset.At(22.0 / 255); !sameColor(c, lin(0xda5500)) {
		t.Errorf("Sunset at 22 = %+v", c)
	}
	// 16-entry palettes are 16 wrapping stops.
	rainbow, _ := r.ByWLED(11)
	if c := rainbow.At(1.0 / 16); !sameColor(c, lin(0xeb7000)) {
		t.Errorf("Rainbow entry 1 = %+v", c)
	}
	if c, want := rainbow.At(1.0/32), color.Lerp(lin(0xff0000), lin(0xeb7000), 0.5); !sameColor(c, want) {
		t.Errorf("Rainbow between entries 0 and 1 = %+v, want %+v", c, want)
	}
	if c, want := rainbow.At(15.0/16+1.0/32), color.Lerp(lin(0xeb0072), lin(0xff0000), 0.5); !sameColor(c, want) {
		t.Errorf("Rainbow wrapping 15 → 0 = %+v, want %+v", c, want)
	}
	// FastLED color names: Cloud's entry 10 is SkyBlue.
	cloud, _ := r.Get("Cloud")
	if c := cloud.At(10.0 / 16); !sameColor(c, lin(0x87ceeb)) {
		t.Errorf("Cloud entry 10 = %+v", c)
	}
}

func TestSpecialPalettes(t *testing.T) {
	r := NewRegistry(nil)
	get := func(name string) *Palette {
		p, ok := r.Get(name)
		if !ok {
			t.Fatalf("no palette %q", name)
		}
		return p
	}
	red, green, blue := lin(0xff0000), lin(0x00ff00), lin(0x0000ff)
	cols := []color.Color{red, green, blue}

	if c := get("* Color 1").Resolve(cols, 0, nil).At(0.7); !sameColor(c, red) {
		t.Errorf("* Color 1 = %+v", c)
	}
	c12 := get("* Colors 1&2").Resolve(cols, 0, nil)
	if !sameColor(c12.At(0.2), red) || !sameColor(c12.At(10.0/16), green) {
		t.Errorf("* Colors 1&2 = %+v / %+v", c12.At(0.2), c12.At(10.0/16))
	}
	grad := get("* Color Gradient").Resolve(cols, 0, nil)
	if !sameColor(grad.At(0), blue) || !sameColor(grad.At(0.5), green) || !sameColor(grad.At(15.0/16), red) {
		t.Errorf("* Color Gradient is wrong")
	}
	only := get("* Colors Only")
	if c := only.Resolve(cols, 0, nil).At(11.0 / 16); !sameColor(c, blue) {
		t.Errorf("* Colors Only with three colors: %+v", c)
	}
	if c := only.Resolve(cols[:2], 0, nil).At(11.0 / 16); !sameColor(c, green) {
		t.Errorf("* Colors Only without a third color: %+v", c)
	}

	def := get("Default")
	ocean, _ := r.Get("ocean")
	if def.Resolve(cols, 0, ocean) != ocean {
		t.Error("Default with an effect default should be that palette")
	}
	if p := def.Resolve(cols, 0, nil); p.Name != "Party" {
		t.Errorf("Default without one = %s, want Party", p.Name)
	}
	if c := def.Resolve(cols, 0, get("* Color 1")).At(0.3); !sameColor(c, red) {
		t.Errorf("Default → * Color 1 = %+v", c)
	}

	rnd := get("* Random Cycle")
	a, b := rnd.Resolve(nil, 1000.5*RandomCycle, nil), rnd.Resolve(nil, 1000.5*RandomCycle, nil)
	if !sameColor(a.At(0.3), b.At(0.3)) {
		t.Error("random cycle isn't a function of time")
	}
	if c := rnd.Resolve(nil, 1001.5*RandomCycle, nil); sameColor(a.At(0.3), c.At(0.3)) {
		t.Error("random cycle didn't change between slots")
	}
	// At the start of a slot it still shows the previous slot's palette.
	start := rnd.Resolve(nil, 1001*RandomCycle, nil)
	if !sameColor(start.At(0.3), a.At(0.3)) {
		t.Error("random cycle should cross-fade from the previous palette")
	}
}

func TestCache(t *testing.T) {
	r := NewRegistry(nil)
	c1, _ := r.Get("color-1")
	red, blue := []color.Color{lin(0xff0000)}, []color.Color{lin(0x0000ff)}
	var c Cache
	a := c.Resolve(c1, red, 0, nil)
	if c.Resolve(c1, red, 10, nil) != a {
		t.Error("cache didn't reuse an unchanged palette")
	}
	if b := c.Resolve(c1, blue, 10, nil); b == a || !sameColor(b.At(0), blue[0]) {
		t.Error("cache didn't follow a color change")
	}
	rainbow, _ := r.Get("rainbow")
	if c.Resolve(rainbow, red, 0, nil) != rainbow {
		t.Error("plain palettes pass through")
	}
}

func TestUserPaletteWLEDIds(t *testing.T) {
	tr := true
	stop := []config.Stop{{At: 0, Color: units.Color{R: 255}}}
	r := NewRegistry([]config.Palette{
		{ID: "ember", Stops: stop, Wrap: &tr},
		{ID: "frost", Stops: stop, Wrap: &tr},
		{ID: "lava", Name: "My lava", Stops: stop, Wrap: &tr}, // replaces the built-in
	})
	if p, _ := r.Get("ember"); p.WLED != WLEDCustomBase {
		t.Errorf("ember WLED id %d", p.WLED)
	}
	if p, _ := r.Get("frost"); p.WLED != WLEDCustomBase-1 {
		t.Errorf("frost WLED id %d", p.WLED)
	}
	if p, _ := r.Get("lava"); p.WLED != 8 || p.Name != "My lava" {
		t.Errorf("replaced Lava = %+v", p)
	}
	list := r.WLEDList()
	if len(list) != WLEDFixedCount+2 || list[8].Name != "My lava" || list[73].ID != "ember" || list[74].ID != "frost" {
		t.Errorf("WLEDList order wrong: %d entries", len(list))
	}
}
