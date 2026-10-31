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

func TestCombinedBrightnessAndOn(t *testing.T) {
	for _, tc := range []struct {
		name, controls string
		segment        bool
		wantOn         bool
	}{
		{"master zero and on", `"bri":0,"on":true`, false, true},
		{"segment zero and toggle", `"bri":0,"on":"t"`, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.post(`{"bri":100,"seg":{"id":0,"on":true,"bri":100}}`)
			body := "{" + tc.controls + "}"
			if tc.segment {
				body = `{"seg":{"id":0,` + tc.controls + `}}`
			}
			st := f.post(body)
			if tc.segment {
				st = seg(st, 0)
			}
			if st["on"] != tc.wantOn || num(st["bri"]) != 100 {
				t.Errorf("on/bri = %v/%v, want %v/100", st["on"], st["bri"], tc.wantOn)
			}
		})
	}
}

func TestReusedPresetNumber(t *testing.T) {
	f := newFixture(t)
	f.post(`{"psave":20,"n":"First look"}`)
	f.post(`{"pdel":20}`)
	f.post(`{"psave":20,"n":"Second look"}`)
	// Reintroducing the deleted native preset must not steal the slot
	// explicitly assigned to Second look, including after a restart.
	f.a.Close()
	f.start()
	if _, _, err := f.a.SavePreset(config.Preset{ID: "first-look", Name: "First look", Effect: "solid"}); err != nil {
		t.Fatal(err)
	}
	first, _ := f.d.presetNumber(f.a.Current().Config, "first-look")
	second, _ := f.d.presetNumber(f.a.Current().Config, "second-look")
	if first == second || second != 20 {
		t.Errorf("preset numbers: first=%d, second=%d, want distinct and second=20", first, second)
	}
}
