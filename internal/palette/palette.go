// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package palette holds named colour gradients: built-ins (WLED's palettes,
// under their WLED ids and names) and user palettes from palettes.yaml.
//
// # WLED palettes
//
// Builtins holds WLED's 73 fixed palettes under their WLED ids (0–72) and
// names, so Home Assistant's palette list matches a real WLED device. Ids
// are slugs of the names ("Red & Blue" is "red-blue"); lookups also accept
// the name, case-insensitively. User palettes get WLED ids from 200
// downward, WLED's numbering for custom palettes; a user palette that
// replaces a built-in keeps the built-in's id.
//
// Palettes 0–5 are special: they have no colours of their own and are
// resolved per layer with Resolve. See Special.
package palette

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"

	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/units"
)

// Stop is a palette stop.
type Stop struct {
	At    float64     // 0–1
	Color units.Color // as authored
}

// Palette is a colour gradient over 0–1.
type Palette struct {
	ID    string
	Name  string
	WLED  int // WLED palette id, or -1
	Stops []Stop
	Step  bool // hold each stop's colour until the next instead of blending
	Wrap  bool // positions wrap modulo 1 (and the last stop blends into the first)
	// Special marks WLED's palettes 0–5, which are made per layer from the
	// effect's default palette, its colours or the time. Effects call
	// Resolve (or a Cache) before sampling. Their own Stops are a fallback.
	Special Special

	linear []color.Color
}

// New builds a palette, sorting stops and decoding colours.
func New(id, name string, stops []Stop, step, wrap bool) *Palette {
	p := &Palette{ID: id, Name: name, WLED: -1, Stops: slices.Clone(stops), Step: step, Wrap: wrap}
	sort.SliceStable(p.Stops, func(i, j int) bool { return p.Stops[i].At < p.Stops[j].At })
	p.linear = make([]color.Color, len(p.Stops))
	for i, s := range p.Stops {
		p.linear[i] = color.Linear(s.Color)
	}
	return p
}

// FromConfig converts a palettes.yaml entry.
func FromConfig(c *config.Palette) *Palette {
	stops := make([]Stop, len(c.Stops))
	for i, s := range c.Stops {
		stops[i] = Stop{At: s.At, Color: s.Color}
	}
	name := c.Name
	if name == "" {
		name = c.ID
	}
	return New(c.ID, name, stops, c.Interpolate == "step", c.Wrap == nil || *c.Wrap)
}

// At samples the palette at position t (opaque, linear light).
func (p *Palette) At(t float64) color.Color {
	n := len(p.linear)
	switch {
	case n == 0:
		return color.Black
	case n == 1:
		return p.linear[0]
	}
	if p.Wrap {
		t -= math.Floor(t)
	} else {
		t = math.Max(0, math.Min(1, t))
	}
	// i is the last stop at or before t.
	i := sort.Search(n, func(i int) bool { return p.Stops[i].At > t }) - 1
	if i < 0 {
		if !p.Wrap {
			return p.linear[0]
		}
		i = n - 1 // before the first stop: between the last and the first
	}
	if p.Step {
		return p.linear[i]
	}
	j, span, off := i+1, 0.0, 0.0
	if j == n {
		if !p.Wrap {
			return p.linear[n-1]
		}
		j = 0
	}
	a, b := p.Stops[i].At, p.Stops[j].At
	if j <= i { // wrapping segment from the last stop round to the first
		b++
		if t < a {
			t++
		}
	}
	span, off = b-a, t-a
	if span <= 0 {
		return p.linear[j]
	}
	return color.Lerp(p.linear[i], p.linear[j], float32(off/span))
}

// Builtins are palettes compiled into Glowstack: WLED's fixed palettes in
// WLED id order (see wled.go and special.go). NewRegistry copies it.
var Builtins []*Palette

// WLED palette id ranges.
const (
	WLEDFixedCount = 73  // ids 0–72 are WLED's fixed palettes
	WLEDCustomBase = 200 // user palettes count down from here
)

// Registry looks palettes up by id, name (case-insensitive) or WLED id.
type Registry struct {
	list []*Palette
	byID map[string]*Palette
}

// NewRegistry returns the built-ins plus user palettes. A user palette with
// a built-in's id replaces it.
//
// User palettes get WLED ids from WLEDCustomBase downward, in file order,
// unless they replace a built-in, whose WLED id they keep.
func NewRegistry(user []config.Palette) *Registry {
	r := &Registry{byID: map[string]*Palette{}}
	for _, p := range Builtins {
		r.Add(p)
	}
	next := WLEDCustomBase
	for i := range user {
		p := FromConfig(&user[i])
		if old, ok := r.byID[p.ID]; ok && old.WLED >= 0 {
			p.WLED = old.WLED
		} else if next >= WLEDFixedCount {
			p.WLED = next
			next--
		}
		r.Add(p)
	}
	return r
}

// WLEDList lists the palettes that have WLED ids in the order WLED lists
// them (for /json/pal): fixed palettes by id, then custom palettes from
// id 200 downward.
func (r *Registry) WLEDList() []*Palette {
	var out []*Palette
	for _, p := range r.list {
		if p.WLED >= 0 {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].WLED, out[j].WLED
		if (a < WLEDFixedCount) != (b < WLEDFixedCount) {
			return a < WLEDFixedCount
		}
		if a < WLEDFixedCount {
			return a < b
		}
		return a > b
	})
	return out
}

// Add adds or replaces a palette.
func (r *Registry) Add(p *Palette) {
	if old, ok := r.byID[p.ID]; ok {
		r.list[slices.Index(r.list, old)] = p
	} else {
		r.list = append(r.list, p)
	}
	r.byID[p.ID] = p
}

// Get finds a palette by id, then by name.
func (r *Registry) Get(key string) (*Palette, bool) {
	if p, ok := r.byID[key]; ok {
		return p, true
	}
	for _, p := range r.list {
		if strings.EqualFold(p.Name, key) {
			return p, true
		}
	}
	return nil, false
}

// ByWLED finds a palette by WLED palette id.
func (r *Registry) ByWLED(id int) (*Palette, bool) {
	for _, p := range r.list {
		if p.WLED == id {
			return p, true
		}
	}
	return nil, false
}

// All lists palettes: built-ins first, then user palettes.
func (r *Registry) All() []*Palette { return slices.Clone(r.list) }

// Parse turns a raw parameter value into a palette: an id or name looked up
// in r, or inline stops `[[0, "#ff0000"], [1, "#0000ff"]]`.
func (r *Registry) Parse(raw any) (*Palette, error) {
	switch v := raw.(type) {
	case string:
		if p, ok := r.Get(v); ok {
			return p, nil
		}
		return nil, fmt.Errorf("unknown palette %q", v)
	case []any:
		stops := make([]Stop, 0, len(v))
		for _, s := range v {
			pair, ok := s.([]any)
			if !ok || len(pair) != 2 {
				return nil, fmt.Errorf(`palette stops: want [position, "#rrggbb"]`)
			}
			at, ok := toFloat(pair[0])
			cs, ok2 := pair[1].(string)
			if !ok || !ok2 || at < 0 || at > 1 {
				return nil, fmt.Errorf(`palette stops: want [position 0–1, "#rrggbb"]`)
			}
			c, err := units.ParseColor(cs)
			if err != nil {
				return nil, err
			}
			stops = append(stops, Stop{At: at, Color: c})
		}
		if len(stops) == 0 {
			return nil, fmt.Errorf("palette has no stops")
		}
		return New("", "inline", stops, false, true), nil
	default:
		return nil, fmt.Errorf("want a palette id or a list of stops")
	}
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case float32:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}
