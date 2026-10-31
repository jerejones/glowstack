// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package output

import (
	"bytes"
	"errors"
	"math"
	"testing"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
)

func TestQuantize(t *testing.T) {
	l := &layout.Layout{Controllers: []layout.Controller{
		{ID: "shed", Base: 0, Pixels: 2, Config: &config.Controller{Channels: "rgbw"}},
		{ID: "yard", Base: 2, Pixels: 2, Config: &config.Controller{Channels: "rgb"}},
	}}
	buf := render.NewBuffer(4)
	buf.Pix[0] = color.Color{R: 1, G: 0.5, B: -1, W: 2}
	buf.Pix[2] = color.Color{R: 0.2, W: 0.5}
	buf.Pix[3] = color.Color{R: float32(math.NaN())}
	out := Frames(l)
	Quantize{Layout: l}.Process(clock.Frame{Seq: 7, T: 1.5}, buf, out)
	if want := []byte{255, 128, 0, 255, 0, 0, 0, 0}; !bytes.Equal(out[0].Data, want) || out[0].Channels != 4 {
		t.Errorf("rgbw: %v", out[0].Data)
	}
	if want := []byte{178, 128, 128, 0, 0, 0}; !bytes.Equal(out[1].Data, want) {
		t.Errorf("rgb: %v", out[1].Data)
	}
	if out[1].Seq != 7 || out[1].Time.UnixMilli() != 1500 || out[1].ID != "yard" {
		t.Errorf("frame header %+v", out[1])
	}
}

type failing struct{ closed bool }

func (f *failing) Send(*Frame) error { return errors.New("unreachable") }
func (f *failing) Close() error      { f.closed = true; return nil }

func TestMulti(t *testing.T) {
	f := &failing{}
	m := Multi{Discard{}, f}
	if err := m.Send(&Frame{}); err == nil {
		t.Error("error lost")
	}
	if err := m.Close(); err != nil || !f.closed {
		t.Error("close")
	}
}

