// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/effects"
)

// maxBody is the largest state request taken (WLED's own JSON buffer is
// smaller).
const maxBody = 64 << 10

// device is one running zone device: an HTTP server and its websocket
// clients.
type device struct {
	d      *Devices
	zone   string
	cfg    config.Device
	addr   string // as asked for
	ln     net.Listener
	srv    *http.Server
	cancel context.CancelFunc
	done   chan struct{}

	mu   sync.Mutex
	subs map[*wsClient]bool
	last string // key of the state last pushed
}

type wsClient struct {
	send chan []byte // newest message wins
}

func (d *Devices) start(ctx context.Context, zone string, cfg config.Device, addr string) (*device, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	dev := &device{d: d, zone: zone, cfg: cfg, addr: addr, ln: ln, cancel: cancel,
		done: make(chan struct{}), subs: map[*wsClient]bool{}}
	dev.srv = &http.Server{
		Handler:           d.handler(dev),
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          slog.NewLogLogger(d.log.Handler(), slog.LevelWarn),
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() {
		defer close(dev.done)
		if err := dev.srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			d.log.Error("wled device stopped", "zone", zone, "err", err)
		}
	}()
	return dev, nil
}

// stop shuts the server down. Websockets end with the context.
func (dev *device) stop() {
	dev.cancel()
	sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := dev.srv.Shutdown(sctx); err != nil {
		_ = dev.srv.Close()
	}
	<-dev.done
}

func (dev *device) clients() int {
	dev.mu.Lock()
	defer dev.mu.Unlock()
	return len(dev.subs)
}

// broadcast sends msg to every client, unless key says it's what was sent
// last.
func (dev *device) broadcast(msg []byte, key string) {
	dev.mu.Lock()
	defer dev.mu.Unlock()
	if key == dev.last {
		return
	}
	dev.last = key
	for c := range dev.subs {
		offer(c.send, msg)
	}
}

// offer puts msg in a one-slot channel, replacing what's waiting.
func offer(ch chan []byte, msg []byte) {
	for {
		select {
		case ch <- msg:
			return
		default:
		}
		select {
		case <-ch:
		default:
		}
	}
}

func (d *Devices) wsCount(zone string) int {
	d.devMu.Lock()
	dev := d.devices[zone]
	d.devMu.Unlock()
	if dev == nil {
		return 0
	}
	return dev.clients()
}

// handler serves one device's WLED API.
func (d *Devices) handler(dev *device) http.Handler {
	return d.zoneHandler(dev.zone, dev)
}

// zoneHandler is the API for zone; dev (nil in tests) has the websocket
// clients.
func (d *Devices) zoneHandler(zone string, dev *device) http.Handler {
	mux := http.NewServeMux()
	read := func(fn func(v *view) any) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			d.mu.Lock()
			v, err := d.view(zone)
			var body any
			if err == nil {
				body = fn(v)
			}
			d.mu.Unlock()
			if err != nil {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
			writeJSON(w, http.StatusOK, body)
		}
	}
	mux.HandleFunc("GET /json", read(func(v *view) any {
		return map[string]any{"state": d.state(v), "info": d.info(v),
			"effects": effects.WLEDEffectNames(d.a.Effects), "palettes": paletteNames(v)}
	}))
	mux.HandleFunc("GET /json/si", read(func(v *view) any {
		return map[string]any{"state": d.state(v), "info": d.info(v)}
	}))
	mux.HandleFunc("GET /json/state", read(func(v *view) any { return d.state(v) }))
	mux.HandleFunc("GET /json/info", read(func(v *view) any { return d.info(v) }))
	mux.HandleFunc("GET /json/eff", read(func(*view) any { return effects.WLEDEffectNames(d.a.Effects) }))
	mux.HandleFunc("GET /json/pal", read(func(v *view) any { return paletteNames(v) }))
	mux.HandleFunc("GET /json/fxdata", read(func(*view) any { return fxData(d.a.Effects) }))
	mux.HandleFunc("GET /json/cfg", read(func(v *view) any { return cfgJSON(v) }))
	mux.HandleFunc("GET /json/nodes", read(func(*view) any { return map[string]any{"nodes": []any{}} }))
	mux.HandleFunc("GET /presets.json", read(func(v *view) any { return d.presetsJSON(v) }))
	post := func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": 9})
			return
		}
		wantState, err := d.apply(zone, body)
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, errBadRequest) {
				status = http.StatusBadRequest
			} else if errors.Is(err, errNoZone) {
				status = http.StatusServiceUnavailable
			}
			d.log.Warn("wled request failed", "zone", zone, "err", err)
			writeJSON(w, status, map[string]any{"error": err.Error()})
			return
		}
		if !wantState {
			writeJSON(w, http.StatusOK, map[string]any{"success": true})
			return
		}
		read(func(v *view) any { return d.state(v) })(w, r)
	}
	for _, p := range []string{"/json", "/json/state", "/json/si"} {
		mux.HandleFunc("POST "+p, post)
	}
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		if dev == nil {
			http.NotFound(w, r)
			return
		}
		dev.serveWS(w, r)
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<!doctype html><title>Glowstack</title><p>A Glowstack zone, as a WLED device. Use the JSON API at /json.</p>\n")
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	data, err := marshal(body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// serveWS is WLED's websocket: the state and info on connecting and on
// every change. A client may send state changes, as to POST /json/state;
// {"v": true} asks for the state and info.
func (dev *device) serveWS(w http.ResponseWriter, r *http.Request) {
	d := dev.d
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(maxBody)
	c := &wsClient{send: make(chan []byte, 1)}
	dev.mu.Lock()
	dev.subs[c] = true
	dev.mu.Unlock()
	defer func() {
		dev.mu.Lock()
		delete(dev.subs, c)
		dev.mu.Unlock()
	}()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sendNow := func() {
		if msg, _, err := d.message(dev.zone); err == nil {
			offer(c.send, msg)
		}
	}
	sendNow()
	d.signal() // ws count in everyone's info
	go func() {
		defer cancel()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			wantState, err := d.apply(dev.zone, data)
			if err != nil {
				d.log.Warn("wled websocket request failed", "zone", dev.zone, "err", err)
				continue
			}
			if wantState {
				sendNow()
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			conn.Close(websocket.StatusGoingAway, "")
			return
		case msg := <-c.send:
			wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(wctx, websocket.MessageText, msg)
			wcancel()
			if err != nil {
				return
			}
		}
	}
}
