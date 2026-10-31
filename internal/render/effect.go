// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package render holds the renderer's core types: the frame buffer, the
// Effect interface and registry with its typed parameter schema, resolved
// layers, and the compositor that evaluates the stack into the buffer.
//
// # Writing an effect
//
// An effect is a Def registered under a stable id. Each frame its Render
// method is asked for the colours of some target pixels, given their
// coordinates in the layer's mapping (Context.U, already reversed and
// offset), plan positions, physical size and stretch, the shared frame
// time and its parameter values. It writes one linear-light colour with
// alpha per pixel into out. Alpha below 1 lets lower layers show through.
//
// Effects should be functions of (coordinate, time, params, seed) wherever
// possible. Stateless effects may be called with any subset of their target
// (pixels already covered by layers above are skipped), so they must not
// assume they see every pixel or that Pixels is the same from frame to
// frame. Stateful effects (Def.Stateful) always get their full target in
// the same order, and keep their state in the Effect value: New is called
// once per layer, and the value survives parameter edits.
//
// Randomness must be hashed from (seed, global pixel id, time slot), never
// drawn from a stateful generator, so the house and the preview agree.
package render

import (
	"fmt"
	"slices"

	"github.com/jerejones/glowstack/internal/color"
)

// Coords says which coordinates an effect reads.
type Coords uint8

const (
	CoordU     Coords = 1 << iota // Context.U from the layer's mapping
	CoordXY                       // Context.X, Context.Y plan positions
	CoordIndex                    // Context.Index/Count (WLED-exact effects; use with the index mapping)
)

// Effect renders one layer. Implementations hold per-layer state, if any.
type Effect interface {
	Render(ctx *Context, out []color.Color)
}

// Func adapts a function to a stateless Effect.
type Func func(ctx *Context, out []color.Color)

// Render implements Effect.
func (f Func) Render(ctx *Context, out []color.Color) { f(ctx, out) }

// Def declares an effect.
type Def struct {
	ID       string // stable id, e.g. "bands"
	Name     string // display name, e.g. "Bands"
	Coords   Coords
	Params   []Param
	Stateful bool
	WLED     *WLED // optional WLED fx binding
	// New returns the Effect for one layer.
	New func() Effect
	// CoordsFor optionally refines Coords from a layer's parameters, for
	// effects that read u or x,y depending on a parameter (noise). nil
	// means Coords.
	CoordsFor func(*Values) Coords
	// Internal effects (calibration's) can be used by id but aren't listed
	// by Registry.All, so catalogs, the map and WLED's effect list leave
	// them out.
	Internal bool
}

// CoordsOf returns the coordinates a layer of this effect with params v
// reads.
func (d *Def) CoordsOf(v *Values) Coords {
	if d.CoordsFor != nil && v != nil {
		return d.CoordsFor(v)
	}
	return d.Coords
}

// Context is everything an effect gets for one frame. The per-pixel slices
// are aligned with Pixels and must not be modified or retained.
type Context struct {
	T      float64 // frame time: seconds since the Unix epoch, shared by all layers
	LayerT float64 // seconds since the layer was created
	Dt     float64 // seconds since the previous frame
	Frame  uint64  // frame sequence number
	Seed   uint64  // the layer's seed
	Params *Values
	Pitch  float64 // metres per px for this layer (already applied to px parameters)
	Smooth bool    // sub-pixel rendering wanted (common param `smooth`)

	Pixels  []int32   // global pixel ids to render
	U       []float32 // mapping coordinate (reverse and offset applied); metres, or 0–1 for index
	X, Y    []float32 // plan position, metres (NaN if unknown); only with CoordXY
	Dl      []float32 // physical size of each pixel, metres
	Stretch []float32 // dl/du: >1 where the flow is stretched
	Index   []int32   // rank in the layer's full target, in mapping order
	Count   int       // size of the layer's full target
}

// Len returns the number of pixels to render.
func (c *Context) Len() int { return len(c.Pixels) }

// WLED binds an effect to a WLED fx id and maps WLED's sliders onto its
// physical parameters. The physical value is canonical; sliders are a view.
type WLED struct {
	FX       int
	Name     string // WLED's effect name, for /json/eff
	Bindings []Binding
}

// Slider names a WLED control.
type Slider string

const (
	SliderSpeed     Slider = "sx"
	SliderIntensity Slider = "ix"
	SliderC1        Slider = "c1"
	SliderC2        Slider = "c2"
	SliderC3        Slider = "c3"
	SliderO1        Slider = "o1"
	SliderO2        Slider = "o2"
	SliderO3        Slider = "o3"
	SliderPalette   Slider = "pal"
	SliderColor0    Slider = "col0"
	SliderColor1    Slider = "col1"
	SliderColor2    Slider = "col2"
)

// Curve shapes a slider binding.
type Curve string

const (
	CurveLinear Curve = "linear"
	CurveExp    Curve = "exp" // fine control at the low end; see Curve.Value
	CurveLog    Curve = "log" // fine control at the high end
)

// Binding maps one WLED control to a parameter. For sliders, Min and Max
// are the raw parameter values at 0 and 255 (e.g. "0 m/s", "2 m/s"). For
// colours and palettes they're unused. See SetWLED and GetWLED.
type Binding struct {
	Slider Slider
	// Param is a parameter path: a name ("speed"), dotted for composites
	// ("sparkle.density"), then an element index for colors and list
	// parameters and a field for list elements ("colors.0",
	// "bands.1.width").
	Param string
	Curve Curve
	Min   any
	Max   any
}

// Common parameters every layer takes, whatever its effect.
const (
	ParamMapping    = "mapping"
	ParamReverse    = "reverse"
	ParamOffset     = "offset"
	ParamBrightness = "brightness"
	ParamOpacity    = "opacity"
	ParamBlend      = "blend"
	ParamWhite      = "white"
	ParamSmooth     = "smooth"
	ParamFadeIn     = "fade_in"
	ParamFadeOut    = "fade_out"
)

// Blend modes.
const (
	BlendReplace  = "replace"
	BlendOver     = "over"
	BlendAdd      = "add"
	BlendMax      = "max"
	BlendMultiply = "multiply"
)

// White modes.
const (
	WhiteExplicit = "explicit"
	WhiteNone     = "none"
	WhiteBrighter = "brighter"
	WhiteAccurate = "accurate"
)

// CommonParams is the schema of the common parameters. fade_in and
// fade_out default to the config's fade settings, so they have no default
// here.
var CommonParams = []Param{
	{Name: ParamMapping, Type: TMapping, Default: "", Doc: "which coordinates to use; default the zone's mapping"},
	{Name: ParamReverse, Type: TBool, Default: false, Doc: "flip direction"},
	{Name: ParamOffset, Type: TLength, Default: "0", Doc: "shift along u"},
	{Name: ParamBrightness, Type: TFraction, Default: 1.0, Doc: "layer brightness"},
	{Name: ParamOpacity, Type: TFraction, Default: 1.0, Doc: "blend amount"},
	{Name: ParamBlend, Type: TEnum, Default: BlendOver, Enum: []string{BlendReplace, BlendOver, BlendAdd, BlendMax, BlendMultiply}},
	{Name: ParamWhite, Type: TEnum, Default: WhiteExplicit, Enum: []string{WhiteExplicit, WhiteNone, WhiteBrighter, WhiteAccurate}},
	{Name: ParamSmooth, Type: TBool, Default: true, Doc: "sub-pixel rendering for slow motion"},
	{Name: ParamFadeIn, Type: TDuration, Doc: "fade-in time; default from glowstack.yaml"},
	{Name: ParamFadeOut, Type: TDuration, Doc: "fade-out time; default from glowstack.yaml"},
}

// IsCommon reports whether name is a common parameter.
func IsCommon(name string) bool {
	return slices.ContainsFunc(CommonParams, func(p Param) bool { return p.Name == name })
}

// SplitParams separates a layer's raw params into common and effect ones.
func SplitParams(raw map[string]any) (common, effect map[string]any) {
	common, effect = map[string]any{}, map[string]any{}
	for k, v := range raw {
		if IsCommon(k) {
			common[k] = v
		} else {
			effect[k] = v
		}
	}
	return common, effect
}

// Registry holds effect definitions.
type Registry struct {
	defs []*Def
	byID map[string]*Def
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{byID: map[string]*Def{}} }

// Register adds an effect after checking its definition.
func (r *Registry) Register(d *Def) error {
	if d.ID == "" || d.New == nil {
		return fmt.Errorf("effect %q: needs an id and New", d.ID)
	}
	if _, dup := r.byID[d.ID]; dup {
		return fmt.Errorf("effect %q registered twice", d.ID)
	}
	if err := checkSchema(d.Params, true); err != nil {
		return fmt.Errorf("effect %q: %w", d.ID, err)
	}
	for _, p := range d.Params {
		if IsCommon(p.Name) {
			return fmt.Errorf("effect %q: parameter %q is a common layer parameter", d.ID, p.Name)
		}
	}
	if d.WLED != nil {
		if other, ok := r.ByWLED(d.WLED.FX); ok {
			return fmt.Errorf("effect %q: WLED fx %d already bound to %q", d.ID, d.WLED.FX, other.ID)
		}
	}
	if d.Name == "" {
		d.Name = d.ID
	}
	r.defs = append(r.defs, d)
	r.byID[d.ID] = d
	return nil
}

// MustRegister is Register that panics, for init-time registration.
func (r *Registry) MustRegister(d *Def) {
	if err := r.Register(d); err != nil {
		panic(err)
	}
}

// Get returns the effect with the given id.
func (r *Registry) Get(id string) (*Def, bool) {
	d, ok := r.byID[id]
	return d, ok
}

// ByWLED returns the effect bound to a WLED fx id.
func (r *Registry) ByWLED(fx int) (*Def, bool) {
	for _, d := range r.defs {
		if d.WLED != nil && d.WLED.FX == fx {
			return d, true
		}
	}
	return nil, false
}

// All lists the effects that aren't Internal, in registration order.
func (r *Registry) All() []*Def {
	return slices.DeleteFunc(slices.Clone(r.defs), func(d *Def) bool { return d.Internal })
}

func init() {
	if err := checkSchema(CommonParams, false); err != nil {
		panic(err)
	}
}
