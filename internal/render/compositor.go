// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package render

import (
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
)

// Buffer is one frame: linear-light RGBW per global pixel id. A is the
// accumulated layer coverage (0 where no layer drew).
type Buffer struct {
	Pix []color.Color
}

// NewBuffer returns a black buffer for n pixels.
func NewBuffer(n int) *Buffer { return &Buffer{Pix: make([]color.Color, n)} }

// Clear sets every pixel to transparent black.
func (b *Buffer) Clear() { clear(b.Pix) }

// Compositor evaluates layers into a Buffer: top-down to find which pixels
// each layer must draw (stopping at full coverage), then bottom-up to blend.
// It is not safe for concurrent use; the frame loop owns it.
type Compositor struct {
	// Master is the global master brightness (default 1).
	Master float32
	// Gain is an optional per-pixel brightness, indexed by global id. The
	// WLED device layer sets it from zone brightness. nil means 1.
	Gain []float32

	n       int
	covered []bool
	evals   []eval
	top     []int32 // per pixel: index into evals of the topmost layer that showed, or -1
	ctx     Context
	scratch gather
}

// eval is one layer's contribution this frame.
type eval struct {
	layer *Layer
	op    float32
	pix   []int32
	col   []color.Color
	full  []color.Color // stateful effects render their whole target here
}

// gather holds per-frame copies of geometry for partially covered layers.
type gather struct {
	pix             []int32
	u, x, y, dl, st []float32
	index           []int32
	idx             []int32
}

// NewCompositor returns a compositor for n pixels.
func NewCompositor(n int) *Compositor {
	return &Compositor{Master: 1, n: n, covered: make([]bool, n), top: make([]int32, n)}
}

// Top reports which layer is showing at each pixel after the last Render:
// the topmost layer that drew it with nonzero alpha. It writes into top
// (len n) each pixel's index into the returned ids, or -1 where no layer
// showed, and appends the ids of the layers that showed somewhere (top
// first) to ids. Call it from the goroutine that renders, between Renders.
func (c *Compositor) Top(top []int32, ids []string) []string {
	pos := make([]int32, len(c.evals)) // eval index → position in the new ids, -1
	for i := range pos {
		pos[i] = -1
	}
	for _, e := range c.top {
		if e >= 0 {
			pos[e] = 0
		}
	}
	n := int32(0)
	for i := range pos {
		if pos[i] == 0 {
			pos[i] = n
			ids = append(ids, c.evals[i].layer.ID)
			n++
		}
	}
	for p, e := range c.top[:min(len(top), c.n)] {
		if e < 0 {
			top[p] = -1
		} else {
			top[p] = pos[e]
		}
	}
	return ids
}

// Render draws layers (top first) at frame f into buf.
func (c *Compositor) Render(f clock.Frame, layers []*Layer, buf *Buffer) {
	clear(c.covered)
	ncovered := 0
	ev := c.evals[:0]
	for _, L := range layers {
		// Once every pixel is covered, only stateful effects still run, so
		// their state keeps advancing while they're hidden.
		if ncovered == c.n && !L.Def.Stateful {
			continue
		}
		op := L.Common.Opacity * L.Fade
		g := L.Geometry
		if op <= 0 || g == nil {
			continue
		}
		if len(ev) == cap(ev) {
			ev = append(ev, eval{})
		} else {
			ev = ev[:len(ev)+1]
		}
		e := &ev[len(ev)-1]
		e.layer, e.op, e.pix, e.col = L, op, e.pix[:0], e.col[:0]

		// Which of the layer's pixels are still visible?
		idx := c.scratch.idx[:0]
		for i, p := range g.Pixels {
			if !c.covered[p] {
				idx = append(idx, int32(i))
			}
		}
		c.scratch.idx = idx
		if len(idx) > 0 || L.Def.Stateful {
			c.renderEffect(f, L, e, idx)
		}
		for _, p := range g.Dark {
			if !c.covered[p] {
				e.pix = append(e.pix, p)
				e.col = append(e.col, color.Black)
			}
		}
		if len(e.pix) == 0 {
			ev = ev[:len(ev)-1]
			continue
		}
		for j, p := range e.pix {
			if covers(L.Common.Blend, e.col[j].A, op) {
				c.covered[p] = true
				ncovered++
			}
		}
	}
	c.evals = ev

	buf.Clear()
	for i := range c.top {
		c.top[i] = -1
	}
	for i := len(ev) - 1; i >= 0; i-- {
		e := &ev[i]
		blendInto(buf.Pix, e.pix, e.col, e.layer.Common.Blend, e.op)
		for j, p := range e.pix {
			if shows(e.layer.Common.Blend, e.col[j].A, e.op) {
				c.top[p] = int32(i)
			}
		}
	}
	for p := range buf.Pix {
		k := c.Master
		if c.Gain != nil {
			k *= c.Gain[p]
		}
		if k != 1 {
			buf.Pix[p] = buf.Pix[p].Scale(k)
		}
	}
}

// renderEffect runs L's effect for the visible indices idx and appends the
// results to e.
func (c *Compositor) renderEffect(f clock.Frame, L *Layer, e *eval, idx []int32) {
	g := L.Geometry
	ctx := &c.ctx
	*ctx = Context{
		T: f.T, LayerT: f.T - L.Created, Dt: f.Dt, Frame: f.Seq, Seed: L.Seed,
		Params: L.Params, Pitch: L.Pitch, Smooth: L.Common.Smooth, Count: len(g.Pixels),
	}
	all := L.Def.Stateful || len(idx) == len(g.Pixels)
	if all {
		ctx.Pixels, ctx.U, ctx.X, ctx.Y = g.Pixels, g.U, g.X, g.Y
		ctx.Dl, ctx.Stretch, ctx.Index = g.Dl, g.Stretch, g.Index
	} else {
		s := &c.scratch
		s.pix, s.u, s.dl, s.st, s.index = s.pix[:0], s.u[:0], s.dl[:0], s.st[:0], s.index[:0]
		s.x, s.y = s.x[:0], s.y[:0]
		for _, i := range idx {
			s.pix = append(s.pix, g.Pixels[i])
			s.u = append(s.u, g.U[i])
			s.dl = append(s.dl, g.Dl[i])
			s.st = append(s.st, g.Stretch[i])
			s.index = append(s.index, g.Index[i])
			if g.X != nil {
				s.x = append(s.x, g.X[i])
				s.y = append(s.y, g.Y[i])
			}
		}
		ctx.Pixels, ctx.U, ctx.Dl, ctx.Stretch, ctx.Index = s.pix, s.u, s.dl, s.st, s.index
		if g.X != nil {
			ctx.X, ctx.Y = s.x, s.y
		}
	}
	out := grow(&e.full, len(ctx.Pixels))
	for i := range out {
		out[i] = color.Color{}
	}
	L.Effect.Render(ctx, out)

	bright, white := L.Common.Brightness, L.Common.White
	add := func(p int32, col color.Color) {
		if bright != 1 {
			col = col.Scale(bright)
		}
		e.pix = append(e.pix, p)
		e.col = append(e.col, deriveWhite(col, white))
	}
	if L.Def.Stateful && len(idx) != len(g.Pixels) {
		for _, i := range idx {
			add(g.Pixels[i], out[i])
		}
		return
	}
	for j, p := range ctx.Pixels {
		add(p, out[j])
	}
}

func grow(s *[]color.Color, n int) []color.Color {
	if cap(*s) < n {
		*s = make([]color.Color, n)
	}
	*s = (*s)[:n]
	return *s
}

// covers reports whether a layer pixel hides everything below it.
func covers(blend string, alpha, op float32) bool {
	const opaque = 1 - 1e-6
	switch blend {
	case BlendReplace:
		return op >= opaque
	case BlendOver:
		return alpha*op >= opaque
	}
	return false
}

// shows reports whether a layer pixel contributes anything to the result.
func shows(blend string, alpha, op float32) bool {
	if blend == BlendReplace {
		return op > 0
	}
	return alpha*op > 0
}

// deriveWhite applies a layer's white mode (WLED auto-white):
//
//   - explicit: white only where colors give it ("#ff8000/40").
//   - none: no white at all; W is dropped (for RGB-only looks on RGBW
//     strips).
//   - brighter: W = min(R, G, B) is added, as WLED's "Brighter".
//   - accurate: W = min(R, G, B) replaces that much of R, G and B, as
//     WLED's "Accurate".
//
// brighter and accurate leave colors that already carry white alone
// (like WLED's "Dual"), because an authored W is deliberate. The maths is
// in linear light, where moving equal R, G and B into W keeps the color.
func deriveWhite(c color.Color, mode string) color.Color {
	if mode == WhiteNone {
		c.W = 0
		return c
	}
	if c.W > 0 || mode == WhiteExplicit {
		return c
	}
	m := min(c.R, c.G, c.B)
	if m <= 0 {
		return c
	}
	c.W = m
	if mode == WhiteAccurate {
		c.R, c.G, c.B = c.R-m, c.G-m, c.B-m
	}
	return c
}

// blendInto blends colors onto dst at pixels pix. Colors carry straight
// alpha; op is the layer's opacity × fade.
func blendInto(dst []color.Color, pix []int32, col []color.Color, mode string, op float32) {
	for j, p := range pix {
		dst[p] = Blend(dst[p], col[j], mode, op)
	}
}

// Blend blends one layer pixel s (straight alpha) onto d with a blend mode
// and the layer's opacity op. d is an accumulation as in Buffer: its
// color is premultiplied by its coverage A, so a fresh transparent black
// d works, and blending onto it is associative with blending what comes
// out onto lower layers. Composite effects use it to blend their parts.
func Blend(d, s color.Color, mode string, op float32) color.Color {
	a := s.A * op
	var out color.Color
	switch mode {
	case BlendReplace:
		// Replace ignores the effect's alpha: it replaces even
		// transparent output, scaled only by opacity.
		out = color.Lerp(d, s.WithAlpha(1), op)
	case BlendAdd:
		out = color.Color{R: d.R + s.R*a, G: d.G + s.G*a, B: d.B + s.B*a, W: d.W + s.W*a, A: d.A + a*(1-d.A)}
	case BlendMax:
		m := color.Color{R: max(d.R, s.R), G: max(d.G, s.G), B: max(d.B, s.B), W: max(d.W, s.W), A: 1}
		out = color.Lerp(d, m, a)
	case BlendMultiply:
		m := color.Color{R: d.R * s.R, G: d.G * s.G, B: d.B * s.B, W: d.W * s.W, A: 1}
		out = color.Lerp(d, m, a)
	default: // over
		out = color.Lerp(d, s.WithAlpha(1), a)
	}
	// Coverage accumulates like alpha "over".
	if mode != BlendAdd {
		out.A = d.A + a*(1-d.A)
		if mode == BlendReplace {
			out.A = d.A + op*(1-d.A)
		}
	}
	return out
}
