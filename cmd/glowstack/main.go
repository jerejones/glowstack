// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command glowstack loads an installation's config and data folders,
// solves the layout, prints a summary and runs the frame loop, with the
// live map on --http (default :8080, at /map/).
//
// Output isn't wired yet: frames are rendered and discarded until the
// output stage and DDP senders exist (see docs/architecture.md), so
// --output only accepts "none" for now.
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

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/httpserver"
	"github.com/jerejones/glowstack/internal/mapview"
)

func main() {
	configDir := flag.String("config", "/config", "config folder (read-only)")
	dataDir := flag.String("data", "/data", "data folder (writable): state.json, anchors.yaml, presets.saved.yaml")
	fps := flag.Float64("fps", 0, "frame rate (default: glowstack.yaml's fps, else 40)")
	check := flag.Bool("check", false, "load, solve and print the summary, then exit")
	httpAddr := flag.String("http", ":8080", `HTTP listen address for the live map (/map/) and APIs; "" for none`)
	outputs := flag.String("output", "none", `where to send frames: "none" (DDP output isn't built yet)`)
	flag.Parse()
	if *outputs != "none" {
		fmt.Fprintln(os.Stderr, "--output: only \"none\" is supported until DDP output exists")
		os.Exit(2)
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	var services []app.Service
	if *httpAddr != "" {
		srv := httpserver.New(*httpAddr, log)
		services = append(services,
			func(ctx context.Context, _ *app.App) error { return srv.Run(ctx) },
			mapview.Service(srv, mapview.Options{}),
		)
	}
	a, err := app.New(app.Options{ConfigDir: *configDir, DataDir: *dataDir, FPS: *fps, Log: log, Services: services})
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
