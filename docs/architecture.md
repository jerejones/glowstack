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
| `internal/palette` | Palettes, the palette registry and `Builtins`: WLED's 73 fixed palettes (`wled.go`, ported) and the special palettes 0–5 with `Resolve` and `Cache` (`special.go`). |
| `internal/render` | The `Effect` interface, `Def` and registry, the typed parameter schema with WLED bindings and their curves (`SetWLED`, `GetWLED`), common layer params, `Layer` and `Geometry`, `Buffer`, `Blend` and the `Compositor`. |
| `internal/effects` | Effect implementations, one file each: `solid`, `bands`, `gradient`, `sparkle`, `chase`, `noise`, `breathe`, and composites (`Composite`, built-in `glitter`, `RegisterComposites` for config). `WLEDEffects`/`WLEDEffectNames` give the `/json/eff` order. |
| `internal/preset` | Presets as layer specs: the effective `Library` (saved presets shadow configured ones), `Expand`/`Apply` with overrides, `Check` against the effects. |
| `internal/stack` | The layer stack: push, edit, remove with fades, lifetimes, owners, `state.json`. |
| `internal/engine` | Stack layers to render layers: presets, mapping precedence, params at the target's pitch, geometry, caching. |
| `internal/storage` | `Store` (atomic file writes in the data folder, or memory) and the debounced `Saver`. |
| `internal/output` | `Stage` and `Sink`, the controller `Frame`, `Pipeline` (the production stage: white handling, power limiting, dithering, quantising; `Power()` reports current estimates), `Quantize` (a minimal stage), `Discard`, `Multi`, `Check` (wire-time and power-config warnings), `Select` (`--output`). |
| `internal/output/ddp` | DDP packets (`Packets`, `Parse`) and `Sink`: one sender goroutine per controller over UDP, newest frame wins, `max_fps` pacing, `Stats`. |
| `internal/output/health` | Read-only controller checks: polls `/json/info`, reads `/json/cfg`, reports reboots, firmware changes and realtime-setting mismatches. |
| `internal/fakewled` | A fake WLED controller: DDP receiver with WLED's semantics, `/json/info`, `/json/cfg`, a pixel page. |
| `internal/app` | Wiring, the frame loop, `Summary`, and the seams below. |
| `cmd/glowstack` | The program: `--config`, `--data`, `--fps`, `--check`, `--output`, `--loopback`. |
| `cmd/fakewled` | Fake controllers on loopback, from flags, a YAML list or a Glowstack config folder. |
| `internal/output` | `Stage` and `Sink`, the controller `Frame`, `Quantize` (a placeholder stage), `Discard`, `Multi`. |
| `internal/app` | Wiring, the frame loop, `Summary`, master and zone brightness, config reload, frame stats, and the seams below. |
| `internal/httpserver` | The one HTTP server. Features register routes through a `Mount`; it runs as an `app.Service` on `--http` and shuts down gracefully. `Authorize` is the auth hook (none for now: LAN only). |
| `internal/api` | The native control API under `/api/v1/` (routes in the package doc). |
| `internal/ctl` | The command-line client for the API: `glowstack ctl …` or `glowctl …`. |
| `cmd/glowstack` | The program: `--config`, `--data`, `--fps`, `--check`, `--http`; `glowstack ctl …` runs the client. SIGHUP reloads the config. |
| `cmd/glowctl` | The client on its own. |

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
- **`render.Def.WLED`.** Bindings from WLED controls to parameter paths,
  with curves. `Def.SetWLED` applies a control value (slider position,
  option, colour or palette id) to a layer's raw params, and `Def.GetWLED`
  reads one back. `effects.WLEDEffectNames` and `palette.Registry.WLEDList`
  give `/json/eff` and `/json/pal` order.
- **`render.Param`.** Typed parameters. `Resolve` turns raw values into
  metres, m/s and so on at the layer's pitch. `Length` keeps its `Measure`
  (`flow` = along u, `physical` = along the strip; convert with `InU`).
- **`output.Stage` / `output.Sink`.** A stage turns the linear buffer into
  wire bytes per controller (power limiting, white, dithering,
  quantising). A sink delivers them. `app.Options.Stage` and
  `app.Options.Sink` (or `NewSink`, called once the layout exists) choose
  them. `App.Stage` is the stage in use; the live map gets power
  estimates with `a.Stage.(output.PowerReporter).Power()`.
- **`app.Service`.** `func(ctx, *App) error`, run for the life of
  `App.Run`. The HTTP API, the WLED-compatible devices and the live-map
  server are services. They reach the stack (`App.Stack`), validation
  (`App.Engine.Check`), the layout and the registries through the App.
- **`app.App.OnFrame`.** Per-frame observer on the frame goroutine. It gets
  the linear buffer and must copy what it needs and return quickly.
- **`app.App.Current` and `Reload`.** `Reload` re-reads the config and
  data folders and swaps in a new config, layout, mappings, palettes and
  engine between frames. Code on other goroutines reads those through
  `Current()` (a consistent `View`), not the exported fields, which
  `Reload` replaces. `OnReload` tells services afterwards. An output stage
  or sink that depends on the layout implements `app.Rebuilder`; it's
  called on the frame loop before the next frame.
- **Brightness.** `App.SetMaster`, `App.SetZoneBrightness` and
  `App.Brightness` are safe from any goroutine; the frame loop turns them
  into `Compositor.Master` and `Compositor.Gain`. Don't set those
  directly. The WLED devices should use these for `bri`.
- **`app.App.Preview`.** A second stack for preview-only layers ("try
  before applying"). It's validated like the real one and never saved or
  sent to the lights; the live map renders it.
- **`httpserver.Mount`.** `func(*app.App, *httpserver.Server) error`. A
  feature registers its routes on the shared server (the API owns
  `/api/v1/`, the live map `/map/` and `/api/map/`).
- **`api.HealthReporter`.** An output sink or stage with `Health() any`
  has its controller health shown by `/api/v1/status` and
  `/api/v1/controllers`.
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
    brightness is `Compositor.Master`. The frame loop sets them from
    `App.SetMaster` and `App.SetZoneBrightness`.
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

## Decisions made while building the effects

1. **Effects read u or x,y by parameter.** `Def.CoordsFor` lets `noise`
   choose with `space: u|xy`; the engine builds geometry from
   `Def.CoordsOf`.
2. **Sub-pixel edges** are a box filter: a pixel's colour is the average
   of the pattern over its footprint along u (`dl / stretch`). `smooth:
   false` samples the pixel centre.
3. **Sparkle** slots are one sparkle long, and counts per slot are
   Poisson-distributed (design.md "Randomness").
4. **Perceptual fades.** Sparkle decay, chase tails and breathing fade
   evenly to the eye: a perceptual level is raised to the decode gamma.
5. **Composites** are built from `render.Values.Sub` and `render.Blend`.
   They're registered after the built-ins, from `presets.yaml`'s
   `composites:` (and `presets.saved.yaml`'s), and may nest.
6. **WLED palettes** are ported with WLED's authored values and decoded
   like any authored colour (gamma 2.8). WLED's main branch pre-corrects
   these palettes for its own 2.2 default, so they look a little deeper
   here than on a current WLED.
7. **`white: none`** drops W; `explicit` keeps authored W only.
8. **Phase maths** reduces `speed × T` modulo the pattern period in
   float64 before adding u, so patterns stay precise at Unix-epoch times.
   Patterns move with absolute time, so an edit to `speed` makes them
   jump.

### Decisions made while building the output stage

18. **Power policy** lives in `glowstack.yaml`: `power: { group, release }`
    (default `global`, `2 s`). `dither` (default on) is there too.
19. **White handling comes before power limiting**, because current
    depends on the channels actually driven. RGB controllers, and RGBW
    ones with `white: auto`, get W folded into R, G and B (W sent as 0).
20. **Limit groups.** Every pixel gets the lowest scale among the limits
    of its own output and controller and every limit touching any group
    it's in. A controller total therefore always covers the whole
    controller, even with `group: output`. With `group: zone`, pixels in
    no zone get only their own limits.
21. **Smoothing.** A tighter limit takes effect in the same frame (never
    over budget); recovery is exponential with time constant `release`.
22. **Dithering** carries each channel's rounding error to the next frame.
    The error stays within ±½, so 0 and 255 are exact and never flicker.
23. **DDP sequence numbers** advance per frame, not per packet, so WLED's
    optional out-of-sequence check accepts frames of any size.
24. **`http_port`** (default 80) is the controller's JSON API port, for
    health checks. `--loopback=PORT` sends controller *i* to
    `127.0.0.1:PORT+i` (DDP and HTTP), matching `fakewled --from-config`.
25. **The DDP sink never blocks rendering.** `Send` copies the frame; each
    controller's goroutine sends the newest one, at most `max_fps`, with
    100 µs between a frame's packets.
Decisions made while building the control API:

18. **Reload re-solves everything** every time (it takes milliseconds), so
    there's no separate "hot" path: palettes, presets and mappings change
    in place, and layout, area and controller changes rebuild the pixel
    table. Every layer is resolved again, so stateful effects restart.
    Layers that no longer validate are dropped at once, without a fade.
    The fps and default fades from `glowstack.yaml` are applied; the
    effect registry is code and doesn't change.
19. **Zone brightness multiplies** where zones overlap, and master and zone
    brightness persist in `brightness.json` in the data folder.
20. **Edits always change `Updated`**, even within one clock reading,
    because the engine rebuilds a layer only when it changes.
21. **Preview layers get ids `p1`, `p2`, …** when pushed through the API,
    so they can't be mistaken for real layers.
22. **API edits merge params**; `null` removes an override and `replace`
    swaps the whole set. Switching effect in an edit drops the old
    effect's parameters (common ones stay). In an edit, `for` counts from
    now, not from the layer's creation.
23. **`use`** in a push or edit names an effect or a preset; an effect
    wins if both have the id. The CLI's `push <area> <name>` uses it.
24. **No auth.** Glowstack is LAN-only for now; `httpserver.Server.Authorize`
    is the hook for adding it.

## Work not in the core, and where it goes

| Work | Package | Notes |
|---|---|---|
| More effects (`wave`, `fire`, WLED-exact ports) | `internal/effects` | One file per effect; add to `Register`. Keep WLED fx ids and names. Ported WLED code keeps WLED's copyright notice (see AGENTS.md). |
| Live map | `internal/livemap` | An `app.Service` serving the page and a websocket. `App.OnFrame` gives frames. For "try before applying", run a second `engine.Engine` and `render.Compositor` on a `clock.Preview` (an engine's `Resolve` is single-goroutine). |
| WLED-compatible devices | `internal/wled` | One `app.Service` per zone (its own IP, mDNS). Owners are `stack.WLEDOwner(zone, segment)`. Bindings come from `render.Def.WLED`. Test against `python-wled`. |
| Calibration | `internal/calibrate` | Pushes a temporary top layer, then writes `anchors.yaml` through `storage.Store` (atomic). Needs a layout rebuild after writing. |
| Saved presets | `internal/api` + `storage` | Write `presets.saved.yaml` through `storage.Store`, then `App.Reload`. |

Not done in the core, and not assigned above:

- Inline mappings in a layer's `mapping` param (only ids are accepted).
- `max_stretch` and other flow diagnostics on the live map, beyond the
  values already stored in `layout.FlowInfo`.

## Running

```sh
go run ./cmd/glowstack --config examples/fictional/config \
  --data "$(mktemp -d)" --check     # print the summary and exit
go run ./cmd/glowstack --config examples/fictional/config --data /tmp/gs --output=none

# With fake controllers on loopback (two terminals):
go run ./cmd/fakewled --from-config examples/fictional/config --base-port 40481
go run ./cmd/glowstack --config examples/fictional/config --data /tmp/gs --loopback=40481
# then open http://127.0.0.1:40481/ and http://127.0.0.1:40482/
# (examples/fictional/fake/fakes.yaml is a misconfigured variant: --config)
go run ./cmd/glowstack --config examples/fictional/config --data /tmp/gs
go run ./cmd/glowstack --config examples/fictional/config --data /tmp/gs \
  --http 127.0.0.1:8080              # the control API on /api/v1/
go run ./cmd/glowstack ctl push porch solid color=#ff5a00 for=30s
go run ./cmd/glowstack ctl layers    # or: glowctl layers; --server or $GLOWSTACK_URL
go test ./...
```
