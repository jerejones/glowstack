// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package render

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/jerejones/glowstack/internal/color"
)

// Sub returns the parameters under prefix ("sparkle" gives "sparkle.x" as
// "x"), already resolved. Composite effects use it to hand each part its
// own values without resolving again.
func (v *Values) Sub(prefix string) *Values {
	pre := prefix + "."
	s := &Values{raw: map[string]any{}, vals: map[string]any{}}
	for _, p := range v.params {
		if name, ok := strings.CutPrefix(p.Name, pre); ok {
			p.Name = name
			s.params = append(s.params, p)
		}
	}
	for k, x := range v.raw {
		if name, ok := strings.CutPrefix(k, pre); ok {
			s.raw[name] = x
		}
	}
	for k, x := range v.vals {
		if name, ok := strings.CutPrefix(k, pre); ok {
			s.vals[name] = x
		}
	}
	return s
}

// Param finds a parameter by name.
func (d *Def) Param(name string) (Param, bool) {
	for _, p := range d.Params {
		if p.Name == name {
			return p, true
		}
	}
	return Param{}, false
}

// paramPath is a parsed parameter path (see Binding.Param): a top-level
// parameter, then element indices and list-element fields.
type paramPath struct {
	top  Param
	rest []string
	leaf Param // the parameter type at the end of the path
}

// lookupPath parses path against params. The longest dotted prefix that
// names a parameter wins, so composite names like "sparkle.density" work.
func lookupPath(params []Param, path string) (paramPath, error) {
	segs := strings.Split(path, ".")
	for i := len(segs); i > 0; i-- {
		name := strings.Join(segs[:i], ".")
		for _, p := range params {
			if p.Name != name {
				continue
			}
			pp := paramPath{top: p, rest: segs[i:], leaf: p}
			rest := pp.rest
			for len(rest) > 0 {
				idx, err := strconv.Atoi(rest[0])
				if err != nil || idx < 0 {
					return pp, fmt.Errorf("%s: %q is not an element index", path, rest[0])
				}
				switch pp.leaf.Type {
				case TColors:
					if len(rest) != 1 {
						return pp, fmt.Errorf("%s: a color has no fields", path)
					}
					pp.leaf = Param{Name: pp.leaf.Name, Type: TColor, Default: "#000000"}
					rest = nil
				case TList:
					if len(rest) < 2 {
						return pp, fmt.Errorf("%s: name a field of the element", path)
					}
					f, ok := fieldOf(pp.leaf.Fields, rest[1])
					if !ok {
						return pp, fmt.Errorf("%s: no field %q", path, rest[1])
					}
					pp.leaf, rest = f, rest[2:]
				default:
					return pp, fmt.Errorf("%s: %s is not a list", path, pp.leaf.Name)
				}
			}
			return pp, nil
		}
	}
	return paramPath{}, fmt.Errorf("no parameter %q", path)
}

func fieldOf(fields []Param, name string) (Param, bool) {
	for _, f := range fields {
		if f.Name == name {
			return f, true
		}
	}
	return Param{}, false
}

// resolvedAt returns the resolved value at a path.
func (v *Values) resolvedAt(pp paramPath) (any, bool) {
	x, ok := v.vals[pp.top.Name]
	if !ok {
		return nil, false
	}
	rest := pp.rest
	for len(rest) > 0 {
		idx, _ := strconv.Atoi(rest[0])
		switch l := x.(type) {
		case []*Values:
			if idx >= len(l) || len(rest) < 2 {
				return nil, false
			}
			if x, ok = l[idx].vals[rest[1]]; !ok {
				return nil, false
			}
			rest = rest[2:]
			continue
		default:
			return elementAt(x, idx)
		}
	}
	return x, true
}

// setRaw returns a copy of raw with the value at path set to val. Lists
// along the way are copied (from the default if unset) and padded.
func setRaw(raw map[string]any, pp paramPath, val any) map[string]any {
	out := make(map[string]any, len(raw)+1)
	for k, x := range raw {
		out[k] = x
	}
	cur, ok := out[pp.top.Name]
	if !ok || cur == nil {
		cur = pp.top.Default
	}
	out[pp.top.Name] = setIn(cur, pp.top, pp.rest, val)
	return out
}

func setIn(cur any, p Param, rest []string, val any) any {
	if len(rest) == 0 {
		return val
	}
	idx, _ := strconv.Atoi(rest[0])
	old, _ := cur.([]any)
	list := make([]any, max(len(old), idx+1))
	copy(list, old)
	switch p.Type {
	case TColors:
		for i := len(old); i < idx; i++ {
			list[i] = "#000000"
		}
		list[idx] = val
	case TList:
		for i := len(old); i < idx; i++ {
			list[i] = map[string]any{}
		}
		elem := map[string]any{}
		if m, ok := list[idx].(map[string]any); ok {
			for k, x := range m {
				elem[k] = x
			}
		}
		f, _ := fieldOf(p.Fields, rest[1])
		cur, ok := elem[f.Name]
		if !ok {
			cur = f.Default
		}
		elem[f.Name] = setIn(cur, f, rest[2:], val)
		list[idx] = elem
	}
	return list
}

// rawAt returns the raw value at a path, if set.
func rawAt(raw map[string]any, pp paramPath) (any, bool) {
	x, ok := raw[pp.top.Name]
	rest := pp.rest
	for ok && len(rest) > 0 {
		idx, _ := strconv.Atoi(rest[0])
		var e any
		if e, ok = elementAt(x, idx); !ok {
			break
		}
		if len(rest) == 1 {
			return e, true
		}
		m, isMap := e.(map[string]any)
		if !isMap {
			return nil, false
		}
		x, ok = m[rest[1]]
		rest = rest[2:]
	}
	return x, ok
}

func elementAt(x any, idx int) (any, bool) {
	switch l := x.(type) {
	case []any:
		if idx < len(l) {
			return l[idx], true
		}
	case []*Values:
		if idx < len(l) {
			return l[idx], true
		}
	case []color.Color:
		if idx < len(l) {
			return l[idx], true
		}
	}
	return nil, false
}
