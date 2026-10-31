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
frame. Everything up to the stack is built at start and again by
`App.Reload`. The sink in production is `wire.Outputs` (DDP senders and
health checks); the HTTP server carries the control API and the live map.

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
| `internal/render` | The `Effect` interface, `Def` and registry, the typed parameter schema with WLED bindings and their curves (`SetWLED`, `GetWLED`), common layer params, `Layer` and `Geometry`, `Buffer`, `Blend` and the `Compositor` (with `Top`, the layer showing per pixel). |
| `internal/effects` | Effect implementations, one file each: `solid`, `bands`, `gradient`, `sparkle`, `chase`, `noise`, `breathe`, and composites (`Composite`, built-in `glitter`, `RegisterComposites` for config). `WLEDEffects`/`WLEDEffectNames` give the `/json/eff` order. |
| `internal/preset` | Presets as layer specs: the effective `Library` (saved presets shadow configured ones), `Expand`/`Apply` with overrides, `Check` against the effects. |
| `internal/stack` | The layer stack: push, edit, remove with fades, lifetimes, owners, `Prune` and `SetFades` for reloads, `state.json`. |
| `internal/engine` | Stack layers to render layers: presets, mapping precedence, params at the target's pitch, geometry, caching. |
| `internal/storage` | `Store` (atomic file writes in the data folder, or memory) and the debounced `Saver`. |
| `internal/output` | `Stage` and `Sink`, the controller `Frame`, `Pipeline` (the production stage: white handling, power limiting, dithering, quantising; `Power()` reports current estimates; `Rebuild` after a reload), `Quantize` (a minimal stage), `Discard`, `Multi`, `Check` (wire-time and power-config warnings), `Select` (`--output`). |
| `internal/output/ddp` | DDP packets (`Packets`, `Parse`) and `Sink`: one sender goroutine per controller over UDP, newest frame wins, `max_fps` pacing, `Stats`. |
| `internal/output/health` | Read-only controller checks: polls `/json/info`, reads `/json/cfg`, reports reboots, firmware changes and realtime-setting mismatches. `SetTargets` after a reload. |
| `internal/output/wire` | The program's link to its controllers: `Outputs` is the DDP sink plus the health monitor for the `--output` selection (and `--loopback`), rebuilt on reload, reporting health and DDP counters to the API. |
| `internal/fakewled` | A fake WLED controller: DDP receiver with WLED's semantics, `/json/info`, `/json/cfg`, a pixel page. |
| `internal/app` | Wiring, the frame loop, `Summary`, master and zone brightness (`brightness.json`), config reload, frame stats, the preview stack, and the seams below. |
| `internal/httpserver` | The one HTTP server. Features register routes through a `Mount` (and background work with `Go`); it runs as an `app.Service` on `--http` and shuts down gracefully. `Authorize` is the auth hook (none for now: LAN only). |
| `internal/api` | The native control API under `/api/v1/` (routes in the package doc). |
| `internal/ctl` | The command-line client for the API: `glowstack ctl …` or `glowctl …`. |
| `internal/mapview` | The live map at `/map/`: the embedded page (`static/`, plain JS, no build step), geometry and inspect JSON under `/api/map/`, the websocket frame stream, the preview clock, power figures. |
| `cmd/glowstack` | The program: `--config`, `--data`, `--fps`, `--check`, `--http` (default `:8080`), `--output` (`all`, `none` or ids; default `none`, or `all` with `--loopback`), `--loopback=PORT`; `glowstack ctl …` runs the client. SIGHUP reloads the config. |
| `cmd/glowctl` | The client on its own. |
| `cmd/fakewled` | Fake controllers on loopback, from flags, a YAML list or a Glowstack config folder. |

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
  them. `App.Stage()` is the stage in use; the default `output.Pipeline`
  is an `output.PowerReporter`.
- **`app.Service`.** `func(ctx, *App) error`, run for the life of
  `App.Run`. The HTTP server (with the API and the live map), the health
  monitor and the WLED-compatible devices are services. They reach the
  stacks, validation, the layout and the registries through the App.
- **`app.App.OnFrame` and `Observed`.** Per-frame observer on the frame
  goroutine. It gets the linear buffer and must copy what it needs and
  return quickly. Inside it, `App.Observed()` gives the view and
  compositor that frame was rendered with (after a reload, `Current` may
  already be newer).
- **`app.App.Current` and `Reload`.** `Reload` re-reads the config and
  data folders and swaps in a new config, layout, mappings, palettes and
  engine between frames. Code on other goroutines reads those through
  `Current()` (a consistent `View` with a generation `Gen`), not the
  exported fields, which `Reload` replaces. `OnReload` tells services
  afterwards. An output stage or sink that depends on the layout
  implements `app.Rebuilder`; it's called on the frame loop before the
  next frame (`output.Pipeline` and `wire.Outputs` do).
- **Brightness.** `App.SetMaster`, `App.SetZoneBrightness` and
  `App.Brightness` are safe from any goroutine; the frame loop turns them
  into `Compositor.Master` and `Compositor.Gain`. Don't set those
  directly. The WLED devices should use these for `bri`.
- **`app.App.Preview`.** The one preview stack, for "try before
  applying". It's validated like the real one and never saved or sent to
  the lights; the live map renders it on its preview clock. Push with
  `App.PushPreview`. The API's `preview: true` routes and the map's
  preview panel both use it.
- **`httpserver.Mount`.** `func(*app.App, *httpserver.Server) error`. A
  feature registers its routes on the shared server (the API owns
  `/api/v1/`, the live map `/map/` and `/api/map/`), and background work
  with `Server.Go`.
- **`api.HealthReporter`.** An output sink or stage with `Health() any`
  has its controller health shown by `/api/v1/status` and
  `/api/v1/controllers`. `wire.Outputs` reports reachability, firmware,
  reboots, setting mismatches and DDP counters per controller.
- **`mapview.PowerReport`.** The output stage's power figures for the
  map. `mapview.Options.Power` supplies it; by default it's
  `FromStage(App.Stage().(output.PowerReporter).Power())`.
- **`storage.Store`.** Everything Glowstack writes goes through it:
  `state.json` and `brightness.json` now, and `anchors.yaml` and
  `presets.saved.yaml` later.

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

## Decisions

Choices the design left open, recorded so they can be revisited. One
list, numbered in the order they were made.

### The core

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

### Effects

18. **Effects read u or x,y by parameter.** `Def.CoordsFor` lets `noise`
    choose with `space: u|xy`; the engine builds geometry from
    `Def.CoordsOf`.
19. **Sub-pixel edges** are a box filter: a pixel's colour is the average
    of the pattern over its footprint along u (`dl / stretch`). `smooth:
    false` samples the pixel centre.
20. **Sparkle** slots are one sparkle long, and counts per slot are
    Poisson-distributed (design.md "Randomness").
21. **Perceptual fades.** Sparkle decay, chase tails and breathing fade
    evenly to the eye: a perceptual level is raised to the decode gamma.
22. **Composites** are built from `render.Values.Sub` and `render.Blend`.
    They're registered after the built-ins, from `presets.yaml`'s
    `composites:` (and `presets.saved.yaml`'s), and may nest.
23. **WLED palettes** are ported with WLED's authored values and decoded
    like any authored colour (gamma 2.8). WLED's main branch pre-corrects
    these palettes for its own 2.2 default, so they look a little deeper
    here than on a current WLED.
24. **`white: none`** drops W; `explicit` keeps authored W only.
25. **Phase maths** reduces `speed × T` modulo the pattern period in
    float64 before adding u, so patterns stay precise at Unix-epoch times.
    Patterns move with absolute time, so an edit to `speed` makes them
    jump.

### Output

26. **Power policy** lives in `glowstack.yaml`: `power: { group, release }`
    (default `global`, `2 s`). `dither` (default on) is there too.
27. **White handling comes before power limiting**, because current
    depends on the channels actually driven. RGB controllers, and RGBW
    ones with `white: auto`, get W folded into R, G and B (W sent as 0).
28. **Limit groups.** Every pixel gets the lowest scale among the limits
    of its own output and controller and every limit touching any group
    it's in. A controller total therefore always covers the whole
    controller, even with `group: output`. With `group: zone`, pixels in
    no zone get only their own limits.
29. **Smoothing.** A tighter limit takes effect in the same frame (never
    over budget); recovery is exponential with time constant `release`.
30. **Dithering** carries each channel's rounding error to the next frame.
    The error stays within ±½, so 0 and 255 are exact and never flicker.
31. **DDP sequence numbers** advance per frame, not per packet, so WLED's
    optional out-of-sequence check accepts frames of any size.
32. **`http_port`** (default 80) is the controller's JSON API port, for
    health checks. `--loopback=PORT` sends controller *i* to
    `127.0.0.1:PORT+i` (DDP and HTTP), matching `fakewled --from-config`.
33. **The DDP sink never blocks rendering.** `Send` copies the frame; each
    controller's goroutine sends the newest one, at most `max_fps`, with
    100 µs between a frame's packets.

### Control API

34. **Reload re-solves everything** every time (it takes milliseconds), so
    there's no separate "hot" path: palettes, presets and mappings change
    in place, and layout, area and controller changes rebuild the pixel
    table. Every layer is resolved again, so stateful effects restart.
    Layers that no longer validate are dropped at once, without a fade.
    The fps and default fades from `glowstack.yaml` are applied; the
    effect registry is code and doesn't change.
35. **Zone brightness multiplies** where zones overlap, and master and zone
    brightness persist in `brightness.json` in the data folder.
36. **Preview layers get ids `p1`, `p2`, …** (`App.PushPreview`, used by
    the API and the live map), so they can't be mistaken for real layers.
37. **API edits merge params**; `null` removes an override and `replace`
    swaps the whole set. Switching effect in an edit drops the old
    effect's parameters (common ones stay). In an edit, `for` counts from
    now, not from the layer's creation.
38. **`use`** in a push or edit names an effect or a preset; an effect
    wins if both have the id. The CLI's `push <area> <name>` uses it.
39. **No auth.** Glowstack is LAN-only for now; `httpserver.Server.Authorize`
    is the hook for adding it.

### Integration

40. **Edits bump a `Revision`**, not `Updated`. The engine rebuilds a
    layer when either changes, so two edits within one clock reading
    still take effect, and `Updated` stays the true clock time.
41. **One HTTP server**, with `Mount`s. The live map registers through
    `mapview.Mount` and runs its preview renderer with `Server.Go`, so it
    starts and stops with the server.
42. **One preview stack**, `App.Preview`, replaces the map's private one.
    Preview layers keep the house's default fades in the stack, but the
    map shows them at full fade. The frame loop advances the preview
    stack with the house clock (lifetimes end, removed layers free their
    ids); the outputs never render it. The map's "clear" removes every
    preview layer, whoever pushed it. In the preview pass, preview layers
    are renamed `preview:<id>` so their ids can't clash with house layers
    in the engine's cache.
43. **Reload rebuilds the output in place.** `output.Pipeline.Rebuild`
    keeps the same stage object, so the API and the map can hold it; its
    power smoothing and dither state restart. `wire.Outputs` re-selects
    controllers by the same `--output` value, restarts the DDP senders
    only if their addresses changed, and keeps health status for
    controllers that stay. `--loopback` ports follow layout order, so
    adding a controller shifts the ones after it (as `fakewled
    --from-config` does).
44. **`--output=none` still makes a `wire.Outputs`**, with no targets.
    The default is `none`: sending to real controllers takes over their
    lights, so it needs an explicit `--output=all` or `--output=<ids>`.
    With `--loopback` (local fakes only) the default is `all`.
45. **The ticker's wall clock is injectable** (unexported), so the
    late-frame test runs on a fake clock and doesn't depend on load.

### Config gaps

46. **Exclusive area range ends.** `after` and `before` step one pixel
    along the walk from the range's start to its end, not along the run,
    so a range written against the run direction means the same thing.
    Start and end stay optional (the run's ends); a range left empty is an
    error.
47. **Inline mappings** are parsed by `config.ParseInlineMapping` (the same
    decoder and checks as `mappings.yaml`, errors without positions) when
    the `mapping` param resolves, and solved by `Engine.Inline`, cached by
    content hash (at most `engine.MaxInline`, then the cache restarts).
    Flow warnings (such as `max_stretch`) aren't reported for them;
    `strict: true` turns those into errors.

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
  `App.Preview` is empty, the map streams the house's own frames
  (captured in `App.OnFrame` at up to the stream rate, only while someone
  is watching). Otherwise it renders its own frames with a second engine
  and compositor on a `clock.Preview`: the preview stack's layers on top
  of the house stack's live layers. It reads both stacks with
  `Stack.List`, never `Stack.Frame`, so scrubbing can't expire layers.
  Layers show at full fade there, and zone and master brightness aren't
  applied.
- **Power.** The panel shows the map's own pre-limiting estimate for the
  frame on screen (house or preview) from `led_ma`, and the output
  stage's figures for the house frames it sent: per output and
  controller, drawn and requested current, and the limit scale.
- **Reloads.** The map rebuilds its geometry and preview engine from
  `App.Current` in `OnReload`. Snapshots and the stream's `subscribed`
  message carry the reload generation (`gen`); the page reloads when it
  changes.
- **One preview** per Glowstack, shared by every open map. It's a design
  tool, and sharing keeps a phone outside and a laptop inside in step.
- **Speed** is 0.1×–10×, forwards only. Scrubbing pauses and seeks.

## Work not done yet, and where it goes

| Work | Package | Notes |
|---|---|---|
| More effects (`wave`, `fire`, WLED-exact ports) | `internal/effects` | One file per effect; add to `Register`. Keep WLED fx ids and names. Ported WLED code keeps WLED's copyright notice (see AGENTS.md). |
| WLED-compatible devices | `internal/wled` | One `app.Service` per zone (its own IP, mDNS). Owners are `stack.WLEDOwner(zone, segment)`. Bindings come from `render.Def.WLED`; brightness through `App.SetZoneBrightness`. Test against `python-wled`. |
| Calibration | `internal/calibrate` | Pushes a temporary top layer, then writes `anchors.yaml` through `storage.Store` (atomic), then `App.Reload`. |
| Saved presets | `internal/api` + `storage` | Write `presets.saved.yaml` through `storage.Store`, then `App.Reload`. |

Not assigned above:

- `max_stretch` and other flow diagnostics on the live map, beyond the
  values already stored in `layout.FlowInfo`.

## Running

```sh
go run ./cmd/glowstack --config examples/fictional/config \
  --data "$(mktemp -d)" --check     # print the summary and exit

# Render with no controllers; the live map is at http://127.0.0.1:8080/map/
go run ./cmd/glowstack --config examples/fictional/config --data /tmp/gs \
  --http 127.0.0.1:8080 --output=none

# With fake controllers on loopback (two terminals):
go run ./cmd/fakewled --from-config examples/fictional/config --base-port 40481
go run ./cmd/glowstack --config examples/fictional/config --data /tmp/gs \
  --http 127.0.0.1:8080 --loopback=40481
# then open http://127.0.0.1:40481/ and http://127.0.0.1:40482/ (the fakes)
# (examples/fictional/fake/fakes.yaml is a misconfigured variant: --config)

go run ./cmd/glowstack ctl push porch solid color=#ff5a00 for=30s
go run ./cmd/glowstack ctl layers    # or: glowctl layers; --server or $GLOWSTACK_URL
go test ./...
```

See README.md, "Try it", for a longer walk-through.
