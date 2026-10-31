// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"testing"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
)

func TestPowerEstimateUsesAutoWhiteWireChannels(t *testing.T) {
	cfg := &config.Controller{Channels: "rgbw", White: "auto", Power: &config.Power{LedMA: config.LedMA{R: 10, G: 10, B: 10, W: 20, Idle: 1}}}
	l := &layout.Layout{Controllers: []layout.Controller{{ID: "shed", Pixels: 1, Config: cfg}}}
	b := render.NewBuffer(1)
	b.Pix[0] = color.Color{W: 1, A: 1}
	// Auto mode folds authored W into RGB before output: 30 mA + idle,
	// rather than the 20 mA W channel used by explicit mode.
	if got := estimatePower(l, b)[0].MA; got != 31 {
		t.Errorf("auto-white estimate = %v mA, want 31", got)
	}
	cfg.White = "explicit"
	if got := estimatePower(l, b)[0].MA; got != 21 {
		t.Errorf("explicit-white estimate = %v mA, want 21", got)
	}
}
