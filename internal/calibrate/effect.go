// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate

import (
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/units"
)

// EffectID is the calibration layer's effect. It's internal: usable by id,
// but not listed with the other effects.
const EffectID = "calibration"

// Pattern modes.
const (
	ModeRuler = "ruler" // one pixel white, a ruler around it, the rest dim
	ModeBands = "bands" // 100-pixel blocks in alternating colours, every 10th white
)

// Pattern colours, authored like any colour (decoded with the usual gamma).
var (
	colFocus  = mustColor("#ffffff")
	colBefore = mustColor("#ff0000") // ruler marks towards the run's start
	colAfter  = mustColor("#00ff00") // ruler marks towards the run's end
	colNearB  = mustColor("#600000") // the pixel just before the focus
	colNearA  = mustColor("#006000") // and just after
	colMark   = mustColor("#ff00ff") // a marked range (dead pixels)
	colDim    = mustColor("#404040") // the rest of the run
	colBlockA = mustColor("#ff6000")
	colBlockB = mustColor("#0050ff")
	colOff    = color.Color{A: 1} // opaque black: covers the layers below
)

func mustColor(s string) color.Color {
	var c units.Color
	if err := c.UnmarshalText([]byte(s)); err != nil {
		panic(err)
	}
	return color.Linear(c)
}

// Effect is the calibration pattern. It works in controller indices, not
// mapping coordinates: calibration is about which physical pixel is which,
// so it's the one effect that reads pixel ids (Context.Pixels) directly.
//
// Parameters (all controller indices on one controller, whose first global
// id is `base`):
//
//   - mode: ruler | bands
//   - focus: the pixel lit white (-1: none); also: a second white pixel
//   - dir: +1 if the run counts up from focus, -1 if it counts down; marks
//     towards the run's start are red, towards its end green
//   - ruler, reach: a mark every `ruler` pixels out to `reach` either side
//   - lo, hi: pixels outside lo–hi are black (-1: no limit), inside dim
//   - mark_lo, mark_hi: a range lit magenta (-1: none)
//
// In bands mode, block b (indices 100b–100b+99) is orange for even b and
// blue for odd, and every 10th index is white, so a photo of a whole face
// can be read off in indices.
func Effect() *render.Def {
	i := func(name string, def int, doc string) render.Param {
		return render.Param{Name: name, Type: render.TInt, Default: def, Doc: doc}
	}
	return &render.Def{
		ID:       EffectID,
		Name:     "Calibration",
		Coords:   render.CoordPixel,
		Internal: true,
		Params: []render.Param{
			{Name: "mode", Type: render.TEnum, Default: ModeRuler, Enum: []string{ModeRuler, ModeBands}},
			i("base", 0, "global id of the controller's index 0"),
			i("focus", -1, "index lit white"),
			i("also", -1, "a second index lit white"),
			i("dir", 1, "+1: the run's indices count up from focus"),
			i("ruler", 10, "mark every n pixels"),
			i("reach", 100, "ruler length either side"),
			i("lo", -1, "first index lit dim"),
			i("hi", -1, "last index lit dim"),
			i("mark_lo", -1, "first index of a marked range"),
			i("mark_hi", -1, "last index of a marked range"),
		},
		New: func() render.Effect { return render.Func(renderPattern) },
	}
}

func renderPattern(ctx *render.Context, out []color.Color) {
	p := ctx.Params
	base := p.Int("base")
	if p.Enum("mode") == ModeBands {
		for i, g := range ctx.Pixels {
			idx := int(g) - base
			switch {
			case idx%10 == 0:
				out[i] = colFocus
			case (idx/100)%2 == 0:
				out[i] = colBlockA
			default:
				out[i] = colBlockB
			}
		}
		return
	}
	focus, also, dir := p.Int("focus"), p.Int("also"), p.Int("dir")
	ruler, reach := max(p.Int("ruler"), 1), p.Int("reach")
	lo, hi := p.Int("lo"), p.Int("hi")
	mlo, mhi := p.Int("mark_lo"), p.Int("mark_hi")
	if dir < 0 {
		dir = -1
	} else {
		dir = 1
	}
	for i, g := range ctx.Pixels {
		idx := int(g) - base
		d := (idx - focus) * dir
		c := colDim
		if lo >= 0 && idx < lo || hi >= 0 && idx > hi {
			c = colOff
		}
		switch {
		case idx == focus || idx == also:
			c = colFocus
		case mlo >= 0 && idx >= mlo && idx <= mhi:
			c = colMark
		case focus < 0:
		case d%ruler == 0 && d >= -reach && d <= reach:
			if d < 0 {
				c = colBefore
			} else {
				c = colAfter
			}
		case d == -1:
			c = colNearB
		case d == 1:
			c = colNearA
		}
		out[i] = c
	}
}
