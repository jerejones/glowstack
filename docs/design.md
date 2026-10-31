# Glowstack design

Status: draft. Nothing here is built. This document fixes the vocabulary, the
configuration shapes and the effect model before any code is written.
Examples use made-up installations only.

## Principles

1. **Flexibility first.** The installation's physical facts go in
   configuration: where pixels are and which ones meet. Everything about how a
   look appears is a parameter chosen at run time: colour, palette, speed,
   direction, size, density and which coordinate system to use. Nothing about
   a look is compiled in.
2. **Separate the house from the look.** House config describes hardware and
   geometry, and changes only when the hardware does. Looks are layers made of
   an effect, its parameters and a target. They change all the time.
3. **Physical units.** Lengths are in metres, speeds in metres per second and
   rates per second. A pattern is the same size on every strip, whatever the
   controller, segment length or frame rate. `px` is accepted as a unit and
   means one LED pitch on the run in question. The exception is deliberate
   stretching or compression, where a flow makes runs of different lengths
   stay in step.
4. **Effects are functions of place and time.** Wherever possible a pixel's
   colour is `f(coordinate, t, params, seed)`. That keeps controllers in sync
   for free, makes restarts seamless and lets the preview match the house
   exactly. Effects that need state, like fire or ripples, keep it inside
   their layer.
5. **One frame buffer, many outputs.** Glowstack renders every pixel centrally
   and slices the result per controller. Controllers display pixels and
   nothing else.

## Vocabulary

| Term | Meaning |
|---|---|
| **Controller** | A physical WLED device that receives frames over the network. It has an address and a pixel count. |
| **Output** | One data pin on a controller: a contiguous index range. Used for frame-rate and power budgeting only. Rendering never looks at outputs. |
| **Pixel** | One addressable LED, identified by `(controller, index)`. Internally every pixel gets a dense global id. |
| **Run** | A physically continuous stretch of pixels on one controller, between two nodes, with a known index direction. Runs are the unit of layout. |
| **Node** | A named point in the house's layout graph: a corner, an end, a junction or a sync point. |
| **Anchor** | A statement that a particular pixel sits at a node, for example "index 402 is at node `shed-sw`". Anchors split runs into edges. |
| **Edge** | A connection between two nodes in the layout graph. A **strip edge** carries pixels. A **gap edge** has physical length but no pixels, like a gate or doorway. A **link edge** has zero length and no pixels, and ties two nodes that aren't physically connected but should line up. |
| **Sync point** | A node where effects must line up. Any node can be one. A link edge makes two nodes one sync point. |
| **Plan coordinates** | Optional 2-D positions on a floor plan, in metres. Used by the live map and by spatial mappings. |
| **Mapping** | A rule that gives every pixel a coordinate: flow distance, plan position, radius, or raw index. Effects read coordinates and never read indices. |
| **Flow** | A mapping kind: position along the layout graph from an origin, with edge orientations. |
| **Flow position (`u`)** | A pixel's coordinate in a flow. Measured in metres *of the reference path*, so it equals physical distance only where nothing is stretched. |
| **Pinned node** | A node whose `u` is fixed before edges are filled in: by the reference path, by a link to another pinned node, or by an explicit value. |
| **Stretch** | Physical metres per metre of flow position on an edge (`dl/du`). 1 means unchanged. Above 1 the run is longer than the reference, so the pattern is **stretched**: physically bigger, and it moves faster. Below 1 the run is shorter, so the pattern is **compressed**: physically smaller, and it moves slower. |
| **Reference path** | The path between two pinned nodes whose physical length defines the `u` distance between them. Other parallel paths stretch or compress to match. |
| **Area** | A named set of pixels, defined as a union of runs or run sub-ranges. Areas may overlap. |
| **Zone** | An area that Home Assistant sees as one virtual WLED device. |
| **Segment** | A WLED-API term. It is one area within a zone's virtual device. |
| **Effect** | Code that turns coordinates, time and parameters into colours. It declares a parameter schema. |
| **Palette** | A named colour gradient: stops, an interpolation mode and wrapping. |
| **Layer** | An effect, its parameter values, a target area, a mapping, a blend mode, an opacity and a lifetime. |
| **Stack** | The ordered list of active layers. For each pixel, the top layer that covers it wins, subject to blending. Removing a layer reveals whatever is below. |
| **Preset** | A saved, named layer specification (effect plus parameters), reusable on any area. |
| **Frame** | One rendered instant of every pixel, stamped with the shared clock time. |

## Configuration files

Configuration is YAML, versioned with a top-level `schema:` number and
validated at load with errors that point to the file and line. It's split by
how often it changes:

| File | Contents | Changes when |
|---|---|---|
| `glowstack.yaml` | Optional program settings: `fps`, `boot`, default `fade` times, power-limit `power: { group, release }`, `dither` | Rarely |
| `controllers.yaml` | Controllers, outputs, transport settings | Hardware or network changes |
| `layout.yaml` | Runs, nodes, anchors, edges, plan coordinates | Strips are repaired, moved or measured |
| `areas.yaml` | Areas and zones, virtual device identity | Grouping changes |
| `mappings.yaml` | Named flows and spatial mappings | New ways of looking at the house |
| `palettes.yaml` | User palettes, adding to the built-ins | Taste |
| `presets.yaml` | Saved looks | Taste |

Glowstack writes its own files to a separate folder. It never rewrites the
hand-edited ones:

| File | Contents | Changes when |
|---|---|---|
| `anchors.yaml` | Measured anchors from calibration; overrides `layout.yaml` | Calibration |
| `presets.saved.yaml` | Presets saved through the API or HA; adds to `presets.yaml` | Saved from HA |
| `state.json` | The current stack | Every change (debounced) |
| `brightness.json` | Master and zone brightness, so a restart doesn't jump to full | Every change (debounced) |

All of these are site data. They're mounted into the container and are never
committed to this repo. `examples/` will hold a fictional installation.

#### Storage

- **Plain files, not a database.** All config and state are text files
  (YAML, plus JSON for state). Site config lives in a private git repo, where
  text gives readable diffs, review and revert, and both people and coding
  agents can edit it directly. A SQLite file would be an opaque binary to
  git. The data is small (thousands of pixels, hundreds of anchors, dozens of
  layers and presets) and is held entirely in memory, so the storage format
  doesn't affect performance. Glowstack is the only writer and never queries
  its storage, so a database's transactions, concurrency and queries buy
  nothing.
- **Two folders.** The config folder is hand-edited, versioned and mounted
  read-only. The data folder is writable and holds what Glowstack writes.
  Useful machine-written files (`anchors.yaml`, `presets.saved.yaml`) are
  copied back into the config repo by hand when they should be versioned.
  `state.json` is never versioned. Having Glowstack commit to a git clone
  itself is a possible later option, but it needs a remote and credentials
  on the host.
- **Safe writes.** Every write goes to a temporary file in the same folder,
  is synced, then renamed over the old file, so a crash or power cut never
  leaves a partial file.
- **Debounced.** Stack changes (for example HA slider drags) are saved at
  most about once a second, plus once at shutdown.
- **Behind an interface.** Storage sits behind a small Go interface, so a
  different backend can be swapped in later without touching the rest.
- **History is not stored here.** Metrics and event history (frame times,
  power limiting, controller reboots) go to HA or a metrics system, not to
  Glowstack's files.

### Controllers

```yaml
schema: 1
controllers:
  - id: shed
    host: 192.0.2.21          # IP or hostname
    transport: ddp            # ddp now; e131/artnet possible later
    port: 4048                # DDP port
    http_port: 80             # JSON API port, for read-only health checks
    pixels: 1800              # total pixel count the controller expects
    channels: rgbw            # rgb | rgbw: bytes per pixel on the wire
    max_fps: 40               # cap; also derived from the longest output
    outputs:                  # fps budgeting and power limiting
      - { pin: 1, start: 0,    count: 600,  max_ma: 6000 }
      - { pin: 2, start: 600,  count: 1200, max_ma: 6000 }
    power:
      max_ma: 10000           # optional controller/supply total, like WLED's ABL total
      led_ma: { r: 12, g: 12, b: 12, w: 20, idle: 1 }   # per pixel at full; per strip type
    white: explicit           # explicit | auto. Who computes the W channel
```

Notes:

- **Power limits** are per output, like WLED's per-output current limit, plus
  an optional controller total. `max_ma` omitted means unlimited. See the
  brightness pipeline for how limits are applied.

- **DDP framing.** Each packet holds at most 1440 data bytes, which is 360
  RGBW pixels. The offset is in bytes. The push flag goes on the last packet
  of a frame so the controller shows the whole frame at once. Checked
  against WLED's receiver (`wled00/e131.cpp`): flags `0x40` (version 1)
  plus `0x01` (push), data type `0x0B` RGB or `0x1B` RGBW, destination 1.
  All packets of a frame share one sequence number (1–15), advancing per
  frame, which WLED's optional out-of-sequence check always accepts. See
  `internal/output/ddp`.
- **Wire-time ceiling.** About 30 µs per RGB pixel and 40 µs per RGBW pixel
  per output. Glowstack warns when `max_fps` can't be reached on the longest
  output.
- **Controller settings Glowstack relies on.** They should be checked and
  reported at startup with read-only `/json/cfg` queries, never changed
  automatically:
  - realtime receive enabled
  - "use main segment only" off
  - a realtime timeout, so the controller falls back to its own state if
    Glowstack stops
  - realtime gamma correction off (`no-gc`)
  - "force max brightness" on (`maxbri`) if Glowstack owns brightness
  - auto-white off if `white: explicit`
  - whether an LED map is active (`rlm`), because it remaps indices
- **Health.** Poll `/json/info` slowly to detect reboots, firmware changes
  and an unexpected pixel count. An unreachable controller never stalls
  rendering for the others.

### Layout

The layout is a graph. Runs supply the pixels, anchors pin pixels to nodes,
and the solver turns that into edges.

```yaml
schema: 1
pitch: 1/60 m                  # default LED pitch; a run may override it

nodes:                         # optional declarations; anchors can create nodes too
  - { id: shed-ne, label: "shed NE corner" }
  - { id: tower-top, sync: true }

runs:
  - id: shed-eave
    controller: shed
    indices: [0, 1199]         # inclusive; order = direction along `path`
    path: [shed-se, shed-sw, shed-nw, shed-ne]   # node sequence the run passes
    anchors:                   # which index sits at each interior node
      - { node: shed-sw, index: 402 }
      - { node: shed-nw, index: 815 }
    plan: { svg: "plan.svg#eave", reverse: false }   # optional
    lengths:                   # optional measured lengths between path nodes
      - { from: shed-sw, to: shed-nw, length: 6.9 m }

  - id: tower
    controller: shed
    indices: [1600, 1799]
    path: [tower-l, tower-top, tower-r]
    anchors:
      - { node: tower-top, index: 1700 }

edges:                         # non-strip edges
  - { kind: gap,  from: fence-end, to: wall-start, length: 1.2 m }
  - { kind: link, from: tower-top, to: shed-eave-mid }   # disconnected but aligned

dead:                          # pixels physically present but unlit or hidden
  - { controller: shed, indices: [1200, 1205] }
```

- **Node at an arbitrary pixel.** A link may need a node partway along a run,
  like `shed-eave-mid`. Declare it with an extra anchor on that run.
- **Edge length.** By default the length is pixel count × pitch. A measured
  length in the run's `lengths:` list overrides it for the stretch between
  two consecutive path nodes, for example where a strip is cut and jumped
  around an obstacle.
- **Positions along a run.** Positions are measured in pixel cells: the run
  starts at 0, pixel *k*'s centre is at *k* + ½ and the run ends at its
  pixel count. An anchor puts its node at its pixel's centre. The run's two
  end nodes sit at the run's ends, so they take no anchor.
- **Plan coordinates.** Pixels are spaced evenly along an SVG path between
  anchors. Anchors can name SVG vertices so that corners land on corners.
  Anchors can be estimated from the drawing (see "Drawing first, measuring
  later").
- **What the solver produces.** A pixel table with, for each pixel: global
  id, controller, index, run, edge, distance along the edge, and plan x/y if
  known.
- **Validation:**
  - every pixel belongs to at most one run
  - anchors are monotone along their run
  - nodes referenced by edges exist
  - reports pixels that aren't in any run

#### Drawing first, measuring later

Corner indices are hard to know up front. Glowstack can start from the
drawing and refine from there:

1. **Draw the runs.** Each run gets an SVG path on the plan, drawn in data
   direction from its first pixel, with a vertex at every corner and feature.
   Vertices can carry node ids: a `data-nodes` attribute on the path lists
   one node id per drawn vertex, in order (empty entries leave a vertex
   unlabelled), so the path doubles as the run's node list. The path itself
   is found by its `id` or `inkscape:label`.
2. **Estimate anchors.** Glowstack knows the run's pixel count and pitch,
   which give its true physical length. It scales the drawn path to that
   length and places each vertex at the index proportional to its distance
   along the path. Example: a vertex 40% of the way along a 1,000-pixel run
   is estimated at index 400. A plan scale (from a known dimension) isn't
   needed for this, only for checking.
3. **Mark confidence.** Each anchor records where it came from:

   ```yaml
   anchors:
     - { node: shed-sw, index: 402, source: estimated }   # from the drawing
     - { node: shed-nw, index: 815, source: measured }    # confirmed on site
   ```

   Everything (solver, mappings, effects, live map) works the same with
   estimated anchors, so looks can be designed before anything is measured.
   The live map shows estimated anchors differently from measured ones.
4. **Refine on site** with Glowstack's calibration mode (below). Each
   measured anchor fixes the run piecewise: unmeasured vertices between two
   measured anchors are re-estimated proportionally *within that stretch*,
   so one measurement improves its neighbours too.
5. **Let the measurements correct the drawing.** Pixels are placed on the map
   piecewise between anchors, so a drawing with wrong proportions still shows
   corners on corners once they're measured. The drawing only needs the right
   shape, not the right dimensions.

Drawn proportions can be well off. Simplified plans miss steps and dormers
and misjudge lengths, so an error of 10–20% is normal. Glowstack reports, per
run, the drawn length (when the plan scale is known) against the pixel-count
length. A large mismatch suggests a missing corner, hidden slack, a jumper
gap or a wrong pixel count.

#### Calibration mode

This is a guided way to turn estimates into measurements, using the live map
and the real lights together:

- **Pick a node** on the live map, or step through the unmeasured ones in
  order.
- **Light the guess.** Glowstack pushes a temporary top layer over the
  area. It lights the estimated pixel in white, its neighbours as a
  colour-coded ruler (every 10th pixel marked, for example), and everything
  else dim. Normal layers are untouched underneath and come back when
  calibration ends.
- **Nudge** with buttons from a phone, standing outside: ±1, ±10. Then
  **confirm.** The anchor becomes `measured` and the rest of the run is
  re-estimated.
- **Coarse pass.** A band view lights 100-pixel blocks in alternating colours
  for photographing a whole face at once.
- **Other features** use the same flow: run ends, gap lengths (entered by
  hand), dead pixels, link points between floors.
- **Where it's written.** Measurements are stored in a machine-written
  `anchors.yaml` in the data folder that overrides the hand-written layout. Glowstack never
  rewrites hand-edited YAML, and the file diffs cleanly in git.

Calibration needs DDP output to the controllers involved. Everything before it
(drawing, estimating, designing looks on the map) works with no hardware.

How it works:

- **One session at a time**, held by the server, so a phone and a laptop see
  the same one. It has a *target*: `anchor` (run, node), `end` (run,
  `first` | `last`), `link` or `gap` (its two nodes), `dead` (controller,
  first and last index) or `bands` (a run or a controller). A target has one
  or two *cursors* (a link has one per side, a dead range one per end); the
  nudge buttons move the selected one along its run, so `+` always means
  "towards the run's end", whichever way the run was drawn.
- **The calibration layer** is an ordinary layer with owner `calibration`
  and the internal `calibration` effect (hidden from effect lists and the
  WLED API). It targets the implicit area `run:<id>` or
  `controller:<id>`, so only the controllers involved light up. It is never
  written to `state.json`, and it stays on top: a layer pushed during a
  session ends up underneath it within half a second.
- **The ruler**: the cursor is white; every 10th pixel within 100 of it is
  red towards the run's start and green towards its end, with the cursor's
  direct neighbours a dim red and green; the rest of the run is dim grey.
  A run end lights its whole controller, with pixels outside the run dark.
  A dead range lights its controller, with the ruler at the selected end and
  the range magenta. Bands are 100-pixel blocks, alternately orange and
  blue, with every 10th pixel white.
- **Confirming** writes `anchors.yaml` atomically and reloads the config, so
  the layout is re-solved and the map refreshes. The new file is checked
  first, the same way a reload checks config; if a measurement doesn't fit
  (say, out of order along the run) nothing is written and the error comes
  back with its line. Measured anchors are knots for the piecewise
  estimate, so their neighbours move with them.
- **Output.** Calibration never widens `--output`. If a controller it lights
  isn't selected, the session says so; the live map still shows the pattern.

`anchors.yaml` holds four lists, each optional, one flow-style line per
entry, sorted in layout order:

```yaml
schema: 1
anchors:   # a node's pixel on a run (overrides that anchor in layout.yaml)
  - { run: shed-eave, node: shed-nw, index: 305, source: measured }
ends:      # a run's first or last pixel (overrides indices in layout.yaml)
  - { run: porch, last: 392 }
gaps:      # a gap edge's length, measured by hand
  - { from: gate-w, to: gate-e, length: 1.25 m }
dead:      # added to the layout's dead pixels
  - { controller: yard, indices: [100, 103] }
```

A link is calibrated by placing both of its nodes; confirming writes an
anchor for each side that sits inside its run (a run end is already fixed).

The API lives under `/api/v1/calibration/` (`GET` for the state; `POST`
`start`, `target`, `next`, `nudge`, `set`, `side`, `confirm`, `forget`,
`end`), the CLI under `glowstack ctl cal`, and the live map has a
Calibrate panel.

### Areas and zones

```yaml
schema: 1
areas:
  - id: front
    include: [shed-eave, fence, wall]
  - id: porch
    include: [{ run: shed-eave, from: shed-nw, to: shed-ne }]  # by node or index
  - id: everything
    include: [{ area: front }, { area: porch }]               # other areas
zones:
  - id: front
    area: front
    device: { name: "Glowstack Front", ip: 192.0.2.50, mac: "02:00:00:00:00:01" }
    mapping: front-sweep       # default mapping for layers on this zone
    segments:                  # areas exposed as WLED segments
      - { area: front }
      - { area: porch, mapping: porch-local }   # per-segment override
```

A layer's mapping comes from, in order: the layer itself, its segment, its
zone, then the global default in `mappings.yaml`.

Areas reference runs and nodes, not raw indices. If a strip is repaired and
its pixel count changes, only `layout.yaml` changes.

### Mappings

A mapping gives every pixel in its domain one or more coordinates. Coordinates
are in metres unless the kind says otherwise. Effects say which coordinates
they need, and a layer picks the mapping.

| Kind | Coordinate(s) | Parameters |
|---|---|---|
| `flow` | `u`: graph distance from the origin | origin node, edge orientation overrides, conflict policy |
| `axis` | `u`: plan position projected onto a direction | angle, or two reference points |
| `radial` | `u`: plan distance from a point | centre node or point |
| `plan` | `x`, `y` | none (2-D effects) |
| `local` | `u`: distance along each run separately | none. The "unsynced" fallback |
| `index` | `u`: position within the target area, 0–1 | ordering of runs. Used for WLED-exact effects |

#### Flow solving

```yaml
flows:
  - id: front-sweep
    origin: shed-ne              # u = 0 here
    orient:                      # optional: edges that flow INTO a node
      - { edge: [door, wall-end], into: wall-end }
      - { edge: [tower-l, tower-top], into: tower-top }
    pace: reference              # how parallel paths are reconciled (below)
    reference: [lower-eave]      # runs/edges that set pace; others conform
    pin:                         # optional explicit positions
      - { node: upper-ne, u: 0 m }
    warp: linear                 # linear | smooth: how stretch changes at nodes
    loops: stretch               # stretch | meet | error
    unreached: local             # local | dark | error
```

The solver works in two passes:

1. **Pin nodes.** Walk the graph from the origin along the reference path(s)
   to give sync nodes their `u`. Explicit `pin:` entries and link edges
   (which force equal `u`) add more pinned nodes.
2. **Fill edges.** Every edge between two pinned nodes gets `u` interpolated
   between its ends. Its stretch is (physical length) ÷ (u difference).
   Edges with only one pinned end use stretch 1 from that end, as before.

#### Stretching and compression

Two physically different paths often have to stay in step. For example, a
lower eave and an upper eave are linked at both corners (two pairs of sync
points), but the upper run between them is longer or shorter. Each pair of
linked nodes forces the same `u`, so the run between them must cover the same
`u` distance in a different physical length.

- **Longer than the reference:** the pattern is stretched. Bands are wider and
  move faster in metres per second, so they arrive at the next sync point at
  the same moment.
- **Shorter than the reference:** the pattern is compressed. Bands are
  narrower and move slower.

- **`pace`** says whose length wins between two pinned nodes:
  - `reference` (default): the edges in `reference:` define the distance.
    Everything else conforms.
  - `longest` / `shortest`: the longest or shortest parallel path wins.
  - `average`: the mean of the parallel paths, so every path stretches a
    little and none stretches a lot.
- **Granularity.** Stretch is uniform between consecutive pinned nodes. More
  sync points give finer control. They are just more anchors and links in the
  layout, with no extra machinery.
- **`warp: smooth`.** With `linear`, speed jumps where stretch changes at a
  node. `smooth` blends the stretch across nodes with a monotone spline, so
  speed changes gradually and the sync positions still hold exactly.
- **Limits.** A flow may set `max_stretch: 1.5`, which applies both ways:
  from 1.5× stretched to 1.5× compressed (stretch 1/1.5). Solving warns, or
  fails under `strict`, when an edge goes beyond that, which usually points
  to a wrong anchor.
- **Loops** are the same mechanism. An edge pinned at both ends by different
  routes is stretched (`stretch`), split (`meet`), or rejected (`error`).

The solver also stores each pixel's physical size `dl` (metres) and stretch
`dl/du`. Effects use them to decide which quantities follow the flow and
which stay physical (see "Flow versus physical quantities").

- **Default orientation.** Edges are oriented away from the origin along
  shortest paths. Branches then carry the pattern outward from their branch
  point.
- **`orient` overrides.** An edge marked `into: N` takes its `u` from node N
  and counts down going away from N. This is how a stretch "flows into" a
  sync point rather than out of it.
- **Loops.** When both ends of an edge are already fixed by different paths:
  - `stretch` scales the edge so the pattern matches at both ends (its speed
    changes slightly).
  - `meet` splits it so each half flows from its nearer end.
  - `error` refuses to load.
- **Unreached.** Pixels with no path from the origin, and no link to one, use
  the `unreached` policy.
- **Direction is not part of the mapping.** Effects take `reverse` (or a
  negative speed), so one flow serves both directions. Mappings are named in
  config, and the API can also accept an inline mapping for experiments.

The solver turns each mapping into a precomputed `[]float32` per coordinate,
indexed by global pixel id. Mappings are solved at load time, not per frame.

### Palettes

```yaml
palettes:
  - id: ember
    stops: [[0.0, "#ff2000"], [0.6, "#ff8000"], [1.0, "#ffd060"]]
    interpolate: linear          # linear | step
    wrap: true
```

- **Built-ins.** WLED's 73 fixed palettes are included under their WLED ids
  (0–72) and names, so HA's palette list matches. Their ids are slugs of the
  names (`"Red & Blue"` is `red-blue`), and the name works too. 16-entry
  FastLED palettes become 16 evenly spaced wrapping stops; gradient
  palettes keep their own stops. User palettes get WLED ids from 200
  downward (WLED's custom-palette numbering), or keep a built-in's id when
  they replace it.
- **Special palettes.** WLED's palettes 0–5 have no colours of their own and
  are resolved per layer:
  - `Default` (0) is the effect's own default (Rainbow for `gradient` and
    glitter, the sparkle's colour for `sparkle`, Party otherwise).
  - `* Random Cycle` (1) is four random hues that change every 5 s with a
    1 s cross-fade, a function of time only, so every layer agrees.
  - `* Color 1`, `* Colors 1&2`, `* Color Gradient` and `* Colors Only`
    (2–5) are built from the effect's colours as WLED builds them from a
    segment's three colours. Effects with palettes take a `colors`
    parameter for this (bound to WLED's `col`), except `sparkle`, which
    uses its `color`.
- **White channel.** Colours may give white explicitly (`"#ff8000/40"` = RGB
  plus W). Otherwise the layer's `white` mode derives it, as in WLED's
  auto-white: `explicit` (the default) leaves W as authored, `brighter`
  adds W = min(R, G, B), `accurate` moves min(R, G, B) into W, and `none`
  drops W altogether. `brighter` and `accurate` leave colours that already
  carry white alone (like WLED's "Dual").
- **Linear light.** Authored colours are perceptual, like WLED's. They're
  decoded once to linear light with gamma 2.8 (WLED's default), and all
  compositing, brightness and power maths happens in linear light. The
  output stage therefore doesn't apply gamma again: linear values are LED
  drive levels.

## Effects

### Shape

An effect is Go code registered under a stable id. It declares:

```text
id, name                 e.g. "bands", "Bands"
coords                   which mapping coordinates it needs: u | x,y | index
params                   typed schema (below)
stateful                 bool. Most are not
wled                     optional: fx id/name and slider bindings (below)
```

Each frame it's asked for the colours of its target pixels, given their
coordinates, the frame time and its parameter values. It returns linear RGBW
with an alpha channel. Alpha below 1 lets lower layers show through. That's
how an overlay effect works.

### Parameter types

| Type | Example values | Notes |
|---|---|---|
| `length` | `0.5 m`, `20 px`, `3 ft` | Normalised to metres |
| `speed` | `0.02 m/s`, `1 px/8s`, `-3 ft/min` | Signed. Negative means reverse |
| `duration` | `250 ms`, `5 s` | |
| `rate` | `2 /s` | Events per second |
| `density` | `0.5 /m/s` | Events per metre per second. Sparkle rate independent of length and fps |
| `fraction` | `0.0`–`1.0` | Mix, intensity, probability |
| `angle` | `90 deg` | |
| `color` | `"#ff5a00"`, `"#ff5a00/20"` | RGB with optional W |
| `colors` | list of `color` | |
| `palette` | palette id or inline stops | |
| `mapping` | mapping id or inline | |
| `enum` | one of a declared list | |
| `bool` | | |
| `seed` | integer | Random effects are reproducible |
| `int`, `number` | `3`, `0.25` | Plain counts and factors with no unit |
| `list` of struct | e.g. bands `[{color, width}]` | |

Every parameter has a default, so an effect with no parameters set still runs.

### Common parameters

Every layer gets these whatever the effect, so they behave the same
everywhere:

```text
mapping      which coordinates to use              default: zone's default mapping
reverse      flip direction                        false
offset       shift along u (length)                0
brightness   layer brightness                      1.0
opacity      blend amount                          1.0
blend        replace | over | add | max | multiply over (honours alpha)
white        explicit | none | brighter | accurate  explicit
smooth       sub-pixel rendering for slow motion   true
fade_in, fade_out   transition durations           from config default
```

### Building blocks

Glowstack has a small set of primitive effects. Richer looks are compositions
of them, or presets over them:

| Primitive | What it draws | Key parameters |
|---|---|---|
| `solid` | One colour | `color` |
| `bands` | A repeating sequence of coloured bands over `u` | `bands: [{color, width}]`, `speed`, `edge: hard\|soft` |
| `gradient` | A palette stretched over `u`, optionally moving | `palette`, `span` (length of one full palette cycle), `speed`, `colors` |
| `sparkle` | Random short-lived points over the base | `density`, `color` or `palette`, `lifetime`, `decay`, `seed` |
| `chase` | Moving pulses | `width`, `spacing`, `speed`, `colors`, `tail`, `background`, `overlay` |
| `noise` | Smooth noise over `u`/`x,y` and time | `palette`, `scale`, `speed`, `evolve`, `space: u\|xy`, `seed` |
| `breathe` | Brightness over time | `color`, `background`, `period`, `min`, `max` |

- **`bands`** with `edge: soft` blend linearly from each band's centre to
  the next.
- **`sparkle`** paints only its sparkles, with alpha, so it overlays. Each
  is at full brightness for `lifetime` and then fades over `decay`.
- **`chase`** paints `background` between pulses, or nothing with
  `overlay: true`. The tail trails behind the direction of motion.
- **`noise`** is 3-D gradient noise over (u or x, y) and time. `scale` is
  the feature size and is physical by default; `speed` drifts the field
  and `evolve` changes it in place.
- **`breathe`** mixes `background` to `color` and back with a raised
  cosine. Levels are perceptual, so it looks even. With white over black
  and `blend: multiply` it makes the layers below breathe.

A composite effect is a named stack of primitives sharing one target and
mapping, presented as a single effect. For example, `glitter = gradient +
sparkle(blend: over)`. Composites can be defined in config, so new looks don't
need new code:

```yaml
# presets.yaml
composites:
  - id: ember-glitter
    name: Ember glitter
    layers:                      # bottom first
      - { name: base, effect: gradient, params: { palette: ember, span: 4 m } }
      - { name: sparks, effect: sparkle, blend: over, params: { density: 6 /m/s } }
```

- **Parameters.** A composite's parameters are its parts' parameters under
  the part's name (`base.span`, `sparks.density`), plus `<part>.blend` and
  `<part>.opacity`. A part's `params` are its defaults. The part name
  defaults to the effect id. Each part gets its own seed, derived from the
  layer's.
- **Blending.** Parts are blended bottom first with the compositor's own
  blend, and the composite outputs colour with alpha. With `blend: over`
  that's exactly the same as stacking the parts as layers. `add`, `max` and
  `multiply` parts act on the composite's own parts only.
- **Nesting.** A part may be another composite, and its parameters get two
  prefixes (`outer.inner.speed`). Composites may be listed in any order; a
  cycle is a load error.
- **WLED.** Config composites get fx ids from 240 up, `sx` bound to their
  first speed, `ix` to their first density, `pal` to their first palette
  and `col` to their first colours. `glitter` is built in as WLED fx 87.

### Sub-pixel motion

When something moves slower than about one pixel per frame, it should glide.
Edges are drawn at fractional positions and the boundary pixel is blended.
Temporal dithering in the output stage hides 8-bit steps at low brightness.
`smooth: false` gives whole-pixel stepping when that look is wanted.

### Flow versus physical quantities

Under stretch, an effect must choose per quantity whether it follows `u` or
stays physical:

| Follows `u` (synced, scales with stretch) | Stays physical (per metre, ignores stretch) |
|---|---|
| Positions of waves, bands, gradients, chases | Sparkle density (events per metre per second) |
| Pattern widths and spacing (by default) | Brightness and power |
| Speed along the flow | Noise grain, when it should look the same everywhere |

Each `length` parameter takes a `measure: flow | physical` option, defaulting
to `flow`. Band widths can then either stretch or compress with the run (stay in sync)
or stay a fixed physical size and drift relative to the sync points. Each
effect declares a sensible default per parameter.

### Randomness

Random effects hash `(seed, global pixel id, time slot)` instead of calling a
stateful random number generator. The same seed gives the same sparkles in the
house and in the preview. Sparkles stay in sync across controllers, and
density stays per metre whatever the frame rate.

For `sparkle`, a time slot is as long as one sparkle lasts (`lifetime +
decay`). The hash gives each pixel's number of sparkles starting in a slot,
Poisson-distributed with mean `density × dl × slot`, and each one's start
time and colour. A frame looks at the current and previous slots. Because
`dl` is the pixel's physical size, density is per metre of strip whatever
the stretch.

### Presets

```yaml
presets:
  - id: slow-crawl
    effect: bands
    params:
      bands: [{ color: "#ff5a00", width: 20 px }, { color: "#3cff00", width: 3 px }]
      speed: 1 px/8s
```

A preset is a layer without a target. Applying it to an area makes a layer.
Any parameter can be overridden when it's applied. Overrides replace whole
parameters (overriding `bands` replaces the list). A layer can either copy
the preset's effect and parameters (like applying a preset on WLED, so later
edits to the preset don't affect it) or name the preset, which is expanded
whenever the layer is resolved. Presets are checked against the effects at
startup and problems are logged.

### WLED compatibility

HA's WLED integration speaks in fx ids, palette ids, `sx`/`ix` sliders
(0–255), `c1`–`c3`, `o1`–`o3` and three colours. Each effect that has a WLED
equivalent declares bindings:

```text
wled.fx: 87  "Glitter"
  sx  -> gradient.speed   curve: exp, 0 -> 0, 255 -> 2 m/s
  ix  -> sparkle.density  curve: exp, 0 -> 0, 255 -> 50 /m/s
  pal -> gradient.palette
  col[2] -> sparkle.color
```

- **Canonical values.** The canonical value is always the physical parameter.
  Sliders are a view of it. A slider change sets the physical value through
  its curve. A physical value set through the native API is reported back
  through the inverse curve, clamped.
- **Curves.** With slider position x = s/255 and y the position between
  the binding's two ends: `linear` is y = x; `exp` is
  y = (e^(4x) − 1) / (e^4 − 1), fine control near the first end; `log` is
  its inverse, fine control near the second. Ends may be in either order
  ("255 → 0.5 s" for a period that gets shorter as the slider goes up).
- **Parameter paths.** A binding names a parameter path: `speed`,
  `colors.0` (an element), `bands.1.width` (a list element's field) or
  `sparkle.density` (a composite part's parameter).
- **Sliders set size, not direction.** A slider keeps a speed's sign and a
  length's `physical` measure.
- **Effects with no WLED equivalent.** They're still listed in `/json/eff`
  under ids above WLED's range, with their two most important parameters
  bound to `sx`/`ix`. WLED's ids end at 220 and are 8-bit, so Glowstack
  uses 240–255. `/json/eff` lists names by id with `RSVD` for ids Glowstack
  doesn't implement, as WLED does.
- **Bindings for the built-in effects:**

  | Effect | WLED fx | `sx` | `ix` | Colours, palette |
  |---|---|---|---|---|
  | `solid` | 0 Solid | | | col0 → `color` |
  | `breathe` | 2 Breathe | `period` 10 s → 0.5 s (log) | | col0 `color`, col1 `background` |
  | `sparkle` | 20 Sparkle | `decay` 2 s → 0.05 s (exp) | `density` 0 → 50 /m/s (exp) | col0 `color`, pal |
  | `chase` | 28 Chase | `speed` 0 → 5 m/s (exp) | `width` 1 px → 2 m (exp) | col0 `background`, col1–2 `colors` |
  | `gradient` | 65 Palette | `speed` 0 → 2 m/s (exp) | `span` 0.25 → 20 m (exp) | col0–2 `colors`, pal |
  | `bands` | 83 Solid Pattern | first band's width 1 → 256 px | second band's width 1 → 256 px | col0–1 band colours |
  | `glitter` | 87 Glitter | `gradient.speed` | `sparkle.density` | col0–1 `gradient.colors`, col2 `sparkle.color`, pal |
  | `noise` | 107 Noise Pal | `evolve` 0 → 3 /s (exp) | `scale` 5 → 0.1 m (log) | col0–2 `colors`, pal |
- **WLED-exact mode.** For an effect that should look exactly like WLED, an
  effect can use the `index` mapping and WLED's own maths (ported, with
  attribution).

## Layers and the stack

```text
layer:
  id            stable id (returned to the caller)
  owner         who created it: api | wled-device:<zone>/<segment> | cli | calibration
  target        area id
  effect        effect id + params (or preset id + overrides)
  mapping       mapping id or inline (defaults to the zone's)
  blend, opacity, brightness
  lifetime      until removed | duration | until time
  created, updated
```

- **Pushing.** A new layer goes on top. The stack is one global list, not one
  per zone, so a layer on a small area sits above a layer on a large one by
  recency.
- **Editing.** Changing an active layer edits it in place and keeps its
  position. WLED-API changes to a segment that's already on are edits.
- **Removing ("off").** The layer fades out and is dropped. Pixels it
  covered show the next layer down, or nothing if no layer is left.
- **Black is a colour, not "off".** A layer showing black covers the pixels
  below it and turns those LEDs off. Removing a layer reveals what's below.
  Through the WLED API, `on: false` removes the segment's layer, while
  `on: true` with colour black keeps a layer that blacks out the area.
- **Persistence.** The stack is written to `state.json` on every change
  (debounced; see "Storage").
  What happens at start is configurable: `boot: restore` (reload the stack)
  or `boot: dark` (start with an empty stack). Pixels no layer covers are
  dark.
- **Rendering.** Layers are evaluated top-down per pixel. Once accumulated
  alpha reaches 1 the rest are skipped, so covered pixels cost nothing.

## Brightness and colour pipeline

Per frame, per pixel:

1. Composite the layers in linear float RGBW.
2. Multiply by layer brightness, then zone brightness (the WLED device `bri`),
   then the global master. Zones may overlap; a pixel in several zones is
   multiplied by each of their brightnesses.
3. Power limit:
   - Estimate each output's current from the frame and `led_ma`.
   - For each output over `max_ma`, compute the scale that brings it under.
     Do the same for each controller total.
   - Apply the **lowest** of those scales uniformly to every pixel in the
     limit group, so the brightest-constrained output sets the brightness
     for all of them. The look stays even instead of one stretch going dim.
   - The limit group is configurable (`glowstack.yaml` `power.group`):
     `global` (default), `zone`, `controller` or `output`. A pixel gets
     the lowest scale among its own output's and controller's limits and
     every limit touching a group it belongs to.
   - The scale is smoothed: fast to drop, slow to recover, so moving
     patterns don't make the whole house pump. Drops apply in the same
     frame; recovery has time constant `power.release` (default 2 s).
   - Current is estimated on the wire values, after white handling (step
     4), since it depends on which channels are driven.
4. White handling, then temporal dithering, then quantise to 8 bits. There
   is no gamma step here: values are already linear drive levels (see
   "Linear light"), and quantising is the one encoding to 8 bits.
5. Slice per controller, in wire channel order, and send.

Glowstack owns brightness and gamma. Controllers are configured so they don't
apply theirs a second time (see Controllers).

## Live map

A web page served by Glowstack that draws every pixel on the floor plan and
updates as it renders. It is a development tool first and an HA dashboard
later. It comes early in the build because it lets layouts and effects be
checked without going outside.

- **Server.** Built into Glowstack. Static page plus a websocket that streams
  frames: 8-bit RGB per pixel in global-id order (W folded into RGB for
  display), at a capped rate (say 20 fps). 25,000 pixels is about 1.5 MB/s,
  fine on a LAN. Clients can ask for a lower rate or a subset of areas.
- **Background.** Plan SVGs are site data, mounted with the config and never
  committed. Pixels are drawn at their plan coordinates from the layout
  solver. Runs with no plan geometry are listed but not drawn.
- **Output optional.** `--output=none` renders without sending DDP, so the
  map works with no controllers. `--output=<controller,…>` sends to some
  (the default is `all`). `--loopback=PORT` sends to fake controllers on
  this machine instead (`cmd/fakewled`).
- **Inspect.** Hover or tap a pixel for its controller, index, run, edge,
  areas, flow position `u`, stretch and which layer is showing.
- **Diagnostic views** (overlays instead of the live frame):
  - flow position as a colour ramp per mapping, with direction arrows
  - stretch per edge (blue compressed, red stretched)
  - nodes, anchors, sync points and links, labelled
  - areas and zones
  - estimated current per output and the active power-limit scale
- **Time control** for designing effects: pause, step a frame, slow down or
  speed up, and scrub. It's the preview's clock only, so the house keeps
  running normally. Because effects are functions of place and time, the
  scrubbed view is exactly what the house would show at that moment.
- **Try before applying.** A layer can be previewed on the map only, without
  pushing it to the real stack. There is one preview stack, shared by the
  map's panel and the API (`preview: true`); it's never saved or sent to
  the lights.
- **Later:** embedded in HA as a dashboard panel (iframe or custom card), and
  2-D/elevation views for multi-floor runs.

## Runtime components

```text
config loader ─► layout solver ─► pixel table + mapping arrays
                                         │
API (native HTTP, CLI) ─┐                ▼
WLED-compat devices ────┼─► stack ─► renderer ─► output stage ─► DDP senders
live map (websocket) ◄──┘     │      (per frame,   (bri, power,    (one per
                              ▼       shared clock)  white, dither)  controller)
                         state.json
```

- **Clock.** One monotonic frame clock. Frame time is shared by every layer
  and controller. The frame rate is configurable and capped by the slowest
  controller.
- **Hot reload.** Palettes, presets and mappings reload without a restart
  (`POST /api/v1/reload`, `glowstack ctl reload` or SIGHUP). Layout and
  controller changes rebuild the pixel table, the output stage, the DDP
  senders and the live map. Layers whose target no longer exists are
  dropped with a warning.
- **Observability.** Frame time, per-controller send errors, controller
  reboots and power-limit activity. Logs explain config errors in house
  terms, for example "run `fence` overlaps run `wall` at shed:600–605".

## Decisions made here

- Units are metres internally. `px` is one pitch of the run in question.
- Effects read mapping coordinates, never indices (except the `index`
  mapping).
- Direction is an effect parameter. Sync points, nodes and edges are layout.
- Layouts can start from the drawing: anchors are estimated from the plan
  and pixel counts, marked `estimated`, and refined in calibration mode.
- Stretching and compression are part of the flow solver from the start.
  `u` is measured along a reference path, and parallel paths between pinned
  nodes conform. Each pixel also keeps its physical size, so density-type
  quantities stay physical.
  Flows are named mappings in site config that layers choose between.
- Randomness is hashed, so it's deterministic and the preview matches.
- The physical parameter value is canonical. WLED sliders are views of it.
- Glowstack owns brightness, gamma and the white channel.
- Storage is plain text files: hand-edited YAML config (read-only, in git)
  plus a writable data folder for anchors, saved presets and state. No
  database.
- Black is an ordinary colour. "Off" means removing the layer.
- Power limits are per output (and optional controller totals). Glowstack
  scales a whole limit group by the lowest required factor, global by
  default.
- Boot behaviour and default mappings (zone, with segment override) are
  configurable.
- Composites may nest, with cycles rejected at load.

## Open questions

- When a layer covers part of a larger layer's area, should turning it off in
  HA ever remove the larger layer? Currently it never does.
- `led_ma` figures for the strips need measuring or a datasheet value.
