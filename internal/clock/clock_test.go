// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package clock

import (
	"context"
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)

func TestTickerFrames(t *testing.T) {
	m := NewManual(t0)
	tk := NewTicker(40, m)
	f := tk.Next()
	if f.Seq != 0 || f.Dt != 0 || f.T != float64(t0.Unix()) {
		t.Errorf("first frame = %+v", f)
	}
	m.Advance(25 * time.Millisecond)
	f = tk.Next()
	if f.Seq != 1 || math.Abs(f.Dt-0.025) > 1e-9 || math.Abs(f.T-float64(t0.Unix())-0.025) > 1e-6 {
		t.Errorf("second frame = %+v", f)
	}
	if tk.Period() != 25*time.Millisecond {
		t.Errorf("period = %v", tk.Period())
	}
}

func TestTickerRun(t *testing.T) {
	tk := NewTicker(200, Real{})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	n := 0
	err := tk.Run(ctx, func(Frame) { n++ })
	if err != context.DeadlineExceeded {
		t.Errorf("err = %v", err)
	}
	// 60 ms at 5 ms per frame: about 12; allow for a slow machine.
	if n < 4 || n > 14 {
		t.Errorf("frames = %d", n)
	}
}

func TestTickerSkipsWhenLate(t *testing.T) {
	tk := NewTicker(1000, Real{})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	n := 0
	tk.Run(ctx, func(Frame) { n++; time.Sleep(5 * time.Millisecond) })
	if tk.Late() == 0 || n > 8 {
		t.Errorf("late = %d, frames = %d", tk.Late(), n)
	}
}

func TestPreview(t *testing.T) {
	base := NewManual(t0)
	p := NewPreview(base)
	base.Advance(time.Second)
	if got := p.Now(); !got.Equal(t0.Add(time.Second)) {
		t.Errorf("live: %v", got)
	}
	p.Pause()
	base.Advance(time.Second)
	if got := p.Now(); !got.Equal(t0.Add(time.Second)) || !p.Paused() {
		t.Errorf("paused: %v", got)
	}
	p.Step(25 * time.Millisecond)
	if got := p.Now(); !got.Equal(t0.Add(time.Second + 25*time.Millisecond)) {
		t.Errorf("step: %v", got)
	}
	p.SetSpeed(0.5)
	p.Resume()
	base.Advance(2 * time.Second)
	if got := p.Now(); !got.Equal(t0.Add(2*time.Second + 25*time.Millisecond)) {
		t.Errorf("half speed: %v", got)
	}
	p.Seek(t0)
	base.Advance(2 * time.Second)
	if got := p.Now(); !got.Equal(t0.Add(time.Second)) {
		t.Errorf("seek: %v", got)
	}
	p.Live()
	if got := p.Now(); !got.Equal(base.Now()) {
		t.Errorf("live again: %v vs %v", got, base.Now())
	}
}
