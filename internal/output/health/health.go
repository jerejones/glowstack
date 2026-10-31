// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package health checks WLED controllers over their JSON API, read-only.
// It polls /json/info slowly to notice reboots, firmware changes and an
// unexpected pixel count, and reads /json/cfg at start and after each
// reboot to check the realtime settings Glowstack relies on (see
// docs/design.md, "Controllers"). It never writes to a controller and
// never changes a setting: mismatches are reported for a person to fix.
package health

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"
)

// DefaultInterval is how often /json/info is polled.
const DefaultInterval = time.Minute

// Target is one controller to check.
type Target struct {
	ID       string
	URL      string // base URL, e.g. http://192.0.2.21
	Pixels   int    // expected LED count
	Channels string // rgb | rgbw
	White    string // explicit | auto
}

// Status is what's known about one controller.
type Status struct {
	ID         string
	Reachable  bool
	Version    string
	Uptime     time.Duration
	Count      int // LED count it reports
	Reboots    int // reboots seen since Glowstack started
	Mismatches []string
	Err        string // last error, if unreachable
	Checked    time.Time
}

// Info is the part of /json/info that's checked.
type Info struct {
	Ver    string `json:"ver"`
	Uptime int64  `json:"uptime"` // seconds
	Leds   struct {
		Count int `json:"count"`
	} `json:"leds"`
	Maps []struct {
		ID int `json:"id"`
	} `json:"maps"`
}

// Cfg is the part of /json/cfg that's checked. Pointers are nil when a
// firmware doesn't have the setting.
type Cfg struct {
	If struct {
		Live struct {
			En      *bool `json:"en"`
			MSO     *bool `json:"mso"`
			RLM     *bool `json:"rlm"`
			Timeout *int  `json:"timeout"` // 100 ms units
			MaxBri  *bool `json:"maxbri"`
			NoGC    *bool `json:"no-gc"`
			DMX     struct {
				Addr *int `json:"addr"`
			} `json:"dmx"`
		} `json:"live"`
	} `json:"if"`
	HW struct {
		LED struct {
			RGBWM *int `json:"rgbwm"` // global auto-white override; 255 = per bus
			Ins   []struct {
				Start int  `json:"start"`
				Len   int  `json:"len"`
				RGBWM *int `json:"rgbwm"`
			} `json:"ins"`
		} `json:"led"`
	} `json:"hw"`
}

// infiniteTimeout is WLED's "never time out" realtime timeout (65 s in
// 100 ms units).
const infiniteTimeout = 650

// Mismatches lists the ways a controller's settings differ from what
// Glowstack needs.
func Mismatches(t Target, info *Info, cfg *Cfg) []string {
	var out []string
	add := func(format string, args ...any) { out = append(out, fmt.Sprintf(format, args...)) }
	if info != nil && info.Leds.Count != 0 && info.Leds.Count != t.Pixels {
		add("reports %d LEDs, controllers.yaml says %d", info.Leds.Count, t.Pixels)
	}
	if cfg == nil {
		return out
	}
	l := cfg.If.Live
	if l.En != nil && !*l.En {
		add("realtime receive is off (Sync settings: \"Receive UDP realtime\")")
	}
	if l.MSO != nil && *l.MSO {
		add("\"Use main segment only\" is on; realtime data would only reach the main segment")
	}
	if l.Timeout != nil {
		switch *l.Timeout {
		case 0:
			add("realtime timeout is 0")
		case infiniteTimeout:
			add("realtime timeout is infinite; the controller won't fall back if Glowstack stops")
		}
	}
	if l.NoGC != nil && !*l.NoGC {
		add("realtime gamma correction is on (no-gc off); Glowstack already sends drive levels, so colours would be gamma-corrected twice")
	}
	if l.MaxBri != nil && !*l.MaxBri {
		add("\"Force max brightness\" is off; the controller's brightness would scale Glowstack's frames")
	}
	if l.RLM != nil && *l.RLM && info != nil && len(info.Maps) > 0 {
		add("an LED map exists and realtime respects LED maps (rlm); indices would be remapped")
	}
	ch := 3
	if t.Channels == "rgbw" {
		ch = 4
	}
	if a := l.DMX.Addr; a != nil && *a/ch != 0 {
		add("DMX start address %d shifts DDP data by %d pixels", *a, *a/ch)
	}
	if t.White == "explicit" {
		modes := map[int]string{1: "brighter", 2: "accurate", 3: "dual", 4: "max"}
		if g := cfg.HW.LED.RGBWM; g != nil && *g != 255 && *g != 0 {
			add("global auto-white is %q; with white: explicit it must be off", modes[*g])
		} else if g == nil || *g == 255 {
			for _, b := range cfg.HW.LED.Ins {
				if b.RGBWM != nil && *b.RGBWM != 0 {
					add("output at %d+%d has auto-white %q; with white: explicit it must be off", b.Start, b.Len, modes[*b.RGBWM])
				}
			}
		}
	}
	return out
}

// Monitor checks a set of controllers. Set Targets before Run, or call
// SetTargets at any time.
type Monitor struct {
	Targets  []Target
	Client   *http.Client // nil = 5 s timeout client
	Interval time.Duration
	Log      *slog.Logger

	mu     sync.Mutex
	status map[string]*Status
	cfgs   map[string]*Cfg // read since the last reboot; nil = read it next time
	kick   chan struct{}
}

// SetTargets replaces the controllers to check, for a config reload.
// Controllers that stay keep their status; Run checks the new set at once.
func (m *Monitor) SetTargets(ts []Target) {
	m.mu.Lock()
	// An id may now name a different endpoint (including shifted loopback
	// ports). Do not reuse settings or in-flight results from the old one.
	for _, old := range m.Targets {
		if !slices.ContainsFunc(ts, func(t Target) bool { return t.ID == old.ID && t.URL == old.URL }) {
			delete(m.status, old.ID)
			delete(m.cfgs, old.ID)
		}
	}
	m.Targets = slices.Clone(ts)
	if m.kick == nil {
		m.kick = make(chan struct{}, 1)
	}
	kick := m.kick
	m.mu.Unlock()
	select {
	case kick <- struct{}{}:
	default:
	}
}

// Run checks every target now and then every Interval until ctx is done.
// It suits app.Service.
func (m *Monitor) Run(ctx context.Context) error {
	interval := m.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	m.mu.Lock()
	if m.kick == nil {
		m.kick = make(chan struct{}, 1)
	}
	kick := m.kick
	m.mu.Unlock()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		m.Check(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-kick:
		}
	}
}

// Check polls every target once, concurrently.
func (m *Monitor) Check(ctx context.Context) {
	m.mu.Lock()
	if m.status == nil {
		m.status, m.cfgs = map[string]*Status{}, map[string]*Cfg{}
	}
	targets := slices.Clone(m.Targets)
	for _, t := range targets {
		if m.status[t.ID] == nil {
			m.status[t.ID] = &Status{ID: t.ID}
		}
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, t := range targets {
		wg.Go(func() { m.check(ctx, t) })
	}
	wg.Wait()
}

func (m *Monitor) check(ctx context.Context, t Target) {
	var info Info
	err := m.get(ctx, t.URL+"/json/info", &info)
	m.mu.Lock()
	st := m.status[t.ID]
	if st == nil || !slices.Contains(m.Targets, t) {
		m.mu.Unlock()
		return
	}
	prev := *st
	st.Checked = time.Now()
	if err != nil {
		st.Reachable, st.Err = false, err.Error()
		m.mu.Unlock()
		if prev.Reachable || prev.Checked.IsZero() {
			m.log().Warn("controller unreachable", "controller", t.ID, "err", err)
		}
		return
	}
	st.Reachable, st.Err = true, ""
	st.Version, st.Count = info.Ver, info.Leds.Count
	up := time.Duration(info.Uptime) * time.Second
	// An offline poll preserves the last successful uptime. A reboot
	// commonly causes that outage, so compare even after a failed poll.
	rebooted := up < prev.Uptime
	if rebooted {
		st.Reboots++
		m.cfgs[t.ID] = nil
	}
	st.Uptime = up
	cfg := m.cfgs[t.ID]
	m.mu.Unlock()

	if rebooted {
		m.log().Warn("controller rebooted", "controller", t.ID, "uptime", up)
	}
	if prev.Version != "" && prev.Version != info.Ver {
		m.log().Warn("controller firmware changed", "controller", t.ID, "from", prev.Version, "to", info.Ver)
	}
	if cfg == nil {
		cfg = new(Cfg)
		if err := m.get(ctx, t.URL+"/json/cfg", cfg); err != nil {
			m.log().Warn("reading controller settings", "controller", t.ID, "err", err)
			cfg = nil
		}
	}
	found := Mismatches(t, &info, cfg)
	for _, s := range found {
		if !slices.Contains(prev.Mismatches, s) {
			m.log().Warn("controller setting", "controller", t.ID, "problem", s)
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status[t.ID] != st || !slices.Contains(m.Targets, t) {
		return
	}
	m.cfgs[t.ID] = cfg
	st.Mismatches = found
}

func (m *Monitor) get(ctx context.Context, url string, v any) error {
	c := m.Client
	if c == nil {
		c = &http.Client{Timeout: 5 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(v)
}

func (m *Monitor) log() *slog.Logger {
	if m.Log != nil {
		return m.Log
	}
	return slog.Default()
}

// Status returns a snapshot per target, in target order.
func (m *Monitor) Status() []Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Status, 0, len(m.Targets))
	for _, t := range m.Targets {
		if st := m.status[t.ID]; st != nil {
			s := *st
			s.Mismatches = slices.Clone(st.Mismatches)
			out = append(out, s)
		} else {
			out = append(out, Status{ID: t.ID})
		}
	}
	return out
}
