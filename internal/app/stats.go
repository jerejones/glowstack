// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package app

import (
	"sync"
	"time"
)

// FrameStats describes recent frame-loop performance, in wall-clock time.
type FrameStats struct {
	Frames    uint64        // frames rendered since start
	FPS       float64       // measured frame rate (smoothed)
	FrameTime time.Duration // render + output time per frame (smoothed)
	MaxFrame  time.Duration // longest frame in the last few seconds
}

// statsWindow is how long MaxFrame remembers a slow frame.
const statsWindow = 5 * time.Second

type stats struct {
	mu        sync.Mutex
	frames    uint64
	last      time.Time     // start of the previous frame
	interval  float64       // smoothed seconds between frames
	frameTime float64       // smoothed seconds per frame
	max, prev time.Duration // longest frame this window and last
	window    time.Time     // start of this window
}

// record notes one frame that ran from start to end.
func (s *stats) record(start, end time.Time) {
	const k = 0.05 // smoothing: about the last 20 frames
	d := end.Sub(start)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames++
	if s.frames == 1 {
		s.frameTime, s.window = d.Seconds(), start
	} else {
		s.frameTime += k * (d.Seconds() - s.frameTime)
		gap := start.Sub(s.last).Seconds()
		if s.interval == 0 {
			s.interval = gap
		} else {
			s.interval += k * (gap - s.interval)
		}
	}
	s.last = start
	if start.Sub(s.window) > statsWindow {
		s.prev, s.max, s.window = s.max, 0, start
	}
	s.max = max(s.max, d)
}

// Stats returns frame-loop statistics.
func (a *App) Stats() FrameStats {
	s := &a.stats
	s.mu.Lock()
	defer s.mu.Unlock()
	st := FrameStats{Frames: s.frames, FrameTime: time.Duration(s.frameTime * float64(time.Second)), MaxFrame: max(s.max, s.prev)}
	if s.interval > 0 {
		st.FPS = 1 / s.interval
	}
	return st
}
