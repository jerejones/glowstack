// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"bytes"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jerejones/glowstack/internal/render"
)

// sprite fetches a strip sprite and decodes it.
func (f *fixture) sprite(path string) (*http.Response, [][]uint8) {
	f.t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		return res, nil
	}
	img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		f.t.Fatalf("%s: %v", path, err)
	}
	b := img.Bounds()
	if b.Dx() != StripPixels || b.Dy() != StripFrames {
		f.t.Fatalf("%s: %dx%d, want %dx%d", path, b.Dx(), b.Dy(), StripPixels, StripFrames)
	}
	rows := make([][]uint8, b.Dy())
	for y := range rows {
		for x := 0; x < b.Dx(); x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			rows[y] = append(rows[y], uint8(r>>8), uint8(g>>8), uint8(bl>>8))
		}
	}
	return res, rows
}

func rowsDiffer(rows [][]uint8) bool {
	for _, r := range rows[1:] {
		if !bytes.Equal(r, rows[0]) {
			return true
		}
	}
	return false
}

func TestEffectStripSprite(t *testing.T) {
	f := newFixture(t, nil)
	res, solid := f.sprite("/api/v1/effects/solid/strip.png")
	if ct := res.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content type %q", ct)
	}
	if cc := res.Header.Get("Cache-Control"); cc == "" {
		t.Fatal("a sprite is cacheable")
	}
	if rowsDiffer(solid) {
		t.Error("Solid holds still: every frame is the same")
	}
	if solid[0][0] == 0 && solid[0][1] == 0 && solid[0][2] == 0 {
		t.Error("Solid is lit at its default color")
	}
	_, breathe := f.sprite("/api/v1/effects/breathe/strip.png")
	if !rowsDiffer(breathe) {
		t.Error("Breathe changes from frame to frame")
	}
	if bytes.Equal(breathe[0], solid[0]) && bytes.Equal(breathe[15], solid[15]) {
		t.Error("Breathe and Solid are different pictures")
	}
	// The four palette effects differ from one another in their first frame.
	seen := map[string]string{}
	for _, id := range []string{"gradient", "sparkle", "noise", "burst"} {
		_, rows := f.sprite("/api/v1/effects/" + id + "/strip.png")
		key := string(rows[0]) + string(rows[10])
		if other, dup := seen[key]; dup {
			t.Errorf("%s draws the same as %s", id, other)
		}
		seen[key] = id
	}
}

func TestEffectStripCachesAndRejects(t *testing.T) {
	f := newFixture(t, nil)
	res, _ := f.sprite("/api/v1/effects/gradient/strip.png")
	tag := res.Header.Get("ETag")
	if tag == "" {
		t.Fatal("a sprite has an ETag")
	}
	req := httptest.NewRequest("GET", "/api/v1/effects/gradient/strip.png", nil)
	req.Header.Set("If-None-Match", tag)
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Errorf("same tag: %d, want 304", rec.Code)
	}
	if code, _ := f.do("GET", "/api/v1/effects/no-such/strip.png", nil); code != http.StatusNotFound {
		t.Errorf("unknown effect: %d", code)
	}
}

func TestPresetStripSprite(t *testing.T) {
	f := newFixture(t, nil)
	f.must(http.StatusCreated, "PUT", "/api/v1/presets/red-only?library=true", map[string]any{"name": "Red only", "effect": "solid", "params": map[string]any{"color": "#ff0000"}})
	_, rows := f.sprite("/api/v1/presets/red-only/strip.png")
	if rows == nil {
		t.Fatal("a saved preset has a sprite")
	}
	if r, g, b := rows[0][0], rows[0][1], rows[0][2]; r < 200 || g > 30 || b > 30 {
		t.Errorf("the preset's own color shows: %d,%d,%d", r, g, b)
	}
	if code, _ := f.do("GET", "/api/v1/presets/no-such/strip.png", nil); code != http.StatusNotFound {
		t.Errorf("unknown preset: %d", code)
	}
}

// litPixels counts a row's pixels that are more than a few levels off black.
func litPixels(row []uint8) int {
	n := 0
	for i := 0; i+2 < len(row); i += 3 {
		if row[i] > 8 || row[i+1] > 8 || row[i+2] > 8 {
			n++
		}
	}
	return n
}

func TestStripFitsTheLook(t *testing.T) {
	f := newFixture(t, nil)
	looks := map[string]map[string]any{
		"chase-1":  {"name": "Chase one", "effect": "chase", "params": map[string]any{"spacing": "1 m", "colors": []any{"#ffffff", "#ff0000"}}},
		"chase-10": {"name": "Chase ten", "effect": "chase", "params": map[string]any{"width": "30 cm", "spacing": "10 m", "speed": "2 m/s", "tail": "1 m", "colors": []any{"#ff2000", "#ff8000", "#ffffff"}}},
		"chase-60": {"name": "Chase sixty", "effect": "chase", "params": map[string]any{"width": "50 cm", "spacing": "60 m", "speed": "4 m/s", "tail": "3 m", "colors": []any{"#00c0ff", "#ff00c0", "#ffff00", "#00ff40"}}},
		"grad-12":  {"name": "Wide gradient", "effect": "gradient", "params": map[string]any{"palette": "Rainbow", "span": "12 m", "speed": "0.2 m/s"}},
		"still":    {"name": "Still", "effect": "solid", "params": map[string]any{"color": "#00ff00"}},
	}
	for id, body := range looks {
		f.must(http.StatusCreated, "PUT", "/api/v1/presets/"+id+"?library=true", body)
		_, rows := f.sprite("/api/v1/presets/" + id + "/strip.png")
		if rows == nil {
			t.Fatalf("%s: no sprite", id)
		}
		for k, row := range rows {
			// A pulse at least two pixels wide is always on the strip: no row is a black bar.
			if lit := litPixels(row); lit < 2 {
				t.Errorf("%s: frame %d has %d lit pixels", id, k, lit)
				break
			}
		}
		if id != "still" && !rowsDiffer(rows) {
			t.Errorf("%s moves", id)
		}
	}
	// The wide gradient's whole palette is on the strip: red, green and blue each lead somewhere.
	_, grad := f.sprite("/api/v1/presets/grad-12/strip.png")
	leads := map[int]bool{}
	for i := 0; i+2 < len(grad[0]); i += 3 {
		r, g, b := grad[0][i], grad[0][i+1], grad[0][i+2]
		switch {
		case r > g && r > b:
			leads[0] = true
		case g > r && g > b:
			leads[1] = true
		case b > r && b > g:
			leads[2] = true
		}
	}
	if len(leads) < 3 {
		t.Errorf("a 12 m rainbow shows its whole palette, got %v", leads)
	}
	// The ten-meter chase is not drawn at a 2 m strip's pitch: fewer pixels are lit than in the one-meter chase's.
	_, one := f.sprite("/api/v1/presets/chase-1/strip.png")
	_, ten := f.sprite("/api/v1/presets/chase-10/strip.png")
	if litPixels(one[0]) <= litPixels(ten[0])-6 {
		t.Errorf("the strip grows with the spacing: 1 m lit %d, 10 m lit %d", litPixels(one[0]), litPixels(ten[0]))
	}
}

func TestPlanStrip(t *testing.T) {
	f := newFixture(t, nil)
	chase, _ := f.app.Effects.Get("chase")
	env := render.Env{Palettes: f.app.Current().Palettes}
	cases := []struct {
		raw    map[string]any
		length float64
	}{
		{nil, stripMin},
		{map[string]any{"spacing": "1 m"}, stripMin},
		{map[string]any{"spacing": "10 m", "width": "30 cm"}, 10},
		{map[string]any{"spacing": "60 m", "width": "50 cm", "speed": "4 m/s"}, stripMax},
	}
	for _, c := range cases {
		length, raw, err := planStrip(chase, c.raw, env)
		if err != nil {
			t.Fatal(err)
		}
		if length != c.length {
			t.Errorf("%v: strip %g m, want %g", c.raw, length, c.length)
		}
		v, err := render.Resolve(chase.Params, raw, render.Env{Pitch: length / StripPixels, Palettes: env.Palettes})
		if err != nil {
			t.Fatalf("%v: %v", raw, err)
		}
		if px := v.Length("width").Meters / (length / StripPixels); px < stripMinFeaturePx-0.01 {
			t.Errorf("%v: a pulse %.2f px wide", c.raw, px)
		}
		if sp := v.Speed("speed"); sp*stripSeconds < length-0.01 {
			t.Errorf("%v: at %g m/s a pulse does not cross %g m in %g s", c.raw, sp, length, stripSeconds)
		}
	}
	// Scaled down to fit, the sixty-meter chase keeps its proportions: spacing at the cap.
	_, raw, _ := planStrip(chase, map[string]any{"spacing": "60 m", "width": "50 cm", "tail": "3 m"}, env)
	v, _ := render.Resolve(chase.Params, raw, render.Env{Pitch: stripMax / StripPixels})
	if s := v.Length("spacing").Meters; s < stripMax-0.01 || s > stripMax+0.01 {
		t.Errorf("spacing %g, want %g", s, stripMax)
	}
	if tail := v.Length("tail").Meters; tail < 0.99 || tail > 1.01 {
		t.Errorf("tail %g, want 1 (3 m scaled by a third)", tail)
	}
	// A show has no strip, and the catalog says so, so the map never asks for one.
	if code, _ := f.do("GET", "/api/v1/presets/evening/strip.png", nil); code != http.StatusNotFound {
		t.Errorf("a show's strip: %d", code)
	}
	effects := f.must(http.StatusOK, "GET", "/api/v1/effects", nil)
	shows := map[string]bool{}
	for _, e := range effects["effects"].([]any) {
		m := e.(map[string]any)
		shows[m["id"].(string)] = m["show"] == true
	}
	if !shows["evening"] || shows["chase"] {
		t.Errorf("show flags: %v", shows)
	}
}

func TestStripRestsOnALitFrame(t *testing.T) {
	f := newFixture(t, nil)
	// Breathe is dark at its trough: the resting row is not that frame.
	_, breathe := f.sprite("/api/v1/effects/breathe/strip.png")
	if lit := litPixels(breathe[StripRest]); lit < StripPixels/2 {
		t.Errorf("Breathe rests on a frame with %d lit pixels", lit)
	}
	best := 0
	for _, row := range breathe {
		best = max(best, litPixels(row))
	}
	if litPixels(breathe[StripRest]) != best {
		t.Errorf("the resting row has %d lit pixels; the best frame has %d", litPixels(breathe[StripRest]), best)
	}
	// The rows stay in cyclic order: the frame with most lit pixels moves to
	// the resting row and the others follow it round.
	img := image.NewNRGBA(image.Rect(0, 0, 2, StripFrames))
	for y := 0; y < StripFrames; y++ {
		img.Pix[img.PixOffset(0, y)] = uint8(y + 1) // row y's first pixel says which row it was
		if y == 7 {
			img.Pix[img.PixOffset(0, y)], img.Pix[img.PixOffset(1, y)] = 200, 200 // two lit pixels: the most
		} else if y%2 == 0 {
			img.Pix[img.PixOffset(1, y)] = 200 // one lit pixel
		}
	}
	restFrame(img)
	if got := img.Pix[img.PixOffset(0, StripRest)]; got != 200 {
		t.Errorf("row %d holds %d, want the brightest row", StripRest, got)
	}
	if got := img.Pix[img.PixOffset(0, StripRest+1)]; got != 9 {
		t.Errorf("the row after the resting row was row 8 (marked 9), got %d", got)
	}
	if got := img.Pix[img.PixOffset(0, StripRest-1)]; got != 7 {
		t.Errorf("the row before the resting row was row 6 (marked 7), got %d", got)
	}
}

// litShare is the share of a decoded sprite's pixels that are lit.
func litShare(rows [][]byte) float64 {
	lit := 0
	for _, row := range rows {
		lit += litPixels(row)
	}
	return float64(lit) / float64(len(rows)*StripPixels)
}

// A swatch is never blank (B3): a sparse effect is drawn denser for its
// sprite, and only for its sprite.
func TestStripIsNeverSparse(t *testing.T) {
	f := newFixture(t, nil)
	for _, id := range []string{"solid", "bands", "gradient", "sparkle", "chase", "noise", "breathe", "burst"} {
		_, rows := f.sprite("/api/v1/effects/" + id + "/strip.png")
		if share := litShare(rows); share < stripLitFloor {
			t.Errorf("%s: %.1f%% of the sprite is lit, want at least %.0f%%", id, share*100, stripLitFloor*100)
		}
	}
	// Sparkle at its defaults is the sparse one: drawn as it is, it is under
	// the floor, which is why the sprite raises its density.
	def, _ := f.app.Effects.Get("sparkle")
	img, values, err := drawStrip(def, nil, render.Env{Pitch: stripMin / StripPixels, Palettes: f.app.Current().Palettes})
	if err != nil {
		t.Fatal(err)
	}
	if lit := litFraction(img); lit >= stripLitFloor {
		t.Fatalf("Sparkle as it runs lights %.1f%% of a strip; the test expects it under the floor", lit*100)
	}
	denser, ok := denserParams(def, nil, values, 4)
	if !ok || denser["density"] != "8 /m/s" {
		t.Errorf("denserParams = %v, %v; want density 8 /m/s", denser, ok)
	}
	// The hint never reaches the effect's own defaults: what goes on the
	// lights is unchanged.
	if d, _ := f.app.Effects.Get("sparkle"); d.Params[0].Default != "2 /m/s" {
		t.Errorf("Sparkle's default density is %v", d.Params[0].Default)
	}
	// An effect with no density is drawn as it is, and a dark look stays dark.
	solid, _ := f.app.Effects.Get("solid")
	if _, ok := denserParams(solid, nil, values, 4); ok {
		t.Error("Solid has no density to raise")
	}
	png, err := renderStrip(solid, map[string]any{"color": "#000000"}, render.Env{Palettes: f.app.Current().Palettes})
	if err != nil || len(png) == 0 {
		t.Fatalf("a black Solid still has a sprite: %v", err)
	}
}
