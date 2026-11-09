// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"
	"net/http"
	"strings"
	"sync"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/render"
)

// A strip sprite shows an effect moving. The real renderer draws the effect
// on a virtual strip of StripPixels pixels for StripFrames frames at
// StripFPS, one frame per row of a PNG, so a tile in the map's library can
// step through the rows and show the effect as it runs, with no second
// implementation of it in JavaScript.
const (
	StripPixels = 60 // pixels across the virtual strip, the sprite's width
	StripFrames = 30 // frames, the sprite's height: 3 s at StripFPS
	StripFPS    = 10 // frames per second
)

// The virtual strip is as long as the look's spatial period (one pulse
// spacing, one palette span, one run of bands) so the picture shows the
// look whole: at least stripMin meters, at most stripMax. A look with a
// longer period than stripMax is drawn with its lengths scaled down to
// fit instead of on a longer strip, where its pulses would vanish between
// pixels; and no feature is drawn thinner than stripMinFeaturePx pixels.
const (
	stripMin          = 2.0  // meters: a 30 px/m strip
	stripMax          = 20.0 // meters: the gradient slider's longest span
	stripMinFeaturePx = 2.0  // a pulse or band is at least this wide
	stripSeconds      = float64(StripFrames) / StripFPS
	stripFastest      = 0.6 // seconds: nothing crosses the strip faster than this
)

// A swatch must never look blank. A sparse effect (Sparkle at its defaults
// lights about 2% of a strip at any instant) is drawn for the sprite with
// its density raised until at least stripLitTarget of the sprite is lit: a
// render hint for the picture only, never a change to what goes on the
// lights. A sprite already above stripLitFloor is drawn as the look is, and
// one with nothing lit at all (a look that is dark by design) is left dark.
const (
	stripLitFloor  = 0.08 // below this the sprite is redrawn denser
	stripLitTarget = 0.14 // what the denser drawing aims for
	stripLitPasses = 3    // redraws at most
	stripLitStep   = 12.0 // the most one redraw multiplies the density by
)

// stripEpoch is the frame time the sprite starts at: fixed, so a sprite is
// the same picture every time it is drawn, and can be cached.
const stripEpoch = 1_700_000_000.0

// stripCache holds rendered sprites by what they show.
type stripCache struct {
	mu   sync.Mutex
	pngs map[string][]byte
}

// renderStrip draws def with raw effect parameters as a sprite, or says why
// it can't: an effect that reads the site's own mappings and areas (a show)
// has no meaning on a strip.
func renderStrip(def *render.Def, raw map[string]any, env render.Env) ([]byte, error) {
	if def.Extra != nil {
		return nil, fmt.Errorf("effect %s draws on the site's areas; it has no strip", def.ID)
	}
	_, effectRaw := render.SplitParams(raw)
	length, effectRaw, err := planStrip(def, effectRaw, env)
	if err != nil {
		return nil, fmt.Errorf("effect %s: %w", def.ID, err)
	}
	env.Pitch = length / StripPixels
	img, values, err := drawStrip(def, effectRaw, env)
	if err != nil {
		return nil, fmt.Errorf("effect %s: %w", def.ID, err)
	}
	// Too sparse to read at this size: draw it denser, for the picture only.
	for pass := 0; pass < stripLitPasses; pass++ {
		lit := litFraction(img)
		if lit >= stripLitFloor || lit == 0 {
			break
		}
		denser, ok := denserParams(def, effectRaw, values, math.Min(stripLitTarget/lit, stripLitStep))
		if !ok {
			break
		}
		effectRaw = denser
		if img, values, err = drawStrip(def, effectRaw, env); err != nil {
			return nil, fmt.Errorf("effect %s: %w", def.ID, err)
		}
	}
	restFrame(img)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// drawStrip renders def with raw effect parameters on the virtual strip
// env.Pitch describes, one frame per row, and returns the picture with the
// resolved values it drew.
func drawStrip(def *render.Def, effectRaw map[string]any, env render.Env) (*image.NRGBA, *render.Values, error) {
	values, err := render.Resolve(def.Params, effectRaw, env)
	if err != nil {
		return nil, nil, err
	}
	n := StripPixels
	pitch := env.Pitch
	pixels, u, x, y, z, dl, stretch, index := make([]int32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]int32, n)
	for i := 0; i < n; i++ {
		pixels[i], index[i] = int32(i), int32(i)
		// u runs from the strip's start; x is centered on the site's origin,
		// so an effect that spreads from a point in space (Burst) opens from
		// the middle of the picture, both ways.
		u[i], x[i] = float32(float64(i)*pitch), float32((float64(i)-float64(n-1)/2)*pitch)
		dl[i], stretch[i] = float32(pitch), 1
	}
	eff := def.New()
	img := image.NewNRGBA(image.Rect(0, 0, n, StripFrames))
	out := make([]color.Color, n)
	for k := 0; k < StripFrames; k++ {
		t := float64(k) / StripFPS
		ctx := &render.Context{
			T: stripEpoch + t, LayerT: t, Dt: 1.0 / StripFPS, Frame: uint64(k), Seed: 7,
			Params: values, Pitch: pitch, Smooth: true, Count: n,
			Pixels: pixels, U: u, X: x, Y: y, Z: z, Dl: dl, Stretch: stretch, Index: index,
		}
		for i := range out {
			out[i] = color.Color{}
		}
		eff.Render(ctx, out)
		for i, c := range out {
			// Over black, white folded in as a warm white, to 8-bit sRGB.
			r, g, b := (c.R+c.W)*c.A, (c.G+c.W*0.72)*c.A, (c.B+c.W*0.4)*c.A
			o := img.PixOffset(i, k)
			img.Pix[o], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3] = color.Encode(r), color.Encode(g), color.Encode(b), 255
		}
	}
	return img, values, nil
}

// stripLitLevel is how far off black (0 to 255, the brightest channel) a
// sprite pixel must be to count as lit: the same threshold tiles.js uses.
const stripLitLevel = 8

// litFraction is the share of a sprite's pixels that are lit.
func litFraction(img *image.NRGBA) float64 {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	lit := 0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			o := img.PixOffset(x, y)
			if img.Pix[o] > stripLitLevel || img.Pix[o+1] > stripLitLevel || img.Pix[o+2] > stripLitLevel {
				lit++
			}
		}
	}
	return float64(lit) / float64(w*h)
}

// denserParams returns raw with every density parameter of def (a composite's
// parts included) multiplied by factor, and whether there was one to raise.
// Density is the one parameter that says how much of the strip a sparse
// effect lights; an effect without one is drawn as it is.
func denserParams(def *render.Def, raw map[string]any, values *render.Values, factor float64) (map[string]any, bool) {
	out, found := map[string]any{}, false
	for k, v := range raw {
		out[k] = v
	}
	for _, p := range def.Params {
		if p.Type != render.TDensity {
			continue
		}
		if d := values.Density(p.Name); d > 0 {
			out[p.Name] = fmt.Sprintf("%.6g /m/s", d*factor)
			found = true
		}
	}
	return out, found
}

// StripRest is the row a tile shows at rest: while paused, under reduced
// motion, or before its clock starts (tiles.js: --tile-row).
const StripRest = StripFrames / 2

// restFrame turns the sprite's rows so the frame with the most lit pixels
// sits at StripRest: a still tile shows the look, never a dark gap in its
// cycle (Breathe at its trough, a chase between pulses). The rows stay in
// order, so stepping through them cyclically is the same motion.
func restFrame(img *image.NRGBA) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	best, bestLit := 0, -1
	for y := 0; y < h; y++ {
		lit := 0
		for x := 0; x < w; x++ {
			o := img.PixOffset(x, y)
			if img.Pix[o] > 8 || img.Pix[o+1] > 8 || img.Pix[o+2] > 8 {
				lit++
			}
		}
		if lit > bestLit {
			best, bestLit = y, lit
		}
	}
	shift := (StripRest - best + h) % h
	if shift == 0 {
		return
	}
	rows := make([]byte, len(img.Pix))
	for y := 0; y < h; y++ {
		src, dst := img.PixOffset(0, y), img.PixOffset(0, (y+shift)%h)
		copy(rows[dst:dst+img.Stride], img.Pix[src:src+img.Stride])
	}
	copy(img.Pix, rows)
}

// planStrip chooses the virtual strip for def with raw effect parameters:
// its length in meters, and the parameters to draw with. The length is the
// look's spatial period, read from its length parameters by name (chase's
// spacing, or its pulse with tail; gradient's span; the bands' total width;
// two of noise's feature size), clamped to stripMin..stripMax. When the
// period is longer than stripMax every length is scaled down by the same
// factor, so the look keeps its proportions; a feature (a pulse or band
// width) thinner than stripMinFeaturePx pixels is widened to that. A speed
// too slow to cross the strip once in the sprite's stripSeconds is raised
// so a pulse crosses once; a speed of zero is left still, as the look is.
// A speed that would cross the strip in under stripFastest seconds (a
// burst's shell, a few frames end to end) is lowered to that, so the motion
// draws as a slanted streak a person can read instead of a flat line.
// Part names of a composite ("gradient.span") are read by their last word.
func planStrip(def *render.Def, raw map[string]any, env render.Env) (float64, map[string]any, error) {
	env.Pitch = stripMin / StripPixels
	values, err := render.Resolve(def.Params, raw, env)
	if err != nil {
		return 0, nil, err
	}
	out := map[string]any{}
	for k, v := range raw {
		out[k] = v
	}
	base := func(name string) string { return name[strings.LastIndex(name, ".")+1:] }
	// The period from each part: chase spacing (or pulse and tail), gradient
	// span, noise scale, bands' run. Parts are told apart by their prefix.
	period := 0.0
	run := map[string]float64{} // prefix → width + tail
	for _, p := range def.Params {
		prefix := strings.TrimSuffix(p.Name, base(p.Name))
		switch p.Type {
		case render.TLength:
			m := values.Length(p.Name).Meters
			switch base(p.Name) {
			case "spacing", "span":
				period = max(period, m)
			case "scale":
				period = max(period, 2*m)
			case "width", "tail":
				run[prefix] += m
			}
		case render.TList:
			total := 0.0
			for _, e := range values.List(p.Name) {
				for _, f := range p.Fields {
					if f.Type == render.TLength && f.Name == "width" {
						total += e.Length(f.Name).Meters
					}
				}
			}
			period = max(period, total)
		}
	}
	for _, r := range run {
		period = max(period, r)
	}
	length := math.Min(math.Max(period, stripMin), stripMax)
	scale := 1.0
	if period > stripMax {
		scale = stripMax / period
	}
	pitch := length / StripPixels
	minFeature := stripMinFeaturePx * pitch
	meters := func(m float64) string { return fmt.Sprintf("%.6g m", m) }
	feature := func(name string, m float64) float64 {
		if b := base(name); b == "width" && m > 0 && m*scale < minFeature {
			return minFeature / scale
		}
		return m
	}
	for _, p := range def.Params {
		switch p.Type {
		case render.TLength:
			m := values.Length(p.Name).Meters
			if m2 := feature(p.Name, m) * scale; m2 != m || isPx(raw[p.Name]) {
				out[p.Name] = meters(m2)
			}
		case render.TList:
			list, changed := values.List(p.Name), false
			elems := make([]any, len(list))
			for i, e := range list {
				elem := e.Raw()
				for _, f := range p.Fields {
					if f.Type != render.TLength {
						continue
					}
					m := e.Length(f.Name).Meters
					if m2 := feature(f.Name, m) * scale; m2 != m {
						elem[f.Name], changed = meters(m2), true
					}
				}
				elems[i] = elem
			}
			if changed {
				out[p.Name] = elems
			}
		case render.TSpeed:
			v := values.Speed(p.Name)
			if v == 0 {
				continue
			}
			if need := length / stripSeconds; math.Abs(v) < need {
				out[p.Name] = fmt.Sprintf("%.6g m/s", math.Copysign(need, v))
			} else if most := length / stripFastest; math.Abs(v) > most {
				out[p.Name] = fmt.Sprintf("%.6g m/s", math.Copysign(most, v))
			}
		}
	}
	return length, out, nil
}

// isPx says whether a raw length was given in pixels, which would change
// its meaning with the strip's pitch.
func isPx(x any) bool {
	s, ok := x.(string)
	return ok && strings.Contains(s, "px")
}

// strip serves a cached sprite for def with raw parameters.
func (api *API) strip(w http.ResponseWriter, r *http.Request, def *render.Def, raw map[string]any) error {
	keyBytes, _ := json.Marshal(raw)
	sum := sha256.Sum256(append([]byte(def.ID+"\x00"), keyBytes...))
	key := hex.EncodeToString(sum[:8])
	api.strips.mu.Lock()
	if api.strips.pngs == nil {
		api.strips.pngs = map[string][]byte{}
	}
	b, ok := api.strips.pngs[key]
	api.strips.mu.Unlock()
	if !ok {
		var err error
		b, err = renderStrip(def, raw, render.Env{Palettes: api.app.Current().Palettes})
		if err != nil {
			return errorf(http.StatusNotFound, "%v", err)
		}
		api.strips.mu.Lock()
		api.strips.pngs[key] = b
		api.strips.mu.Unlock()
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("ETag", `"`+key+`"`)
	if r.Header.Get("If-None-Match") == `"`+key+`"` {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	w.Header().Set("X-Strip-Frames", fmt.Sprint(StripFrames))
	_, err := w.Write(b)
	return err
}

// effectStrip is GET /api/v1/effects/{id}/strip.png: the effect at its
// defaults.
func (api *API) effectStrip(w http.ResponseWriter, r *http.Request) error {
	d, ok := api.app.Effects.Get(r.PathValue("id"))
	if !ok {
		return errorf(http.StatusNotFound, "no effect %q (effects: %s)", r.PathValue("id"), quoteList(api.effectIDs()))
	}
	return api.strip(w, r, d, nil)
}

// presetStrip is GET /api/v1/presets/{id}/strip.png: the preset's effect
// with its settings.
func (api *API) presetStrip(w http.ResponseWriter, r *http.Request) error {
	cfg := api.app.Current().Config
	p, ok := cfg.Preset(r.PathValue("id"))
	if !ok {
		return errorf(http.StatusNotFound, "no preset %q", r.PathValue("id"))
	}
	return api.strip(w, r, presetDef(api, p), p.Params)
}

func presetDef(api *API, p *config.Preset) *render.Def {
	d, _ := api.app.Effects.Get(p.Effect)
	return d
}
