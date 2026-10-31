// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"fmt"
	"testing"

	"github.com/jerejones/glowstack/internal/config"
)

func TestPresetCommonControls(t *testing.T) {
	f := newFixture(t)
	if _, _, err := f.a.SavePreset(config.Preset{ID: "dim-reversed", Effect: "solid",
		Params: map[string]any{"brightness": 0.25, "reverse": true}}); err != nil {
		t.Fatal(err)
	}
	n, _ := f.d.presetNumber(f.a.Current().Config, "dim-reversed")
	for _, tc := range []struct{ name, request string }{
		{"reset", `{"seg":{"id":0,"bri":255,"rev":false}}`},
		{"switch effect", `{"seg":{"id":0,"fx":65}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f.post(fmt.Sprintf(`{"ps":%d}`, n))
			s := seg(f.post(tc.request), 0)
			bri, rev := 255, false
			if tc.name == "switch effect" {
				bri, rev = 64, true
			}
			if num(s["bri"]) != bri || s["rev"] != rev {
				t.Errorf("bri/rev = %v/%v, want %d/%v", s["bri"], s["rev"], bri, rev)
			}
		})
	}
}
