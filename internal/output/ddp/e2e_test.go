// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package ddp_test

import (
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/fakewled"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/ddp"
	"github.com/jerejones/glowstack/internal/stack"
)

// TestAppToFakes renders the fictional installation through the default
// output stage and DDP to two fake controllers on loopback.
func TestAppToFakes(t *testing.T) {
	ctx := t.Context()
	shed, shedAddr := fake(t, ctx, fakewled.Config{Name: "shed", Pixels: 604, Channels: "rgbw"})
	yard, yardAddr := fake(t, ctx, fakewled.Config{Name: "yard", Pixels: 480, Channels: "rgb"})
	a, err := app.New(app.Options{
		ConfigDir: "../../../examples/fictional/config",
		Clock:     clock.NewManual(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)),
		NewSink: func(a *app.App) (output.Sink, error) {
			return ddp.New([]ddp.Target{{ID: "shed", Addr: shedAddr}, {ID: "yard", Addr: yardAddr}}, ddp.Options{}), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.Stack.Push(stack.Layer{Owner: stack.OwnerCLI, Target: "porch", Effect: "solid",
		Params: map[string]any{"color": "#ff0000", "fade_in": "0s"}}); err != nil {
		t.Fatal(err)
	}
	if err := a.RenderFrame(a.Ticker.Next()); err != nil {
		t.Fatal(err)
	}
	want := make([]byte, 480*3)
	for p := 390; p < 480; p++ { // the porch rail
		want[p*3] = 255
	}
	waitFor(t, yard, want)
	waitFor(t, shed, make([]byte, 604*4))
	if p, ok := a.Stage.(output.PowerReporter); !ok || p.Power().Scale != 1 {
		t.Error("power report")
	}
}
