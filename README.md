# Glowstack

Glowstack drives a whole-building addressable LED installation from one
program. Many WLED controllers become simple displays, and Glowstack draws
every pixel and streams each controller its frame. Lighting is organized into
zones and areas that can be controlled independently from Home Assistant,
because Glowstack presents itself as ordinary WLED devices.

> **Status: early.** The core, the first effects, DDP output with power
> limiting, the control API and CLI, the live map and the WLED-compatible
> devices for Home Assistant run. This README describes the design being
> built; `docs/architecture.md` maps it to code.

## Why

A single ESP32 running WLED can't render tens of thousands of pixels, and
separate controllers can't run one effect that spans all of them. A normal
computer can do both easily. Glowstack moves rendering onto one, keeps WLED
on the controllers for the job it's best at, and keeps Home Assistant as the
control surface.

## Design

- **Per-pixel layer stack.** Every command creates a layer: a target (a zone,
  an area, or any set of pixels) and a program (color, effect, show). Each
  pixel shows the topmost layer that covers it. Remove a layer and whatever
  was below shows through again, at the point it has reached by then. For
  example, a porch override sits on top of a yard-wide effect, and when the
  override is removed the porch rejoins the yard.
- **WLED-compatible API.** Each zone appears as its own WLED device (its own
  IP, mDNS `_wled._tcp`), with areas as segments. Home Assistant's built-in
  WLED integration controls Glowstack with no custom integration.
  - Turning a segment on pushes its layer to the top of the stack.
  - Turning it off removes the layer.
  - Changing an active segment edits its layer in place.
- **WLED effect IDs and names,** so existing automations and presets carry
  over. Effects are ported from WLED where useful (see License).
- **DDP output** to each controller, one sender per controller.
- **Area map in YAML.** It maps zones and areas to pixel ranges on each
  controller, including corners, gaps and jumpers, so effects line up and
  move at an even speed.
- **Live map.** A web page draws your site, as a 3-D model or as floor
  plans, with live LED dots. It works on a phone in the yard as well as at a
  desk: try looks on the map before they reach the lights, inspect any
  pixel, and calibrate. Later, a Home Assistant dashboard.
- **Runs as one container.** Deployment is a single static Go binary in a
  Docker image. Site config (area map, addresses, floor plans) is mounted at
  runtime and never built into the image.

## Try it

Everything below runs on your machine against a fictional installation
(`examples/fictional`, a shed, a tower, a fence and a porch) and fake WLED
controllers on loopback. No real controller is contacted. You need Go 1.26.

```sh
go build -o bin/ ./cmd/...
cp -r examples/fictional/data /tmp/gs-data      # anchors.yaml; state is saved here

# Terminal 1: one fake controller per controllers.yaml entry, on
# 127.0.0.1:40481 (shed) and :40482 (yard), DDP and HTTP on each.
bin/fakewled --from-config examples/fictional/config --base-port 40481

# Terminal 2: Glowstack, sending controller i to 127.0.0.1:40481+i, with
# the zones' WLED devices on 127.0.0.1:40080 (front) and :40081 (porch).
bin/glowstack --config examples/fictional/config --data /tmp/gs-data \
  --http 127.0.0.1:8080 --loopback=40481 --wled-bind 127.0.0.1:40080
```

Open the live map at <http://127.0.0.1:8080/map/>, and the fakes' own
pages at <http://127.0.0.1:40481/> and <http://127.0.0.1:40482/> to see
what reaches the "controllers". Then, in a third terminal:

```sh
bin/glowstack ctl push everything slow-crawl    # orange bands creeping along
bin/glowstack ctl push shed glitter             # rainbow with white sparkles
bin/glowstack ctl push porch solid color=#000000   # the porch goes dark …
bin/glowstack ctl layers
bin/glowstack ctl rm 3                          # … and rejoins the yard (use the id shown)
bin/glowstack ctl bri 0.5                       # master brightness
bin/glowstack ctl bri porch 30%                 # one zone
bin/glowstack ctl push --preview porch solid color=#0040ff   # map only
bin/glowstack ctl save-preset blue-porch --from-layer p1   # keep it (use the id shown)
bin/glowstack ctl presets                       # saved ones say "saved"
bin/glowstack ctl reload                        # re-read the config folder
bin/glowstack ctl status                        # frame rate and controller health
bin/glowstack ctl cal start                     # calibration: white pixel = the guessed corner
bin/glowstack ctl cal +10                       # nudge it (or -1, set 400, …)
bin/glowstack ctl cal confirm --next            # write anchors.yaml, go to the next one
bin/glowstack ctl cal stop                      # the house look comes back

# The porch zone as a WLED device: segment 0 on, WLED's Glitter (fx 87).
curl -s 127.0.0.1:40081/json/state -d '{"seg":[{"id":0,"on":true,"fx":87}]}'
bin/glowstack ctl layers                        # owner wled-device:porch/0
```

Controller health is available as `health.controllers` in `/api/v1/status`
and as `health` on each `/api/v1/controllers` entry. Every configured
controller appears; disabled output has `sending: false` and
`reachable: null`. See [the health API contract](docs/design.md#controller-health-api).

`glowctl` is the same client on its own. The map's panel (a bottom sheet
on a phone, a side panel on wider screens) has three tabs. *Looks* tries
presets and effects on the map, with the preview clock (pause, scrub,
speed), before **Apply to lights** sends them. *Setup* has the overlays,
the camera and Calibrate, which on a phone fills the screen with big
nudge and confirm buttons. *Status* shows frame timing, controller health,
each output's estimated current, the output stage's figures after power
limiting and the limit scale. By default Glowstack sends
nothing (`--output=none`); real controllers only receive frames with
`--output=all` or `--output=<ids>`. `--loopback` defaults to all, because it
only reaches local fakes.

### Checking the keyboard

Everything on the live map works without a pointer (see "Keyboard and
assistive technology" in `docs/design.md`). `scripts/keyboard-check.js`
proves it against a running instance by driving a browser with the keyboard
only: it previews a look on a chosen run and puts it on the lights, undoes
that, pins and unpins a preset, creates one, runs a calibration step
(nudge, confirm, back), lists each tab's Tab order, and checks that every
stop shows a focus ring and every control has an accessible name.

It changes the looks, presets and calibration of the instance it is pointed
at and puts them back, so run it only against an example config with fake
controllers, started as above:

```sh
# Playwright is not a dependency of this repo: say where yours is.
PLAYWRIGHT=/path/to/node_modules/playwright \
  node scripts/keyboard-check.js --url http://127.0.0.1:8080
#   --phone            the phone's shell (390 x 844, a coarse pointer)
#   --axe axe.min.js   also scan each tab with axe-core (not vendored here)
```

## Home Assistant

Each zone with a `device:` block in `areas.yaml` is a WLED device of its
own, and its `segments` are the device's segments:

```yaml
zones:
  - id: porch
    area: porch
    device: { name: "Glowstack Porch", ip: 192.0.2.51, mac: "02:00:00:00:00:02" }
    segments:
      - { area: porch }
      - { area: shed-north }
```

1. **Give each device its own IP on the Glowstack host.** Home Assistant's
   WLED integration only talks to port 80, so two devices can't share an
   address. With Docker, a macvlan network with one address per device
   works; on a plain host, add the addresses to the interface. Each `mac`
   must be unique (any locally administered `02:…` address will do); Home
   Assistant tells devices apart by it.
2. **Start Glowstack with `--mdns`** to have the devices discovered (they're
   advertised as `_wled._tcp`, like WLED). Without it, add each one by hand:
   Settings → Devices & services → Add integration → WLED, and enter the
   device's IP.
3. **Use them like WLED.** Each segment is a light; turning it on puts a
   layer on its area, changing effect, palette, colors or sliders edits
   that layer, and turning it off removes it so whatever is below shows
   again (black is a color, not off). The device's own switch and
   brightness are the zone's brightness: off darkens the zone without
   removing anything. Glowstack's presets are the device's presets, under
   ids that don't change.

To try it locally, `--wled-bind 127.0.0.1:0` puts every device on a free
loopback port and logs each address (`wled device listening … addr=…`);
`curl http://ADDR/json/state` or python-wled can talk to them there (Home
Assistant can't: port 80 only). `--wled-bind off` runs no devices. See
`docs/design.md`, "WLED devices", for what maps to what.

## Container

```sh
docker build -t glowstack:dev .
docker run -d --name glowstack \
  -v /path/to/config:/config:ro -v glowstack-data:/data \
  -p 8080:8080 glowstack:dev
```

The image is a static Go binary on `distroless/static` (no shell, so debug
with `--entrypoint`), running as a non-root user (uid 65532) with
`glowstack`, `glowctl` and `fakewled` in `/usr/local/bin`. `/config` is your
site config, mounted read-only and never built in; `/data` is writable and
holds `state.json`, `anchors.yaml` and saved presets, and must be writable by
uid 65532 (or run with `--user`). The entrypoint is
`glowstack --config /config --data /data` and the default argument is
`--http :8080`; add `--output=all` (or ids) to send to real controllers. It
sends nothing by default. The healthcheck is `glowctl status`.

Port 8080 carries the API and live map. Port 80 is for the WLED-compatible
devices, which bind :80 on their own IPs. Docker already lets non-root
processes bind it; if your runtime doesn't, add
`--sysctl net.ipv4.ip_unprivileged_port_start=0`.

Home Assistant finds WLED devices by mDNS and each device needs its own IP,
so the container wants a network on the LAN segment: a `br0` bridge or a
`macvlan` network, one IP for the container plus extra IPs for the WLED
devices. Adding those extra addresses from inside the container needs
`--cap-add NET_ADMIN`; the alternative is to assign them on the host or the
network and leave the container unprivileged. That's the pattern only; the
addressing is yours to choose.

CI (`.github/workflows/ci.yml`) runs `go vet`, `go test -race` and the license
header check. `image.yml` publishes a multi-arch (amd64, arm64) image to
`ghcr.io/jerejones/glowstack` on `v*` tags and on pushes to `main`.

## Requirements (planned)

- WLED controllers that can receive DDP
- A Linux host for the container, on the same network segment as Home
  Assistant for mDNS discovery
- Home Assistant with the WLED integration

## How it's built

Glowstack is written largely by AI coding agents, directed and reviewed by
the maintainer. Agents follow [AGENTS.md](AGENTS.md), which covers the
license header every file needs, how code ported from WLED is attributed, and
the rule that no real installation data goes in this repo.

Agent-written code is tested against the real thing where it matters. The
WLED API is checked with Home Assistant's own `python-wled` library. Expect
rough edges anyway.

Contributions written with AI tools are welcome if they follow AGENTS.md.
Pull requests may not be reviewed.

## License

[MPL-2.0](LICENSE) (Mozilla Public License 2.0). Use it for anything,
including commercially and alongside closed code. If you distribute a
modified version, share your changes to Glowstack's own files.

**No support.** Glowstack is provided as is, with no warranty and no promise
of help, fixes or answers to issues.

Parts of Glowstack may not be eligible for copyright protection. To the
extent they are, they're offered under MPL-2.0.

Some effects are ported from [WLED](https://github.com/wled/WLED), Copyright
(c) 2016-present Christian Schwinne and individual WLED contributors,
originally EUPL-1.2. MPL-2.0 is on EUPL-1.2's list of compatible licenses.
Ported files keep WLED's copyright notice.

Every source file carries the MPL-2.0 header. A pre-commit hook checks it.
See [AGENTS.md](AGENTS.md).
