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
	"net/http"
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
	StripPixels = 60  // pixels across the virtual strip, the sprite's width
	StripFrames = 30  // frames, the sprite's height: 3 s at StripFPS
	StripFPS    = 10  // frames per second
	stripLength = 2.0 // meters of virtual strip: a 30 px/m strip
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
	values, err := render.Resolve(def.Params, effectRaw, env)
	if err != nil {
		return nil, fmt.Errorf("effect %s: %w", def.ID, err)
	}
	n := StripPixels
	pitch := env.Pitch
	pixels, u, x, y, z, dl, stretch, index := make([]int32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]float32, n), make([]int32, n)
	for i := 0; i < n; i++ {
		pixels[i], index[i] = int32(i), int32(i)
		u[i], x[i] = float32(float64(i)*pitch), float32(float64(i)*pitch)
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
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
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
		b, err = renderStrip(def, raw, render.Env{Pitch: stripLength / StripPixels, Palettes: api.app.Current().Palettes})
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
