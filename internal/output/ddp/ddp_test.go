// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package ddp_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"math/rand/v2"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/fakewled"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/ddp"
)

func collect(t *testing.T, frame []byte, channels int, seq byte) [][]byte {
	t.Helper()
	var pkts [][]byte
	err := ddp.Packets(frame, channels, seq, nil, func(p []byte) error {
		pkts = append(pkts, bytes.Clone(p))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return pkts
}

func TestPacketGolden(t *testing.T) {
	// Two RGB pixels in one packet: version 1 + push, seq 3, RGB type,
	// display id 1, offset 0, length 6.
	pkts := collect(t, []byte{1, 2, 3, 4, 5, 6}, 3, 3)
	if len(pkts) != 1 {
		t.Fatalf("%d packets", len(pkts))
	}
	if got, want := hex.EncodeToString(pkts[0]), "41030b0100000000000"+"6010203040506"; got != want {
		t.Errorf("rgb packet\n got %s\nwant %s", got, want)
	}

	// 361 RGBW pixels: 1440 bytes, then 4 with push at offset 1440.
	frame := make([]byte, 361*4)
	for i := range frame {
		frame[i] = byte(i)
	}
	pkts = collect(t, frame, 4, 15)
	if len(pkts) != 2 {
		t.Fatalf("%d packets", len(pkts))
	}
	if got, want := hex.EncodeToString(pkts[0][:10]), "400f1b01000000000"+"5a0"; got != want {
		t.Errorf("first header %s, want %s", got, want)
	}
	if len(pkts[0]) != 10+1440 || !bytes.Equal(pkts[0][10:], frame[:1440]) {
		t.Error("first packet data")
	}
	if got, want := hex.EncodeToString(pkts[1]), "410f1b01000005a00004"+hex.EncodeToString(frame[1440:]); got != want {
		t.Errorf("second packet\n got %s\nwant %s", got, want)
	}

	// 480 RGB pixels fit one packet exactly.
	if n := len(collect(t, make([]byte, 480*3), 3, 1)); n != 1 {
		t.Errorf("480 rgb px: %d packets", n)
	}
	if n := len(collect(t, nil, 3, 1)); n != 0 {
		t.Errorf("empty frame: %d packets", n)
	}
}

func TestParse(t *testing.T) {
	p := ddp.AppendPacket(nil, ddp.FlagVer1|ddp.FlagPush, 7, ddp.TypeRGBW, 8, []byte{9, 8, 7, 6})
	h, data, err := ddp.Parse(p)
	if err != nil || !h.Push() || h.Seq != 7 || h.Channels() != 4 || h.Offset != 8 || !bytes.Equal(data, []byte{9, 8, 7, 6}) {
		t.Errorf("%+v %v %v", h, data, err)
	}
	// Timecode: data starts 4 bytes later.
	tc := append(append([]byte{ddp.FlagVer1 | ddp.FlagTime, 1, ddp.TypeRGB, 1, 0, 0, 0, 0, 0, 3}, 0, 0, 0, 0), 1, 2, 3)
	if _, data, err := ddp.Parse(tc); err != nil || !bytes.Equal(data, []byte{1, 2, 3}) {
		t.Errorf("timecode: %v %v", data, err)
	}
	if _, _, err := ddp.Parse(p[:12]); err == nil {
		t.Error("truncated packet accepted")
	}
	if _, _, err := ddp.Parse(p[:5]); err != ddp.ErrShort {
		t.Error("short")
	}
	if ddp.NextSeq(15) != 1 || ddp.NextSeq(0) != 1 || ddp.NextSeq(4) != 5 {
		t.Error("seq")
	}
}

// fake starts a fake device on a free loopback port.
func fake(t *testing.T, ctx context.Context, cfg fakewled.Config) (*fakewled.Device, string) {
	t.Helper()
	d, err := fakewled.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go d.ServeUDP(ctx, pc)
	return d, pc.LocalAddr().String()
}

// waitFor waits until d shows want. Before WLED has seen a push it shows
// every packet, so "a frame was shown" isn't enough.
func waitFor(t *testing.T, d *fakewled.Device, want []byte) fakewled.Stats {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		w := d.Shown()
		got, st := d.Frame()
		if bytes.Equal(got, want) {
			return st
		}
		select {
		case <-w:
		case <-time.After(time.Until(deadline)):
			t.Fatalf("%s: frame not shown (rejected %d)", d.Config().Name, st.Rejected)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	ctx := t.Context()
	shed, shedAddr := fake(t, ctx, fakewled.Config{Name: "shed", Pixels: 1000, Channels: "rgbw"})
	yard, yardAddr := fake(t, ctx, fakewled.Config{Name: "yard", Pixels: 700, Channels: "rgb"})
	s := ddp.New([]ddp.Target{{ID: "shed", Addr: shedAddr}, {ID: "yard", Addr: yardAddr}}, ddp.Options{})
	defer s.Close()

	rng := rand.New(rand.NewPCG(1, 2))
	for range 5 {
		frames := []output.Frame{
			{ID: "shed", Channels: 4, Data: make([]byte, 1000*4)},
			{ID: "yard", Channels: 3, Data: make([]byte, 700*3)},
			{ID: "porch", Channels: 3, Data: make([]byte, 30)}, // not a target: dropped
		}
		for k := range frames {
			for j := range frames[k].Data {
				frames[k].Data[j] = byte(rng.Uint32())
			}
			if err := s.Send(&frames[k]); err != nil {
				t.Fatal(err)
			}
		}
		for k, d := range []*fakewled.Device{shed, yard} {
			if st := waitFor(t, d, frames[k].Data); st.Rejected != 0 {
				t.Errorf("%s rejected %d packets", frames[k].ID, st.Rejected)
			}
		}
	}
	st := s.Stats()
	if st[0].Frames != 5 || st[0].Packets != 15 || st[0].Bytes != 5*4000 || st[0].Errors != 0 {
		t.Errorf("shed stats %+v", st[0])
	}
	if st[1].Packets != 10 {
		t.Errorf("yard stats %+v", st[1])
	}
}

func TestSequenceSkipAcceptsManyPackets(t *testing.T) {
	// With WLED's out-of-sequence check on, frames of many packets must
	// still all be accepted.
	ctx := t.Context()
	live := fakewled.GoodLive
	live.SkipOutOfSeq = true
	d, addr := fake(t, ctx, fakewled.Config{Name: "big", Pixels: 3000, Channels: "rgbw", Live: &live})
	s := ddp.New([]ddp.Target{{ID: "big", Addr: addr}}, ddp.Options{})
	defer s.Close()
	for i := range 20 {
		f := output.Frame{ID: "big", Channels: 4, Data: bytes.Repeat([]byte{byte(i)}, 3000*4)}
		s.Send(&f)
		waitFor(t, d, f.Data)
	}
}

func TestMaxFPSAndCoalescing(t *testing.T) {
	ctx := t.Context()
	d, addr := fake(t, ctx, fakewled.Config{Name: "slow", Pixels: 10})
	s := ddp.New([]ddp.Target{{ID: "slow", Addr: addr, MaxFPS: 20}}, ddp.Options{})
	defer s.Close()
	start := time.Now()
	for i := range 50 { // 50 frames in well under 50 ms
		f := output.Frame{ID: "slow", Channels: 3, Data: bytes.Repeat([]byte{byte(i)}, 30)}
		s.Send(&f)
	}
	if el := time.Since(start); el > 50*time.Millisecond {
		t.Errorf("Send blocked: %v", el)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		got, _ := d.Frame()
		if got[0] == 49 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("last frame never arrived: %v", got[0])
		}
		time.Sleep(5 * time.Millisecond)
	}
	st := s.Stats()[0]
	if st.Frames > 3 || st.Coalesced < 45 {
		t.Errorf("max_fps 20 should send few frames: %+v", st)
	}
}

func TestUnreachableDoesNotBlock(t *testing.T) {
	// A loopback port nobody listens on: writes fail with "connection
	// refused" (or silently). Send must stay fast and errors are counted.
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := pc.LocalAddr().String()
	pc.Close()
	s := ddp.New([]ddp.Target{{ID: "gone", Addr: addr}, {ID: "bad", Addr: "not a host:port:x"}}, ddp.Options{})
	defer s.Close()
	start := time.Now()
	var sawErr bool
	for range 100 {
		for _, id := range []string{"gone", "bad"} {
			f := output.Frame{ID: id, Channels: 3, Data: make([]byte, 3000)}
			if err := s.Send(&f); err != nil {
				sawErr = true
			}
		}
		time.Sleep(time.Millisecond)
	}
	if el := time.Since(start); el > time.Second {
		t.Errorf("sending took %v", el)
	}
	st := s.Stats()
	if st[1].Errors == 0 || !strings.Contains(st[1].LastError, "address") {
		t.Errorf("bad address not counted: %+v", st[1])
	}
	if !sawErr {
		t.Error("Send never reported an error")
	}
}
