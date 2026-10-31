// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"net/http"

	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
)

// PowerReport is what the output stage knows about power limiting. It's
// the interface between the output stage and the map: the stage fills it
// in and the program passes a func returning the latest one as
// Options.Power. Until then the map shows its own estimate and no scale.
type PowerReport struct {
	// Scale is the active limit scale (1 = not limiting), per limit group.
	Scale float64 `json:"scale"`
	// Groups optionally breaks Scale down per limit group (zone,
	// controller or output id → scale).
	Groups map[string]float64 `json:"groups,omitempty"`
	// Outputs are the stage's own current figures, after limiting.
	Outputs []OutputPower `json:"outputs,omitempty"`
}

// OutputPower is the current drawn by one output (one data pin).
type OutputPower struct {
	Controller string  `json:"controller"`
	Pin        int     `json:"pin"`
	Start      int     `json:"start"`
	Count      int     `json:"count"`
	MA         float64 `json:"ma"`
	MaxMA      float64 `json:"max_ma,omitempty"` // 0 = unlimited
	// Known is false when the controller has no `power.led_ma`, so the
	// estimate is meaningless.
	Known bool `json:"known"`
}

// estimatePower estimates each output's current from a linear frame and
// the controllers' `led_ma`, before any limiting, the way the design's
// brightness pipeline does: a channel at full drive draws its led_ma, plus
// idle per pixel. On RGB controllers white is folded into RGB first. A
// controller with no outputs listed counts as one output.
func estimatePower(l *layout.Layout, buf *render.Buffer) []OutputPower {
	var out []OutputPower
	for _, c := range l.Controllers {
		cfg := c.Config
		rgbw := cfg.Channels == "rgbw"
		var r, g, b, w, idle float64
		known := cfg.Power != nil
		if known {
			ma := cfg.Power.LedMA
			r, g, b, w, idle = ma.R, ma.G, ma.B, ma.W, ma.Idle
		}
		type pin struct {
			pin, start, count int
			max               float64
		}
		pins := []pin{{0, 0, c.Pixels, 0}}
		if len(cfg.Outputs) > 0 {
			pins = pins[:0]
			for _, o := range cfg.Outputs {
				pins = append(pins, pin{o.Pin, o.Start, o.Count, o.MaxMA})
			}
		}
		for _, o := range pins {
			total := 0.0
			if known {
				for k := o.start; k < o.start+o.count && k < c.Pixels; k++ {
					px := buf.Pix[int(c.Base)+k]
					pr, pg, pb, pw := clamp1(px.R), clamp1(px.G), clamp1(px.B), clamp1(px.W)
					if !rgbw {
						pr, pg, pb, pw = clamp1(pr+pw), clamp1(pg+pw), clamp1(pb+pw), 0
					}
					total += float64(pr)*r + float64(pg)*g + float64(pb)*b + float64(pw)*w + idle
				}
			}
			out = append(out, OutputPower{Controller: c.ID, Pin: o.pin, Start: o.start, Count: o.count,
				MA: total, MaxMA: o.max, Known: known})
		}
	}
	return out
}

func clamp1(v float32) float32 {
	if !(v > 0) {
		return 0
	}
	return min(v, 1)
}

type powerJSON struct {
	Frame    uint32        `json:"frame"`
	Preview  bool          `json:"preview"`
	Estimate []OutputPower `json:"estimate"`
	Totals   []ctrlPower   `json:"controllers"`
	Stage    *PowerReport  `json:"stage"` // null: the output stage doesn't report yet
}

type ctrlPower struct {
	Controller string  `json:"controller"`
	MA         float64 `json:"ma"`
	MaxMA      float64 `json:"max_ma,omitempty"`
}

func (m *Map) handlePower(w http.ResponseWriter, r *http.Request) {
	m.touch()
	s, _ := m.latest()
	out := powerJSON{Estimate: []OutputPower{}, Totals: []ctrlPower{}}
	if s != nil {
		out.Frame, out.Preview, out.Estimate = s.Seq, s.Preview, s.Power
		for _, c := range m.layout.Controllers {
			t := ctrlPower{Controller: c.ID}
			if c.Config.Power != nil {
				t.MaxMA = c.Config.Power.MaxMA
			}
			for _, o := range s.Power {
				if o.Controller == c.ID {
					t.MA += o.MA
				}
			}
			out.Totals = append(out.Totals, t)
		}
	}
	if m.opts.Power != nil {
		out.Stage = m.opts.Power()
	}
	writeJSON(w, out)
}
