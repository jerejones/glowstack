// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package output

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/jerejones/glowstack/internal/layout"
)

// Time on the data line per pixel, the usual figures for WS281x-style
// strips at 800 kHz: 24 bits × 1.25 µs for RGB, 32 for RGBW.
const (
	WireRGB  = 30 * time.Microsecond
	WireRGBW = 40 * time.Microsecond
)

// WireFPS is the highest frame rate the longest output of c can show.
// Outputs are driven in parallel, so only the longest counts. A
// controller without outputs is treated as one output.
func WireFPS(c *layout.Controller) (fps float64, longest int) {
	longest = c.Pixels
	if len(c.Config.Outputs) > 0 {
		longest = 0
		for _, o := range c.Config.Outputs {
			longest = max(longest, o.Count)
		}
	}
	per := WireRGB
	if c.Config.Channels == "rgbw" {
		per = WireRGBW
	}
	return 1 / (float64(longest) * per.Seconds()), longest
}

// Check returns warnings about the controllers' output settings: frame
// rates the wire can't carry and power limits that can't work. fps is the
// render frame rate.
func Check(l *layout.Layout, fps float64) []string {
	var out []string
	for i := range l.Controllers {
		c := &l.Controllers[i]
		cc := c.Config
		wire, longest := WireFPS(c)
		want := fps
		if cc.MaxFPS > 0 {
			want = min(want, cc.MaxFPS)
		}
		if want > wire {
			what := "max_fps"
			if cc.MaxFPS == 0 || fps < cc.MaxFPS {
				what = "the frame rate"
			}
			out = append(out, fmt.Sprintf("controller %s: %s %.0f can't be reached: its longest output (%d px, %s) takes %.1f ms per frame, so at most %.0f fps",
				c.ID, what, want, longest, cc.Channels, 1000/wire, wire))
		}
		limited := cc.Power != nil && cc.Power.MaxMA > 0
		for _, o := range cc.Outputs {
			limited = limited || o.MaxMA > 0
		}
		if limited {
			if !cc.Power.KnowsCurrent() {
				out = append(out, fmt.Sprintf("controller %s: max_ma is set but power.led_ma isn't, so power limiting is off", c.ID))
			}
		}
	}
	return out
}

// Select parses an --output value: "none", "all" or a comma-separated list
// of controller ids. It returns the chosen controllers' indices in layout
// order.
func Select(l *layout.Layout, spec string) ([]int, error) {
	spec = strings.TrimSpace(spec)
	switch spec {
	case "none":
		return nil, nil
	case "", "all":
		all := make([]int, len(l.Controllers))
		for i := range all {
			all[i] = i
		}
		return all, nil
	}
	want := map[string]bool{}
	for _, id := range strings.Split(spec, ",") {
		if id = strings.TrimSpace(id); id != "" {
			want[id] = true
		}
	}
	var out []int
	for i, c := range l.Controllers {
		if want[c.ID] {
			out = append(out, i)
			delete(want, c.ID)
		}
	}
	if len(want) > 0 {
		unknown := slices.Sorted(maps.Keys(want))
		return nil, fmt.Errorf("--output: unknown controller %s", strings.Join(unknown, ", "))
	}
	return out, nil
}
