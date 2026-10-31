# Glowstack architecture

How the code is laid out, and where the work that isn't done yet belongs.
`docs/design.md` is the spec and defines the vocabulary; this document maps
it to packages. Read the package docs (`go doc ./internal/<pkg>`) for the
details.

## Data flow

```text
config dir ──► config.Load ──► layout.Build ──► layout.SolveMappings
data dir ───┘   (YAML, file:line errors)  (pixel table)   (flows, spatial)
                                                 │
 API / WLED devices / CLI ──► stack.Stack ──► engine.Engine ──► render.Compositor
                               │ state.json      (presets, mapping,   (layers → Buffer,
                               ▼                  params, geometry)    linear RGBW)
                         storage.Saver                                    │
                                                    app.OnFrame ◄─────────┤ (live map)
                                                                          ▼
                                                  output.Stage ──► output.Sink (DDP)
```

`app.App` wires all of it. `clock.Ticker` drives `App.RenderFrame` once per
frame; everything up to the stack is built once at start.

## Packages

| Package | What it holds |
|---|---|
| `internal/units` | Parsing and printing of lengths (`m cm mm ft in px`), speeds, durations, rates, densities, angles, fractions and `#rrggbb[/ww]` colours. `px` stays symbolic until a pitch is known. |
| `internal/config` | The YAML schema for every config file plus the data-folder `anchors.yaml` and `presets.saved.yaml`; the loader; validation with defaults; `config.Errors` naming file and line. |
| `internal/plan` | SVG plans: paths, polylines, polygons and lines flattened to polylines in plan units, with transforms and `data-nodes` vertex labels. |
| `internal/layout` | The solver. `Layout` is the immutable pixel table (global id, controller, index, run, edge, distances, dl, plan x/y), runs with solved anchors, nodes, edges and areas. `Mapping` is per-pixel `u` and stretch. `SolveFlow` and `SolveSpatial` make them. |
| `internal/clock` | `Source` (injectable time), `Manual` for tests, `Preview` (pause, seek, speed) for the live map, `Ticker` for pacing, `Frame`. |
| `internal/color` | Linear-light RGBW with straight alpha; gamma decode of authored colours. |
| `internal/palette` | Palettes, the palette registry and `Builtins`. |
| `internal/render` | The `Effect` interface, `Def` and registry, the typed parameter schema with WLED bindings, common layer params, `Layer` and `Geometry`, `Buffer` and the `Compositor`. |
| `internal/effects` | Effect implementations. `Register` adds them all. Only `solid` so far. |
| `internal/stack` | The layer stack: push, edit, remove with fades, lifetimes, owners, `state.json`. |
| `internal/engine` | Stack layers to render layers: presets, mapping precedence, params at the target's pitch, geometry, caching. |
| `internal/storage` | `Store` (atomic file writes in the data folder, or memory) and the debounced `Saver`. |
| `internal/output` | `Stage` and `Sink`, the controller `Frame`, `Quantize` (a placeholder stage), `Discard`, `Multi`. |
| `internal/app` | Wiring, the frame loop, `Summary`, and the seams below. |
| `internal/httpserver` | The one shared HTTP listener. Services register their routes on it under their own prefixes. |
| `internal/mapview` | The live map: the embedded page (`static/`, plain JS, no build step), geometry and inspect JSON, the websocket frame stream, the preview clock and preview-only layers. |
| `cmd/glowstack` | The program: `--config`, `--data`, `--fps`, `--check`, `--http` (default `:8080`), `--output` (only `none` so far). |

## Seams

These are the interfaces other work plugs into. Keep them small, and
change them in one place when they need to grow.

- **`render.Def` / `render.Effect`.** An effect declares its id, the
  coordinates it reads (`CoordU`, `CoordXY`, `CoordIndex`), a parameter
  schema, whether it's stateful and an optional WLED binding. `Render(ctx,
  out)` gets aligned slices (`Pixels`, `U`, `X`, `Y`, `Dl`, `Stretch`,
  `Index`) and writes one colour per pixel. Stateless effects may get any
  subset of their target (pixels covered from above are skipped).
  Randomness must be hashed from seed, pixel id and time, never drawn from a
  generator. See the `render` package doc.
- **`render.Param`.** Typed parameters. `Resolve` turns raw values into
  metres, m/s and so on at the layer's pitch. `Length` keeps its `Measure`
  (`flow` = along u, `physical` = along the strip; convert with `InU`).
- **`output.Stage` / `output.Sink`.** A stage turns the linear buffer into
  wire bytes per controller (power limiting, white, dithering,
  quantising). A sink delivers them. `app.Options.Stage` and
  `app.Options.Sink` choose them.
- **`app.Service`.** `func(ctx, *App) error`, run for the life of
  `App.Run`. The HTTP API, the WLED-compatible devices and the live-map
  server are services. They reach the stack (`App.Stack`), validation
  (`App.Engine.Check`), the layout and the registries through the App.
- **`app.App.OnFrame`.** Per-frame observer on the frame goroutine. It gets
  the linear buffer and must copy what it needs and return quickly.
- **`httpserver.Server`.** One listener for everything. Route prefixes
  are owned: the live map has `/map/` and `/api/map/`, the control API
  `/api/v1/`. Register with `Handle` (Go 1.22 patterns) when the service
  starts.
- **`render.Compositor.Top`.** Which layer is showing at each pixel after
  the last `Render`, for the live map's inspect. Call it on the rendering
  goroutine (an `OnFrame` observer).
- **`mapview.PowerReport`.** What the output stage knows about power
  limiting (the active scale, per group, and its own per-output figures).
  The program passes a func returning the latest one as
  `mapview.Options.Power`. Until the stage provides it, the map shows its
  own pre-limiting estimate from `led_ma` and "n/a" for the scale.
- **`storage.Store`.** Everything Glowstack writes goes through it:
  `state.json` now, and `anchors.yaml` and `presets.saved.yaml` later.

## Conventions

- **Global pixel ids.** Controllers take consecutive id ranges in
  `controllers.yaml` order (`Layout.Controllers[i].Base`). Everything inside
  Glowstack uses global ids, and per-controller indices appear only in
  config and output.
- **Positions along a run** are in pixel cells: the run starts at 0, pixel
  *k*'s centre is at *k* + ½, the run ends at its pixel count. Anchors sit
  at pixel centres and run ends at run ends.
- **Units inside the code** are SI: metres, seconds, radians. `u` is metres
  for flows and spatial mappings and 0–1 for `index`.
- **Linear light.** Colours are decoded from authored hex with gamma 2.8
  (WLED's default), and compositing and brightness happen in linear light.
  The output stage must not apply gamma again.
- **Time.** `Frame.T` is Unix seconds (float64), shared by every layer, so
  restarts continue patterns. Effects do phase maths in float64.
- **Black is a colour.** A pixel inside a layer's target but outside its
  mapping's domain (for example `unreached: dark`) is painted opaque black.

## Decisions made while building the core

These are choices the design left open, recorded so they can be revisited.

1. **`glowstack.yaml`** is a new optional config file: `fps` (default 40),
   `boot` (`restore` | `dark`) and default `fade: { in: 300 ms, out: 500 ms }`.
2. **Explicit anchor indices are never moved**, whatever their `source`.
   Anchors without an index are estimated from the drawing piecewise
   between explicit anchors, and only the drawing's labelled vertices are
   used as knots. With neither an index nor a drawing, it's an error.
3. **Measured lengths** go in a run-level `lengths:` list (`from`, `to`,
   `length`) for a stretch between consecutive path nodes.
4. **Plan scale** is estimated as total pixel length ÷ total drawn length
   when `scale` isn't given. Plan coordinates are stored in metres.
5. **`pace`** reconciles only parallel chains between the same two break
   points. `pace: reference` with no reference chain in a bundle falls back
   to `average`. Other cycles are handled by `loops`.
6. **Pins act as extra origins.** A span between two different pins is
   always stretched, never met.
7. **A ring whose ends get the same `u`** is met in the middle, with a
   warning, even under `loops: stretch`.
8. **`unreached: dark`** gives those pixels NaN `u`. Layers using the flow
   paint them black (they're in the target but have no coordinate).
9. **The `index` mapping** is a global ordering. The renderer turns it into
   0–1 across the layer's own target, which matches WLED's per-segment
   index.
10. **`int` and `number`** parameter types were added for unitless counts.
11. **Zone brightness** is a per-pixel `Compositor.Gain` array, and master
    brightness is `Compositor.Master`. The WLED device layer sets them.
12. **Areas may include other areas** with `{ area: id }`.
13. **`local`, `index` and `plan`** are built-in mapping ids and are
    reserved.
14. **Stateful effects keep running** when fully covered, so their state
    stays continuous. Stateless ones are skipped.
15. **Removed layers** leave `List` at once and are left out of
    `state.json`, but keep rendering until their fade-out ends.
16. **Layer ids** are small integers as strings unless the caller picks one.
    The layer seed is random at push time and persisted.
17. **Layer pitch** (for `px` params) is the most common pitch among the
    target's runs.

## Work not in the core, and where it goes

| Work | Package | Notes |
|---|---|---|
| Effects beyond `solid` (`bands`, `gradient`, `sparkle`, `wave`, `noise`, `fire`, composites, WLED-exact ports) | `internal/effects` | One file per effect; add to `Register`. Keep WLED fx ids and names. Ported WLED code keeps WLED's copyright notice (see AGENTS.md). |
| Palettes: the WLED palette port | `internal/palette` | Append to `palette.Builtins` with WLED ids (`Palette.WLED`) and names. |
| Output stage and DDP | `internal/output` (stage), `internal/output/ddp` (sink) | Replace `Quantize` with power limiting (per output and controller, limit groups, smoothing), white handling per controller, temporal dithering and quantising; channel order from config. The DDP sink sends per controller, splitting packets and respecting `max_fps`. Use loopback in tests. |
| HTTP / CLI API | `internal/api`, CLI subcommands in `cmd/glowstack` or `cmd/glowctl` | An `app.Service`. Push, edit and remove go through `App.Stack`, which validates with `App.Engine.Check`. |
| WLED-compatible devices | `internal/wled` | One `app.Service` per zone (its own IP, mDNS). Owners are `stack.WLEDOwner(zone, segment)`. Bindings come from `render.Def.WLED`. Test against `python-wled`. |
| Calibration | `internal/calibrate` | Pushes a temporary top layer, then writes `anchors.yaml` through `storage.Store` (atomic). Needs a layout rebuild after writing. |
| Saved presets | `internal/api` + `storage` | Write `presets.saved.yaml` through `storage.Store`. |

Not done in the core, and not assigned above:

- Inline mappings in a layer's `mapping` param (only ids are accepted).
- Config reload without a restart.
- `max_stretch` and other flow diagnostics on the live map, beyond the
  values already stored in `layout.FlowInfo`.

## Live map

`internal/mapview`, at `/map/`. The routes are listed in its package doc.

- **Frames.** One binary websocket message per frame: a 16-byte header
  (version, flags for preview and paused, frame number, Unix time as f64,
  little-endian), then RGB per pixel for the client's subscribed ranges.
  A client sends `{"fps": 5, "areas": ["porch"]}` to slow down or narrow
  the stream; the server replies with the exact id ranges it will send.
  The default is every pixel at 20 fps. Slow clients skip frames rather
  than queue them.
- **Display colour.** W is folded into RGB, and linear light is
  re-encoded with the authored-colour gamma (`color.DecodeGamma`), so a
  layer authored as `#ff8000` shows as `#ff8000`. It's what a designer
  expects to see, not a photometric model of the LEDs. Unlit pixels are
  drawn dim grey so strips stay visible.
- **House or preview.** While the preview clock follows the house and
  there are no preview layers, the map streams the house's own frames
  (captured in `App.OnFrame` at up to the stream rate, only while someone
  is watching). Otherwise it renders its own frames with a second engine
  and compositor on a `clock.Preview`: the preview layers on top of the
  house stack's live layers. It reads the house with `Stack.List`, never
  `Stack.Frame`, so scrubbing can't expire house layers. House layers
  show at full fade there, and zone and master brightness aren't applied.
- **One preview** per Glowstack, shared by every open map. It's a design
  tool, and sharing keeps a phone outside and a laptop inside in step.
- **Speed** is 0.1×–10×, forwards only. Scrubbing pauses and seeks.

## Running

```sh
go run ./cmd/glowstack --config examples/fictional/config \
  --data "$(mktemp -d)" --check     # print the summary and exit
go run ./cmd/glowstack --config examples/fictional/config --data /tmp/gs \
  --http :8080 --output=none   # then open http://localhost:8080/map/
go test ./...
```
