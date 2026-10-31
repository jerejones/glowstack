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
	ID        string   `yaml:"id"`
	Host      string   `yaml:"host"`
	Transport string   `yaml:"transport"` // ddp (default)
	Port      int      `yaml:"port"`      // default 4048
	Pixels    int      `yaml:"pixels"`
	Channels  string   `yaml:"channels"` // rgb (default) | rgbw
	MaxFPS    float64  `yaml:"max_fps"`
	Outputs   []Output `yaml:"outputs"`
	Power     *Power   `yaml:"power"`
	White     string   `yaml:"white"` // explicit (default) | auto
}

// Output is one data pin: a contiguous index range.
type Output struct {
	Pos
	Pin   int     `yaml:"pin"`
	Start int     `yaml:"start"`
	Count int     `yaml:"count"`
	MaxMA float64 `yaml:"max_ma"` // 0 = unlimited
}

// Power is a controller's supply limit and per-LED current figures.
type Power struct {
	Pos
	MaxMA float64 `yaml:"max_ma"` // controller total; 0 = unlimited
	LedMA LedMA   `yaml:"led_ma"`
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
	Pitch units.Length `yaml:"pitch"` // default pitch; required, metres
	Plans []Plan       `yaml:"plans"`
	Nodes []Node       `yaml:"nodes"`
	Runs  []Run        `yaml:"runs"`
	Edges []Edge       `yaml:"edges"`
	Dead  []Dead       `yaml:"dead"`
}

// Plan declares a plan SVG and, optionally, its scale. Runs may also name
// SVGs that aren't declared here; their scale is then unknown.
type Plan struct {
	Pos
	SVG   string        `yaml:"svg"`   // path relative to the config dir
	Scale *units.Length `yaml:"scale"` // metres per plan unit
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
type Run struct {
	Pos
	ID         string        `yaml:"id"`
	Controller string        `yaml:"controller"`
	Indices    [2]int        `yaml:"indices"` // inclusive; order = direction along path
	Pitch      *units.Length `yaml:"pitch"`   // overrides the layout pitch
	Path       []string      `yaml:"path"`    // node sequence; may be omitted if Plan labels vertices
	Anchors    []Anchor      `yaml:"anchors"`
	Lengths    []EdgeLength  `yaml:"lengths"` // measured lengths overriding count × pitch
	Plan       *RunPlan      `yaml:"plan"`
}

// Anchor sources.
const (
	SourceMeasured  = "measured"
	SourceEstimated = "estimated"
)

// Anchor says which pixel sits at a node. With no Index, the anchor is
// estimated from the run's plan drawing.
type Anchor struct {
	Pos
	Node   string `yaml:"node"`
	Index  *int   `yaml:"index"`
	Source string `yaml:"source"` // measured (default when Index is set) | estimated
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

// Dead marks pixels that are physically present but unlit or hidden.
type Dead struct {
	Pos
	Controller string `yaml:"controller"`
	Indices    [2]int `yaml:"indices"` // inclusive
}

// ---- anchors.yaml (data dir) ----

// AnchorsFile is the machine-written anchors.yaml in the data dir.
type AnchorsFile struct {
	Schema  int              `yaml:"schema"`
	Anchors []AnchorOverride `yaml:"anchors"`
}

// AnchorOverride replaces (or adds) the anchor for Node on Run.
type AnchorOverride struct {
	Pos
	Run    string `yaml:"run" json:"run"`
	Node   string `yaml:"node" json:"node"`
	Index  int    `yaml:"index" json:"index"`
	Source string `yaml:"source" json:"source"` // default measured
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
// id. A mapping gives `{run, from, to}` (from/to are node ids or pixel
// indices, inclusive, either may be omitted) or `{area}`.
type AreaPart struct {
	Pos
	Run  string       `yaml:"run"`
	Area string       `yaml:"area"`
	From *NodeOrIndex `yaml:"from"`
	To   *NodeOrIndex `yaml:"to"`
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

// NodeOrIndex is a node id or a controller pixel index.
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

// Device is a zone's virtual WLED identity.
type Device struct {
	Pos
	Name string `yaml:"name"`
	IP   string `yaml:"ip"`
	MAC  string `yaml:"mac"`
}

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
	KindFlow   = "flow"
	KindLocal  = "local"
	KindIndex  = "index"
	KindAxis   = "axis"
	KindRadial = "radial"
	KindPlan   = "plan"
)

// Mapping is a non-flow mapping.
type Mapping struct {
	Pos
	ID     string       `yaml:"id"`
	Kind   string       `yaml:"kind"`   // local | index | axis | radial | plan
	Angle  *units.Angle `yaml:"angle"`  // axis: direction, 0 = +x, counter-clockwise on the plan as drawn
	From   *PointRef    `yaml:"from"`   // axis: u = 0 here (default plan origin); with To, sets direction
	To     *PointRef    `yaml:"to"`     // axis: direction from From
	Center *PointRef    `yaml:"center"` // radial
	Order  []string     `yaml:"order"`  // index: run order (default: layout order)
}

// PointRef is a node id or a plan point `[x, y]` in metres.
type PointRef struct {
	Pos
	Node string
	X, Y units.Length
}

func (p *PointRef) unmarshalNode(d *decoder, n *yaml.Node) error {
	p.Pos = d.pos(n)
	switch {
	case n.Kind == yaml.ScalarNode:
		p.Node = n.Value
	case n.Kind == yaml.SequenceNode && len(n.Content) == 2:
		for i, dst := range []*units.Length{&p.X, &p.Y} {
			v := n.Content[i].Value
			if n.Content[i].Tag == "!!int" || n.Content[i].Tag == "!!float" {
				v += " m"
			}
			l, err := units.ParseLength(v)
			if err != nil {
				return err
			}
			if l.PX {
				return fmt.Errorf("plan points are in metres, not px")
			}
			*dst = l
		}
	default:
		return fmt.Errorf("want a node id or an [x, y] point in metres")
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
	Schema     int         `yaml:"schema" json:"schema"`
	Presets    []Preset    `yaml:"presets" json:"presets"`
	Composites []Composite `yaml:"composites" json:"composites,omitempty"`
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

// CompositeLayer is one part of a composite.
type CompositeLayer struct {
	Pos     `json:"-"`
	Name    string         `yaml:"name" json:"name,omitempty"`       // parameter prefix; default the effect id
	Effect  string         `yaml:"effect" json:"effect"`             // effect or composite id
	Blend   string         `yaml:"blend" json:"blend,omitempty"`     // onto the layers below; default over
	Opacity *float64       `yaml:"opacity" json:"opacity,omitempty"` // default 1
	Params  map[string]any `yaml:"params" json:"params,omitempty"`   // the part's default params
}
