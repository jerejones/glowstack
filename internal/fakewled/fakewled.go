// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package fakewled is a stand-in for a WLED controller, for running and
// testing Glowstack without hardware. A Device receives DDP the way WLED
// does (offsets, push flag, RGB or RGBW data, optional sequence check),
// keeps the last shown frame, and serves a minimal /json/info and
// /json/cfg with configurable realtime settings, plus a small page that
// draws the pixels.
//
// It only listens; cmd/fakewled insists on loopback addresses.
package fakewled

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/output/ddp"
)

// Live holds the realtime settings reported under /json/cfg `if.live`.
type Live struct {
	Enabled         bool `yaml:"en" json:"en"`
	MainSegmentOnly bool `yaml:"mso" json:"mso"`
	RespectLedMaps  bool `yaml:"rlm" json:"rlm"`
	Timeout         int  `yaml:"timeout" json:"timeout"` // 100 ms units, as WLED stores it
	ForceMaxBri     bool `yaml:"maxbri" json:"maxbri"`
	NoGamma         bool `yaml:"no-gc" json:"no-gc"`
	SkipOutOfSeq    bool `yaml:"seqskip" json:"-"`
	DMXAddress      int  `yaml:"addr" json:"-"`
}

// GoodLive is how Glowstack wants a controller set up.
var GoodLive = Live{Enabled: true, Timeout: 25, ForceMaxBri: true, NoGamma: true, DMXAddress: 1}

// Config describes one fake device.
type Config struct {
	Name     string `yaml:"name"`
	Listen   string `yaml:"listen"`   // UDP for DDP and TCP for HTTP, e.g. 127.0.0.1:40481
	Pixels   int    `yaml:"pixels"`   // LED count
	Channels string `yaml:"channels"` // rgb | rgbw
	Live     *Live  `yaml:"live"`     // nil = GoodLive
	// AutoWhite is the bus auto-white mode (hw.led.ins[].rgbwm): 0 off,
	// 1 brighter, 2 accurate, 3 dual, 4 max.
	AutoWhite int    `yaml:"rgbwm"`
	LedMaps   int    `yaml:"ledmaps"` // how many LED map files exist, ledmap.json first (info.maps always lists 0)
	Version   string `yaml:"version"`
}

// Stats describes the frames a device has shown.
type Stats struct {
	Frames   uint64
	Packets  uint64
	Rejected uint64  // packets dropped as malformed or out of sequence
	FPS      float64 // over the last second or so
	Checksum uint32  // CRC-32 of the last shown frame's wire bytes
	Last     time.Time
	Source   string // address of the last sender
}

// Device is one fake controller. Use New, then Serve or HandlePacket.
type Device struct {
	cfg      Config
	channels int
	start    time.Time

	mu       sync.Mutex
	pix      [][4]byte // receive buffer, like WLED's realtime pixels
	shown    []byte    // last shown frame, cfg channels per pixel
	stats    Stats
	seenPush bool
	lastSeq  int
	fpsCount int
	fpsFrom  time.Time
	waiters  []chan struct{}
	requests []Request
}

// Request is one HTTP request a fake device received.
type Request struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   string `json:"body,omitempty"` // the first 4 kB
}

// PowerOff says whether the request would turn a WLED device off: a write
// to its JSON state API with "on" false. Nothing in Glowstack may ever
// send one; the tests ask the fakes.
func (r Request) PowerOff() bool {
	if r.Method == http.MethodGet || !strings.HasPrefix(r.Path, "/json") {
		return false
	}
	var body struct {
		On    any `json:"on"`
		State struct {
			On any `json:"on"`
		} `json:"state"`
	}
	if json.Unmarshal([]byte(r.Body), &body) != nil {
		return false
	}
	off := func(v any) bool { return v == false || v == "f" || v == float64(0) }
	return off(body.On) || off(body.State.On)
}

// Requests returns the HTTP requests the device has received, oldest first
// (the last 1000).
func (d *Device) Requests() []Request {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]Request(nil), d.requests...)
}

// record keeps r in the request log and hands it on to next.
func (d *Device) record(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/requests" {
			body, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
			r.Body = io.NopCloser(bytes.NewReader(body))
			d.mu.Lock()
			d.requests = append(d.requests, Request{Method: r.Method, Path: r.URL.Path, Body: string(body)})
			if n := len(d.requests); n > 1000 {
				d.requests = d.requests[n-1000:]
			}
			d.mu.Unlock()
		}
		next.ServeHTTP(w, r)
	})
}

// New makes a device. Pixels must be positive.
func New(cfg Config) (*Device, error) {
	if cfg.Pixels <= 0 {
		return nil, fmt.Errorf("fake %q: pixels must be positive", cfg.Name)
	}
	ch := 3
	switch cfg.Channels {
	case "", "rgb":
	case "rgbw":
		ch = 4
	default:
		return nil, fmt.Errorf("fake %q: channels %q: want rgb or rgbw", cfg.Name, cfg.Channels)
	}
	if cfg.Live == nil {
		l := GoodLive
		cfg.Live = &l
	}
	if cfg.Version == "" {
		cfg.Version = "0.15.0-fake"
	}
	now := time.Now()
	return &Device{cfg: cfg, channels: ch, start: now, fpsFrom: now,
		pix: make([][4]byte, cfg.Pixels), shown: make([]byte, cfg.Pixels*ch)}, nil
}

// Config returns the device's configuration.
func (d *Device) Config() Config { return d.cfg }

// HandlePacket applies one DDP packet the way WLED's handleDDPPacket does.
// from is the sender, for /json/info.
func (d *Device) HandlePacket(pkt []byte, from string) {
	h, data, err := ddp.Parse(pkt)
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stats.Packets++
	if err != nil || h.ID == ddp.IDControl || h.ID == ddp.IDStatus || h.ID == ddp.IDConfig ||
		h.Flags&(ddp.FlagQuery|ddp.FlagReply) != 0 || (!h.Push() && h.Flags&ddp.FlagStorage != 0) {
		d.stats.Rejected++
		return
	}
	if d.cfg.Live.SkipOutOfSeq && d.lastSeq != 0 && h.Seq != 0 {
		sn, last := int(h.Seq), d.lastSeq
		if (last > 5 && sn > last-5 && sn < last) || (last <= 5 && (sn > 10+last || sn < last)) {
			d.stats.Rejected++
			return
		}
	}
	ch := h.Channels()
	start := int(h.Offset)/ch + d.cfg.Live.DMXAddress/ch
	n := len(data) / ch
	for i := range n {
		p := start + i
		if p >= len(d.pix) {
			break
		}
		c := data[i*ch:]
		d.pix[p] = [4]byte{c[0], c[1], c[2], 0}
		if ch == 4 {
			d.pix[p][3] = c[3]
		}
	}
	d.stats.Source = from
	d.seenPush = d.seenPush || h.Push()
	if !d.seenPush || h.Push() {
		if h.Seq != 0 {
			d.lastSeq = int(h.Seq)
		}
		d.show()
	}
}

// show copies the receive buffer to the shown frame. d.mu is held.
func (d *Device) show() {
	for i, p := range d.pix {
		copy(d.shown[i*d.channels:], p[:d.channels])
	}
	now := time.Now()
	d.stats.Frames++
	d.stats.Last = now
	d.stats.Checksum = crc32.ChecksumIEEE(d.shown)
	d.fpsCount++
	if el := now.Sub(d.fpsFrom); el >= time.Second {
		d.stats.FPS = float64(d.fpsCount) / el.Seconds()
		d.fpsCount, d.fpsFrom = 0, now
	}
	for _, w := range d.waiters {
		close(w)
	}
	d.waiters = d.waiters[:0]
}

// Frame returns a copy of the last shown frame (cfg channels per pixel)
// and the stats.
func (d *Device) Frame() ([]byte, Stats) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]byte(nil), d.shown...), d.stats
}

// Shown returns a channel closed when the next frame is shown.
func (d *Device) Shown() <-chan struct{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	c := make(chan struct{})
	d.waiters = append(d.waiters, c)
	return c
}

// live reports whether a frame arrived within the realtime timeout.
func (d *Device) live() bool {
	t := time.Duration(d.cfg.Live.Timeout) * 100 * time.Millisecond
	return !d.stats.Last.IsZero() && time.Since(d.stats.Last) < t
}

// ServeUDP reads DDP packets from conn until ctx is done.
func (d *Device) ServeUDP(ctx context.Context, conn net.PacketConn) error {
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()
	buf := make([]byte, 2048)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		d.HandlePacket(buf[:n], from.String())
	}
}

// Serve listens on cfg.Listen (UDP and TCP) until ctx is done.
func (d *Device) Serve(ctx context.Context) error {
	pc, err := net.ListenPacket("udp", d.cfg.Listen)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", d.cfg.Listen)
	if err != nil {
		pc.Close()
		return err
	}
	srv := &http.Server{Handler: d.Handler(), ReadHeaderTimeout: 5 * time.Second}
	errc := make(chan error, 2)
	go func() { errc <- d.ServeUDP(ctx, pc) }()
	go func() {
		if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			errc <- err
			return
		}
		errc <- nil
	}()
	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	sctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	srv.Shutdown(sctx)
	pc.Close()
	return err
}

// Handler serves /json/info, /json/cfg, /frame (the shown frame as raw
// bytes) and / (a page drawing the pixels). It accepts a write to
// /json/state as WLED would, and keeps every request it gets, which
// /requests lists: a test can then say what a controller was, and was
// never, asked.
func (d *Device) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /json/state", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"success": true}) })
	mux.HandleFunc("POST /json", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"success": true}) })
	mux.HandleFunc("GET /requests", func(w http.ResponseWriter, r *http.Request) {
		reqs := d.Requests()
		offs := 0
		for _, q := range reqs {
			if q.PowerOff() {
				offs++
			}
		}
		if reqs == nil {
			reqs = []Request{}
		}
		writeJSON(w, map[string]any{"requests": reqs, "power_offs": offs})
	})
	mux.HandleFunc("GET /json/info", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, d.info()) })
	mux.HandleFunc("GET /ledmap.json", func(w http.ResponseWriter, r *http.Request) {
		if d.cfg.LedMaps < 1 {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, map[string]any{"map": []int{}})
	})
	mux.HandleFunc("GET /json/cfg", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, d.cfgJSON()) })
	mux.HandleFunc("GET /frame", func(w http.ResponseWriter, r *http.Request) {
		b, _ := d.Frame()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Channels", fmt.Sprint(d.channels))
		w.Write(b)
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, page, d.cfg.Name, d.cfg.Name, d.channels)
	})
	return d.record(mux)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func (d *Device) info() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	// Like WLED, map 0 is always listed, whether or not ledmap.json exists.
	maps := []map[string]any{}
	for i := range max(d.cfg.LedMaps, 1) {
		maps = append(maps, map[string]any{"id": i})
	}
	lm, lip := "", ""
	live := d.live()
	if live {
		lm = "DDP"
		if h, _, err := net.SplitHostPort(d.stats.Source); err == nil {
			lip = h
		}
	}
	lc := 1
	if d.channels == 4 {
		lc = 3
	}
	return map[string]any{
		"ver":     d.cfg.Version,
		"vid":     2412040,
		"name":    d.cfg.Name,
		"brand":   "WLED",
		"product": "FOSS",
		"arch":    "fake",
		"mac":     "020000000000",
		"uptime":  int(time.Since(d.start).Seconds()),
		"live":    live,
		"lm":      lm,
		"lip":     lip,
		"maps":    maps,
		"leds": map[string]any{
			"count": d.cfg.Pixels, "fps": int(d.stats.FPS + 0.5), "rgbw": d.channels == 4, "lc": lc,
			"pwr": 0, "maxpwr": 0,
		},
	}
}

func (d *Device) cfgJSON() map[string]any {
	l := d.cfg.Live
	typ := 22 // WS2812 RGB
	if d.channels == 4 {
		typ = 30 // SK6812 RGBW
	}
	return map[string]any{
		"if": map[string]any{"live": map[string]any{
			"en": l.Enabled, "mso": l.MainSegmentOnly, "rlm": l.RespectLedMaps, "port": 5568,
			"timeout": l.Timeout, "maxbri": l.ForceMaxBri, "no-gc": l.NoGamma, "offset": 0,
			"dmx": map[string]any{"uni": 1, "seqskip": l.SkipOutOfSeq, "addr": l.DMXAddress, "mode": 4},
		}},
		"hw": map[string]any{"led": map[string]any{
			"total": d.cfg.Pixels, "maxpwr": 0, "rgbwm": 255,
			"ins": []map[string]any{{"start": 0, "len": d.cfg.Pixels, "type": typ, "order": 0, "rgbwm": d.cfg.AutoWhite}},
		}},
	}
}

// page draws the pixels as a strip of squares, refreshed from /frame.
const page = `<!DOCTYPE html>
<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at https://mozilla.org/MPL/2.0/. -->
<html><head><meta charset="utf-8"><title>fake WLED %s</title>
<style>body{background:#111;color:#ccc;font:14px sans-serif}canvas{image-rendering:pixelated;width:100%%}</style>
</head><body><p>fake WLED <b>%s</b> <span id="s"></span></p><canvas id="c"></canvas>
<script>
const ch = %d, cols = 100, c = document.getElementById("c"), g = c.getContext("2d");
async function tick() {
  try {
    const b = new Uint8Array(await (await fetch("frame")).arrayBuffer()), n = b.length / ch;
    c.width = cols; c.height = Math.ceil(n / cols);
    const img = g.createImageData(c.width, c.height);
    for (let i = 0; i < n; i++) {
      const w = ch == 4 ? b[i*4+3] : 0;
      img.data[i*4] = Math.min(255, b[i*ch] + w);
      img.data[i*4+1] = Math.min(255, b[i*ch+1] + w);
      img.data[i*4+2] = Math.min(255, b[i*ch+2] + w);
      img.data[i*4+3] = 255;
    }
    g.putImageData(img, 0, 0);
    document.getElementById("s").textContent = n + " px";
  } catch (e) {}
  setTimeout(tick, 100);
}
tick();
</script></body></html>
`
