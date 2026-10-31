// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package clock

import (
	"context"
	"fmt"
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

// fakePacer is a wall clock that only moves when told to, or to reach a
// wait's deadline at once.
type fakePacer struct{ t time.Time }

func (p *fakePacer) now() time.Time { return p.t }

func (p *fakePacer) wait(ctx context.Context, until time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if until.After(p.t) {
		p.t = until
	}
	return nil
}

// TestTickerSkipsWhenLate runs on a fake wall clock, so it doesn't depend
// on the machine's load. The first three frames take 5 ms against a 1 ms
// period; the ticker must count them late and then carry on 1 ms apart
// instead of firing a burst of frames to catch up.
func TestTickerSkipsWhenLate(t *testing.T) {
	wall := &fakePacer{t: t0}
	tk := NewTicker(1000, Real{})
	tk.wall = wall
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var at []time.Duration
	err := tk.Run(ctx, func(Frame) {
		at = append(at, wall.t.Sub(t0))
		if len(at) <= 3 {
			wall.t = wall.t.Add(5 * time.Millisecond)
		}
		if len(at) == 8 {
			cancel()
		}
	})
	if err != context.Canceled {
		t.Errorf("Run returned %v", err)
	}
	ms := time.Millisecond
	want := []time.Duration{0, 5 * ms, 10 * ms, 15 * ms, 16 * ms, 17 * ms, 18 * ms, 19 * ms}
	if fmt.Sprint(at) != fmt.Sprint(want) || tk.Late() != 3 {
		t.Errorf("frames at %v, want %v; late %d, want 3", at, want, tk.Late())
	}
}

// TestTickerPacesInRealTime is a loose check of the system pacer.
func TestTickerPacesInRealTime(t *testing.T) {
	tk := NewTicker(200, Real{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	n := 0
	start := time.Now()
	tk.Run(ctx, func(Frame) {
		if n++; n == 5 {
			cancel()
		}
	})
	// Five frames at 5 ms are at least 20 ms apart end to end.
	if d := time.Since(start); n != 5 || d < 20*time.Millisecond {
		t.Errorf("%d frames in %v", n, d)
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
	if p.Speed() != 0.5 {
		t.Errorf("speed %v", p.Speed())
	}
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
