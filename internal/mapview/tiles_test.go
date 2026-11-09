// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/render"
)

// TestTileSubtitlesCoverEffects checks that tiles.js has words for every
// built-in effect, and that no two built-in effects share them.
func TestTileSubtitlesCoverEffects(t *testing.T) {
	src, err := os.ReadFile("static/tiles.js")
	if err != nil {
		t.Fatal(err)
	}
	table := regexp.MustCompile(`(?s)export const MOTION = \{(.*?)\};`).FindSubmatch(src)
	if table == nil {
		t.Fatal("no MOTION table in tiles.js")
	}
	entry := regexp.MustCompile(`'?([a-z-]+)'?: '([^']+)'`)
	words := map[string]string{}
	for _, m := range entry.FindAllStringSubmatch(string(table[1]), -1) {
		words[m[1]] = m[2]
	}
	reg := render.NewRegistry()
	if err := effects.Register(reg); err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	for _, d := range reg.All() {
		w, ok := words[d.ID]
		if !ok {
			t.Errorf("effect %s has no subtitle in tiles.js", d.ID)
			continue
		}
		if other, dup := seen[w]; dup {
			t.Errorf("effects %s and %s share the subtitle %q", d.ID, other, w)
		}
		seen[w] = d.ID
		if n := len(strings.Fields(w)); n < 1 || n > 4 {
			t.Errorf("%s: %q is not two or three words", d.ID, w)
		}
	}
}
