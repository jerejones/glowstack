// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package effects holds Glowstack's effects. Register adds them all to a
// registry; each effect lives in its own file and is listed in Register.
package effects

import "github.com/jerejones/glowstack/internal/render"

// Register adds every effect in this package to r.
func Register(r *render.Registry) error {
	for _, d := range []*render.Def{Solid()} {
		if err := r.Register(d); err != nil {
			return err
		}
	}
	return nil
}
