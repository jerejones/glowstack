// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package clock is Glowstack's frame clock. One Ticker paces the house;
// every layer and controller shares its frame time. Time comes from a
// Source, so tests use a Manual source and the live map runs its own
// Preview source (pause, step, scrub, speed) without touching the house.
package clock

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// Source tells the time.
type Source interface {
	Now() time.Time
}

// Real is the system clock.
type Real struct{}

// Now implements Source.
func (Real) Now() time.Time { return time.Now() }

// Manual is a Source that only moves when told to.
type Manual struct {
	mu sync.Mutex
	t  time.Time
}

// NewManual returns a Manual source at t.
func NewManual(t time.Time) *Manual { return &Manual{t: t} }

// Now implements Source.
func (m *Manual) Now() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.t
}

// Set moves the clock to t.
func (m *Manual) Set(t time.Time) {
	m.mu.Lock()
	m.t = t
	m.mu.Unlock()
}

// Advance moves the clock forward by d.
func (m *Manual) Advance(d time.Duration) {
	m.mu.Lock()
	m.t = m.t.Add(d)
	m.mu.Unlock()
}

// Preview is a Source derived from a base source that can be paused,
// stepped, scrubbed and run faster or slower. Because effects are functions
// of place and time, the preview shows exactly what the house would show at
// the preview's time.
type Preview struct {
	mu       sync.Mutex
	base     Source
	baseAt   time.Time // base time at the last re-anchor
	previewT time.Time // preview time at the last re-anchor
	speed    float64
	paused   bool
}

// NewPreview returns a running Preview that starts in step with base.
func NewPreview(base Source) *Preview {
	now := base.Now()
	return &Preview{base: base, baseAt: now, previewT: now, speed: 1}
}

// Now implements Source.
func (p *Preview) Now() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.nowLocked()
}

func (p *Preview) nowLocked() time.Time {
	if p.paused {
		return p.previewT
	}
	elapsed := p.base.Now().Sub(p.baseAt)
	return p.previewT.Add(time.Duration(float64(elapsed) * p.speed))
}

// reanchor fixes the current preview time so speed or pause changes apply
// from now on.
func (p *Preview) reanchor() {
	p.previewT = p.nowLocked()
	p.baseAt = p.base.Now()
}

// Pause freezes preview time.
func (p *Preview) Pause() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reanchor()
	p.paused = true
}

// Resume continues from the paused time.
func (p *Preview) Resume() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reanchor()
	p.paused = false
}

// Paused reports whether preview time is frozen.
func (p *Preview) Paused() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.paused
}

// SetSpeed sets the rate of preview time to base time (1 = real time;
// negative runs backwards).
func (p *Preview) SetSpeed(s float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reanchor()
	p.speed = s
}

// Seek jumps preview time to t.
func (p *Preview) Seek(t time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reanchor()
	p.previewT = t
}

// Step moves preview time by d (typically one frame while paused).
func (p *Preview) Step(d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reanchor()
	p.previewT = p.previewT.Add(d)
}

// Live rejoins the base clock at speed 1.
func (p *Preview) Live() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.baseAt = p.base.Now()
	p.previewT, p.speed, p.paused = p.baseAt, 1, false
}

// Frame is one rendered instant.
type Frame struct {
	Seq  uint64    // frame number since the ticker started
	Time time.Time // the frame's timestamp from the Source
	// T is Time in seconds since the Unix epoch: the shared time effects
	// are functions of. It's absolute so restarts continue seamlessly.
	// float64 has sub-microsecond resolution at today's epoch offsets;
	// effects must do their phase arithmetic in float64 (e.g. math.Mod)
	// before dropping to float32.
	T  float64
	Dt float64 // seconds since the previous frame (0 for the first)
}

// Seconds converts a time to Frame.T's scale.
func Seconds(t time.Time) float64 {
	return float64(t.Unix()) + float64(t.Nanosecond())/1e9
}

// Ticker paces frames at a target rate. Pacing uses the real system timer;
// frame timestamps come from the Source.
type Ticker struct {
	src  Source
	fps  atomic.Uint64 // frames per 1000 s
	seq  uint64
	prev time.Time
	late atomic.Uint64
}

// NewTicker returns a ticker at fps frames per second reading time from src.
func NewTicker(fps float64, src Source) *Ticker {
	t := &Ticker{src: src}
	t.SetFPS(fps)
	return t
}

// SetFPS changes the frame rate; it takes effect from the next frame.
func (t *Ticker) SetFPS(fps float64) {
	if fps <= 0 {
		fps = 1
	}
	t.fps.Store(uint64(fps * 1000))
}

// FPS returns the target frame rate.
func (t *Ticker) FPS() float64 { return float64(t.fps.Load()) / 1000 }

// Period returns the target time between frames.
func (t *Ticker) Period() time.Duration {
	return time.Duration(float64(time.Second) / t.FPS())
}

// Late counts frames that started after the following frame was due, so
// one or more frames were skipped.
func (t *Ticker) Late() uint64 { return t.late.Load() }

// Next stamps the next frame with the source's current time.
func (t *Ticker) Next() Frame {
	now := t.src.Now()
	f := Frame{Seq: t.seq, Time: now, T: Seconds(now)}
	if t.seq > 0 {
		f.Dt = now.Sub(t.prev).Seconds()
	}
	t.seq++
	t.prev = now
	return f
}

// Run calls fn once per frame until ctx is done. If fn overruns, frames are
// skipped rather than bunched up.
func (t *Ticker) Run(ctx context.Context, fn func(Frame)) error {
	deadline := time.Now()
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
		fn(t.Next())
		period := t.Period()
		deadline = deadline.Add(period)
		if now := time.Now(); now.After(deadline) {
			t.late.Add(1)
			deadline = now
		}
		timer.Reset(time.Until(deadline))
	}
}
