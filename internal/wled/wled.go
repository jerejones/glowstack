// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package wled makes each zone with a `device:` block look like a WLED
// device to Home Assistant's WLED integration (the python-wled library):
// its own HTTP server with WLED's JSON API, a websocket that pushes state
// changes, and optionally an mDNS advertisement.
//
// # Routes (per device)
//
//	GET  /json                 state, info, effects and palettes
//	GET  /json/si              state and info
//	GET  /json/state           state
//	GET  /json/info            info
//	POST /json[/state|/si]     change the state (WLED's JSON API)
//	GET  /json/eff             effect names by fx id ("RSVD" for unused ids)
//	GET  /json/pal             palette names by WLED palette id
//	GET  /json/fxdata          effect metadata (which sliders each uses)
//	GET  /json/cfg             a minimal config: the LED setup
//	GET  /json/nodes           no other nodes
//	GET  /presets.json         Glowstack's presets under stable WLED ids
//	GET  /ws                   websocket: state and info on every change
//
// # How WLED maps to the stack (docs/design.md, "Layers and the stack")
//
// The device's segments are the zone's configured segments. A segment is
// on when a layer owned by stack.WLEDOwner(zone, segment) is on the stack.
// `on: true` pushes one if there isn't one and edits it in place if there
// is; `on: false` removes it, so the layers below show again. Black with
// `on: true` keeps a layer that blacks the area out. A segment that is off
// remembers its look, which comes back when it's turned on (as on WLED).
// fx, sx, ix, c1–c3, o1–o3, pal and col go through the effect's
// render.Def.WLED bindings; segment bri is the layer's brightness and rev
// its reverse. Controls an effect doesn't bind are remembered and reported
// back unchanged. Switching effect keeps the colours and palette; sliders
// start at the new effect's defaults (their physical meaning changes).
//
// The device's own `on` and `bri` are the zone brightness (App.SetZoneBrightness):
// off sets it to 0, which darkens the zone without removing any layer, so
// turning the device on again shows what was there. The last brightness
// is kept in wled.json in the data folder for that. Because it's the zone
// brightness, the device reports whatever the native API sets too.
//
// `transition` (the device default) and `tt` (this request) are the fade
// in of pushed layers and the fade out of removed ones; edits and
// brightness changes are immediate. `ps` applies a preset to the main
// segment (by name, so the layer shows the preset; its first slider change
// copies it into the layer), `psave` saves the main segment's look with
// App.SavePreset and `pdel` deletes a saved preset. Glowstack presets get
// WLED preset ids 1–250 in order of first sight, kept in wled.json so they
// don't move. Nightlight, UDP sync, live override and per-LED colours are
// accepted and ignored, and reported as off.
//
// Home Assistant only talks to port 80 on the device's address, so a real
// installation gives each zone device its own IP on the host. The
// integration identifies devices by MAC, which config validation keeps
// unique.
package wled

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
)

// Options configures the devices.
type Options struct {
	// Bind overrides every device's listen address, for development
	// without extra IPs: with "127.0.0.1:40080" the first zone device
	// listens on port 40080, the next on 40081 and so on, in zone order.
	// Port 0 gives each device a free port. "" uses each device's
	// configured ip and port.
	Bind string
	// MDNS advertises each device as _wled._tcp and _http._tcp.
	MDNS bool
}

// Devices runs the WLED-compatible devices of an app's zones.
type Devices struct {
	opts    Options
	a       *app.App
	log     *slog.Logger
	started time.Time

	// mu serialises changes and guards the remembered state below.
	mu    sync.Mutex
	segs  map[string]*segMem // by owner
	zones map[string]*zoneMem
	saved savedFile // wled.json
	pmt   int64     // presets modified time (Unix seconds)
	pkey  string    // what the presets list looked like at pmt

	devMu   sync.Mutex
	devices map[string]*device // running, by zone id
	ready   chan struct{}

	changed chan struct{}
	reload  chan struct{}
}

// New returns the devices; run them with Service.
func New(opts Options) *Devices {
	return &Devices{
		opts:    opts,
		segs:    map[string]*segMem{},
		zones:   map[string]*zoneMem{},
		devices: map[string]*device{},
		ready:   make(chan struct{}),
		changed: make(chan struct{}, 1),
		reload:  make(chan struct{}, 1),
	}
}

// Service returns the app.Service that runs the devices: it starts one
// HTTP server per zone device, follows config reloads (starting, stopping
// or moving devices) and pushes state to websocket clients.
func (d *Devices) Service() app.Service {
	return func(ctx context.Context, a *app.App) error {
		d.init(a)
		d.sync(ctx)
		close(d.ready)
		var adv *advertiser
		if d.opts.MDNS {
			adv = newAdvertiser(d.log)
			adv.set(d.adverts())
			defer adv.close()
		}
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				d.stopAll()
				return nil
			case <-d.reload:
				d.sync(ctx)
				if adv != nil {
					adv.set(d.adverts())
				}
			case <-d.changed:
				// Let a burst of changes (a slider drag) settle.
				time.Sleep(20 * time.Millisecond)
			case <-tick.C:
				// Picks up brightness set through the native API.
			}
			d.push()
		}
	}
}

// init connects d to a. Tests call it directly.
func (d *Devices) init(a *app.App) {
	d.a = a
	d.log = a.Log.With("service", "wled")
	d.started = time.Now()
	d.pmt = d.started.Unix()
	d.loadSaved()
	a.Stack.OnChange(d.signal)
	a.OnReload(func() {
		select {
		case d.reload <- struct{}{}:
		default:
		}
		d.signal()
	})
}

// signal says the state may have changed. It never blocks: the stack
// calls it on the frame loop.
func (d *Devices) signal() {
	select {
	case d.changed <- struct{}{}:
	default:
	}
}

// Ready waits until the devices have started listening.
func (d *Devices) Ready(ctx context.Context) error {
	select {
	case <-d.ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Addrs returns each running device's listen address, by zone id.
func (d *Devices) Addrs() map[string]net.Addr {
	d.devMu.Lock()
	defer d.devMu.Unlock()
	out := map[string]net.Addr{}
	for z, dev := range d.devices {
		out[z] = dev.ln.Addr()
	}
	return out
}

// deviceZones lists the zones that have a device, in config order.
func deviceZones(cfg *config.Config) []*config.Zone {
	var out []*config.Zone
	for i := range cfg.Zones {
		if cfg.Zones[i].Device.Present() {
			out = append(out, &cfg.Zones[i])
		}
	}
	return out
}

// listenAddr is where zone device number i listens.
func (d *Devices) listenAddr(i int, dev *config.Device) (string, error) {
	if d.opts.Bind == "" {
		return net.JoinHostPort(dev.IP, strconv.Itoa(cmpOr(dev.Port, config.DefaultDevicePort))), nil
	}
	host, port, err := net.SplitHostPort(d.opts.Bind)
	if err != nil {
		return "", fmt.Errorf("--wled-bind %q: %w", d.opts.Bind, err)
	}
	base, err := strconv.Atoi(port)
	if err != nil || base < 0 || base+i > 65535 {
		return "", fmt.Errorf("--wled-bind %q: bad port", d.opts.Bind)
	}
	if base == 0 {
		return net.JoinHostPort(host, "0"), nil
	}
	return net.JoinHostPort(host, strconv.Itoa(base+i)), nil
}

func sameDevice(a, b *config.Device) bool {
	return a.Name == b.Name && a.IP == b.IP && a.MAC == b.MAC && a.Port == b.Port
}

func cmpOr(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

// sync starts, stops and restarts devices to match the config.
func (d *Devices) sync(ctx context.Context) {
	cfg := d.a.Current().Config
	want := map[string]bool{}
	for i, z := range deviceZones(cfg) {
		want[z.ID] = true
		addr, err := d.listenAddr(i, &z.Device)
		if err != nil {
			d.log.Error("wled device not started", "zone", z.ID, "err", err)
			continue
		}
		d.devMu.Lock()
		old := d.devices[z.ID]
		d.devMu.Unlock()
		if old != nil {
			// Same identity and address: keep it (a device on a free port
			// keeps the port it got).
			if sameDevice(&old.cfg, &z.Device) && old.addr == addr {
				continue
			}
			old.stop()
			d.devMu.Lock()
			delete(d.devices, z.ID)
			d.devMu.Unlock()
		}
		dev, err := d.start(ctx, z.ID, z.Device, addr)
		if err != nil {
			d.log.Error("wled device not started", "zone", z.ID, "addr", addr, "err", err)
			continue
		}
		d.devMu.Lock()
		d.devices[z.ID] = dev
		d.devMu.Unlock()
		d.log.Info("wled device listening", "zone", z.ID, "name", z.Device.Name, "mac", z.Device.MAC, "addr", dev.ln.Addr().String())
	}
	d.devMu.Lock()
	var gone []*device
	for z, dev := range d.devices {
		if !want[z] {
			gone = append(gone, dev)
			delete(d.devices, z)
		}
	}
	d.devMu.Unlock()
	for _, dev := range gone {
		dev.stop()
		d.log.Info("wled device stopped", "zone", dev.zone)
	}
}

func (d *Devices) stopAll() {
	d.devMu.Lock()
	devs := slices.Collect(maps.Values(d.devices))
	clear(d.devices)
	d.devMu.Unlock()
	for _, dev := range devs {
		dev.stop()
	}
}

// push sends the state to every websocket client of a device whose state
// changed since it was last sent.
func (d *Devices) push() {
	d.devMu.Lock()
	devs := slices.Collect(maps.Values(d.devices))
	d.devMu.Unlock()
	for _, dev := range devs {
		if dev.clients() == 0 {
			continue
		}
		msg, key, err := d.message(dev.zone)
		if err != nil {
			continue
		}
		dev.broadcast(msg, key)
	}
}

// message is the websocket message for a zone: state and info. key is
// what changes it (the state and the presets version, not the uptime).
func (d *Devices) message(zone string) (msg []byte, key string, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	v, err := d.view(zone)
	if err != nil {
		return nil, "", err
	}
	st := d.state(v)
	info := d.info(v)
	msg, err = marshal(struct {
		State *State `json:"state"`
		Info  *Info  `json:"info"`
	}{st, info})
	if err != nil {
		return nil, "", err
	}
	sk, _ := marshal(st)
	return msg, string(sk) + strconv.FormatInt(info.FS.PMT, 10), nil
}

var errNoZone = errors.New("no such zone device")
