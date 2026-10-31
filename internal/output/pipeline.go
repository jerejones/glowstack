// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package output

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
)

// Limit groups (glowstack.yaml `power.group`).
const (
	GroupGlobal     = "global"
	GroupZone       = "zone"
	GroupController = "controller"
	GroupOutput     = "output"
)

// Pipeline is the production Stage. Per frame, after the compositor has
// applied layer, zone and master brightness:
//
//  1. White handling, per controller: RGBW controllers with `white:
//     explicit` get W as rendered. RGB controllers, and RGBW controllers
//     with `white: auto` (the controller derives W), get W folded into
//     R, G and B, and W sent as 0. Values are clamped to 0–1.
//  2. Power limiting on those wire values (see Power).
//  3. Temporal dithering (if enabled) and quantising to 8 bits.
//
// There is no gamma step: the buffer holds linear drive levels, and
// quantising them is the one and only encoding to the strip's 8-bit
// space (see package color). Controllers must have realtime gamma
// correction off.
//
// White handling comes before power limiting, not after as the design's
// list has it, because current depends on the channels actually driven.
//
// Process runs on the frame goroutine. Power may be called from any
// goroutine.
//
// Rebuild replaces the layout and settings after a config reload (it
// implements app.Rebuilder); power smoothing and dither state restart.
type Pipeline struct {
	pipe

	mu     sync.Mutex
	report PowerReport
}

// pipe is the Pipeline state only the frame goroutine touches.
type pipe struct {
	l       *layout.Layout
	release float64 // seconds; 0 = recover at once
	dither  bool
	group   string

	meters    []meter
	pixMeters [][2]int32   // per global pixel: output meter (or -1), controller meter
	pixClass  []uint16     // per global pixel: index into classes
	classes   [][]int32    // per class: the limited meters whose scale applies
	classK    []float32    // per class: this frame's scale
	ctlMA     [][5]float32 // per controller: led_ma r, g, b, w, idle
	ctlMeter  []int32      // per controller: its total meter
	wire      []float32    // per controller pixel channel, all controllers
	wireBase  []int        // per controller: offset into wire and residual
	residual  []float32    // dither error per wire channel
	pixMA     []float32    // per global pixel: channel current at full scale, mA
	lastT     float64
}

// meter estimates the current of one output or one controller total.
type meter struct {
	ctl    int
	pin    int // 0 for a controller total
	maxMA  float64
	idle   float64 // mA drawn with everything dark
	varMA  float64 // channel current this frame, before limiting
	drawn  float64 // channel current after limiting
	scale  float64 // smoothed scale this limit needs (1 when not limiting)
	minApp float64 // lowest scale applied to its pixels this frame
}

// PowerReport is a snapshot of the power limiter, for the live map and
// metrics.
type PowerReport struct {
	Time  time.Time
	Group string
	// Scale is the lowest scale applied to any pixel this frame.
	Scale       float64
	Outputs     []MeterReport // every configured output
	Controllers []MeterReport // every controller's total
}

// MeterReport is one output's or controller's estimate.
type MeterReport struct {
	Controller string
	Pin        int     // 0 for a controller total
	MaxMA      float64 // 0 = unlimited
	// RequestedMA is the estimated current of the frame as rendered;
	// DrawnMA after power limiting. Both include idle current.
	RequestedMA float64
	DrawnMA     float64
	// Need is the smoothed scale this limit asks for (1 = not limiting);
	// Applied is the lowest scale its pixels actually got, which is lower
	// when another limit in the same group is tighter.
	Need    float64
	Applied float64
}

// PowerReporter is implemented by stages that power-limit.
type PowerReporter interface {
	Power() PowerReport
}

// NewPipeline builds the stage for l with the settings and zones in cfg.
func NewPipeline(l *layout.Layout, cfg *config.Config) (*Pipeline, error) {
	s := cfg.Settings
	p := &Pipeline{pipe: pipe{l: l, group: s.Power.Group, dither: s.Dither == nil || *s.Dither}}
	if p.group == "" {
		p.group = GroupGlobal
	}
	if s.Power.Release != nil {
		p.release = s.Power.Release.Seconds()
	} else {
		p.release = config.DefaultRelease.Seconds()
	}
	n := len(l.Pixels)
	p.pixMeters = make([][2]int32, n)
	p.pixMA = make([]float32, n)
	p.ctlMA = make([][5]float32, len(l.Controllers))
	p.ctlMeter = make([]int32, len(l.Controllers))
	p.wireBase = make([]int, len(l.Controllers)+1)
	for ci, c := range l.Controllers {
		cc := c.Config
		if pw := cc.Power; pw != nil {
			m := pw.LedMA
			p.ctlMA[ci] = [5]float32{float32(m.R), float32(m.G), float32(m.B), float32(m.W), float32(m.Idle)}
		}
		idle := float64(p.ctlMA[ci][4])
		for k := range c.Pixels {
			p.pixMeters[int(c.Base)+k][0] = -1
		}
		for _, o := range cc.Outputs {
			mi := int32(len(p.meters))
			p.meters = append(p.meters, meter{ctl: ci, pin: o.Pin, maxMA: o.MaxMA, idle: idle * float64(o.Count), scale: 1})
			for k := o.Start; k < o.Start+o.Count && k < c.Pixels; k++ {
				p.pixMeters[int(c.Base)+k][0] = mi
			}
		}
		total := 0.0
		if cc.Power != nil {
			total = cc.Power.MaxMA
		}
		p.ctlMeter[ci] = int32(len(p.meters))
		p.meters = append(p.meters, meter{ctl: ci, maxMA: total, idle: idle * float64(c.Pixels), scale: 1})
		for k := range c.Pixels {
			p.pixMeters[int(c.Base)+k][1] = p.ctlMeter[ci]
		}
		ch := 3
		if cc.Channels == "rgbw" {
			ch = 4
		}
		p.wireBase[ci+1] = p.wireBase[ci] + c.Pixels*ch
	}
	p.wire = make([]float32, p.wireBase[len(l.Controllers)])
	p.residual = make([]float32, len(p.wire))
	for i := range p.residual {
		p.residual[i] = ditherSeed(uint32(i))
	}
	if err := p.buildClasses(cfg); err != nil {
		return nil, err
	}
	p.classK = make([]float32, len(p.classes))
	p.report = PowerReport{Group: p.group}
	for _, m := range p.meters {
		r := MeterReport{Controller: l.Controllers[m.ctl].ID, Pin: m.pin, MaxMA: m.maxMA}
		if m.pin == 0 {
			p.report.Controllers = append(p.report.Controllers, r)
		} else {
			p.report.Outputs = append(p.report.Outputs, r)
		}
	}
	return p, nil
}

// Rebuild switches p to a new layout and settings. Like Process, it must
// run on the frame goroutine.
func (p *Pipeline) Rebuild(cfg *config.Config, l *layout.Layout) error {
	q, err := NewPipeline(l, cfg)
	if err != nil {
		return err
	}
	p.pipe = q.pipe
	p.mu.Lock()
	p.report = q.report
	p.mu.Unlock()
	return nil
}

// buildClasses works out, for every pixel, which limits constrain it:
// the limits of its own output and controller, plus every limit touching
// any limit group the pixel is in. Pixels with the same set share a class.
func (p *Pipeline) buildClasses(cfg *config.Config) error {
	limited := func(mi int32) bool { return mi >= 0 && p.meters[mi].maxMA > 0 }
	n := len(p.l.Pixels)
	sets := make([][]int32, n)
	add := func(px int, mi int32) {
		if limited(mi) && !slices.Contains(sets[px], mi) {
			sets[px] = append(sets[px], mi)
		}
	}
	for px := range n {
		add(px, p.pixMeters[px][0])
		add(px, p.pixMeters[px][1])
	}
	// groupLimits adds every limit touching any pixel of members to all of
	// them.
	groupLimits := func(members []int32) {
		var lims []int32
		for _, px := range members {
			for _, mi := range p.pixMeters[px] {
				if limited(mi) && !slices.Contains(lims, mi) {
					lims = append(lims, mi)
				}
			}
		}
		for _, px := range members {
			for _, mi := range lims {
				add(int(px), mi)
			}
		}
	}
	switch p.group {
	case GroupGlobal:
		all := make([]int32, n)
		for i := range all {
			all[i] = int32(i)
		}
		groupLimits(all)
	case GroupController:
		for _, c := range p.l.Controllers {
			members := make([]int32, c.Pixels)
			for k := range members {
				members[k] = c.Base + int32(k)
			}
			groupLimits(members)
		}
	case GroupOutput:
		// Own output and controller limits only.
	case GroupZone:
		for _, z := range cfg.Zones {
			a, ok := p.l.Area(z.Area)
			if !ok {
				return fmt.Errorf("zone %q: unknown area %q", z.ID, z.Area)
			}
			groupLimits(a.Pixels)
		}
	default:
		return fmt.Errorf("unknown power group %q", p.group)
	}
	index := map[string]uint16{}
	p.pixClass = make([]uint16, n)
	var key strings.Builder
	for px, set := range sets {
		slices.Sort(set)
		key.Reset()
		for _, mi := range set {
			key.WriteString(strconv.Itoa(int(mi)))
			key.WriteByte(',')
		}
		ci, ok := index[key.String()]
		if !ok {
			if len(p.classes) > math.MaxUint16 {
				return fmt.Errorf("too many distinct power-limit combinations")
			}
			ci = uint16(len(p.classes))
			index[key.String()] = ci
			p.classes = append(p.classes, set)
		}
		p.pixClass[px] = ci
	}
	return nil
}

// Process implements Stage.
func (p *Pipeline) Process(f clock.Frame, buf *render.Buffer, out []Frame) {
	dt := f.Dt
	if dt <= 0 && p.lastT != 0 {
		dt = f.T - p.lastT
	}
	p.lastT = f.T
	for i := range p.meters {
		p.meters[i].varMA, p.meters[i].drawn = 0, 0
	}

	// 1. White handling and current estimate.
	for ci, c := range p.l.Controllers {
		ch := 3
		if c.Config.Channels == "rgbw" {
			ch = 4
		}
		fold := ch == 3 || c.Config.White == "auto"
		ma := p.ctlMA[ci]
		w := p.wire[p.wireBase[ci]:p.wireBase[ci+1]]
		for k := range c.Pixels {
			g := int(c.Base) + k
			px := buf.Pix[g]
			r, gr, b, wh := px.R, px.G, px.B, px.W
			if fold {
				r, gr, b, wh = r+wh, gr+wh, b+wh, 0
			}
			r, gr, b, wh = clamp01(r), clamp01(gr), clamp01(b), clamp01(wh)
			d := w[k*ch:]
			d[0], d[1], d[2] = r, gr, b
			if ch == 4 {
				d[3] = wh
			}
			cur := r*ma[0] + gr*ma[1] + b*ma[2] + wh*ma[3]
			p.pixMA[g] = cur
			pm := p.pixMeters[g]
			if pm[0] >= 0 {
				p.meters[pm[0]].varMA += float64(cur)
			}
			p.meters[pm[1]].varMA += float64(cur)
		}
	}

	// 2. Scales: what each limit needs, smoothed, then the lowest per class.
	rise := 1.0
	if p.release > 0 {
		rise = 1 - math.Exp(-max(dt, 0)/p.release)
	}
	for i := range p.meters {
		m := &p.meters[i]
		need := 1.0
		if m.maxMA > 0 && m.idle+m.varMA > m.maxMA {
			need = max(0, (m.maxMA-m.idle)/m.varMA)
		}
		if need < m.scale {
			m.scale = need // limit at once
		} else {
			m.scale += (need - m.scale) * rise
		}
		m.minApp = 1
	}
	for ci, set := range p.classes {
		k := 1.0
		for _, mi := range set {
			k = min(k, p.meters[mi].scale)
		}
		p.classK[ci] = float32(k)
	}

	// 3. Scale, dither and quantise.
	when := time.Unix(0, int64(f.T*1e9))
	lowest := 1.0
	for i := range out {
		o := &out[i]
		ci := o.Controller
		c := p.l.Controllers[ci]
		o.Seq, o.Time = f.Seq, when
		ch := o.Channels
		base := p.wireBase[ci]
		w := p.wire[base:p.wireBase[ci+1]]
		res := p.residual[base:p.wireBase[ci+1]]
		for k := range c.Pixels {
			g := int(c.Base) + k
			s := p.classK[p.pixClass[g]]
			if s != 1 {
				pm := p.pixMeters[g]
				for _, mi := range pm {
					if mi >= 0 && float64(s) < p.meters[mi].minApp {
						p.meters[mi].minApp = float64(s)
					}
				}
				lowest = min(lowest, float64(s))
			}
			drawn := float64(p.pixMA[g] * s)
			pm := p.pixMeters[g]
			if pm[0] >= 0 {
				p.meters[pm[0]].drawn += drawn
			}
			p.meters[pm[1]].drawn += drawn
			j := k * ch
			for x := j; x < j+ch; x++ {
				v := w[x] * s
				if p.dither {
					o.Data[x] = ditherByte(v, &res[x])
				} else {
					o.Data[x] = byte8(v)
				}
			}
		}
	}
	p.publish(when, lowest)
}

func (p *Pipeline) publish(when time.Time, lowest float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.report.Time, p.report.Scale = when, lowest
	oi, ci := 0, 0
	for _, m := range p.meters {
		var r *MeterReport
		if m.pin == 0 {
			r = &p.report.Controllers[ci]
			ci++
		} else {
			r = &p.report.Outputs[oi]
			oi++
		}
		r.RequestedMA, r.DrawnMA = m.idle+m.varMA, m.idle+m.drawn
		r.Need, r.Applied = m.scale, m.minApp
	}
}

// Power implements PowerReporter: the latest frame's estimates.
func (p *Pipeline) Power() PowerReport {
	p.mu.Lock()
	defer p.mu.Unlock()
	r := p.report
	r.Outputs = slices.Clone(r.Outputs)
	r.Controllers = slices.Clone(r.Controllers)
	return r
}

func clamp01(v float32) float32 {
	if !(v > 0) { // also NaN
		return 0
	}
	return min(v, 1)
}

// ditherByte quantises v (0–1) to 8 bits, carrying the rounding error to
// the next frame in *r so the average over frames equals v·255. *r stays
// in [-0.5, 0.5), so 0 always gives 0 and 1 always gives 255: dark pixels
// never flicker on and full ones never flicker off.
func ditherByte(v float32, r *float32) byte {
	if v <= 0 {
		return 0
	}
	if v >= 1 {
		return 255
	}
	// Accumulate every fractional byte, including values close to a step.
	// Use float64 here so adding the residual cannot round 255.5 up.
	x := float64(v)*255 + float64(*r)
	q := min(max(math.Floor(x+0.5), 0), 255)
	*r = min(max(float32(x-q), -0.5), math.Nextafter32(0.5, 0))
	return byte(q)
}

// ditherSeed spreads the starting error of each channel over [-0.5, 0.5)
// so neighbouring pixels at the same level don't step in unison.
func ditherSeed(i uint32) float32 {
	i ^= i >> 16
	i *= 0x7feb352d
	i ^= i >> 15
	i *= 0x846ca68b
	i ^= i >> 16
	return float32(i>>8)/(1<<24) - 0.5
}
