// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package effects

import (
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/render"
)

// Solid is one colour everywhere: WLED's fx 0.
func Solid() *render.Def {
	return &render.Def{
		ID:     "solid",
		Name:   "Solid",
		Params: []render.Param{{Name: "color", Type: render.TColor, Default: "#ffa000", Doc: "the colour"}},
		WLED: &render.WLED{FX: 0, Name: "Solid", Bindings: []render.Binding{
			{Slider: render.SliderColor0, Param: "color"},
		}},
		New: func() render.Effect {
			return render.Func(func(ctx *render.Context, out []color.Color) {
				c := ctx.Params.Color("color")
				for i := range out {
					out[i] = c
				}
			})
		},
	}
}
