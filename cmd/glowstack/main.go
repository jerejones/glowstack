// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command glowstack loads an installation's config and data folders,
// solves the layout, prints a summary and runs the frame loop, sending
// frames to the controllers over DDP and serving the control API
// (/api/v1/, with calibration mode under /api/v1/calibration) and the
// live map (/map/) on --http.
//
// Each zone with a `device:` block is also a WLED device for Home
// Assistant (internal/wled), listening on its configured ip and port.
// --wled-bind=HOST:PORT moves them, for development: the first device on
// PORT, the next on PORT+1 and so on (PORT 0: free ports; each device's
// address is logged). --wled-bind=off runs none. --mdns advertises them.
//
// --output chooses the controllers to send to: none (the default; all with
// --loopback), all, or a comma-separated list of ids. --loopback=PORT sends
// controller i to 127.0.0.1:PORT+i instead of its configured address, for
// testing with cmd/fakewled; health checks then go there too.
//
// `glowstack ctl …` is the control API's command-line client instead (see
// internal/ctl).
//
// `glowstack anchors accept|shift|clear …` settles a run's measurements in
// anchors.yaml after its LED count changed (see anchorsMain).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/jerejones/glowstack/internal/api"
	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/calibrate"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/ctl"
	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/mapview"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/wire"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/wled"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "ctl" {
		os.Exit(ctl.Main(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "anchors" {
		os.Exit(anchorsMain(os.Args[2:]))
	}
	configDir := flag.String("config", "/config", "config folder (read-only)")
	dataDir := flag.String("data", "/data", "data folder (writable): state.json, anchors.yaml, presets.saved.yaml")
	fps := flag.Float64("fps", 0, "frame rate (default: glowstack.yaml's fps, else 40)")
	check := flag.Bool("check", false, "load, solve and print the summary, then exit")
	httpAddr := flag.String("http", ":8080", `HTTP listen address for the control API (/api/v1/) and live map (/map/); "" for none`)
	outputs := flag.String("output", "none", "controllers to send to: all, none, or comma-separated ids (default none; with --loopback, default all)")
	wledBind := flag.String("wled-bind", "", `listen address for the zones' WLED devices instead of their configured ones: HOST:PORT puts the first on PORT, the next on PORT+1 (PORT 0: free ports); "off" for none`)
	mdnsOn := flag.Bool("mdns", false, "advertise the zones' WLED devices over mDNS (_wled._tcp), for Home Assistant's discovery")
	loopback := flag.Int("loopback", 0, "send controller i to 127.0.0.1:PORT+i (DDP and health checks), for cmd/fakewled")
	flag.Parse()
	// Sending to real controllers takes over their lights, so it must be asked
	// for explicitly. --loopback only reaches local fakes, so it defaults to all.
	outputSet := false
	flag.Visit(func(f *flag.Flag) { outputSet = outputSet || f.Name == "output" })
	if !outputSet && *loopback > 0 {
		*outputs = "all"
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	var out *wire.Outputs
	opts := app.Options{ConfigDir: *configDir, DataDir: *dataDir, FPS: *fps, Log: log}
	opts.Effects = func(r *render.Registry) error {
		return errors.Join(effects.Register(r), calibrate.Register(r))
	}
	opts.NewSink = func(a *app.App) (output.Sink, error) {
		if *check {
			return nil, nil
		}
		var err error
		out, err = wire.New(a.Layout, wire.Options{Select: *outputs, Loopback: *loopback, Log: log})
		return out, err
	}
	opts.Services = append(opts.Services, func(ctx context.Context, a *app.App) error {
		if out == nil {
			return nil
		}
		return out.Run(ctx)
	})
	if *httpAddr != "" {
		opts.Services = append(opts.Services, httpserver.New(*httpAddr, api.Mount, mapview.Mount(mapview.Options{}), calibrate.Mount).Service())
	}
	if *wledBind != "off" {
		opts.Services = append(opts.Services, wled.New(wled.Options{Bind: *wledBind, MDNS: *mdnsOn}).Service())
	}
	a, err := app.New(opts)
	if err != nil {
		var errs config.Errors
		if errors.As(err, &errs) {
			for _, e := range errs {
				fmt.Fprintln(os.Stderr, e)
			}
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
	a.Summary(os.Stdout)
	for _, w := range output.Check(a.Layout, a.Ticker.FPS()) {
		fmt.Fprintln(os.Stdout, "warning:", w)
	}
	if *check {
		if err := a.Close(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// SIGHUP reloads the config, like POST /api/v1/reload.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			if _, err := a.Reload(); err != nil {
				log.Error("reload failed; keeping the old config", "err", err)
			}
		}
	}()
	log.Info("running", "fps", a.Ticker.FPS())
	if err := a.Run(ctx); err != nil {
		log.Error("stopped", "err", err)
		os.Exit(1)
	}
	log.Info("stopped", "late_frames", a.Ticker.Late())
}

const anchorsUsage = `usage: glowstack anchors [--config DIR] [--data DIR] accept RUN
       glowstack anchors [--config DIR] [--data DIR] shift RUN AT N
       glowstack anchors [--config DIR] [--data DIR] clear RUN

Settles a run's measurements in anchors.yaml after its LED count changed:
  accept  LEDs were added or removed at the run's far end; keep every offset
  shift   N LEDs were added (negative: removed) before offset AT; move the
          offsets at or past AT by N
  clear   drop the run's measurements and recalibrate it
`

// anchorsMain runs `glowstack anchors`.
func anchorsMain(args []string) int {
	fs := flag.NewFlagSet("anchors", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, anchorsUsage) }
	configDir := fs.String("config", "/config", "config folder (read-only)")
	dataDir := fs.String("data", "/data", "data folder holding anchors.yaml")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	want := map[string]int{calibrate.AdjustAccept: 2, calibrate.AdjustShift: 4, calibrate.AdjustClear: 2}
	if len(rest) == 0 || want[rest[0]] != len(rest) {
		fs.Usage()
		return 2
	}
	adj := calibrate.Adjustment{Op: rest[0], Run: rest[1]}
	if adj.Op == calibrate.AdjustShift {
		var err1, err2 error
		adj.At, err1 = strconv.Atoi(rest[2])
		adj.N, err2 = strconv.Atoi(rest[3])
		if err1 != nil || err2 != nil {
			fmt.Fprintln(os.Stderr, "shift: AT and N are whole numbers of LEDs")
			return 2
		}
	}
	msg, err := calibrate.Adjust(*configDir, *dataDir, adj)
	if msg != "" {
		fmt.Println(msg)
	}
	if err != nil {
		if msg != "" {
			fmt.Fprintln(os.Stderr, "the config still doesn't load:")
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
