// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command fakewled runs one or more fake WLED controllers on loopback, for
// running Glowstack with no hardware. Each fake receives DDP on a UDP port
// and serves /json/info, /json/cfg and a page showing its pixels on the
// same TCP port. It logs per-frame stats now and then.
//
// Fake every controller of an installation, on 127.0.0.1:40481 onwards in
// controllers.yaml order (matching glowstack --loopback=40481):
//
//	fakewled --from-config examples/fictional/config --base-port 40481
//
// Or describe the fakes in a small YAML file (see fakewled.Config):
//
//	devices:
//	  - { name: shed, listen: 127.0.0.1:40481, pixels: 604, channels: rgbw }
//	  - name: yard
//	    listen: 127.0.0.1:40482
//	    pixels: 480
//	    live: { en: true, timeout: 25, maxbri: false, no-gc: false }   # replaces all the defaults
//
// Or one fake from flags: fakewled --listen 127.0.0.1:40481 --pixels 300.
//
// Addresses must be loopback.
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
	"sync"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/fakewled"
)

func main() {
	file := flag.String("config", "", "YAML file listing fake devices")
	fromConfig := flag.String("from-config", "", "Glowstack config folder: fake each controller in controllers.yaml")
	basePort := flag.Int("base-port", 40481, "with --from-config: first port; controller i gets base+i")
	listen := flag.String("listen", "127.0.0.1:40481", "single fake: UDP and TCP address")
	pixels := flag.Int("pixels", 300, "single fake: LED count")
	channels := flag.String("channels", "rgb", "single fake: rgb or rgbw")
	name := flag.String("name", "fake", "single fake: name")
	every := flag.Duration("stats", 5*time.Second, "log frame stats this often (0 = never)")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cfgs, err := devices(*file, *fromConfig, *basePort, fakewled.Config{Name: *name, Listen: *listen, Pixels: *pixels, Channels: *channels})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var devs []*fakewled.Device
	for _, c := range cfgs {
		if err := loopbackOnly(c.Listen); err != nil {
			fmt.Fprintf(os.Stderr, "fake %s: %v\n", c.Name, err)
			os.Exit(1)
		}
		d, err := fakewled.New(c)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		devs = append(devs, d)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	for _, d := range devs {
		c := d.Config()
		log.Info("fake WLED", "name", c.Name, "listen", c.Listen, "pixels", c.Pixels, "channels", c.Channels,
			"page", "http://"+c.Listen+"/")
		wg.Go(func() {
			if err := d.Serve(ctx); err != nil {
				log.Error("fake stopped", "name", c.Name, "err", err)
				cancel()
			}
		})
	}
	if *every > 0 {
		wg.Go(func() { logStats(ctx, log, devs, *every) })
	}
	wg.Wait()
}

func devices(file, fromConfig string, base int, single fakewled.Config) ([]fakewled.Config, error) {
	switch {
	case file != "" && fromConfig != "":
		return nil, errors.New("use --config or --from-config, not both")
	case file != "":
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var f struct {
			Devices []fakewled.Config `yaml:"devices"`
		}
		if err := yaml.Unmarshal(b, &f); err != nil {
			return nil, fmt.Errorf("%s: %w", file, err)
		}
		if len(f.Devices) == 0 {
			return nil, fmt.Errorf("%s: no devices", file)
		}
		return f.Devices, nil
	case fromConfig != "":
		c, err := config.Load(fromConfig, "")
		if err != nil {
			return nil, err
		}
		var out []fakewled.Config
		for i, ctl := range c.Controllers {
			out = append(out, fakewled.Config{Name: ctl.ID, Listen: net.JoinHostPort("127.0.0.1", strconv.Itoa(base+i)),
				Pixels: ctl.Pixels, Channels: ctl.Channels})
		}
		return out, nil
	default:
		return []fakewled.Config{single}, nil
	}
}

// loopbackOnly refuses anything but a loopback address: the fakes are for
// testing on this machine.
func loopbackOnly(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("listen address %q is not loopback", addr)
	}
	return nil
}

func logStats(ctx context.Context, log *slog.Logger, devs []*fakewled.Device, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	prev := make([]uint64, len(devs))
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for i, d := range devs {
			frame, st := d.Frame()
			if st.Frames == prev[i] {
				continue
			}
			c := d.Config()
			ch := len(frame) / c.Pixels
			lit := 0
			for p := 0; p < len(frame); p += ch {
				for _, b := range frame[p : p+ch] {
					if b != 0 {
						lit++
						break
					}
				}
			}
			sample := func(p int) string { return fmt.Sprintf("%d:%x", p, frame[p*ch:p*ch+ch]) }
			log.Info("frames", "name", c.Name, "frames", st.Frames-prev[i], "fps", fmt.Sprintf("%.1f", st.FPS),
				"pixels", c.Pixels, "lit", lit, "crc32", fmt.Sprintf("%08x", st.Checksum),
				"sample", sample(0)+" "+sample(c.Pixels/2)+" "+sample(c.Pixels-1), "rejected", st.Rejected, "from", st.Source)
			prev[i] = st.Frames
		}
	}
}
