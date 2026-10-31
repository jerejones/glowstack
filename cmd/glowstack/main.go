// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command glowstack loads an installation's config and data folders,
// solves the layout, prints a summary and runs the frame loop, sending
// frames to the controllers over DDP.
//
// --output chooses the controllers to send to: all (default), none, or a
// comma-separated list of ids. --loopback=PORT sends controller i to
// 127.0.0.1:PORT+i instead of its configured address, for testing with
// cmd/fakewled; health checks then go there too.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/ddp"
	"github.com/jerejones/glowstack/internal/output/health"
)

func main() {
	configDir := flag.String("config", "/config", "config folder (read-only)")
	dataDir := flag.String("data", "/data", "data folder (writable): state.json, anchors.yaml, presets.saved.yaml")
	fps := flag.Float64("fps", 0, "frame rate (default: glowstack.yaml's fps, else 40)")
	check := flag.Bool("check", false, "load, solve and print the summary, then exit")
	outputs := flag.String("output", "all", "controllers to send to: all, none, or comma-separated ids")
	loopback := flag.Int("loopback", 0, "send controller i to 127.0.0.1:PORT+i (DDP and health checks), for cmd/fakewled")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	var monitor *health.Monitor
	opts := app.Options{ConfigDir: *configDir, DataDir: *dataDir, FPS: *fps, Log: log}
	opts.NewSink = func(a *app.App) (output.Sink, error) {
		sel, err := output.Select(a.Layout, *outputs)
		if err != nil || len(sel) == 0 || *check {
			return nil, err
		}
		var targets []ddp.Target
		monitor = &health.Monitor{Log: log}
		for _, i := range sel {
			c := a.Layout.Controllers[i]
			ddpAddr, httpAddr := endpoints(c, i, *loopback)
			targets = append(targets, ddp.Target{ID: c.ID, Addr: ddpAddr, MaxFPS: c.Config.MaxFPS})
			monitor.Targets = append(monitor.Targets, health.Target{ID: c.ID, URL: "http://" + httpAddr,
				Pixels: c.Pixels, Channels: c.Config.Channels, White: c.Config.White})
			log.Info("output", "controller", c.ID, "ddp", ddpAddr)
		}
		return ddp.New(targets, ddp.Options{}), nil
	}
	opts.Services = append(opts.Services, func(ctx context.Context, a *app.App) error {
		if monitor == nil {
			return nil
		}
		return monitor.Run(ctx)
	})
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
	log.Info("running", "fps", a.Ticker.FPS())
	if err := a.Run(ctx); err != nil {
		log.Error("stopped", "err", err)
		os.Exit(1)
	}
	log.Info("stopped", "late_frames", a.Ticker.Late())
}

// endpoints gives controller c's DDP and HTTP addresses: as configured, or
// on loopback for fakes.
func endpoints(c layout.Controller, i, loopback int) (ddpAddr, httpAddr string) {
	if loopback > 0 {
		a := net.JoinHostPort("127.0.0.1", strconv.Itoa(loopback+i))
		return a, a
	}
	return net.JoinHostPort(c.Config.Host, strconv.Itoa(c.Config.Port)),
		net.JoinHostPort(c.Config.Host, strconv.Itoa(c.Config.HTTPPort))
}
