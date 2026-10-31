// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package output turns rendered frames into per-controller wire data and
// hands it to sinks. Two seams:
//
//   - A Stage converts the linear-light frame buffer to bytes per
//     controller: power limiting, white handling, dithering and
//     quantising. Quantize is a minimal stage with none of the
//     refinements; the output-stage work replaces it.
//   - A Sink delivers controller frames: DDP over UDP in production, a
//     recorder in tests, Discard when running without output. DDP isn't
//     implemented here.
//
// Neither applies gamma: the buffer is already linear drive levels (see
// package color).
package output

import (
	"errors"
	"math"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
)

// Frame is one controller's data for one rendered frame.
type Frame struct {
	Controller int    // index into layout.Layout.Controllers
	ID         string // controller id
	Seq        uint64 // frame sequence number
	Time       time.Time
	Channels   int    // bytes per pixel: 3 (RGB) or 4 (RGBW)
	Data       []byte // pixel 0 first, Channels bytes each, R G B [W]
}

// Sink delivers controller frames. Send must not retain f or f.Data after
// it returns. The frame loop calls Send from one goroutine.
type Sink interface {
	Send(f *Frame) error
	Close() error
}

// Stage converts a rendered buffer into controller frames. out has one
// Frame per controller, in layout order, with Data already sized; Process
// fills it in.
type Stage interface {
	Process(f clock.Frame, buf *render.Buffer, out []Frame)
}

// Discard is a Sink that drops everything.
type Discard struct{}

// Send implements Sink.
func (Discard) Send(*Frame) error { return nil }

// Close implements Sink.
func (Discard) Close() error { return nil }

// Multi sends to several sinks.
type Multi []Sink

// Send implements Sink. It sends to every sink and joins the errors.
func (m Multi) Send(f *Frame) error {
	var errs []error
	for _, s := range m {
		errs = append(errs, s.Send(f))
	}
	return errors.Join(errs...)
}

// Close implements Sink.
func (m Multi) Close() error {
	var errs []error
	for _, s := range m {
		errs = append(errs, s.Close())
	}
	return errors.Join(errs...)
}

// Frames allocates one Frame per controller of l.
func Frames(l *layout.Layout) []Frame {
	out := make([]Frame, len(l.Controllers))
	for i, c := range l.Controllers {
		ch := 3
		if c.Config.Channels == "rgbw" {
			ch = 4
		}
		out[i] = Frame{Controller: i, ID: c.ID, Channels: ch, Data: make([]byte, c.Pixels*ch)}
	}
	return out
}

// Quantize is the minimal Stage: clamp, round to 8 bits, and fold white
// into RGB for RGB controllers. No power limiting or dithering.
type Quantize struct {
	Layout *layout.Layout
}

// Process implements Stage.
func (q Quantize) Process(f clock.Frame, buf *render.Buffer, out []Frame) {
	when := time.Unix(0, int64(f.T*1e9))
	for i := range out {
		o := &out[i]
		c := q.Layout.Controllers[o.Controller]
		o.Seq, o.Time = f.Seq, when
		for k := range c.Pixels {
			px := buf.Pix[int(c.Base)+k]
			d := o.Data[k*o.Channels:]
			if o.Channels == 4 {
				d[0], d[1], d[2], d[3] = byte8(px.R), byte8(px.G), byte8(px.B), byte8(px.W)
			} else {
				d[0], d[1], d[2] = byte8(px.R+px.W), byte8(px.G+px.W), byte8(px.B+px.W)
			}
		}
	}
}

func byte8(v float32) byte {
	if !(v > 0) {
		return 0
	}
	if v >= 1 {
		return 255
	}
	return byte(math.Round(float64(v) * 255))
}
