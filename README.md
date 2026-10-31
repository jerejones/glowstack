# Glowstack

Glowstack drives a whole-building addressable LED installation from one
program. Many WLED controllers become simple displays, and Glowstack draws
every pixel and streams each controller its frame. Lighting is organised into
zones and areas that can be controlled independently from Home Assistant,
because Glowstack presents itself as ordinary WLED devices.

> **Status: early.** The core, the first effects, DDP output with power
> limiting, the control API and CLI, and the live map run. The
> WLED-compatible devices for Home Assistant aren't built yet. This README
> describes the design being built; `docs/architecture.md` maps it to code.

## Why

A single ESP32 running WLED can't render tens of thousands of pixels, and
separate controllers can't run one effect that spans all of them. A normal
computer can do both easily. Glowstack moves rendering onto one, keeps WLED
on the controllers for the job it's best at, and keeps Home Assistant as the
control surface.

## Design

- **Per-pixel layer stack.** Every command creates a layer: a target (a zone,
  an area, or any set of pixels) and a program (colour, effect, show). Each
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
- **Live map.** A web page draws your floor plans with live LED dots, for a
  Home Assistant dashboard or for testing effects without going outside.
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

# Terminal 2: Glowstack, sending controller i to 127.0.0.1:40481+i.
bin/glowstack --config examples/fictional/config --data /tmp/gs-data \
  --http 127.0.0.1:8080 --loopback=40481
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
```

`glowctl` is the same client on its own. The map's side panel shows each
output's estimated current, the output stage's figures after power
limiting and the limit scale; it also has preview controls (pause, scrub,
speed) and a form for preview-only layers. By default Glowstack sends
nothing (`--output=none`); real controllers only receive frames with
`--output=all` or `--output=<ids>`. `--loopback` defaults to all, because it
only reaches local fakes.

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
