// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// Subscription is what a client asks for, as a text message on the
// websocket. Both fields are optional: FPS 0 means the server's cap,
// no Areas means every pixel.
type Subscription struct {
	FPS   float64  `json:"fps"`
	Areas []string `json:"areas"`
}

// Subscribed is the server's text reply to a subscription (and its first
// message). Binary frames that follow carry RGB for Ranges, in order.
type Subscribed struct {
	Type string `json:"type"` // "subscribed"
	// Gen is the reload generation the ranges are for (Geometry.Gen).
	// After a reload it's sent again with the new generation.
	Gen     uint64   `json:"gen"`
	FPS     float64  `json:"fps"`
	Areas   []string `json:"areas"`
	Unknown []string `json:"unknown,omitempty"` // area ids that don't exist
	Count   int      `json:"count"`             // pixels per frame
	Ranges  []Range  `json:"ranges"`            // inclusive global-id ranges
}

// minFPS is the slowest a client may ask for.
const minFPS = 0.2

func (m *Map) subscribe(s Subscription) (Subscribed, []Range) {
	fps := m.opts.FPS
	if s.FPS > 0 {
		fps = min(max(s.FPS, minFPS), m.opts.FPS)
	}
	st := m.state()
	rs, unknown := areaRanges(st.Layout, s.Areas)
	if rs == nil {
		rs = []Range{}
	}
	areas := s.Areas
	if areas == nil {
		areas = []string{}
	}
	return Subscribed{Type: "subscribed", Gen: st.Gen, FPS: fps, Areas: areas, Unknown: unknown, Count: rangeLen(rs), Ranges: rs}, rs
}

// handleWS streams frames to one client: the latest snapshot whenever
// there's a new one and the client's interval has passed. A slow client
// skips frames instead of queueing them.
func (m *Map) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer c.CloseNow()
	m.clients.Add(1)
	defer m.clients.Add(-1)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	c.SetReadLimit(1 << 16)
	subs := make(chan Subscription, 1)
	go func() {
		defer cancel()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			var s Subscription
			if json.Unmarshal(data, &s) != nil {
				continue
			}
			select {
			case <-subs: // replace a pending one
			default:
			}
			subs <- s
		}
	}()

	write := func(typ websocket.MessageType, b []byte) bool {
		wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
		defer wcancel()
		return c.Write(wctx, typ, b) == nil
	}
	sub := Subscription{}
	reply, rs := m.subscribe(sub)
	sendReply := func() bool {
		b, _ := json.Marshal(reply)
		return write(websocket.MessageText, b)
	}
	if !sendReply() {
		return
	}
	var (
		last  uint32
		next  time.Time
		buf   []byte
		timer = time.NewTimer(time.Hour)
	)
	defer timer.Stop()
	for {
		snap, ready := m.latest()
		if snap != nil && snap.Gen > reply.Gen {
			// A reload changed the pixels: re-subscribe on the new
			// layout before sending its frames.
			if reply, rs = m.subscribe(sub); !sendReply() {
				return
			}
		}
		if snap != nil && snap.Gen != reply.Gen {
			snap = nil // wait for a frame on the subscribed layout
		}
		fresh := snap != nil && snap.Seq != last
		if fresh && !time.Now().Before(next) {
			buf = encodeFrame(buf[:0], snap, rs)
			if !write(websocket.MessageBinary, buf) {
				return
			}
			last = snap.Seq
			next = time.Now().Add(time.Duration(float64(time.Second)/reply.FPS) - time.Millisecond)
			continue
		}
		var wake <-chan time.Time
		if fresh {
			timer.Reset(time.Until(next))
			wake = timer.C
		}
		select {
		case <-ctx.Done():
			return
		case <-ready:
		case <-wake:
		case s := <-subs:
			sub = s
			reply, rs = m.subscribe(s)
			last = 0 // resend the current frame in the new shape
			if !sendReply() {
				return
			}
		}
		if wake != nil && !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
	}
}
