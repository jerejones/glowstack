// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package units

import (
	"fmt"
	"strconv"
	"strings"
)

// Color is an authored 8-bit color, as written in config: "#rrggbb", or
// "#rrggbb/ww" with an explicit white channel (ww is hex). HasW tells the
// two apart, because a layer's `white` mode only derives W when it wasn't
// given.
//
// These are authored (perceptual) values, like WLED colors. The renderer
// converts them to linear light; see render.Linear.
type Color struct {
	R, G, B, W uint8
	HasW       bool
}

// ParseColor parses "#rrggbb", "#rgb", "#rrggbb/ww" or "#rrggbbww".
func ParseColor(s string) (Color, error) {
	in := strings.TrimSpace(s)
	hex, w, hasW := strings.Cut(in, "/")
	hex = strings.TrimPrefix(hex, "#")
	if len(hex) == 8 && !hasW {
		hex, w, hasW = hex[:6], hex[6:], true
	}
	if len(hex) == 3 {
		hex = string([]byte{hex[0], hex[0], hex[1], hex[1], hex[2], hex[2]})
	}
	if len(hex) != 6 || !strings.HasPrefix(in, "#") {
		return Color{}, fmt.Errorf("bad color %q: want #rrggbb or #rrggbb/ww", s)
	}
	rgb, err := strconv.ParseUint(hex, 16, 32)
	if err != nil {
		return Color{}, fmt.Errorf("bad color %q: want hex digits", s)
	}
	c := Color{R: uint8(rgb >> 16), G: uint8(rgb >> 8), B: uint8(rgb)}
	if hasW {
		w = strings.TrimSpace(w)
		wv, err := strconv.ParseUint(w, 16, 8)
		if err != nil || len(w) != 2 {
			return Color{}, fmt.Errorf("bad color %q: white must be two hex digits", s)
		}
		c.W, c.HasW = uint8(wv), true
	}
	return c, nil
}

func (c Color) String() string {
	if c.HasW {
		return fmt.Sprintf("#%02x%02x%02x/%02x", c.R, c.G, c.B, c.W)
	}
	return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B)
}

func (c Color) MarshalText() ([]byte, error) { return []byte(c.String()), nil }

func (c *Color) UnmarshalText(b []byte) (err error) {
	*c, err = ParseColor(string(b))
	return err
}
