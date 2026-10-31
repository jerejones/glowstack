# Glowstack

Glowstack drives a whole-building addressable LED installation from one
program. Many WLED controllers become simple displays, and Glowstack draws
every pixel and streams each controller its frame. Lighting is organised into
zones and areas that can be controlled independently from Home Assistant,
because Glowstack presents itself as ordinary WLED devices.

> **Status: planning.** No code yet. This README describes the design being
> built.

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

## Requirements (planned)

- WLED controllers that can receive DDP
- A Linux host for the container, on the same network segment as Home
  Assistant for mDNS discovery
- Home Assistant with the WLED integration

## License

[MPL-2.0](LICENSE) (Mozilla Public License 2.0). Use it for anything,
including commercially and alongside closed code. If you distribute a
modified version, share your changes to Glowstack's own files.

**No support.** Glowstack is provided as is, with no warranty and no promise
of help, fixes or answers to issues.

Some effects are ported from [WLED](https://github.com/wled/WLED), Copyright
(c) 2016-present Christian Schwinne and individual WLED contributors,
originally EUPL-1.2. MPL-2.0 is on EUPL-1.2's list of compatible licenses.
Ported files keep WLED's copyright notice.

Every source file carries the MPL-2.0 header. A pre-commit hook checks it.
See [AGENTS.md](AGENTS.md).
