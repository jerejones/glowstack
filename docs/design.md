# Glowstack design

Status: living spec. Most of it is built; `architecture.md` describes the
code and records where it refines this document. This document fixes the
vocabulary, the configuration shapes and the effect model. Examples use
made-up installations only.

## Principles

1. **Flexibility first.** The installation's physical facts go in
   configuration: where pixels are and which ones meet. Everything about how a
   look appears is a parameter chosen at run time: color, palette, speed,
   direction, size, density and which coordinate system to use. Nothing about
   a look is compiled in.
2. **Separate the house from the look.** House config describes hardware and
   geometry, and changes only when the hardware does. Looks are layers made of
   an effect, its parameters and a target. They change all the time.
3. **Physical units.** Lengths are in meters, speeds in meters per second and
   rates per second. A pattern is the same size on every strip, whatever the
   controller, segment length or frame rate. `px` is accepted as a unit and
   means one LED pitch on the run in question. The exception is deliberate
   stretching or compression, where a flow makes runs of different lengths
   stay in step.
4. **Effects are functions of place and time.** Wherever possible a pixel's
   color is `f(coordinate, t, params, seed)`. That keeps controllers in sync
   for free, makes restarts seamless and lets the preview match the house
   exactly. Effects that need state, like fire or ripples, keep it inside
   their layer.
5. **One frame buffer, many outputs.** Glowstack renders every pixel centrally
   and slices the result per controller. Controllers display pixels and
   nothing else.

## Vocabulary

| Term | Meaning |
|---|---|
| **Controller** | A physical WLED device that receives frames over the network. It has an address and its outputs; its pixel count is their total. |
| **Output** | One WLED output, which drives one data pin: a contiguous index range. Numbered from 1 in WLED's order, as WLED's LED settings show them. Outputs are laid end to end, so each starts where the one before ends. Runs name their LEDs by output; otherwise outputs are used for frame-rate and power budgeting only. |
| **Pixel** | One addressable LED, identified on the wire by `(controller, index)`. Internally every pixel gets a dense global id. Config files never store an index: they count from an output's or a run's first LED, so changing one output's count moves nothing else. |
| **Run** | A physically continuous stretch of pixels on one or two consecutive outputs, between two nodes, with a known direction. Runs are the unit of layout. |
| **Offset** | A position on a run, counted from its first LED in data order (its lowest index), whichever way the run goes. Anchors, dead ranges and area ranges use offsets. |
| **Node** | A named point in the house's layout graph: a corner, an end, a junction or a sync point. |
| **Anchor** | A statement that a particular pixel sits at a node, for example "offset 402 is at node `shed-sw`". Anchors split runs into edges. |
| **Edge** | A connection between two nodes in the layout graph. A **strip edge** carries pixels. A **gap edge** has physical length but no pixels, like a gate or doorway. A **link edge** has zero length and no pixels, and ties two nodes that aren't physically connected but should line up. |
| **Sync point** | A node where effects must line up. Any node can be one. A link edge makes two nodes one sync point. |
| **Position** | Optional physical position of a pixel, `x, y, z` in meters with Z up. It comes from the scene model, or from a floor plan (then `z` is the plan's elevation). Used by the live map and by spatial mappings. |
| **Scene model** | A 3-D model of the site (glTF binary, `.glb`) that carries each run's shape and the building drawn around it. Site data. |
| **Plan coordinates** | The `x, y` part of a position. On a floor plan it is the only part known. |
| **Mapping** | A rule that gives every pixel a coordinate: flow distance, position, radius, or raw index. Effects read coordinates and never read indices. |
| **Flow** | A mapping kind: position along the layout graph from an origin, with edge orientations. |
| **Flow position (`u`)** | A pixel's coordinate in a flow. Measured in meters *of the reference path*, so it equals physical distance only where nothing is stretched. |
| **Pinned node** | A node whose `u` is fixed before edges are filled in: by the reference path, by a link to another pinned node, or by an explicit value. |
| **Stretch** | Physical meters per meter of flow position on an edge (`dl/du`). 1 means unchanged. Above 1 the run is longer than the reference, so the pattern is **stretched**: physically bigger, and it moves faster. Below 1 the run is shorter, so the pattern is **compressed**: physically smaller, and it moves slower. |
| **Reference path** | The path between two pinned nodes whose physical length defines the `u` distance between them. Other parallel paths stretch or compress to match. |
| **Area** | A named set of pixels, defined as a union of runs or run sub-ranges. Areas may overlap. |
| **Zone** | An area that Home Assistant sees as one virtual WLED device. |
| **Segment** | A WLED-API term. It is one area within a zone's virtual device. |
| **Effect** | Code that turns coordinates, time and parameters into colors. It declares a parameter schema. |
| **Palette** | A named color gradient: stops, an interpolation mode and wrapping. |
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
| `glowstack.yaml` | Optional program settings: `fps`, `boot`, default `fade` times, power-limit `power: { group, release }`, `dither`, live map presentation `map:` | Rarely |
| `controllers.yaml` | Controllers, outputs, transport settings | Hardware or network changes |
| `layout.yaml` | Runs, nodes, anchors, edges, the scene model and plans that give runs their shape | Strips are repaired, moved or measured |
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
    channels: rgbw            # rgb | rgbw: bytes per pixel on the wire
    max_fps: 40               # cap; also derived from the longest output
    outputs:                  # every WLED output, in WLED's order
      - { output: 1, gpio: 16, count: 600,  max_ma: 6000 }
      - { output: 2, gpio: 3,  count: 1200, max_ma: 6000 }
    power:
      max_ma: 10000           # optional controller/supply total, like WLED's ABL total
      led_ma: { r: 12, g: 12, b: 12, w: 20, idle: 1 }   # per pixel at full; per strip type
    white: explicit           # explicit | auto. Who computes the W channel
```

Notes:

- **Outputs** are listed in WLED's order, every one of them, because each
  takes up index space. `output:` is WLED's output number, optional but
  checked against the position. Each output starts where the previous one
  ends and the controller's pixel count is the total, so changing one count
  is the only edit when a strip is cut or extended. `gpio:` is for
  information only: messages and the map show "output 2 (GPIO 3)".
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

scene: { glb: site.glb }       # optional 3-D scene model; see "Scene models"
plans:                         # optional floor plans
  - { svg: plan.svg, scale: 0.05 m, z: 0 m }

nodes:                         # optional declarations; anchors can create nodes too
  - { id: shed-ne, label: "shed NE corner" }
  - { id: tower-top, sync: true }

runs:
  - id: shed-eave
    controller: shed
    output: 1                  # or outputs: [1, 2] for a strip fed by two
    leds: [0, 1199]            # optional; counted from the output's first LED
    path: [shed-se, shed-sw, shed-nw, shed-ne]   # node sequence the run passes
    anchors:                   # which offset sits at each interior node
      - { node: shed-sw, offset: 402 }
      - { node: shed-nw, offset: 815 }
    model: { glb: "site.glb#shed-eave" }             # optional 3-D shape
    plan: { svg: "plan.svg#eave", reverse: false }   # optional 2-D shape
    lengths:                   # optional measured lengths between path nodes
      - { from: shed-sw, to: shed-nw, length: 6.9 m }

  - id: tower
    controller: shed
    output: 2
    reverse: true              # wired from tower-r: the path starts at its last LED
    path: [tower-l, tower-top, tower-r]
    anchors:
      - { node: tower-top, offset: 100 }

edges:                         # non-strip edges
  - { kind: gap,  from: fence-end, to: wall-start, length: 1.2 m }
  - { kind: link, from: tower-top, to: shed-eave-mid }   # disconnected but aligned

dead:                          # pixels physically present but unlit or hidden
  - { controller: shed, output: 2, leds: [0, 5] }   # by output, or
  - { run: tower, offsets: [0, 5] }                 # by run
```

- **Which LEDs.** A run names its output (`output: 3`) or consecutive
  outputs (`outputs: [1, 2]`), and by default takes all of them, so it
  follows its output's count. `leds: [a, b]` takes part of it, counted from
  the first output's first LED, low to high and inclusive.
- **Direction.** A run's path goes in data order, from its lowest LED,
  unless `reverse: true` says it starts at its highest. This is separate
  from `plan: { reverse: true }`, which says only the drawing runs the other
  way.
- **Offsets.** Anchors count from the run's first LED in data order (its
  lowest), whichever way the run goes. Nothing in the config counts from
  the controller's first pixel, so cutting or extending one output moves
  nothing on the others. The API, the map and DDP still use `(controller,
  index)`, worked out when the config loads.

- **Node at an arbitrary pixel.** A link may need a node partway along a run,
  like `shed-eave-mid`. Declare it with an extra anchor on that run.
- **Edge length.** By default the length is pixel count × pitch. A measured
  length in the run's `lengths:` list overrides it for the stretch between
  two consecutive path nodes, for example where a strip is cut and jumped
  around an obstacle.
- **Positions along a run.** Positions are measured in pixel cells: the run
  starts at 0, pixel *k*'s center is at *k* + ½ and the run ends at its
  pixel count. An anchor puts its node at its pixel's center. The run's two
  end nodes sit at the run's ends, so they take no anchor.
- **Run shape.** A run's shape is an ordered list of vertices, each with an
  optional node id, drawn in data direction. It comes from the scene model
  (`model:`, 3-D) or a floor plan (`plan:`, 2-D). Both feed the same solver;
  the only difference is that model vertices have a height. When the layout
  has a `scene:`, positions come from `model:` shapes and `plan:` shapes are
  ignored for positions, so 2-D and 3-D never mix in one view. A run with
  neither has no position.
- **Positions.** Pixels are spaced evenly along the shape between anchors.
  Anchors can name shape vertices so that corners land on corners. Anchors
  can be estimated from the drawing (see "Drawing first, measuring later").
- **What the solver produces.** A pixel table with, for each pixel: global
  id, controller, index, run, edge, distance along the edge, and position
  `x, y, z` if known.
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
   unlabeled), so the path doubles as the run's node list. The path itself
   is found by its `id` or `inkscape:label`.
2. **Estimate anchors.** Glowstack knows the run's pixel count and pitch,
   which give its true physical length. It scales the drawn path to that
   length and places each vertex at the offset proportional to its distance
   along the path. Example: a vertex 40% of the way along a 1,000-pixel run
   is estimated at offset 400. A plan scale (from a known dimension) isn't
   needed for this, only for checking.
3. **Mark confidence.** Each anchor records where it came from:

   ```yaml
   anchors:
     - { node: shed-sw, source: estimated }                # from the drawing
     - { node: shed-nw, offset: 815, source: measured }    # confirmed on site
   ```

   Everything (solver, mappings, effects, live map) works the same with
   estimated anchors, so looks can be designed before anything is measured.
   The live map shows estimated anchors differently from measured ones.
4. **Refine on site** with Glowstack's calibration mode (below). Each
   measured anchor fixes the run piecewise: unmeasured vertices between two
   measured anchors are re-estimated proportionally *within that stretch*,
   so one measurement improves its neighbors too.
5. **Let the measurements correct the drawing.** Pixels are placed on the map
   piecewise between anchors, so a drawing with wrong proportions still shows
   corners on corners once they're measured. The drawing only needs the right
   shape, not the right dimensions.

Drawn proportions can be well off. Simplified plans miss steps and dormers
and misjudge lengths, so an error of 10–20% is normal. Glowstack reports, per
run, the drawn length (when the plan scale is known) against the pixel-count
length. A large mismatch suggests a missing corner, hidden slack, a jumper
gap or a wrong pixel count.

The same applies to a scene model. Its units are meters, so no scale is
needed and the length check is always available.

#### Scene models

A scene model is a glTF binary (`.glb`) of the site, usually exported from a
3-D modeling tool. It does two jobs: it gives runs their 3-D shape, and it is
the building the live map draws around the pixels. It is site data, mounted
with the config.

**Frame.** Glowstack works in meters with Z up. glTF is Y up, so a scene
point `(X, Y, Z)` becomes `(X, −Z, Y)` on load. The scene states its frame
in scene-level extras, and Glowstack refuses a scene that doesn't:

```json
{ "glowstack": { "schema": 1, "units": "m", "axes": "gltf-y-up" } }
```

**Runs.** A run's shape is a glTF node with these extras:

| Extra | Required | Meaning |
|---|---|---|
| `glowstack_run` | yes | Run id, as in `layout.yaml` |
| `points` | yes | Ordered vertices in scene coordinates, first vertex at the run's lowest LED |
| `nodes` | yes | Comma-separated node id per vertex; empty entries leave a vertex unlabeled |
| `controller` | no | Checked against `layout.yaml` when present; a mismatch is a load error |
| `basis` | no | Per-vertex provenance (`measured`, `model`, `estimated`, with a note), shown by inspect |

`layout.yaml` stays the source of truth for controllers and LEDs; the model
only supplies shape. It carries no pixel indices, so changing an output's
count doesn't need a re-export (an old exporter's `indices` extra is
ignored). `points` is authoritative: glTF doesn't promise
to keep line vertices in order, so any line mesh on a run node is display
only. `model: { glb: "site.glb#shed-eave" }` names the run node by its
`glowstack_run` value.

**Building.** Every other mesh in the scene is drawing. Line meshes draw as
lines and triangle meshes as faint surfaces. Each mesh node is a **scene
layer**, named by its node name, that the map can style and toggle (see
"Live map"). Glowstack doesn't interpret the building; it only draws it.

**Plans alongside a model.** A site can keep its floor plans for reference
and for drawing new runs. When `scene:` is set the map shows the model, not
the plans, and run positions come from the model. Runs not yet in the model
are listed but not drawn.

#### Calibration mode

This is a guided way to turn estimates into measurements, using the live map
and the real lights together:

- **Pick a node** on the live map, or step through the unmeasured ones in
  order.
- **Light the guess.** Glowstack pushes a temporary top layer over the
  area. It lights the estimated pixel in white, its neighbors as a
  color-coded ruler (every 10th pixel marked, for example), and everything
  else dim. Normal layers are untouched underneath and come back when
  calibration ends.
- **Nudge** with buttons from a phone, standing outside: ±1, ±10. Then
  **confirm.** The anchor becomes `measured` and the rest of the run is
  re-estimated.
- **Coarse pass.** A band view lights 100-pixel blocks in alternating colors
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
  direct neighbors a dim red and green; the rest of the run is dim gray.
  A run end lights its whole controller, with pixels outside the run dark.
  A dead range lights its controller, with the ruler at the selected end and
  the range magenta. Bands are 100-pixel blocks, alternately orange and
  blue, with every 10th pixel white.
- **Confirming** writes `anchors.yaml` atomically and reloads the config, so
  the layout is re-solved and the map refreshes. The new file is checked
  first, the same way a reload checks config; if a measurement doesn't fit
  (say, out of order along the run) nothing is written and the error comes
  back with its line. Measured anchors are knots for the piecewise
  estimate, so their neighbors move with them.
- **Density check.** A measured anchor saved on the wrong node, say the
  opposite corner of a loop, crowds one stretch and thins the next. After
  every solve, each stretch between a run's ends and measured anchors that
  touches a measured anchor is compared with the run's average pixels per
  drawn length; more than 25% off either way is a warning naming the
  anchor. It shows in `--check`, the reload result and, for the stretches a
  confirm just changed, in the Calibrate panel. Comparing with the run's
  own average rather than the pitch keeps a drawing that is off in scale
  overall from warning everywhere.
- **Output.** Calibration never widens `--output`. If a controller it lights
  isn't selected, the session says so; the live map still shows the pattern.

`anchors.yaml` holds four lists, each optional, one flow-style line per
entry, sorted in layout order. Positions are run offsets, like
`layout.yaml`'s, and `pixels` is the run's LED count when the entry was
measured:

```yaml
schema: 1
anchors:   # a node's pixel on a run (overrides that anchor in layout.yaml)
  - { run: shed-eave, node: shed-nw, offset: 305, pixels: 482, source: measured }
ends:      # a run's first or last pixel in run direction (may fall outside its leds)
  - { run: porch, last: 2, pixels: 90 }
gaps:      # a gap edge's length, measured by hand
  - { from: gate-w, to: gate-e, length: 1.25 m }
dead:      # added to the layout's dead pixels: by run, or by output off any run
  - { run: fence-west, offsets: [100, 103], pixels: 240 }
  - { controller: shed, output: 1, leds: [482, 483] }
```

**When a run's count changes.** Offsets survive changes on other outputs
untouched. On the run's own output it depends on where the LEDs went: added
or removed at the far end (away from the data input), every offset still
holds and only the run's end moves; at the data input or in the middle, the
offsets past the change are wrong. Glowstack can't tell which, so while any
of a run's entries has a `pixels` that isn't the run's count it keeps them
and warns once for the run. Settle it with:

```sh
glowstack anchors accept RUN        # the change was at the far end; keep every offset
glowstack anchors shift RUN AT N    # N LEDs added (negative: removed) before offset AT
glowstack anchors clear RUN         # drop the run's measurements and recalibrate it
```

They take `--config` and `--data` like `glowstack` itself, work on the
file's offsets so they run even when stale measurements stop the config
loading, and write `anchors.yaml`; reload Glowstack afterwards.

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
    include: [{ run: shed-eave, from: shed-nw, to: shed-ne }]  # by node or offset
  - id: west-eave
    include: [{ run: shed-eave, after: shed-sw, before: shed-nw }]  # ends excluded
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

A run range has a start and an end, each a node id or a run offset
(counted from the run's first LED in data order).
`from` and `to` include the pixel at that point; `after` and `before`
exclude it, so two neighboring areas can meet at a node without sharing
its pixel (`{to: shed-nw}` and `{after: shed-nw}`). Give at most one start
(`from` or `after`) and one end (`to` or `before`); a missing one means the
run's end. "After" and "before" are along the walk from the start to the
end, so a range written against the run direction works the same way. A
range that ends up with no pixels is an error.

A layer's mapping comes from, in order: the layer itself, its segment, its
zone, then the global default in `mappings.yaml`.

Areas reference runs, nodes and run offsets, not controller indices. If a
strip is repaired and its pixel count changes, only its output's `count` in
`controllers.yaml` changes.

Besides areas.yaml's areas, every layer target can also be an implicit
area: `run:<id>`, `controller:<id>`, or `all` for every pixel on a run. An
areas.yaml area with the same id wins.

### Mappings

A mapping gives every pixel in its domain one or more coordinates. Coordinates
are in meters unless the kind says otherwise. Effects say which coordinates
they need, and a layer picks the mapping.

| Kind | Coordinate(s) | Parameters |
|---|---|---|
| `flow` | `u`: graph distance from the origin | origin node, edge orientation overrides, conflict policy |
| `axis` | `u`: position projected onto a direction | angle (horizontal, counter-clockwise seen from above), a 3-D `direction` vector (`[0, 0, 1]` is up), or two reference points |
| `radial` | `u`: distance from a point | center node or point; `horizontal: true` ignores height |
| `plan` | `x`, `y`, `z` | none (spatial effects) |

Kinds that need a position cover only pixels that have one. Positions are a
property of the pixel, so effects that read `x, y` also get `z`. A point is
a node id, `[x, y]` or `[x, y, z]`; a point without `z` has no height, so a
radial distance from it, or an axis toward it, is horizontal. On a site with
only floor plans, `z` is each plan's elevation, so height-based mappings
work but are coarse.
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
  move faster in meters per second, so they arrive at the next sync point at
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

The solver also stores each pixel's physical size `dl` (meters) and stretch
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

#### Inline mappings

A layer's (or a preset's) `mapping` parameter may be an object instead of an
id, with the same fields as a `mappings.yaml` entry:

```json
{"target": "yard", "effect": "gradient",
 "mapping": {"origin": "gate-e", "pace": "average", "unreached": "dark"}}
```

An object with `kind: flow`, or with an `origin` and no `kind`, is a flow;
otherwise `kind` is one of the `mappings:` kinds. An `id` is allowed and
ignored. It's checked and solved when the layer is pushed or edited, and
errors name the problem without a file position (`inline mapping: unknown
field "pase"`). Solves are cached by a hash of the content, so equal inline
mappings on several layers are solved once, and the layer reports the
mapping as `inline:<hash>`. A reload solves them again on the new layout.

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
- **Special palettes.** WLED's palettes 0–5 have no colors of their own and
  are resolved per layer:
  - `Default` (0) is the effect's own default (Rainbow for `gradient` and
    glitter, the sparkle's color for `sparkle`, Party otherwise).
  - `* Random Cycle` (1) is four random hues that change every 5 s with a
    1 s cross-fade, a function of time only, so every layer agrees.
  - `* Color 1`, `* Colors 1&2`, `* Color Gradient` and `* Colors Only`
    (2–5) are built from the effect's colors as WLED builds them from a
    segment's three colors. Effects with palettes take a `colors`
    parameter for this (bound to WLED's `col`), except `sparkle`, which
    uses its `color`.
- **White channel.** Colors may give white explicitly (`"#ff8000/40"` = RGB
  plus W). Otherwise the layer's `white` mode derives it, as in WLED's
  auto-white: `explicit` (the default) leaves W as authored, `brighter`
  adds W = min(R, G, B), `accurate` moves min(R, G, B) into W, and `none`
  drops W altogether. `brighter` and `accurate` leave colors that already
  carry white alone (like WLED's "Dual").
- **Linear light.** Authored colors are perceptual, like WLED's. They're
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

Each frame it's asked for the colors of its target pixels, given their
coordinates, the frame time and its parameter values. It returns linear RGBW
with an alpha channel. Alpha below 1 lets lower layers show through. That's
how an overlay effect works.

### Parameter types

| Type | Example values | Notes |
|---|---|---|
| `length` | `0.5 m`, `20 px`, `3 ft` | Normalized to meters |
| `speed` | `0.02 m/s`, `1 px/8s`, `-3 ft/min` | Signed. Negative means reverse |
| `duration` | `250 ms`, `5 s` | |
| `rate` | `2 /s` | Events per second |
| `density` | `0.5 /m/s` | Events per meter per second. Sparkle rate independent of length and fps |
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
blend        replace | over | add | max | multiply over (honors alpha)
white        explicit | none | brighter | accurate  explicit
smooth       sub-pixel rendering for slow motion   true
fade_in, fade_out   transition durations           from config default
```

### Building blocks

Glowstack has a small set of primitive effects. Richer looks are compositions
of them, or presets over them:

| Primitive | What it draws | Key parameters |
|---|---|---|
| `solid` | One color | `color` |
| `bands` | A repeating sequence of colored bands over `u` | `bands: [{color, width}]`, `speed`, `edge: hard\|soft` |
| `gradient` | A palette stretched over `u`, optionally moving | `palette`, `span` (length of one full palette cycle), `speed`, `colors` |
| `sparkle` | Random short-lived points over the base | `density`, `color` or `palette`, `lifetime`, `decay`, `seed` |
| `chase` | Moving pulses | `width`, `spacing`, `speed`, `colors`, `tail`, `background`, `overlay` |
| `noise` | Smooth noise over `u`/`x,y` and time | `palette`, `scale`, `speed`, `evolve`, `space: u\|xy`, `seed` |
| `breathe` | Brightness over time | `color`, `background`, `period`, `min`, `max` |

- **`bands`** with `edge: soft` blend linearly from each band's center to
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
  blend, and the composite outputs color with alpha. With `blend: over`
  that's exactly the same as stacking the parts as layers. `add`, `max` and
  `multiply` parts act on the composite's own parts only.
- **Nesting.** A part may be another composite, and its parameters get two
  prefixes (`outer.inner.speed`). Composites may be listed in any order; a
  cycle is a load error.
- **WLED.** Config composites get fx ids from 240 up, `sx` bound to their
  first speed, `ix` to their first density, `pal` to their first palette
  and `col` to their first colors. `glitter` is built in as WLED fx 87.

### Sub-pixel motion

When something moves slower than about one pixel per frame, it should glide.
Edges are drawn at fractional positions and the boundary pixel is blended.
Temporal dithering in the output stage hides 8-bit steps at low brightness.
`smooth: false` gives whole-pixel stepping when that look is wanted.

### Flow versus physical quantities

Under stretch, an effect must choose per quantity whether it follows `u` or
stays physical:

| Follows `u` (synced, scales with stretch) | Stays physical (per meter, ignores stretch) |
|---|---|
| Positions of waves, bands, gradients, chases | Sparkle density (events per meter per second) |
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
density stays per meter whatever the frame rate.

For `sparkle`, a time slot is as long as one sparkle lasts (`lifetime +
decay`). The hash gives each pixel's number of sparkles starting in a slot,
Poisson-distributed with mean `density × dl × slot`, and each one's start
time and color. A frame looks at the current and previous slots. Because
`dl` is the pixel's physical size, density is per meter of strip whatever
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
whenever the layer is resolved. Presets are checked at startup and on every
reload: an unknown effect, palette or mapping (or an inline mapping that
doesn't solve) and bad parameter values are warnings, with the preset's file
and line, in `--check`'s summary, the log and the reload result. A preset
has no target, so there's no area to check; the area is checked when it's
applied.

Presets saved through the API (or from HA) go to `presets.saved.yaml` in the
data folder; `presets.yaml` is never rewritten, so its presets are read-only
through the API. `GET /api/v1/presets` lists the effective set with each
preset's `source` (`saved` or `config`); a saved preset with a configured
one's id replaces it, and deleting the saved one brings the configured one
back. A preset can be saved from an effect and parameters or from a layer,
which is the usual way to keep something tried on the preview:

```sh
glowstack ctl save-preset blue-porch --from-layer p1 --name "Blue porch"
glowstack ctl rm-preset blue-porch
```

### WLED compatibility

HA's WLED integration speaks in fx ids, palette ids, `sx`/`ix` sliders
(0–255), `c1`–`c3`, `o1`–`o3` and three colors. Each effect that has a WLED
equivalent declares bindings:

```text
wled.fx: 87  "Glitter"
  sx  -> gradient.speed   curve: exp, 0 -> 0, 255 -> 10 m/s
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

  | Effect | WLED fx | `sx` | `ix` | Colors, palette |
  |---|---|---|---|---|
  | `solid` | 0 Solid | | | col0 → `color` |
  | `breathe` | 2 Breathe | `period` 10 s → 0.5 s (log) | | col0 `color`, col1 `background` |
  | `sparkle` | 20 Sparkle | `decay` 2 s → 0.05 s (exp) | `density` 0 → 50 /m/s (exp) | col0 `color`, pal |
  | `chase` | 28 Chase | `speed` 0 → 5 m/s (exp) | `width` 1 px → 2 m (exp) | col0 `background`, col1–2 `colors` |
  | `gradient` | 65 Palette | `speed` 0 → 10 m/s (exp) | `span` 0.25 → 20 m (exp) | col0–2 `colors`, pal |
  | `bands` | 83 Solid Pattern | first band's width 1 → 256 px | second band's width 1 → 256 px | col0–1 band colors |
  | `glitter` | 87 Glitter | `gradient.speed` | `sparkle.density` | col0–1 `gradient.colors`, col2 `sparkle.color`, pal |
  | `noise` | 107 Noise Pal | `evolve` 0 → 3 /s (exp) | `scale` 5 → 0.1 m (log) | col0–2 `colors`, pal |
- **WLED-exact mode.** For an effect that should look exactly like WLED, an
  effect can use the `index` mapping and WLED's own maths (ported, with
  attribution).

### WLED devices

Each zone with a `device:` block is its own WLED device: an HTTP server
with WLED's JSON API (`/json`, `/json/state`, `/json/info`, `/json/eff`,
`/json/pal`, `/json/fxdata`, a minimal `/json/cfg`, `/presets.json`) and
the `/ws` websocket, which pushes the state on every change, whoever made
it. It reports WLED 16 with brand `WLED` and product `Glowstack`, so Home
Assistant offers no firmware updates.

```yaml
device: { name: "Glowstack Front", ip: 192.0.2.50, mac: "02:00:00:00:00:01", port: 80 }
```

- **Identity.** `mac` is required and unique: HA identifies devices by it.
  `name` defaults to the zone id. HA's integration only talks to port 80,
  so each device needs its own IP on the host; `port` is for development.
  An empty `ip` listens on every address.
- **Segments** are the zone's `segments`, in order. A segment is on when a
  layer owned by `wled-device:<zone>/<n>` is on the stack (see "Layers and
  the stack"). A segment that's off remembers its look and shows it again
  when turned on. Segment `bri` is the layer's `brightness`, `rev` its
  `reverse`. Segment bounds, names, grouping and freeze can't be changed.
- **Device `on`/`bri` are the zone brightness.** Off sets it to 0, which
  darkens the zone without removing any layer, so turning the device on
  again shows what was there; the brightness to turn on at is kept in
  `wled.json` in the data folder. A zone brightness set through the native
  API is what the device reports.
- **Controls an effect doesn't bind** are remembered and reported back as
  set. Switching effect keeps the colors and palette; the sliders start at
  the new effect's defaults.
- **Transitions.** `transition` and `tt` are the fade-in of a pushed layer
  and the fade-out of a removed one. Edits and brightness are immediate.
- **Presets.** Glowstack's presets get WLED preset ids 1–250 in order of
  first sight, kept in `wled.json` so they don't move. `ps` shows a preset
  on the main segment, as a layer naming the preset; the first control
  change copies it into the layer. `psave` saves the main segment's look
  as a saved preset (configured presets can't be overwritten), `pdel`
  deletes a saved one.
- **Palettes.** `/json/pal` lists every palette at its WLED id, user
  palettes by their own names (with nulls between), and reports no custom
  palettes; WLED would call ids 200 and down "Custom n".
- **Ignored.** Nightlight, UDP sync, live override, per-LED colors and
  playlists are accepted, ignored and reported off.
- **Discovery.** With `--mdns`, devices are advertised as `_wled._tcp` and
  `_http._tcp` with `mac=` in the TXT record, as WLED does.

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
- **Black is a color, not "off".** A layer showing black covers the pixels
  below it and turns those LEDs off. Removing a layer reveals what's below.
  Through the WLED API, `on: false` removes the segment's layer, while
  `on: true` with color black keeps a layer that blacks out the area.
- **Persistence.** The stack is written to `state.json` on every change
  (debounced; see "Storage").
  What happens at start is configurable: `boot: restore` (reload the stack)
  or `boot: dark` (start with an empty stack). Pixels no layer covers are
  dark.
- **Rendering.** Layers are evaluated top-down per pixel. Once accumulated
  alpha reaches 1 the rest are skipped, so covered pixels cost nothing.

## Brightness and color pipeline

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

A web page served by Glowstack that draws every pixel on the site's scene
model (or, without one, its floor plan) and updates as it renders. It is a
development tool first and an HA dashboard later. It comes early in the
build because it lets layouts and effects be checked without going outside,
and it is built to be used on a phone standing in the yard as much as at a
desk.

- **Server.** Built into Glowstack. Static page plus a websocket that streams
  frames: 8-bit RGB per pixel in global-id order (W folded into RGB for
  display), at a capped rate (say 20 fps). 25,000 pixels is about 1.5 MB/s,
  fine on a LAN. Clients can ask for a lower rate or a subset of areas.
- **Background.** The scene model or plan SVGs are site data, mounted with
  the config and never committed. Pixels are drawn at their positions from
  the layout solver. Runs with no position are listed but not drawn.
- **Layout by width.** One page, arranged for the screen:
  - Under 700 px wide, the map fills the screen and the panel is a bottom
    sheet with three detents: *peek* (just the tabs), *half* (45% of the
    height) and *full* (a 120 px strip of map stays above it, framing the
    selection). Drag or flick the handle between them, or tap it. The
    camera chips float over the map.
  - From 700 to 1100 px, and on a phone held sideways, a 300 px side panel
    that folds to an icon rail.
  - Over 1100 px, a 360 px side panel, always open.

  The map frames its content in the part of the screen the panel and chips
  leave free, so the whole house shows above a peeking sheet.
- **Touch and pointer.** A tap selects (a finger may drift 6 px); a long
  press (450 ms) pins a pixel's inspect card; a double tap fits. With a
  mouse, hovering shows the card. On touch screens every control is at
  least 44 px and text is 15 px; with a mouse, controls are about 28 px and
  text 13 px.
- **3-D view.** With a scene model, the map is a 3-D view (WebGL, three.js
  vendored with its license):
  - The building draws as see-through lines over faint surfaces. The
    surfaces also go into the depth buffer, so a pixel on the far side of a
    wall shows dimmed and one in front of it shows fully.
  - The pixels are one point cloud (one color buffer, updated in place
    each frame), each a dot at its position in its live color, sized by its
    pitch and distance. An unlit pixel is a black dot, like the LED; a
    dead pixel is a gray ring, and a pixel whose controller can't be
    reached is gray.
  - Orbit, pan and zoom. Three named views: **Street** (the site's view),
    **Overhead** (straight down, north up) and **Free** (where you last left
    the camera, kept per device). **Fit** frames all the pixels from where
    the camera is looking; **Default** forgets this device's camera. Named
    views and Fit reframe themselves when the screen or the panel changes
    size.
  - Nodes, arrows and labels draw through the same camera, and inspect and
    calibration pick the pixel nearest the pointer on screen.
  - Scene layers can be toggled; the choice is kept in the browser. Their
    look is site config in `glowstack.yaml`, keyed by scene node name;
    unlisted layers get a default. The site's view is set there too:

    ```yaml
    map:
      view: { direction: [-0.4, -0.8, 0.45], to: [8, 6, 2], fov: 40 }   # Z up
      auto_rotate: false
      layers:
        walls lines:  { color: "#cfe3ff", opacity: 0.55 }
        walls faces:  { color: "#4b6a9a", opacity: 0.06 }
        site lines:   { color: "#5b6b7a", opacity: 0.35, visible: true }
    ```

    `direction` points from what the camera looks at toward the camera, and
    the map works out the distance so the model fits whatever the screen's
    shape. `to` is optional (the middle of the pixels otherwise). The older
    `{ from, to, fov }` form still works: its camera is used unless the
    house wouldn't fit. Without a `view`, the map frames the model from an
    elevated three-quarter angle. **Copy view** puts the current camera on
    the clipboard in the direction form, for pasting into config (over plain
    http, where browsers block the clipboard API, it falls back to a dialog
    to copy from).
- **2-D view.** Without a scene model, the map draws the floor plans as
  before, with the same selection and inspect. A site with a model
  doesn't show its plans; they stay in its config folder for reference and
  for drawing new runs.
- **Selection.** Tapping a run selects the smallest area around it; tapping
  it again climbs to the next larger area, then the zone, then **All**
  (every pixel on a run, the `all` target), then back to the run. An area
  that already covers everything is the same step as All. A breadcrumb over
  the map shows the chain and jumps along it. The selection is where looks
  go; a soft white halo marks its pixels on the map.
- **Panel tabs.** Looks, Setup and Status; the open one is remembered per
  device.
  - *Looks*: where looks go, presets first and then effects, the preview
    (a card per layer with its brightness, **Tweak**, **Apply to lights**
    and Remove), what is on the lights, and the preview clock. Tweaking a
    layer that is on the lights edits a preview copy; applying the copy
    replaces the original.
  - *Setup*: calibration, the overlays and their legend, the model's layers
    or the plan, the camera, the stream rate, and the runs the
    plan or model doesn't draw.
  - *Status*: render rate and frame time, controllers (reachability, errors
    and last contact, as far as the server reports them), each run's drawn
    against measured length, and power per output.
- **Output optional.** `--output=none` renders without sending DDP, so the
  map works with no controllers. `--output=<controller,…>` sends to some
  (the default is `none`, or `all` with `--loopback`). `--loopback=PORT` sends to fake controllers on
  this machine instead (`cmd/fakewled`).
- **Area geometry.** `/api/map/geometry` includes each area's `id`, pixel
  `count`, global pixel `ranges` (inclusive `[start, end]` pairs), `includes`
  (directly included area ids), and `runs` (directly referenced run ids,
  including partial runs). Both lists follow config order; `runs` is
  deduplicated. Empty lists are `[]`. The graph preserves direct references
  rather than flattening descendants, so selection can move from a run to
  its containing areas and zones.
- **Inspect.** Hover (mouse) or long-press (touch) a pixel for its
  controller, index, output, run, edge, areas, flow position `u`, stretch
  and which layer is showing.
- **Diagnostic views** (overlays instead of the live frame):
  - flow position as a color ramp per mapping, with direction arrows
  - stretch per edge (blue compressed, red stretched)
  - nodes, anchors, sync points and links, labeled
  - areas and zones
  - controllers and outputs: each output in its own color, a ring where its
    data enters, optionally one controller at a time
  - estimated current per output and the active power-limit scale
- **Time control** for designing effects: pause, step a frame, slow down or
  speed up, and scrub. It's the preview's clock only, so the house keeps
  running normally. Because effects are functions of place and time, the
  scrubbed view is exactly what the house would show at that moment.
- **Try before applying.** A layer can be previewed on the map only, without
  pushing it to the real stack. There is one preview stack, shared by the
  map's panel and the API (`preview: true`); it's never saved or sent to
  the lights. Once it looks right, **push to live** moves preview layers
  (one, or all in order) onto the house stack with the same look and seed.
  Applying is always a separate, green button; nothing on the map applies
  by itself.
- **Preview or live.** Each viewer picks what its map shows: the preview
  (preview layers and clock over the house; the house's own frames when
  nothing is previewed) or live, what the lights show, even while someone
  else is previewing.
- **Calibration mode.** On a phone, calibration (see "Calibration mode"
  above) takes the screen below a strip of map that keeps the cursor in
  view: what is being measured and Stop at the top, nudges and Confirm in
  the thumb zone. Wider screens show it in place of the panel.
- **Light on the device.** The map draws only when a frame arrives or the
  camera moves, and the stream drops to 10 fps while the page is hidden or
  the device runs on battery. Messages share one toast area. Escape unpins
  the inspect card, then clears the selection, then lowers the sheet; Space
  pauses or resumes the preview clock.
- **Later:** embedded in HA as a dashboard panel (iframe or custom card).

## Controller health API

`GET /api/v1/status` includes a stable `health.controllers` map keyed by
controller id. Every configured controller appears, including with
`--output=none`. `GET /api/v1/controllers` has the same top-level `health`
wrapper and the same per-controller object under each entry's `health`:

```json
{"health":{"controllers":{"shed":{"reachable":null,"last_seen":null,"send_errors":0,"last_error":"","sending":false,"reboots":0,"frames":0,"packets":0,"bytes":0,"coalesced":0}}}}
```

- `sending`: selected by `--output`, regardless of current reachability.
  False with output disabled or for an unselected controller.
- `reachable`: the latest read-only `/json/info` check's result; `null`
  until checked, including when output is disabled. Successful UDP sends
  alone do not establish reachability. Selected controllers are checked
  immediately and then every minute by default.
- `last_seen`: last successful `/json/info` check, as an RFC3339 timestamp,
  or `null` if none. A failed check preserves the last successful time.
- `send_errors`: DDP address lookup and write failures. `last_error` is the
  current health-check error, otherwise the latest send error, or `""`.
  Send errors remain recorded after later successful sends.
- `reboots`: observed decreases in the controller's reported uptime.
  `frames`, `packets`, and `bytes` count DDP traffic (bytes excludes packet
  headers); `coalesced` counts queued frames superseded by newer frames.
  All of these counters are present even when zero. There is no measured
  per-controller FPS counter.
- Optional details: `checked` (last HTTP check, successful or failed),
  `version`, `uptime_s`, `led_count`, `mismatches` (setting warnings),
  `error` (current HTTP check error), `last_send_error` and
  `last_send_error_at`. Timestamps use RFC3339. Empty or zero optional
  details are omitted.

Health history lasts for the monitor's lifetime and resets when its endpoint
changes. DDP counters last for the sender's lifetime; a reload that rebuilds
the selected targets resets them. Disabling output does not poll controllers.

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

- Units are meters internally. `px` is one pitch of the run in question.
- Effects read mapping coordinates, never indices (except the `index`
  mapping).
- Direction is an effect parameter. Sync points, nodes and edges are layout.
- Layouts can start from the drawing: anchors are estimated from the plan
  and pixel counts, marked `estimated`, and refined in calibration mode.
- Positions are 3-D, meters, Z up. A scene model (`.glb`) is the preferred
  source of run shapes and the live map's background; floor plans remain
  for sites without one. The model supplies shape only; `layout.yaml` keeps
  controllers and LEDs.
- Config never stores controller indices. Runs name WLED outputs, and
  everything else counts from a run's or an output's first LED, so a
  repair that changes one output's count is a one-line edit. Measurements
  remember the run length they were taken at and warn when it changes.
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
- Black is an ordinary color. "Off" means removing the layer.
- Power limits are per output (and optional controller totals). Glowstack
  scales a whole limit group by the lowest required factor, global by
  default.
- Boot behavior and default mappings (zone, with segment override) are
  configurable.
- Composites may nest, with cycles rejected at load.

## Open questions

- When a layer covers part of a larger layer's area, should turning it off in
  HA ever remove the larger layer? Currently it never does.
- `led_ma` figures for the strips need measuring or a datasheet value.
