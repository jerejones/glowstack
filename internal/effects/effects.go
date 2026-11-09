// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package effects holds Glowstack's effects. Register adds them all to a
// registry; each effect lives in its own file and is listed in Register.
//
// The primitives are solid, bands, gradient, sparkle, chase, noise and
// breathe (design.md "Building blocks"). Composites (Composite) stack them
// into one effect; glitter is built in, and more come from config
// (RegisterComposites).
//
// # Common parameters
//
// The common layer parameters are handled outside the effects: mapping,
// reverse and offset by the layer's geometry (Context.U), brightness,
// opacity, blend and white by the compositor, fades by the stack. Effects
// only honor `smooth` (Context.Smooth), drawing edges at sub-pixel
// positions when it's on and point-sampling at pixel centers when it's
// off.
//
// # Flow and physical quantities
//
// Positions, widths, spans and speeds are along u, so they follow the
// flow: a pattern stretches with it and stays in sync. A length given as
// "… physical" is converted at each pixel with its stretch, so it keeps
// its physical size. Sparkle density uses each pixel's physical size dl,
// so it's per meter of strip whatever the stretch.
package effects

import "github.com/jerejones/glowstack/internal/render"

// Register adds every effect in this package to r.
func Register(r *render.Registry) error {
	for _, d := range []*render.Def{Solid(), Bands(), Gradient(), Sparkle(), Chase(), Noise(), Breathe(), Burst(), Glitter(), SpatialField()} {
		if err := r.Register(d); err != nil {
			return err
		}
	}
	return nil
}
