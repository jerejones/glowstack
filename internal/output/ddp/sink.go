// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package ddp

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/output"
)

// Defaults for Options.
const (
	// DefaultPacketGap spaces the packets of one frame a little, so a
	// controller's small UDP receive queue isn't flooded by a burst.
	DefaultPacketGap = 100 * time.Microsecond
	// DefaultWriteTimeout bounds one packet write.
	DefaultWriteTimeout = 20 * time.Millisecond
	// redialEvery limits how often a failed address lookup is retried.
	redialEvery = 5 * time.Second
)

// Target is one controller to send to.
type Target struct {
	ID     string  // controller id; frames are matched by output.Frame.ID
	Addr   string  // host:port
	MaxFPS float64 // 0 = no cap
}

// Options tunes a Sink. The zero value uses the defaults.
type Options struct {
	PacketGap    time.Duration // < 0 for none
	WriteTimeout time.Duration
}

// Stats counts one controller's traffic.
type Stats struct {
	ID        string
	Addr      string
	Frames    uint64 // frames sent
	Packets   uint64
	Bytes     uint64 // data bytes, without headers
	Errors    uint64 // failed lookups and writes
	Coalesced uint64 // frames replaced by a newer one before they were sent
	LastError string
	ErrorAt   time.Time
}

// Sink sends each controller's frames over UDP from its own goroutine.
// Send only copies the frame and wakes that goroutine, so a slow or
// unreachable controller never holds up rendering or the others. If a
// controller's goroutine is still busy, the newest frame replaces the
// waiting one. Frames for controllers that aren't targets are dropped,
// which is how a subset of controllers is selected.
type Sink struct {
	workers map[string]*worker
	order   []*worker
	stop    chan struct{}
	wg      sync.WaitGroup
	once    sync.Once
}

// New starts a sender per target.
func New(targets []Target, opts Options) *Sink {
	if opts.PacketGap == 0 {
		opts.PacketGap = DefaultPacketGap
	}
	if opts.WriteTimeout <= 0 {
		opts.WriteTimeout = DefaultWriteTimeout
	}
	s := &Sink{workers: map[string]*worker{}, stop: make(chan struct{})}
	for _, t := range targets {
		w := &worker{t: t, opts: opts, wake: make(chan struct{}, 1), stop: s.stop}
		w.stats.ID, w.stats.Addr = t.ID, t.Addr
		if t.MaxFPS > 0 {
			w.minGap = time.Duration(float64(time.Second) / t.MaxFPS)
		}
		s.workers[t.ID] = w
		s.order = append(s.order, w)
		s.wg.Go(w.run)
	}
	return s
}

// Send implements output.Sink. It never blocks on the network. It returns
// the latest send error for f's controller, once, if there's been one
// since the last Send.
func (s *Sink) Send(f *output.Frame) error {
	w := s.workers[f.ID]
	if w == nil {
		return nil
	}
	w.mu.Lock()
	if w.pending {
		w.stats.Coalesced++
	}
	w.next = append(w.next[:0], f.Data...)
	w.channels = f.Channels
	w.pending = true
	err := w.unreported
	w.unreported = nil
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
	if err != nil {
		return fmt.Errorf("controller %s: %w", f.ID, err)
	}
	return nil
}

// Stats returns a snapshot per target, in target order.
func (s *Sink) Stats() []Stats {
	out := make([]Stats, len(s.order))
	for i, w := range s.order {
		w.mu.Lock()
		out[i] = w.stats
		w.mu.Unlock()
	}
	return out
}

// Close implements output.Sink: it stops the senders (a frame being sent
// is finished) and closes their sockets.
func (s *Sink) Close() error {
	s.once.Do(func() { close(s.stop) })
	s.wg.Wait()
	var errs []error
	for _, w := range s.order {
		if w.conn != nil {
			errs = append(errs, w.conn.Close())
		}
	}
	return errors.Join(errs...)
}

type worker struct {
	t      Target
	opts   Options
	minGap time.Duration
	wake   chan struct{}
	stop   chan struct{}

	mu         sync.Mutex
	next       []byte // waiting frame
	channels   int
	pending    bool
	unreported error
	stats      Stats

	// Owned by run.
	conn     net.Conn
	lastDial time.Time
	cur      []byte
	pkt      []byte
	seq      byte
}

func (w *worker) run() {
	var last time.Time
	for {
		select {
		case <-w.stop:
			return
		case <-w.wake:
		}
		if w.minGap > 0 {
			if d := w.minGap - time.Since(last); d > 0 {
				t := time.NewTimer(d)
				select {
				case <-w.stop:
					t.Stop()
					return
				case <-t.C:
				}
			}
		}
		w.mu.Lock()
		if !w.pending {
			w.mu.Unlock()
			continue
		}
		w.cur, w.next = w.next, w.cur
		ch := w.channels
		w.pending = false
		w.mu.Unlock()
		last = time.Now()
		w.send(w.cur, ch)
	}
}

func (w *worker) send(frame []byte, channels int) {
	if w.conn == nil {
		if time.Since(w.lastDial) < redialEvery && !w.lastDial.IsZero() {
			return
		}
		w.lastDial = time.Now()
		c, err := net.Dial("udp", w.t.Addr)
		if err != nil {
			w.fail(err)
			return
		}
		w.conn = c
	}
	w.seq = NextSeq(w.seq)
	var packets, bytes uint64
	first := true
	err := Packets(frame, channels, w.seq, w.pkt, func(pkt []byte) error {
		if !first && w.opts.PacketGap > 0 {
			time.Sleep(w.opts.PacketGap)
		}
		first = false
		w.pkt = pkt
		_ = w.conn.SetWriteDeadline(time.Now().Add(w.opts.WriteTimeout))
		if _, err := w.conn.Write(pkt); err != nil {
			return err
		}
		packets++
		bytes += uint64(len(pkt) - HeaderLen)
		return nil
	})
	w.mu.Lock()
	w.stats.Packets += packets
	w.stats.Bytes += bytes
	if err == nil {
		w.stats.Frames++
	}
	w.mu.Unlock()
	if err != nil {
		w.fail(err)
	}
}

func (w *worker) fail(err error) {
	w.mu.Lock()
	w.stats.Errors++
	w.stats.LastError, w.stats.ErrorAt = err.Error(), time.Now()
	w.unreported = err
	w.mu.Unlock()
}
