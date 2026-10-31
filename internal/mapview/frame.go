// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"encoding/binary"
	"math"
	"slices"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
)

// Snapshot is one captured frame for the map. It's immutable once
// published and shared by every client.
type Snapshot struct {
	Seq     uint32 // map frame number, set by publish
	Gen     uint64 // reload generation of the layout it was rendered on
	T       float64
	Time    time.Time
	Preview bool     // rendered by the map on the preview clock
	Paused  bool     // the preview clock was paused
	RGB     []byte   // display RGB per global id (see displayLUT)
	Top     []int32  // per pixel: index into Layers of the layer showing, or -1
	Layers  []string // layer ids, top first
	Power   []OutputPower
}

// Frame message layout, little-endian. A frame is one binary websocket
// message:
//
//	0   u8   version (1)
//	1   u8   flags: bit 0 preview, bit 1 preview clock paused
//	2   u16  reserved (0)
//	4   u32  map frame number
//	8   f64  frame time, Unix seconds
//	16  RGB  3 bytes per pixel, for the client's subscribed ranges in
//	         order (all pixels in global-id order by default)
const (
	frameVersion   = 1
	frameHeader    = 16
	flagPreview    = 1 << 0
	flagPaused     = 1 << 1
	displayLUTBits = 16
)

// displayLUT turns linear light into display bytes. The map shows the
// colour as it was authored, so it re-encodes with the same gamma the
// authored colours were decoded with (color.DecodeGamma): "#ff8000" on a
// layer shows as #ff8000 on the map. That's what a designer expects to
// see; it isn't a photometric simulation of the LEDs.
var displayLUT = func() []byte {
	t := make([]byte, 1<<displayLUTBits)
	for i := range t {
		t[i] = color.Encode(float32(i) / float32(len(t)-1))
	}
	return t
}()

func display(v float32) byte {
	if !(v > 0) {
		return 0
	}
	if v >= 1 {
		return 255
	}
	return displayLUT[int(v*float32(len(displayLUT)-1)+0.5)]
}

// capture copies a rendered buffer into a snapshot: display RGB with W
// folded in, the layer showing at each pixel, and the power estimate.
func (m *Map) capture(f clock.Frame, v app.View, buf *render.Buffer, comp *render.Compositor, preview bool) *Snapshot {
	n := len(buf.Pix)
	s := &Snapshot{Gen: v.Gen, T: f.T, Time: f.Time, Preview: preview, RGB: make([]byte, 3*n), Top: make([]int32, n)}
	for p, c := range buf.Pix {
		s.RGB[3*p] = display(c.R + c.W)
		s.RGB[3*p+1] = display(c.G + c.W)
		s.RGB[3*p+2] = display(c.B + c.W)
	}
	s.Layers = comp.Top(s.Top, nil)
	s.Power = estimatePower(v.Layout, buf)
	return s
}

// encodeFrame appends s's frame message for the pixel ranges rs to dst.
func encodeFrame(dst []byte, s *Snapshot, rs []Range) []byte {
	var flags byte
	if s.Preview {
		flags |= flagPreview
	}
	if s.Paused {
		flags |= flagPaused
	}
	dst = append(dst, frameVersion, flags, 0, 0)
	dst = binary.LittleEndian.AppendUint32(dst, s.Seq)
	dst = binary.LittleEndian.AppendUint64(dst, math.Float64bits(s.T))
	for _, r := range rs {
		dst = append(dst, s.RGB[3*int(r[0]):3*(int(r[1])+1)]...)
	}
	return dst
}

// Range is an inclusive range of global pixel ids.
type Range [2]int32

// ranges compresses sorted, unique ids into ranges.
func ranges(ids []int32) []Range {
	var rs []Range
	for _, p := range ids {
		if n := len(rs); n > 0 && rs[n-1][1] == p-1 {
			rs[n-1][1] = p
		} else {
			rs = append(rs, Range{p, p})
		}
	}
	return rs
}

// areaRanges is the union of the named areas' pixels as ranges; no areas
// means every pixel. Unknown area ids are reported.
func areaRanges(l *layout.Layout, areas []string) ([]Range, []string) {
	if len(areas) == 0 {
		if len(l.Pixels) == 0 {
			return nil, nil
		}
		return []Range{{0, int32(len(l.Pixels) - 1)}}, nil
	}
	var ids []int32
	var unknown []string
	for _, id := range areas {
		a, ok := l.Area(id)
		if !ok {
			unknown = append(unknown, id)
			continue
		}
		ids = append(ids, a.Pixels...)
	}
	slices.Sort(ids)
	return ranges(slices.Compact(ids)), unknown
}

func rangeLen(rs []Range) int {
	n := 0
	for _, r := range rs {
		n += int(r[1]-r[0]) + 1
	}
	return n
}
