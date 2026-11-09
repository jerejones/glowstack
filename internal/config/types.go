// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"fmt"
	"strconv"

	"gopkg.in/yaml.v3"

	"github.com/jerejones/glowstack/internal/units"
)

// ---- glowstack.yaml ----

// SettingsFile is glowstack.yaml: process-wide settings. Optional.
type SettingsFile struct {
	Schema   int      `yaml:"schema"`
	Settings Settings `yaml:",inline"`
}

// Settings are general runtime settings.
type Settings struct {
	Pos
	FPS  float64 `yaml:"fps"`  // frame rate; default 40, capped by controllers' max_fps
	Boot string  `yaml:"boot"` // restore | dark; default restore
	Fade Fade    `yaml:"fade"` // default layer fade durations
	// Power is the power-limit policy. The limits themselves are per
	// output and controller in controllers.yaml.
	Power PowerPolicy `yaml:"power"`
	// Dither turns temporal dithering to 8 bits on or off; default on.
	Dither *bool `yaml:"dither"`
	// Map is how the live map presents the scene model.
	Map MapSettings `yaml:"map"`
}

// MapSettings are the live map's 3-D presentation: where the camera opens
// and how each scene layer looks. Layers are keyed by scene node name;
// unlisted layers get a default by kind.
type MapSettings struct {
	Pos
	View       *MapView            `yaml:"view"`
	AutoRotate bool                `yaml:"auto_rotate"`
	Layers     map[string]MapLayer `yaml:"layers"`
}

// MapView is a camera: positions in meters, Z up. Direction points from
// the target toward the camera; the page fits its distance to the screen.
type MapView struct {
	Pos
	From      []float64 `yaml:"from"`      // camera position [x, y, z]
	Direction []float64 `yaml:"direction"` // normalized target-to-camera vector
	To        []float64 `yaml:"to"`        // the point it looks at and orbits
	FOV       float64   `yaml:"fov"`       // vertical field of view, degrees; default 40
}

// MapLayer styles one scene layer.
type MapLayer struct {
	Pos
	Color   string   `yaml:"color"`   // #rrggbb
	Opacity *float64 `yaml:"opacity"` // 0–1
	Visible *bool    `yaml:"visible"` // shown when the map opens; default true
}

// PowerPolicy says how power-limit scales are shared and smoothed.
type PowerPolicy struct {
	Pos
	// Group is the limit group: global (default) | zone | controller |
	// output. Every pixel in a group is scaled by the lowest scale any
	// limit touching the group needs.
	Group string `yaml:"group"`
	// Release is the time constant for recovering after a limit eases;
	// default 2 s. Limiting itself takes effect at once.
	Release *units.Duration `yaml:"release"`
}

// Fade gives default layer fade durations.
type Fade struct {
	Pos
	In  *units.Duration `yaml:"in"`
	Out *units.Duration `yaml:"out"`
}

// ---- controllers.yaml ----

// ControllersFile is controllers.yaml.
type ControllersFile struct {
	Schema      int          `yaml:"schema"`
	Controllers []Controller `yaml:"controllers"`
}

// Controller is a physical WLED device.
type Controller struct {
	Pos
	ID        string `yaml:"id"`
	Host      string `yaml:"host"`
	Transport string `yaml:"transport"` // ddp (default)
	Port      int    `yaml:"port"`      // DDP port; default 4048
	HTTPPort  int    `yaml:"http_port"` // JSON API port for health checks; default 80
	// Pixels is the sum of the outputs' counts, set by Validate. Code that
	// builds a Config may set it directly for a controller without outputs.
	Pixels   int      `yaml:"-"`
	Channels string   `yaml:"channels"` // rgb (default) | rgbw
	MaxFPS   float64  `yaml:"max_fps"`
	Outputs  []Output `yaml:"outputs"`
	Power    *Power   `yaml:"power"`
	White    string   `yaml:"white"` // explicit (default) | auto
}

// Output is one WLED output: the LEDs on one data pin, a contiguous index
// range. Outputs are listed in WLED's order and numbered from 1 as WLED
// numbers them; each starts where the one before it ends.
type Output struct {
	Pos
	Reversed bool    `yaml:"reversed"` // WLED bus reversal; physical input marker only, never reverses DDP
	Number   int     `yaml:"output"`   // WLED's output number; optional, must match the position
	GPIO     *int    `yaml:"gpio"`     // the pin it drives; for information only
	Count    int     `yaml:"count"`
	MaxMA    float64 `yaml:"max_ma"` // 0 = unlimited
	Start    int     `yaml:"-"`      // controller index of its first LED, set by Validate
}

// Name is how messages refer to the output: "output 3 (GPIO 2)".
func (o *Output) Name() string {
	if o.GPIO != nil {
		return fmt.Sprintf("output %d (GPIO %d)", o.Number, *o.GPIO)
	}
	return fmt.Sprintf("output %d", o.Number)
}

// Power is a controller's supply limit and per-LED current figures.
type Power struct {
	Pos
	MaxMA float64 `yaml:"max_ma"` // controller total; 0 = unlimited
	LedMA LedMA   `yaml:"led_ma"`
}

// KnowsCurrent reports whether the controller's LEDs have a current set,
// without which its draw can't be estimated.
func (p *Power) KnowsCurrent() bool {
	return p != nil && p.LedMA.R+p.LedMA.G+p.LedMA.B+p.LedMA.W > 0
}

// LedMA is per-pixel current at full drive per channel, plus idle draw.
type LedMA struct {
	Pos
	R    float64 `yaml:"r"`
	G    float64 `yaml:"g"`
	B    float64 `yaml:"b"`
	W    float64 `yaml:"w"`
	Idle float64 `yaml:"idle"`
}

// ---- layout.yaml ----

// LayoutFile is layout.yaml.
type LayoutFile struct {
	Schema int    `yaml:"schema"`
	Layout Layout `yaml:",inline"`
}

// Layout describes runs, nodes, anchors and non-strip edges.
type Layout struct {
	Pos
	Pitch units.Length `yaml:"pitch"` // default pitch; required, meters
	Scene *Scene       `yaml:"scene"`
	Plans []Plan       `yaml:"plans"`
	Nodes []Node       `yaml:"nodes"`
	Runs  []Run        `yaml:"runs"`
	Edges []Edge       `yaml:"edges"`
	Dead  []Dead       `yaml:"dead"`
}

// Scene declares the site's scene model. With a scene, run positions come
// from `model:` shapes and `plan:` shapes are ignored.
type Scene struct {
	Pos
	GLB string `yaml:"glb"` // path relative to the config dir
}

// Plan declares a plan SVG and, optionally, its scale. Runs may also name
// SVGs that aren't declared here; their scale is then unknown.
type Plan struct {
	Pos
	SVG   string        `yaml:"svg"`   // path relative to the config dir
	Scale *units.Length `yaml:"scale"` // meters per plan unit
	Z     *units.Length `yaml:"z"`     // elevation of the plan, meters; default 0
}

// Node is an optional node declaration. Anchors and run paths create nodes
// too.
type Node struct {
	Pos
	ID    string `yaml:"id"`
	Label string `yaml:"label"`
	Sync  bool   `yaml:"sync"`
}

// Run is a physically continuous stretch of pixels on one controller.
//
// Its LEDs are named by output: `output: 3` (or `outputs: [1, 2]` for a
// strip fed by two consecutive outputs) and optionally `leds: [a, b]`,
// counted from the first output's first LED, inclusive. The default is the
// whole output(s), so a run follows its output's count. The run's
// direction along its path is data order (lowest LED first) unless
// `reverse` is set.
type Run struct {
	Pos
	ID         string        `yaml:"id"`
	Controller string        `yaml:"controller"`
	Output     int           `yaml:"output"`
	Outputs    []int         `yaml:"outputs"`
	LEDs       *[2]int       `yaml:"leds"`
	Reverse    bool          `yaml:"reverse"` // the path starts at the run's highest LED
	Pitch      *units.Length `yaml:"pitch"`   // overrides the layout pitch
	Path       []string      `yaml:"path"`    // node sequence; may be omitted if the shape labels vertices
	Anchors    []Anchor      `yaml:"anchors"`
	Lengths    []EdgeLength  `yaml:"lengths"` // measured lengths overriding count × pitch
	Plan       *RunPlan      `yaml:"plan"`
	Model      *RunModel     `yaml:"model"`

	// Indices are the run's first and last controller index in run
	// direction. Load derives them from the outputs, then anchors.yaml's
	// ends may move them. Code that builds a Config sets them directly.
	Indices [2]int `yaml:"-"`
	span    *[2]int
}

// Span is the run's configured LEDs as controller indices, lowest first,
// before anchors.yaml's ends move them. Offsets in anchors, dead ranges
// and areas count from its first LED.
func (r *Run) Span() (lo, hi int) {
	if r.span != nil {
		return r.span[0], r.span[1]
	}
	return min(r.Indices[0], r.Indices[1]), max(r.Indices[0], r.Indices[1])
}

// Count is the number of LEDs in the run's configured span.
func (r *Run) Count() int {
	lo, hi := r.Span()
	return hi - lo + 1
}

// Anchor sources.
const (
	SourceMeasured  = "measured"
	SourceEstimated = "estimated"
)

// Anchor says which pixel sits at a node: Offset counts LEDs from the
// run's first LED in data order (its lowest). With no offset, the anchor
// is estimated from the run's plan drawing.
type Anchor struct {
	Pos
	Node   string `yaml:"node"`
	Offset *int   `yaml:"offset"`
	Source string `yaml:"source"` // measured (default when Offset is set) | estimated
	Index  *int   `yaml:"-"`      // controller index, derived from Offset by Load
}

// EdgeLength is a measured physical length for the stretch of a run between
// two consecutive path nodes.
type EdgeLength struct {
	Pos
	From   string       `yaml:"from"`
	To     string       `yaml:"to"`
	Length units.Length `yaml:"length"`
}

// RunPlan points a run at its drawn path: "file.svg#path-id".
type RunPlan struct {
	Pos
	SVG     string `yaml:"svg"`
	Reverse bool   `yaml:"reverse"` // the drawing runs from the last pixel to the first
}

// RunModel points a run at its shape in the scene model:
// "file.glb#run-id", naming the node by its glowstack_run extra.
type RunModel struct {
	Pos
	GLB string `yaml:"glb"`
}

// Edge kinds.
const (
	EdgeStrip = "strip"
	EdgeGap   = "gap"
	EdgeLink  = "link"
)

// Edge is a non-strip edge: a gap (length, no pixels) or a link (ties two
// nodes into one sync point).
type Edge struct {
	Pos
	Kind   string       `yaml:"kind"` // gap | link
	From   string       `yaml:"from"`
	To     string       `yaml:"to"`
	Length units.Length `yaml:"length"`
}

// Dead marks pixels that are physically present but unlit or hidden,
// either on a run, `{run, offsets: [a, b]}` counted like anchor offsets,
// or on an output, `{controller, output, leds: [a, b]}` counted from the
// output's first LED. Both are inclusive.
type Dead struct {
	Pos
	Run        string  `yaml:"run"`
	Offsets    *[2]int `yaml:"offsets"`
	Controller string  `yaml:"controller"`
	Output     int     `yaml:"output"`
	LEDs       *[2]int `yaml:"leds"`
	// Pixels is the run's LED count when calibration found the range
	// (anchors.yaml only); see AnchorOverride.Pixels.
	Pixels int `yaml:"pixels"`

	// Controller indices, derived by Load (Controller is filled in for
	// run ranges). Code that builds a Config sets them directly.
	Indices [2]int `yaml:"-"`
}

// ---- anchors.yaml (data dir) ----

// AnchorsFile is the machine-written anchors.yaml in the data dir: what
// calibration measured. Each section overrides layout.yaml (see
// measured.go).
type AnchorsFile struct {
	Schema  int              `yaml:"schema"`
	Anchors []AnchorOverride `yaml:"anchors"`
	Ends    []EndOverride    `yaml:"ends"` // measured run ends
	Gaps    []GapOverride    `yaml:"gaps"` // measured gap lengths
	Dead    []Dead           `yaml:"dead"` // dead pixels found on site, added to layout.yaml's
}

// AnchorOverride replaces (or adds) the anchor for Node on Run. Offset
// counts like a layout.yaml anchor's.
//
// Pixels is the run's LED count when the anchor was measured. If the run's
// count has changed since, LEDs may have been added or removed before the
// anchor, so Load warns until the anchor is accepted, shifted or cleared
// (see package calibrate).
type AnchorOverride struct {
	Pos
	Run    string `yaml:"run" json:"run"`
	Node   string `yaml:"node" json:"node"`
	Offset int    `yaml:"offset" required:"true" json:"-"`
	Pixels int    `yaml:"pixels" json:"-"`
	Source string `yaml:"source" json:"source"` // default measured
	Index  int    `yaml:"-" json:"index"`       // controller index, derived by Load
}

// EndOverride moves a run's first or last pixel (in run direction) to
// where calibration found the strip actually starts or ends. First and
// Last are offsets like an anchor's; they may fall outside the run's
// configured LEDs. Pixels is as for AnchorOverride.
type EndOverride struct {
	Pos
	Run    string `yaml:"run" json:"run"`
	First  *int   `yaml:"first" json:"-"`
	Last   *int   `yaml:"last" json:"-"`
	Pixels int    `yaml:"pixels" json:"-"`

	// Controller indices, derived by Load.
	FirstIndex *int `yaml:"-" json:"first,omitempty"`
	LastIndex  *int `yaml:"-" json:"last,omitempty"`
}

// GapOverride replaces the length of layout.yaml's gap edge between From
// and To (either way round) with a measured one.
type GapOverride struct {
	Pos
	From   string       `yaml:"from" json:"from"`
	To     string       `yaml:"to" json:"to"`
	Length units.Length `yaml:"length" json:"length"`
}

// ---- areas.yaml ----

// AreasFile is areas.yaml.
type AreasFile struct {
	Schema int    `yaml:"schema"`
	Areas  []Area `yaml:"areas"`
	Zones  []Zone `yaml:"zones"`
}

// Area is a named set of pixels: a union of runs, run sub-ranges and other
// areas.
type Area struct {
	Pos
	ID      string     `yaml:"id"`
	Include []AreaPart `yaml:"include"`
}

// AreaPart is one entry of an area's include list. A bare string is a run
// id. A mapping gives `{run, …}` with a start and an end, or `{area}`.
//
// The start is `from` (inclusive) or `after` (exclusive) and the end is
// `to` (inclusive) or `before` (exclusive), each a node id or a pixel
// index. Either end may be omitted, meaning the run's end. Exclusive ends
// let neighboring areas meet at a node without sharing its pixel:
// `{to: shed-nw}` and `{after: shed-nw}`. "After" and "before" are along
// the walk from the start to the end, so a range written against the run
// direction works too.
type AreaPart struct {
	Pos
	Run    string       `yaml:"run"`
	Area   string       `yaml:"area"`
	From   *NodeOrIndex `yaml:"from"`
	After  *NodeOrIndex `yaml:"after"`
	To     *NodeOrIndex `yaml:"to"`
	Before *NodeOrIndex `yaml:"before"`
}

// Start returns the range's start and whether it's exclusive (after).
func (a *AreaPart) Start() (*NodeOrIndex, bool) {
	if a.After != nil {
		return a.After, true
	}
	return a.From, false
}

// End returns the range's end and whether it's exclusive (before).
func (a *AreaPart) End() (*NodeOrIndex, bool) {
	if a.Before != nil {
		return a.Before, true
	}
	return a.To, false
}

func (a *AreaPart) unmarshalNode(d *decoder, n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		*a = AreaPart{Pos: d.pos(n), Run: n.Value}
		return nil
	}
	type plain AreaPart
	var p plain
	d.decodeStruct(n, reflectValue(&p))
	*a = AreaPart(p)
	return nil
}

// NodeOrIndex is a node id or a run offset (counted from the run's first
// LED in data order, like an anchor's).
type NodeOrIndex struct {
	Node    string
	Index   int
	IsIndex bool
}

func (x *NodeOrIndex) unmarshalNode(_ *decoder, n *yaml.Node) error {
	if n.Kind != yaml.ScalarNode {
		return fmt.Errorf("want a node id or a pixel index")
	}
	if n.Tag == "!!int" {
		i, err := strconv.Atoi(n.Value)
		if err != nil {
			return err
		}
		*x = NodeOrIndex{Index: i, IsIndex: true}
		return nil
	}
	*x = NodeOrIndex{Node: n.Value}
	return nil
}

func (x NodeOrIndex) String() string {
	if x.IsIndex {
		return strconv.Itoa(x.Index)
	}
	return x.Node
}

// Zone is an area Home Assistant sees as one WLED device.
type Zone struct {
	Pos
	ID       string    `yaml:"id"`
	Area     string    `yaml:"area"`
	Device   Device    `yaml:"device"`
	Mapping  string    `yaml:"mapping"` // default mapping for layers on this zone
	Segments []Segment `yaml:"segments"`
}

// Device is a zone's virtual WLED identity. A zone with a device block
// appears to Home Assistant as a WLED device (internal/wled).
type Device struct {
	Pos
	Name string `yaml:"name"` // default: the zone id
	IP   string `yaml:"ip"`   // listen address; "" listens on every address
	MAC  string `yaml:"mac"`  // required; Home Assistant identifies devices by it
	// Port is the HTTP port, default 80. Home Assistant's WLED integration
	// only talks to port 80, so other ports are for development.
	Port int `yaml:"port"`
}

// Present reports whether the zone has a device block.
func (d *Device) Present() bool { return d.Line > 0 || d.MAC != "" }

// Segment exposes an area as a WLED segment of a zone.
type Segment struct {
	Pos
	Area    string `yaml:"area"`
	Mapping string `yaml:"mapping"` // overrides the zone's mapping
}

// ---- mappings.yaml ----

// MappingsFile is mappings.yaml.
type MappingsFile struct {
	Schema   int       `yaml:"schema"`
	Default  string    `yaml:"default"` // global default mapping id; default "local"
	Flows    []Flow    `yaml:"flows"`
	Mappings []Mapping `yaml:"mappings"`
}

// Flow policies.
const (
	PaceReference = "reference"
	PaceLongest   = "longest"
	PaceShortest  = "shortest"
	PaceAverage   = "average"

	WarpLinear = "linear"
	WarpSmooth = "smooth"

	LoopsStretch = "stretch"
	LoopsMeet    = "meet"
	LoopsError   = "error"

	UnreachedLocal = "local"
	UnreachedDark  = "dark"
	UnreachedError = "error"
)

// Flow is a flow mapping: position along the layout graph from an origin.
type Flow struct {
	Pos
	ID         string    `yaml:"id"`
	Origin     string    `yaml:"origin"`
	Orient     []Orient  `yaml:"orient"`
	Pace       string    `yaml:"pace"`      // default reference
	Reference  []EdgeRef `yaml:"reference"` // runs or node pairs that set pace
	Pin        []Pin     `yaml:"pin"`
	Warp       string    `yaml:"warp"`        // default linear
	MaxStretch float64   `yaml:"max_stretch"` // 0 = no limit; applies both ways
	Loops      string    `yaml:"loops"`       // default stretch
	Unreached  string    `yaml:"unreached"`   // default local
	Strict     bool      `yaml:"strict"`      // max_stretch violations fail instead of warn
}

// Orient makes the edge between two nodes flow into one of them.
type Orient struct {
	Pos
	Edge [2]string `yaml:"edge"`
	Into string    `yaml:"into"`
}

// EdgeRef names a run (bare string) or the edge(s) between two nodes
// (a two-element list).
type EdgeRef struct {
	Pos
	Run  string
	From string
	To   string
}

func (e *EdgeRef) unmarshalNode(d *decoder, n *yaml.Node) error {
	e.Pos = d.pos(n)
	switch {
	case n.Kind == yaml.ScalarNode:
		e.Run = n.Value
	case n.Kind == yaml.SequenceNode && len(n.Content) == 2:
		e.From, e.To = n.Content[0].Value, n.Content[1].Value
	default:
		return fmt.Errorf("want a run id or a [from, to] node pair")
	}
	return nil
}

func (e EdgeRef) String() string {
	if e.Run != "" {
		return e.Run
	}
	return "[" + e.From + ", " + e.To + "]"
}

// Pin fixes a node's flow position.
type Pin struct {
	Pos
	Node string       `yaml:"node"`
	U    units.Length `yaml:"u"`
}

// Mapping kinds.
const (
	KindFlow    = "flow"
	KindLocal   = "local"
	KindIndex   = "index"
	KindAxis    = "axis"
	KindRadial  = "radial"
	KindRoute   = "route"
	KindPlan    = "plan"
	KindAngular = "angular"
)

// Mapping is a non-flow mapping.
type Mapping struct {
	Pos
	ID         string        `yaml:"id"`
	Kind       string        `yaml:"kind"`        // local | index | axis | radial | route | plan | angular
	Angle      *units.Angle  `yaml:"angle"`       // axis: horizontal direction, 0 = +x, counter-clockwise seen from above; angular: where u = 0
	Direction  []float64     `yaml:"direction"`   // axis: 3-D direction [x, y, z], Z up; [0, 0, 1] is up
	From       *PointRef     `yaml:"from"`        // axis: u = 0 here (default origin); with To, sets direction
	To         *PointRef     `yaml:"to"`          // axis: direction from From
	Center     *PointRef     `yaml:"center"`      // radial, angular
	Horizontal bool          `yaml:"horizontal"`  // radial: ignore height
	Order      []string      `yaml:"order"`       // index: run order (default: layout order)
	Points     []PointRef    `yaml:"points"`      // route: the path, in order
	Closed     *bool         `yaml:"closed"`      // route: the last point joins the first (default true)
	Snap       *units.Length `yaml:"snap"`        // route: pixels this close are on it (default 0.15 m)
	Spread     *units.Length `yaml:"spread"`      // route: how far it spills onto crossing strips (default 0.5 m)
	Lap        *units.Length `yaml:"lap"`         // route: u covered by the whole path (default its length); angular: u per full turn (default 10 m)
	SpillSpeed *float64      `yaml:"spill_speed"` // route: spill spreads at this × the pattern's speed (default 1)
}

// PointRef is a node id or a point `[x, y]` or `[x, y, z]` in meters. A
// point without z has no height: distances to it are horizontal.
type PointRef struct {
	Pos
	Node    string
	X, Y, Z units.Length
	HasZ    bool
}

func (p *PointRef) unmarshalNode(d *decoder, n *yaml.Node) error {
	p.Pos = d.pos(n)
	switch {
	case n.Kind == yaml.ScalarNode:
		p.Node = n.Value
	case n.Kind == yaml.SequenceNode && (len(n.Content) == 2 || len(n.Content) == 3):
		p.HasZ = len(n.Content) == 3
		for i, dst := range []*units.Length{&p.X, &p.Y, &p.Z}[:len(n.Content)] {
			v := n.Content[i].Value
			if n.Content[i].Tag == "!!int" || n.Content[i].Tag == "!!float" {
				v += " m"
			}
			l, err := units.ParseLength(v)
			if err != nil {
				return err
			}
			if l.PX {
				return fmt.Errorf("points are in meters, not px")
			}
			*dst = l
		}
	default:
		return fmt.Errorf("want a node id or an [x, y] or [x, y, z] point in meters")
	}
	return nil
}

// ---- palettes.yaml ----

// PalettesFile is palettes.yaml.
type PalettesFile struct {
	Schema   int       `yaml:"schema"`
	Palettes []Palette `yaml:"palettes"`
}

// Palette is a user palette.
type Palette struct {
	Pos
	ID          string `yaml:"id"`
	Name        string `yaml:"name"`
	Stops       []Stop `yaml:"stops"`
	Interpolate string `yaml:"interpolate"` // linear (default) | step
	Wrap        *bool  `yaml:"wrap"`        // default true
}

// Stop is a palette stop, written `[position, "#rrggbb"]`.
type Stop struct {
	Pos
	At    float64
	Color units.Color
}

func (s *Stop) unmarshalNode(d *decoder, n *yaml.Node) error {
	s.Pos = d.pos(n)
	if n.Kind != yaml.SequenceNode || len(n.Content) != 2 {
		return fmt.Errorf(`want [position, "#rrggbb"]`)
	}
	at, err := strconv.ParseFloat(n.Content[0].Value, 64)
	if err != nil || at < 0 || at > 1 {
		return fmt.Errorf("stop position must be a number 0–1")
	}
	s.At = at
	return s.Color.UnmarshalText([]byte(n.Content[1].Value))
}

// ---- presets.yaml / presets.saved.yaml ----

// PresetsFile is presets.yaml (config dir) or presets.saved.yaml (data dir).
type PresetsFile struct {
	Hidden     []string        `yaml:"hidden,omitempty" json:"hidden,omitempty"`
	Pins       map[string]bool `yaml:"pins,omitempty" json:"pins,omitempty"`
	Schema     int             `yaml:"schema" json:"schema"`
	Presets    []Preset        `yaml:"presets" json:"presets"`
	Composites []Composite     `yaml:"composites" json:"composites,omitempty"`
	Shows      []Show          `yaml:"shows" json:"shows,omitempty"`
}

// Preset is a saved layer specification without a target. Params holds raw
// values (strings, numbers, bools, lists, maps) exactly as written; they are
// checked against the effect's schema when the preset is used, because
// effects are registered in code, not config. Common layer parameters
// (blend, opacity, mapping, …) may appear in Params too.
type Preset struct {
	Pos    `json:"-"`
	ID     string         `yaml:"id" json:"id"`
	Name   string         `yaml:"name" json:"name,omitempty"`
	Effect string         `yaml:"effect" json:"effect"`
	Params map[string]any `yaml:"params" json:"params,omitempty"`
	Saved  bool           `yaml:"-" json:"-"` // came from presets.saved.yaml
}

// Composite is a named stack of effects sharing one target and mapping,
// presented as a single effect with the id ID. Layers are listed bottom
// first. Its effects (built-in or other composites) and params are checked
// when it's registered, because effects live in code.
type Composite struct {
	Pos    `json:"-"`
	ID     string           `yaml:"id" json:"id"`
	Name   string           `yaml:"name" json:"name,omitempty"`
	Layers []CompositeLayer `yaml:"layers" json:"layers"`
}

// Show is a timed sequence of cues presented as a single effect with the
// id ID: a whole light show as one layer. Each cue is an effect with its
// own mapping and target area, playing from `at` for `for` with fades. Cues
// are listed bottom first, like a composite's layers. The show's clock is
// the layer's age, so a show starts when it's pushed, scrubs in the
// preview and continues across a restart.
type Show struct {
	Pos    `json:"-"`
	ID     string    `yaml:"id" json:"id"`
	Name   string    `yaml:"name" json:"name,omitempty"`
	Length string    `yaml:"length" json:"length,omitempty"` // duration; default: the end of the last cue
	Loop   bool      `yaml:"loop" json:"loop,omitempty"`     // start over at the end instead of holding the last frame
	Cues   []ShowCue `yaml:"cues" json:"cues"`
}

// ShowCue is one cue of a show.
type ShowCue struct {
	Pos     `json:"-"`
	Name    string         `yaml:"name" json:"name,omitempty"`         // parameter prefix; default the effect id
	Effect  string         `yaml:"effect" json:"effect"`               // effect, composite or show id
	At      string         `yaml:"at" json:"at,omitempty"`             // duration from the show's start; default 0 s
	For     string         `yaml:"for" json:"for,omitempty"`           // duration; default: to the end of the show
	FadeIn  string         `yaml:"fade_in" json:"fade_in,omitempty"`   // duration; default 0 s
	FadeOut string         `yaml:"fade_out" json:"fade_out,omitempty"` // duration; default 0 s
	Mapping any            `yaml:"mapping" json:"mapping,omitempty"`   // mapping id or inline mapping; default the layer's
	Target  string         `yaml:"target" json:"target,omitempty"`     // area id; default the layer's target
	Reverse bool           `yaml:"reverse" json:"reverse,omitempty"`   // flip the cue's u
	Blend   string         `yaml:"blend" json:"blend,omitempty"`       // onto the cues below; default over
	Opacity *float64       `yaml:"opacity" json:"opacity,omitempty"`   // default 1
	Params  map[string]any `yaml:"params" json:"params,omitempty"`     // the cue's default params
}

// CompositeLayer is one part of a composite.
type CompositeLayer struct {
	Pos     `json:"-"`
	Name    string         `yaml:"name" json:"name,omitempty"`       // parameter prefix; default the effect id
	Effect  string         `yaml:"effect" json:"effect"`             // effect or composite id
	Blend   string         `yaml:"blend" json:"blend,omitempty"`     // onto the layers below; default over
	Opacity *float64       `yaml:"opacity" json:"opacity,omitempty"` // default 1
	Params  map[string]any `yaml:"params" json:"params,omitempty"`   // the part's default params
}
