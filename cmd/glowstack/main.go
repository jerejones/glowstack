// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command glowstack loads an installation's config and data folders,
// solves the layout, prints a summary and runs the frame loop, serving the
// control API on --http.
//
// `glowstack ctl …` is the control API's command-line client instead (see
// internal/ctl).
//
// Output isn't wired yet: frames are rendered and discarded until the
// output stage and DDP senders exist (see docs/architecture.md).
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
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	var services []app.Service
	if *httpAddr != "" {
		services = append(services, httpserver.New(*httpAddr, api.Mount).Service())
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
