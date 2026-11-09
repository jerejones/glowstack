// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"net/http"

	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/render"
)

// PowerReport is what the output stage knows about power limiting, for
// the house frames it sent (never the preview). FromStage converts the
// default stage's output.PowerReport; Options.Power supplies it.
type PowerReport struct {
	// Scale is the lowest limit scale applied to any pixel in the latest
	// frame (1 = not limiting).
	Scale float64 `json:"scale"`
	// Group is the power policy's limit group (glowstack.yaml power.group).
	Group string `json:"group,omitempty"`
	// Outputs are the stage's own current figures per output, after
	// limiting; Controllers are the controller totals.
	Outputs     []OutputPower `json:"outputs,omitempty"`
	Controllers []OutputPower `json:"controllers,omitempty"`
}

// FromStage converts the output stage's report.
func FromStage(r output.PowerReport) *PowerReport {
	out := &PowerReport{Scale: r.Scale, Group: r.Group}
	conv := func(ms []output.MeterReport) []OutputPower {
		var ps []OutputPower
		for _, m := range ms {
			ps = append(ps, OutputPower{Controller: m.Controller, Output: m.Output, MA: m.DrawnMA, MaxMA: m.MaxMA,
				RequestedMA: m.RequestedMA, Need: m.Need, Applied: m.Applied, Known: m.Known})
		}
		return ps
	}
	out.Outputs, out.Controllers = conv(r.Outputs), conv(r.Controllers)
	return out
}

// OutputPower is the current drawn by one WLED output (output 0 is
// a controller total in PowerReport.Controllers).
type OutputPower struct {
	Controller string  `json:"controller"`
	Output     int     `json:"output"` // WLED output number
	Start      int     `json:"start"`
	Count      int     `json:"count"`
	MA         float64 `json:"ma"`
	MaxMA      float64 `json:"max_ma,omitempty"` // 0 = unlimited
	// From the output stage only: the current before limiting, the scale
	// this limit asks for and the lowest scale its pixels got.
	RequestedMA float64 `json:"requested_ma,omitempty"`
	Need        float64 `json:"need,omitempty"`
	Applied     float64 `json:"applied,omitempty"`
	// Known is false when the controller has no LED current
	// (`power.led_ma`), so MA means nothing.
	Known bool `json:"known"`
}

// estimatePower estimates each output's current from a linear frame and
// the controllers' `led_ma`, before any limiting, the way the design's
// brightness pipeline does: a channel at full drive draws its led_ma, plus
// idle per pixel. On RGB controllers and RGBW controllers in auto-white mode, W is
// folded into RGB first, matching the output pipeline. A
// controller with no outputs listed counts as one output.
func estimatePower(l *layout.Layout, buf *render.Buffer) []OutputPower {
	var out []OutputPower
	for _, c := range l.Controllers {
		cfg := c.Config
		rgbw := cfg.Channels == "rgbw"
		var r, g, b, w, idle float64
		known := cfg.Power.KnowsCurrent()
		if known {
			ma := cfg.Power.LedMA
			r, g, b, w, idle = ma.R, ma.G, ma.B, ma.W, ma.Idle
		}
		type pin struct {
			output, start, count int
			max                  float64
		}
		pins := []pin{{0, 0, c.Pixels, 0}}
		if len(cfg.Outputs) > 0 {
			pins = pins[:0]
			for _, o := range cfg.Outputs {
				pins = append(pins, pin{o.Number, o.Start, o.Count, o.MaxMA})
			}
		}
		for _, o := range pins {
			total := 0.0
			if known {
				for k := o.start; k < o.start+o.count && k < c.Pixels; k++ {
					px := buf.Pix[int(c.Base)+k]
					pr, pg, pb, pw := clamp1(px.R), clamp1(px.G), clamp1(px.B), clamp1(px.W)
					if !rgbw || cfg.White == "auto" {
						pr, pg, pb, pw = clamp1(pr+pw), clamp1(pg+pw), clamp1(pb+pw), 0
					}
					total += float64(pr)*r + float64(pg)*g + float64(pb)*b + float64(pw)*w + idle
				}
			}
			out = append(out, OutputPower{Controller: c.ID, Output: o.output, Start: o.start, Count: o.count,
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
	// Known is false when no LED current is set, so MA means nothing.
	Known bool `json:"known"`
}

// controllerTotals sums the outputs' estimates for each controller.
func controllerTotals(controllers []layout.Controller, power []OutputPower) []ctrlPower {
	totals := []ctrlPower{}
	for _, c := range controllers {
		t := ctrlPower{Controller: c.ID, Known: c.Config.Power.KnowsCurrent()}
		if c.Config.Power != nil {
			t.MaxMA = c.Config.Power.MaxMA
		}
		for _, o := range power {
			if o.Controller == c.ID {
				t.MA += o.MA
			}
		}
		totals = append(totals, t)
	}
	return totals
}

func (m *Map) handlePower(w http.ResponseWriter, r *http.Request) {
	show, ok := showParam(w, r)
	if !ok {
		return
	}
	m.touch(show)
	s, _ := m.latest(show)
	out := powerJSON{Estimate: []OutputPower{}, Totals: []ctrlPower{}}
	if s != nil {
		out.Frame, out.Preview, out.Estimate = s.Seq, s.Preview, s.Power
		out.Totals = controllerTotals(m.state().Layout.Controllers, s.Power)
	}
	if m.opts.Power != nil {
		out.Stage = m.opts.Power()
	}
	writeJSON(w, out)
}
