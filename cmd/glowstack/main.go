// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command glowstack loads an installation's config and data folders,
// solves the layout, prints a summary and runs the frame loop, sending
// frames to the controllers over DDP and serving the control API on
// --http.
//
// --output chooses the controllers to send to: all (default), none, or a
// comma-separated list of ids. --loopback=PORT sends controller i to
// 127.0.0.1:PORT+i instead of its configured address, for testing with
// cmd/fakewled; health checks then go there too.
//
// `glowstack ctl …` is the control API's command-line client instead (see
// internal/ctl).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/jerejones/glowstack/internal/api"
	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/ctl"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/output/wire"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "ctl" {
		os.Exit(ctl.Main(os.Args[2:], os.Stdout, os.Stderr))
	}
	configDir := flag.String("config", "/config", "config folder (read-only)")
	dataDir := flag.String("data", "/data", "data folder (writable): state.json, anchors.yaml, presets.saved.yaml")
	fps := flag.Float64("fps", 0, "frame rate (default: glowstack.yaml's fps, else 40)")
	check := flag.Bool("check", false, "load, solve and print the summary, then exit")
	httpAddr := flag.String("http", ":8080", "HTTP listen address for the control API (empty: no HTTP server)")
	outputs := flag.String("output", "all", "controllers to send to: all, none, or comma-separated ids")
	loopback := flag.Int("loopback", 0, "send controller i to 127.0.0.1:PORT+i (DDP and health checks), for cmd/fakewled")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	var out *wire.Outputs
	opts := app.Options{ConfigDir: *configDir, DataDir: *dataDir, FPS: *fps, Log: log}
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
		opts.Services = append(opts.Services, httpserver.New(*httpAddr, api.Mount).Service())
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
