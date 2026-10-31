// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package output

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/units"
)

// testLayout lays the controllers out one after another.
func testLayout(cs ...config.Controller) *layout.Layout {
	l := &layout.Layout{}
	base := int32(0)
	for i := range cs {
		c := &cs[i]
		l.Controllers = append(l.Controllers, layout.Controller{ID: c.ID, Base: base, Pixels: c.Pixels, Config: c})
		for k := range c.Pixels {
			l.Pixels = append(l.Pixels, layout.Pixel{Controller: int16(i), Index: int32(k)})
		}
		base += int32(c.Pixels)
	}
	return l
}

func settings(group string, release time.Duration, dither bool) *config.Config {
	r := units.Duration(release)
	return &config.Config{Settings: config.Settings{Power: config.PowerPolicy{Group: group, Release: &r}, Dither: &dither}}
}

// twoControllers: shed (RGB, two outputs of 10 px, pin 1 limited to
// 100 mA) and yard (RGB, one unlimited output of 10 px). 10 mA per
// channel, no idle current.
func twoControllers() *layout.Layout {
	ma := &config.Power{LedMA: config.LedMA{R: 10, G: 10, B: 10}}
	return testLayout(
		config.Controller{ID: "shed", Pixels: 20, Channels: "rgb", Power: ma, Outputs: []config.Output{
			{Pin: 1, Start: 0, Count: 10, MaxMA: 100},
			{Pin: 2, Start: 10, Count: 10},
		}},
		config.Controller{ID: "yard", Pixels: 10, Channels: "rgb", Power: ma, Outputs: []config.Output{
			{Pin: 1, Start: 0, Count: 10},
		}},
	)
}

func fill(buf *render.Buffer, c color.Color) {
	for i := range buf.Pix {
		buf.Pix[i] = c
	}
}

func run(t *testing.T, p *Pipeline, l *layout.Layout, buf *render.Buffer, seq uint64, at float64) []Frame {
	t.Helper()
	out := Frames(l)
	p.Process(clock.Frame{Seq: seq, T: at, Dt: 0.025}, buf, out)
	return out
}

func TestPowerGroups(t *testing.T) {
	// Every pixel red at full: 10 mA each, so shed pin 1 asks for 100 mA
	// against a 50 mA limit and needs 0.5.
	red := color.Color{R: 1, A: 1}
	for _, tc := range []struct {
		group           string
		shed2, yard     byte // shed pin 2 and yard red levels
		wantScale, need float64
	}{
		{GroupGlobal, 128, 128, 0.5, 0.5},
		{GroupController, 128, 255, 0.5, 0.5},
		{GroupOutput, 255, 255, 0.5, 0.5},
	} {
		t.Run(tc.group, func(t *testing.T) {
			l := twoControllers()
			l.Controllers[0].Config.Outputs[0].MaxMA = 50
			p, err := NewPipeline(l, settings(tc.group, 0, false))
			if err != nil {
				t.Fatal(err)
			}
			buf := render.NewBuffer(len(l.Pixels))
			fill(buf, red)
			out := run(t, p, l, buf, 1, 100)
			if got := out[0].Data[0]; got != 128 {
				t.Errorf("shed pin 1: %d", got)
			}
			if got := out[0].Data[10*3]; got != tc.shed2 {
				t.Errorf("shed pin 2: %d, want %d", got, tc.shed2)
			}
			if got := out[1].Data[0]; got != tc.yard {
				t.Errorf("yard: %d, want %d", got, tc.yard)
			}
			r := p.Power()
			if r.Scale != tc.wantScale || r.Group != tc.group {
				t.Errorf("scale %v group %q", r.Scale, r.Group)
			}
			o := r.Outputs[0]
			if o.Controller != "shed" || o.Pin != 1 || o.RequestedMA != 100 || o.DrawnMA != 50 || o.Need != tc.need || o.Applied != 0.5 {
				t.Errorf("shed pin 1 report %+v", o)
			}
			if y := r.Outputs[2]; y.Controller != "yard" || y.RequestedMA != 100 || y.MaxMA != 0 {
				t.Errorf("yard report %+v", y)
			}
		})
	}
}

func TestControllerTotalAndIdle(t *testing.T) {
	l := twoControllers()
	c := l.Controllers[0].Config
	c.Outputs[0].MaxMA = 0
	c.Power = &config.Power{MaxMA: 120, LedMA: config.LedMA{R: 10, G: 10, B: 10, Idle: 1}}
	p, err := NewPipeline(l, settings(GroupOutput, 0, false))
	if err != nil {
		t.Fatal(err)
	}
	buf := render.NewBuffer(len(l.Pixels))
	fill(buf, color.Color{R: 1, A: 1})
	out := run(t, p, l, buf, 1, 100)
	// shed: 20 px × 10 mA + 20 mA idle = 220 > 120. Channel budget 100 of
	// 200 → 0.5, on both outputs (the total covers the whole controller).
	if out[0].Data[0] != 128 || out[0].Data[19*3] != 128 || out[1].Data[0] != 255 {
		t.Errorf("levels %d %d %d", out[0].Data[0], out[0].Data[19*3], out[1].Data[0])
	}
	r := p.Power()
	if tot := r.Controllers[0]; tot.RequestedMA != 220 || tot.DrawnMA != 120 || tot.MaxMA != 120 {
		t.Errorf("total %+v", tot)
	}
}

func TestPowerZones(t *testing.T) {
	cfg, err := config.Load("../../examples/fictional/config", "")
	if err != nil {
		t.Fatal(err)
	}
	l, err := layout.Build(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Zones: the shed alone, and the yard plus porch. Limit only the shed's
	// tower output.
	cfg.Zones = []config.Zone{{ID: "a", Area: "shed"}, {ID: "b", Area: "yard"}, {ID: "c", Area: "porch"}}
	shed := cfg.Controllers[0]
	for i := range shed.Outputs {
		shed.Outputs[i].MaxMA = 0
	}
	shed.Power.MaxMA = 0
	shed.Outputs[1].MaxMA = 120*20/2 + 120 // tower: half its white current plus idle
	cfg.Controllers[1].Outputs[0].MaxMA = 0
	r := units.Duration(0)
	cfg.Settings.Power = config.PowerPolicy{Group: GroupZone, Release: &r}
	off := false
	cfg.Settings.Dither = &off
	p, err := NewPipeline(l, cfg)
	if err != nil {
		t.Fatal(err)
	}
	buf := render.NewBuffer(len(l.Pixels))
	fill(buf, color.Color{W: 1, A: 1})
	out := Frames(l)
	p.Process(clock.Frame{T: 1}, buf, out)
	if got := out[0].Data[10*4+3]; got != 128 {
		t.Errorf("shed eave W %d, want 128 (same zone as the tower)", got)
	}
	if got := out[1].Data[0]; got != 255 {
		t.Errorf("yard %d, want 255 (other zone)", got)
	}
}

func TestPowerSmoothing(t *testing.T) {
	l := twoControllers()
	l.Controllers[0].Config.Outputs[0].MaxMA = 50
	p, err := NewPipeline(l, settings(GroupGlobal, time.Second, false))
	if err != nil {
		t.Fatal(err)
	}
	buf := render.NewBuffer(len(l.Pixels))
	fill(buf, color.Color{R: 1, A: 1}) // shed pin 1 needs 0.5
	run(t, p, l, buf, 1, 100)
	if s := p.Power().Scale; s != 0.5 {
		t.Fatalf("attack: scale %v, want 0.5 at once", s)
	}
	fill(buf, color.Color{R: 0.25, A: 1}) // no longer over the limit
	run(t, p, l, buf, 2, 100.025)
	want := 1 - 0.5*math.Exp(-0.025)
	if s := p.Power().Outputs[0].Need; math.Abs(s-want) > 1e-9 {
		t.Errorf("release after one frame: %v, want %v", s, want)
	}
	for i := range 400 { // 10 s
		run(t, p, l, buf, uint64(3+i), 100.05+float64(i)*0.025)
	}
	if s := p.Power().Scale; s < 0.9999 {
		t.Errorf("not recovered: %v", s)
	}
	fill(buf, color.Color{R: 1, A: 1})
	run(t, p, l, buf, 999, 200)
	if s := p.Power().Scale; s != 0.5 {
		t.Errorf("second attack %v", s)
	}
}

func TestWhiteHandling(t *testing.T) {
	l := testLayout(
		config.Controller{ID: "a", Pixels: 1, Channels: "rgbw", White: "explicit"},
		config.Controller{ID: "b", Pixels: 1, Channels: "rgbw", White: "auto"},
		config.Controller{ID: "c", Pixels: 1, Channels: "rgb", White: "explicit"},
	)
	p, err := NewPipeline(l, settings(GroupGlobal, 0, false))
	if err != nil {
		t.Fatal(err)
	}
	buf := render.NewBuffer(3)
	fill(buf, color.Color{R: 0.2, B: 0.8, W: 0.4, A: 1})
	out := run(t, p, l, buf, 1, 1)
	want := [][]byte{{51, 0, 204, 102}, {153, 102, 255, 0}, {153, 102, 255}}
	for i, w := range want {
		if string(out[i].Data) != string(w) {
			t.Errorf("%s: %v, want %v", out[i].ID, out[i].Data, w)
		}
	}
}

func TestDitherAverages(t *testing.T) {
	l := testLayout(config.Controller{ID: "a", Pixels: 4, Channels: "rgbw"})
	p, err := NewPipeline(l, settings(GroupGlobal, 0, true))
	if err != nil {
		t.Fatal(err)
	}
	buf := render.NewBuffer(4)
	targets := []float32{0.3 / 255, 2.5 / 255, 100.7 / 255, 254.2 / 255}
	for i, v := range targets {
		buf.Pix[i] = color.Color{R: v, G: 0, B: 1, W: v, A: 1}
	}
	const n = 1000
	sum := make([]float64, 4)
	seen := map[byte]bool{}
	for f := range n {
		out := run(t, p, l, buf, uint64(f), float64(f)/40)
		for i := range 4 {
			d := out[0].Data[i*4:]
			sum[i] += float64(d[0])
			if d[1] != 0 || d[2] != 255 {
				t.Fatalf("frame %d px %d: 0 and 1 must be exact, got %v", f, i, d[:4])
			}
			if i == 1 {
				seen[d[0]] = true
			}
		}
	}
	for i, v := range targets {
		if avg := sum[i] / n; math.Abs(avg-float64(v)*255) > 0.01 {
			t.Errorf("px %d: average %.4f, want %.4f", i, avg, v*255)
		}
	}
	if !seen[2] || !seen[3] || len(seen) != 2 {
		t.Errorf("2.5 should alternate between 2 and 3: %v", seen)
	}
	// Without dithering the same buffer rounds.
	p2, _ := NewPipeline(l, settings(GroupGlobal, 0, false))
	out := Frames(l)
	p2.Process(clock.Frame{T: 1}, buf, out)
	if out[0].Data[0] != 0 || out[0].Data[8] != 101 {
		t.Errorf("rounding %v", out[0].Data)
	}
}

func TestDitherByteBounds(t *testing.T) {
	r := float32(0.4999)
	if b := ditherByte(254.99/255, &r); b != 255 {
		t.Errorf("near full %d", b)
	}
	r = 0.4999
	if b := ditherByte(1, &r); b != 255 {
		t.Errorf("full %d", b)
	}
	r = -0.5
	if b := ditherByte(0, &r); b != 0 {
		t.Errorf("zero %d", b)
	}
}

func TestCheck(t *testing.T) {
	l := testLayout(
		config.Controller{ID: "long", Pixels: 1000, Channels: "rgbw", MaxFPS: 40, Outputs: []config.Output{{Pin: 1, Count: 1000, MaxMA: 5000}}},
		config.Controller{ID: "ok", Pixels: 1000, Channels: "rgb", Outputs: []config.Output{{Pin: 1, Count: 500}, {Pin: 2, Start: 500, Count: 500}}},
	)
	ws := Check(l, 40)
	if len(ws) != 2 || !strings.Contains(ws[0], "long: max_fps 40") || !strings.Contains(ws[0], "at most 25 fps") || !strings.Contains(ws[1], "led_ma") {
		t.Errorf("%q", ws)
	}
	if fps, n := WireFPS(&l.Controllers[1]); n != 500 || math.Abs(fps-66.67) > 0.01 {
		t.Errorf("wire fps %v %d", fps, n)
	}
}

func TestSelect(t *testing.T) {
	l := twoControllers()
	for spec, want := range map[string]string{"all": "[0 1]", "": "[0 1]", "none": "[]", "yard": "[1]", "yard, shed": "[0 1]"} {
		got, err := Select(l, spec)
		if err != nil || fmt.Sprint(got) != want {
			t.Errorf("%q: %v %v, want %s", spec, got, err, want)
		}
	}
	if _, err := Select(l, "shed,gate"); err == nil || !strings.Contains(err.Error(), "gate") {
		t.Errorf("unknown id: %v", err)
	}
}

func BenchmarkPipeline(b *testing.B) {
	// 25,000 RGBW pixels on 10 controllers of 4 outputs, all limited.
	var cs []config.Controller
	for i := range 10 {
		c := config.Controller{ID: fmt.Sprint("c", i), Pixels: 2500, Channels: "rgbw",
			Power: &config.Power{MaxMA: 20000, LedMA: config.LedMA{R: 12, G: 12, B: 12, W: 20, Idle: 1}}}
		for o := range 4 {
			c.Outputs = append(c.Outputs, config.Output{Pin: o + 1, Start: o * 625, Count: 625, MaxMA: 6000})
		}
		cs = append(cs, c)
	}
	l := testLayout(cs...)
	p, err := NewPipeline(l, settings(GroupGlobal, time.Second, true))
	if err != nil {
		b.Fatal(err)
	}
	buf := render.NewBuffer(len(l.Pixels))
	for i := range buf.Pix {
		buf.Pix[i] = color.Color{R: float32(i%256) / 255, G: 0.3, B: 0.01, W: 0.5, A: 1}
	}
	out := Frames(l)
	b.ResetTimer()
	for i := range b.N {
		p.Process(clock.Frame{Seq: uint64(i), T: float64(i) / 40, Dt: 0.025}, buf, out)
	}
}

func TestPipelineRebuild(t *testing.T) {
	l := twoControllers()
	l.Controllers[0].Config.Outputs[0].MaxMA = 50
	p, err := NewPipeline(l, settings(GroupGlobal, 0, false))
	if err != nil {
		t.Fatal(err)
	}
	red := color.Color{R: 1, A: 1}
	buf := render.NewBuffer(len(l.Pixels))
	fill(buf, red)
	run(t, p, l, buf, 1, 100)
	if r := p.Power(); r.Scale != 0.5 || len(r.Outputs) != 3 {
		t.Fatalf("before: %+v", r)
	}

	// The reload drops yard and lifts shed's limit.
	ma := &config.Power{LedMA: config.LedMA{R: 10, G: 10, B: 10}}
	l2 := testLayout(config.Controller{ID: "shed", Pixels: 20, Channels: "rgb", Power: ma, Outputs: []config.Output{
		{Pin: 1, Start: 0, Count: 20},
	}})
	if err := p.Rebuild(settings(GroupGlobal, 0, false), l2); err != nil {
		t.Fatal(err)
	}
	if r := p.Power(); len(r.Outputs) != 1 || len(r.Controllers) != 1 {
		t.Fatalf("report not rebuilt: %+v", r)
	}
	buf = render.NewBuffer(len(l2.Pixels))
	fill(buf, red)
	out := run(t, p, l2, buf, 2, 100.025)
	if len(out) != 1 || out[0].Data[0] != 255 || out[0].Data[19*3] != 255 {
		t.Errorf("after rebuild: %v", out[0].Data[:6])
	}
	if r := p.Power(); r.Scale != 1 || r.Outputs[0].RequestedMA != 200 {
		t.Errorf("after: %+v", r)
	}
}
