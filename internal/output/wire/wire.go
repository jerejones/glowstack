// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package wire is Glowstack's link to its controllers: a DDP sender and a
// health monitor for the controllers chosen with --output, kept in step
// with the layout across config reloads.
//
// Outputs is an output.Sink. It also implements app.Rebuilder (a reload
// re-selects the controllers and restarts the senders if their addresses
// changed) and api.HealthReporter (each controller's health check and
// DDP counters). Run the health monitor with Outputs.Run as an
// app.Service.
package wire

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/ddp"
	"github.com/jerejones/glowstack/internal/output/health"
)

// Options configures New.
type Options struct {
	// Select is an --output value: all, none or comma-separated ids.
	Select string
	// Loopback, when > 0, sends controller i (in layout order) to
	// 127.0.0.1:Loopback+i, DDP and HTTP alike, matching
	// `fakewled --from-config`.
	Loopback int
	DDP      ddp.Options
	// HealthInterval is how often controllers are polled (0 = the
	// health package's default).
	HealthInterval time.Duration
	Client         *http.Client
	Log            *slog.Logger
}

// Outputs sends frames to the selected controllers and watches their
// health.
type Outputs struct {
	opts    Options
	monitor *health.Monitor

	mu      sync.RWMutex
	sink    *ddp.Sink
	targets []ddp.Target
}

// New selects controllers from l and starts their senders.
func New(l *layout.Layout, opts Options) (*Outputs, error) {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	o := &Outputs{opts: opts, monitor: &health.Monitor{Interval: opts.HealthInterval, Client: opts.Client, Log: opts.Log}}
	targets, checks, err := o.plan(l)
	if err != nil {
		return nil, err
	}
	o.targets, o.sink = targets, ddp.New(targets, opts.DDP)
	o.monitor.Targets = checks
	for _, t := range targets {
		opts.Log.Info("output", "controller", t.ID, "ddp", t.Addr)
	}
	return o, nil
}

// plan works out the DDP and health targets for l.
func (o *Outputs) plan(l *layout.Layout) ([]ddp.Target, []health.Target, error) {
	sel, err := output.Select(l, o.opts.Select)
	if err != nil {
		return nil, nil, err
	}
	var targets []ddp.Target
	var checks []health.Target
	for _, i := range sel {
		c := l.Controllers[i]
		ddpAddr, httpAddr := Endpoints(c, i, o.opts.Loopback)
		targets = append(targets, ddp.Target{ID: c.ID, Addr: ddpAddr, MaxFPS: c.Config.MaxFPS})
		checks = append(checks, health.Target{ID: c.ID, URL: "http://" + httpAddr,
			Pixels: c.Pixels, Channels: c.Config.Channels, White: c.Config.White})
	}
	return targets, checks, nil
}

// Endpoints gives controller c's (index i in layout order) DDP and HTTP
// addresses: as configured, or on loopback for fakes.
func Endpoints(c layout.Controller, i, loopback int) (ddpAddr, httpAddr string) {
	if loopback > 0 {
		a := net.JoinHostPort("127.0.0.1", strconv.Itoa(loopback+i))
		return a, a
	}
	return net.JoinHostPort(c.Config.Host, strconv.Itoa(c.Config.Port)),
		net.JoinHostPort(c.Config.Host, strconv.Itoa(c.Config.HTTPPort))
}

// Send implements output.Sink.
func (o *Outputs) Send(f *output.Frame) error {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return o.sink.Send(f)
}

// Close implements output.Sink.
func (o *Outputs) Close() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.sink.Close()
}

// Rebuild implements app.Rebuilder. It runs on the frame loop. Senders are
// restarted only if the targets changed; health checks keep the status of
// controllers that stay.
func (o *Outputs) Rebuild(_ *config.Config, l *layout.Layout) error {
	targets, checks, err := o.plan(l)
	if err != nil {
		return err
	}
	o.monitor.SetTargets(checks)
	o.mu.Lock()
	if slices.Equal(targets, o.targets) {
		o.mu.Unlock()
		return nil
	}
	old := o.sink
	o.targets, o.sink = targets, ddp.New(targets, o.opts.DDP)
	o.mu.Unlock()
	for _, t := range targets {
		o.opts.Log.Info("output", "controller", t.ID, "ddp", t.Addr)
	}
	return old.Close()
}

// Run runs the health monitor until ctx is done. It suits app.Service.
func (o *Outputs) Run(ctx context.Context) error { return o.monitor.Run(ctx) }

// Controller is one controller's health and traffic, as the control API
// reports it.
type Controller struct {
	Addr       string    `json:"addr"`
	Reachable  bool      `json:"reachable"`
	Checked    time.Time `json:"checked,omitzero"`
	Version    string    `json:"version,omitempty"`
	Uptime     float64   `json:"uptime_s,omitempty"`
	Count      int       `json:"led_count,omitempty"`
	Reboots    int       `json:"reboots"`
	Mismatches []string  `json:"mismatches,omitempty"`
	Err        string    `json:"error,omitempty"`

	Frames    uint64    `json:"frames"`
	Packets   uint64    `json:"packets"`
	Bytes     uint64    `json:"bytes"`
	Errors    uint64    `json:"send_errors"`
	Coalesced uint64    `json:"coalesced"`
	LastError string    `json:"last_send_error,omitempty"`
	ErrorAt   time.Time `json:"last_send_error_at,omitzero"`
}

// Health implements api.HealthReporter: a map keyed by controller id.
func (o *Outputs) Health() any { return o.Report() }

// Report is each selected controller's health and DDP counters.
func (o *Outputs) Report() map[string]Controller {
	o.mu.RLock()
	stats := o.sink.Stats()
	o.mu.RUnlock()
	out := make(map[string]Controller, len(stats))
	for _, s := range stats {
		out[s.ID] = Controller{Addr: s.Addr, Frames: s.Frames, Packets: s.Packets, Bytes: s.Bytes,
			Errors: s.Errors, Coalesced: s.Coalesced, LastError: s.LastError, ErrorAt: s.ErrorAt}
	}
	for _, h := range o.monitor.Status() {
		c, ok := out[h.ID]
		if !ok {
			continue
		}
		c.Reachable, c.Checked, c.Version, c.Count = h.Reachable, h.Checked, h.Version, h.Count
		c.Uptime, c.Reboots, c.Mismatches, c.Err = h.Uptime.Seconds(), h.Reboots, h.Mismatches, h.Err
		out[h.ID] = c
	}
	return out
}

var _ output.Sink = (*Outputs)(nil)
