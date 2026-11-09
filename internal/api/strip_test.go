// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"bytes"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
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
