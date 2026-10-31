// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package render

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/palette"
	"github.com/jerejones/glowstack/internal/units"
)

// curveK sets how strongly exp and log curves bend: with 4, the top
// slider step changes the value e⁴ ≈ 55 times as much as the bottom one.
const curveK = 4.0

// Value maps a slider position x (0–1) to a position y (0–1) between a
// binding's Min and Max:
//
//	linear: y = x
//	exp:    y = (e^(kx) − 1) / (e^k − 1)   fine control near Min
//	log:    the inverse of exp             fine control near Max
//
// exp and log reach Min exactly, so a binding like "0 → 0 m/s" works.
func (c Curve) Value(x float64) float64 {
	x = clamp01(x)
	switch c {
	case CurveExp:
		return math.Expm1(curveK*x) / math.Expm1(curveK)
	case CurveLog:
		return math.Log1p(x*math.Expm1(curveK)) / curveK
	}
	return x
}

// Slider is the inverse of Value.
func (c Curve) Slider(y float64) float64 {
	y = clamp01(y)
	switch c {
	case CurveExp:
		return CurveLog.Value(y)
	case CurveLog:
		return CurveExp.Value(y)
	}
	return y
}

func clamp01(x float64) float64 { return math.Max(0, math.Min(1, x)) }

// Bindings returns d's bindings for a WLED control.
func (d *Def) Bindings(s Slider) []Binding {
	if d.WLED == nil {
		return nil
	}
	var out []Binding
	for _, b := range d.WLED.Bindings {
		if b.Slider == s {
			out = append(out, b)
		}
	}
	return out
}

// SetWLED applies a WLED control value to a layer's raw parameters,
// returning a new map (raw is not changed). value is:
//
//   - sx, ix, c1–c3: an int 0–255, mapped through each binding's curve
//   - o1–o3: a bool
//   - col0–col2: a units.Color
//   - pal: an int WLED palette id, looked up in env.Palettes
//
// A control with no binding is ignored. Lengths keep a "physical"
// measure and speeds keep their sign from the current raw value: a
// slider sets the size, not the direction.
func (d *Def) SetWLED(raw map[string]any, s Slider, value any, env Env) (map[string]any, error) {
	for _, b := range d.Bindings(s) {
		pp, err := lookupPath(d.Params, b.Param)
		if err != nil {
			return raw, fmt.Errorf("effect %s: binding %s: %w", d.ID, s, err)
		}
		old, _ := rawAt(raw, pp)
		val, err := b.rawValue(pp.leaf, value, old, env)
		if err != nil {
			return raw, fmt.Errorf("effect %s: %s: %w", d.ID, s, err)
		}
		raw = setRaw(raw, pp, val)
	}
	return raw, nil
}

// GetWLED reports a layer's parameter value as a WLED control value, in
// the same types SetWLED takes. Values outside a binding's range are
// clamped. ok is false when nothing is bound to s.
func (d *Def) GetWLED(v *Values, s Slider, env Env) (value any, ok bool, err error) {
	bs := d.Bindings(s)
	if len(bs) == 0 {
		return nil, false, nil
	}
	b := bs[0]
	pp, err := lookupPath(d.Params, b.Param)
	if err != nil {
		return nil, false, err
	}
	x, have := v.resolvedAt(pp)
	if !have {
		return nil, false, fmt.Errorf("effect %s: no value for %s", d.ID, b.Param)
	}
	switch s {
	case SliderColor0, SliderColor1, SliderColor2:
		c, isColor := x.(color.Color)
		if !isColor {
			return nil, false, fmt.Errorf("effect %s: %s is not a colour", d.ID, b.Param)
		}
		return c.Authored(), true, nil
	case SliderPalette:
		p, isPal := x.(*palette.Palette)
		if !isPal {
			return nil, false, fmt.Errorf("effect %s: %s is not a palette", d.ID, b.Param)
		}
		return p.WLED, true, nil
	case SliderO1, SliderO2, SliderO3:
		if bv, isBool := x.(bool); isBool {
			return bv, true, nil
		}
		f, _ := scalar(x)
		lo, hi, err := b.bounds(pp.leaf, env)
		return err == nil && math.Abs(f-hi) < math.Abs(f-lo), err == nil, err
	}
	pos, err := b.slider(pp.leaf, x, env)
	return pos, err == nil, err
}

// rawValue turns a WLED control value into a raw parameter value.
func (b Binding) rawValue(leaf Param, value, old any, env Env) (any, error) {
	switch v := value.(type) {
	case units.Color:
		return v.String(), nil
	case bool:
		if leaf.Type == TBool {
			return v, nil
		}
		pos := 0
		if v {
			pos = 255
		}
		return b.rawValue(leaf, pos, old, env)
	case int:
		if b.Slider == SliderPalette {
			if env.Palettes == nil {
				return nil, fmt.Errorf("no palettes")
			}
			p, ok := env.Palettes.ByWLED(v)
			if !ok {
				return nil, fmt.Errorf("no palette with WLED id %d", v)
			}
			return p.ID, nil
		}
		x := float64(max(0, min(255, v))) / 255
		switch leaf.Type {
		case TBool:
			return v >= 128, nil
		case TEnum:
			return leaf.Enum[min(len(leaf.Enum)-1, int(x*float64(len(leaf.Enum))))], nil
		}
		lo, hi, err := b.bounds(leaf, env)
		if err != nil {
			return nil, err
		}
		return formatRaw(leaf.Type, lo+(hi-lo)*b.curve().Value(x), old), nil
	}
	return nil, fmt.Errorf("unsupported value %T", value)
}

// slider turns a resolved parameter value into a slider position.
func (b Binding) slider(leaf Param, x any, env Env) (int, error) {
	switch leaf.Type {
	case TBool:
		if v, _ := x.(bool); v {
			return 255, nil
		}
		return 0, nil
	case TEnum:
		s, _ := x.(string)
		for i, e := range leaf.Enum {
			if e == s {
				return int(math.Round((float64(i) + 0.5) / float64(len(leaf.Enum)) * 255)), nil
			}
		}
		return 0, nil
	}
	f, ok := scalar(x)
	if !ok {
		return 0, fmt.Errorf("%s: can't show a %s on a slider", b.Param, leaf.Type)
	}
	if leaf.Type == TSpeed {
		f = math.Abs(f)
	}
	lo, hi, err := b.bounds(leaf, env)
	if err != nil {
		return 0, err
	}
	if hi == lo {
		return 0, nil
	}
	return int(math.Round(b.curve().Slider((f-lo)/(hi-lo)) * 255)), nil
}

func (b Binding) curve() Curve {
	if b.Curve == "" {
		return CurveLinear
	}
	return b.Curve
}

// bounds resolves Min and Max to SI numbers.
func (b Binding) bounds(leaf Param, env Env) (lo, hi float64, err error) {
	for i, raw := range []any{b.Min, b.Max} {
		if raw == nil {
			return 0, 0, fmt.Errorf("binding %s → %s needs min and max", b.Slider, b.Param)
		}
		leaf.Min, leaf.Max = nil, nil
		x, err := resolveOne(leaf, raw, env)
		if err != nil {
			return 0, 0, fmt.Errorf("binding %s → %s: %w", b.Slider, b.Param, err)
		}
		f, ok := scalar(x)
		if !ok {
			return 0, 0, fmt.Errorf("binding %s → %s: a %s can't be a slider", b.Slider, b.Param, leaf.Type)
		}
		if i == 0 {
			lo = f
		} else {
			hi = f
		}
	}
	return lo, hi, nil
}

// scalar extracts the number from a resolved value.
func scalar(x any) (float64, bool) {
	switch v := x.(type) {
	case Length:
		return v.Metres, true
	case float64:
		return v, true
	case int:
		return float64(v), true
	case uint64:
		return float64(v), true
	}
	return 0, false
}

// formatRaw writes an SI value as a raw parameter value of type t. old is
// the current raw value: lengths keep its measure suffix, speeds its sign.
func formatRaw(t ParamType, v float64, old any) any {
	num := func(x float64) string { return strconv.FormatFloat(x, 'f', -1, 64) }
	oldStr, _ := old.(string)
	switch t {
	case TLength:
		s := num(v) + " m"
		physical := strings.HasSuffix(oldStr, " "+string(MeasurePhysical))
		if m, ok := old.(map[string]any); ok {
			// Lengths also accept {value, measure}; retain that measure
			// just as for the equivalent string suffix.
			physical = m["measure"] == string(MeasurePhysical)
			if value, ok := m["value"].(string); ok {
				physical = physical || strings.HasSuffix(value, " "+string(MeasurePhysical))
				if strings.HasSuffix(value, " "+string(MeasureFlow)) {
					physical = false
				}
			}
		}
		if physical {
			s += " " + string(MeasurePhysical)
		}
		return s
	case TSpeed:
		if strings.HasPrefix(strings.TrimSpace(oldStr), "-") {
			v = -v
		}
		return num(v) + " m/s"
	case TDuration:
		return num(v) + " s"
	case TRate:
		return num(v) + " /s"
	case TDensity:
		return num(v) + " /m/s"
	case TAngle:
		return v * 180 / math.Pi
	case TInt, TSeed:
		return int(math.Round(v))
	}
	return v // fraction, number
}
