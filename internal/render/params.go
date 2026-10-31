// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package render

import (
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/units"
)

// ParamType is a parameter type from design.md "Parameter types".
type ParamType string

const (
	TLength   ParamType = "length"   // "0.5 m", "20 px", "3 ft"; optional " flow"/" physical" suffix
	TSpeed    ParamType = "speed"    // "0.02 m/s", "1 px/8s"; signed
	TDuration ParamType = "duration" // "250 ms", "5 s"
	TRate     ParamType = "rate"     // "2 /s"
	TDensity  ParamType = "density"  // "0.5 /m/s"
	TFraction ParamType = "fraction" // 0–1 or "50%"
	TAngle    ParamType = "angle"    // "90 deg"; a bare number is degrees
	TColor    ParamType = "color"    // "#rrggbb" or "#rrggbb/ww"
	TColors   ParamType = "colors"   // list of color
	TPalette  ParamType = "palette"  // palette id/name or inline stops
	TMapping  ParamType = "mapping"  // mapping id
	TEnum     ParamType = "enum"     // one of Param.Enum
	TBool     ParamType = "bool"
	TSeed     ParamType = "seed"   // non-negative integer
	TInt      ParamType = "int"    // integer, for counts in WLED ports (extension)
	TNumber   ParamType = "number" // plain number (extension)
	TList     ParamType = "list"   // list of struct, fields in Param.Fields
)

// Measure says whether a length follows the flow (stretches with it, stays
// in sync) or stays physical (same size everywhere, drifts against sync
// points). See design.md "Flow versus physical quantities".
type Measure string

const (
	MeasureFlow     Measure = "flow"
	MeasurePhysical Measure = "physical"
)

// Param declares one parameter.
type Param struct {
	Name    string
	Type    ParamType
	Default any // raw value, as it would be written in YAML; nil means unset (common params only)
	Doc     string
	Enum    []string // TEnum
	Min     *float64 // TInt, TNumber: optional bounds
	Max     *float64
	Measure Measure // TLength: default measure (flow if empty)
	Fields  []Param // TList: fields of each element
}

// Length is a resolved length parameter.
type Length struct {
	Metres  float64
	Measure Measure
}

// InU converts the length to flow units at a pixel with the given stretch:
// a flow length is already in u; a physical one shrinks where the flow is
// stretched.
func (l Length) InU(stretch float32) float64 {
	if l.Measure == MeasurePhysical && stretch > 0 {
		return l.Metres / float64(stretch)
	}
	return l.Metres
}

// Env is what resolving parameters needs to know.
type Env struct {
	Pitch    float64           // metres per px for this layer's target
	Palettes *palette.Registry // for palette ids
}

// Values holds a layer's resolved parameter values. Effects read them with
// the typed getters; asking for the wrong type is a programming error and
// panics.
type Values struct {
	params []Param
	raw    map[string]any
	vals   map[string]any
}

// Raw returns the explicitly set raw values (for persistence and the API).
func (v *Values) Raw() map[string]any { return maps.Clone(v.raw) }

// Has reports whether name has a value (set or defaulted).
func (v *Values) Has(name string) bool {
	_, ok := v.vals[name]
	return ok
}

func (v *Values) get(name string, t ParamType) any {
	x, ok := v.vals[name]
	if !ok {
		panic(fmt.Sprintf("render: parameter %q (%s) has no value", name, t))
	}
	return x
}

func getAs[T any](v *Values, name string, t ParamType) T {
	x, ok := v.get(name, t).(T)
	if !ok {
		panic(fmt.Sprintf("render: parameter %q is not a %s", name, t))
	}
	return x
}

// Length returns a length parameter in metres with its measure.
func (v *Values) Length(name string) Length { return getAs[Length](v, name, TLength) }

// Speed returns a speed in metres (of u) per second; negative is reverse.
func (v *Values) Speed(name string) float64 { return getAs[float64](v, name, TSpeed) }

// Duration returns a duration in seconds.
func (v *Values) Duration(name string) float64 { return getAs[float64](v, name, TDuration) }

// Rate returns events per second.
func (v *Values) Rate(name string) float64 { return getAs[float64](v, name, TRate) }

// Density returns events per metre per second.
func (v *Values) Density(name string) float64 { return getAs[float64](v, name, TDensity) }

// Fraction returns a value in 0–1.
func (v *Values) Fraction(name string) float64 { return getAs[float64](v, name, TFraction) }

// Angle returns radians.
func (v *Values) Angle(name string) float64 { return getAs[float64](v, name, TAngle) }

// Color returns a linear-light colour.
func (v *Values) Color(name string) color.Color { return getAs[color.Color](v, name, TColor) }

// Colors returns linear-light colours.
func (v *Values) Colors(name string) []color.Color { return getAs[[]color.Color](v, name, TColors) }

// Palette returns a palette.
func (v *Values) Palette(name string) *palette.Palette {
	return getAs[*palette.Palette](v, name, TPalette)
}

// Mapping returns a mapping id ("" for the default).
func (v *Values) Mapping(name string) string { return getAs[string](v, name, TMapping) }

// Enum returns the chosen enum value.
func (v *Values) Enum(name string) string { return getAs[string](v, name, TEnum) }

// Bool returns a bool.
func (v *Values) Bool(name string) bool { return getAs[bool](v, name, TBool) }

// Seed returns a seed.
func (v *Values) Seed(name string) uint64 { return getAs[uint64](v, name, TSeed) }

// Int returns an integer.
func (v *Values) Int(name string) int { return getAs[int](v, name, TInt) }

// Number returns a number.
func (v *Values) Number(name string) float64 { return getAs[float64](v, name, TNumber) }

// List returns the elements of a list-of-struct parameter.
func (v *Values) List(name string) []*Values { return getAs[[]*Values](v, name, TList) }

// checkSchema validates parameter declarations. Effect params must all
// have defaults; requireDefaults is false for the common params.
func checkSchema(params []Param, requireDefaults bool) error {
	seen := map[string]bool{}
	for _, p := range params {
		if p.Name == "" {
			return fmt.Errorf("parameter with no name")
		}
		if seen[p.Name] {
			return fmt.Errorf("parameter %q declared twice", p.Name)
		}
		seen[p.Name] = true
		switch p.Type {
		case TLength, TSpeed, TDuration, TRate, TDensity, TFraction, TAngle, TColor, TColors,
			TPalette, TMapping, TBool, TSeed, TInt, TNumber:
		case TEnum:
			if len(p.Enum) == 0 {
				return fmt.Errorf("enum parameter %q has no values", p.Name)
			}
		case TList:
			if err := checkSchema(p.Fields, requireDefaults); err != nil {
				return fmt.Errorf("%s: %w", p.Name, err)
			}
		default:
			return fmt.Errorf("parameter %q: unknown type %q", p.Name, p.Type)
		}
		if p.Default == nil {
			if requireDefaults {
				return fmt.Errorf("parameter %q has no default (every effect parameter needs one)", p.Name)
			}
			continue
		}
		// Palettes can't be checked without a registry; the rest can.
		if p.Type != TPalette {
			if _, err := resolveOne(p, p.Default, Env{Pitch: 1}); err != nil {
				return fmt.Errorf("parameter %q: bad default: %w", p.Name, err)
			}
		}
	}
	return nil
}

// Resolve checks raw values against params and fills defaults. Unknown
// names are errors.
func Resolve(params []Param, raw map[string]any, env Env) (*Values, error) {
	v := &Values{params: params, raw: maps.Clone(raw), vals: map[string]any{}}
	if v.raw == nil {
		v.raw = map[string]any{}
	}
	for name := range raw {
		if !slices.ContainsFunc(params, func(p Param) bool { return p.Name == name }) {
			return nil, fmt.Errorf("unknown parameter %q", name)
		}
	}
	for _, p := range params {
		x, set := raw[p.Name]
		if !set || x == nil {
			x = p.Default
		}
		if x == nil {
			continue
		}
		val, err := resolveOne(p, x, env)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p.Name, err)
		}
		v.vals[p.Name] = val
	}
	return v, nil
}

func resolveOne(p Param, x any, env Env) (any, error) {
	switch p.Type {
	case TLength:
		return parseLength(x, p.Measure, env.Pitch)
	case TSpeed:
		s, err := quantity(x, units.ParseSpeed)
		return s.MetresPerSecond(env.Pitch), err
	case TDuration:
		d, err := quantity(x, units.ParseDuration)
		return d.Seconds(), err
	case TRate:
		r, err := quantity(x, units.ParseRate)
		return float64(r), err
	case TDensity:
		d, err := quantity(x, units.ParseDensity)
		return d.PerMetreSecond(env.Pitch), err
	case TFraction:
		if n, ok := number(x); ok {
			if n < 0 || n > 1 {
				return nil, fmt.Errorf("%v is outside 0–1", n)
			}
			return n, nil
		}
		f, err := quantity(x, units.ParseFraction)
		return float64(f), err
	case TAngle:
		if n, ok := number(x); ok {
			return n * math.Pi / 180, nil
		}
		a, err := quantity(x, units.ParseAngle)
		return float64(a), err
	case TColor:
		c, err := quantity(x, units.ParseColor)
		return color.Linear(c), err
	case TColors:
		list, ok := x.([]any)
		if !ok {
			return nil, fmt.Errorf("want a list of colours")
		}
		cs := make([]color.Color, len(list))
		for i, e := range list {
			c, err := quantity(e, units.ParseColor)
			if err != nil {
				return nil, err
			}
			cs[i] = color.Linear(c)
		}
		return cs, nil
	case TPalette:
		if env.Palettes == nil {
			return nil, fmt.Errorf("no palettes available")
		}
		return env.Palettes.Parse(x)
	case TMapping, TEnum:
		s, ok := x.(string)
		if !ok {
			return nil, fmt.Errorf("want a string")
		}
		if p.Type == TEnum && !slices.Contains(p.Enum, s) {
			return nil, fmt.Errorf("%q: want one of %v", s, p.Enum)
		}
		return s, nil
	case TBool:
		b, ok := x.(bool)
		if !ok {
			return nil, fmt.Errorf("want true or false")
		}
		return b, nil
	case TSeed:
		n, ok := number(x)
		if s, isStr := x.(string); isStr {
			u, err := strconv.ParseUint(s, 10, 64)
			return u, err
		}
		if !ok || n < 0 || n != math.Trunc(n) {
			return nil, fmt.Errorf("want a non-negative integer")
		}
		return uint64(n), nil
	case TInt, TNumber:
		n, ok := number(x)
		if !ok {
			return nil, fmt.Errorf("want a number")
		}
		if p.Min != nil && n < *p.Min || p.Max != nil && n > *p.Max {
			return nil, fmt.Errorf("%v is out of range", n)
		}
		if p.Type == TInt {
			if n != math.Trunc(n) {
				return nil, fmt.Errorf("want an integer")
			}
			return int(n), nil
		}
		return n, nil
	case TList:
		list, ok := x.([]any)
		if !ok {
			return nil, fmt.Errorf("want a list")
		}
		out := make([]*Values, len(list))
		for i, e := range list {
			m, ok := e.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("element %d: want a mapping", i)
			}
			v, err := Resolve(p.Fields, m, env)
			if err != nil {
				return nil, fmt.Errorf("element %d: %w", i, err)
			}
			out[i] = v
		}
		return out, nil
	}
	return nil, fmt.Errorf("unknown type %q", p.Type)
}

// quantity parses a string (or a bare 0) with parse.
func quantity[T any](x any, parse func(string) (T, error)) (T, error) {
	switch v := x.(type) {
	case string:
		return parse(v)
	default:
		if n, ok := number(x); ok && n == 0 {
			return parse("0")
		}
		var zero T
		return zero, fmt.Errorf("want a string with a unit, e.g. \"0.5 m\"")
	}
}

func parseLength(x any, dflt Measure, pitch float64) (Length, error) {
	measure := dflt
	if measure == "" {
		measure = MeasureFlow
	}
	if m, ok := x.(map[string]any); ok {
		if ms, ok := m["measure"].(string); ok {
			measure = Measure(ms)
		}
		x = m["value"]
	}
	if s, ok := x.(string); ok {
		for _, suffix := range []Measure{MeasureFlow, MeasurePhysical} {
			if rest, cut := strings.CutSuffix(s, " "+string(suffix)); cut {
				s, measure = rest, suffix
			}
		}
		x = s
	}
	if measure != MeasureFlow && measure != MeasurePhysical {
		return Length{}, fmt.Errorf("measure %q: want flow or physical", measure)
	}
	l, err := quantity(x, units.ParseLength)
	return Length{Metres: l.Metres(pitch), Measure: measure}, err
}

func number(x any) (float64, bool) {
	switch n := x.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint64:
		return float64(n), true
	}
	return 0, false
}
