// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"encoding"
	"fmt"
	"math"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

// Pos is a position in a config file. Structs that embed a Pos field get it
// filled by the decoder, so later validation can point at the right line.
type Pos struct {
	File string `yaml:"-" json:"-"`
	Line int    `yaml:"-" json:"-"`
	Col  int    `yaml:"-" json:"-"`
}

func (p Pos) String() string {
	switch {
	case p.File == "":
		return "<unknown>"
	case p.Line == 0:
		return p.File
	default:
		return fmt.Sprintf("%s:%d", p.File, p.Line)
	}
}

// Error is a config problem at a position.
type Error struct {
	Pos Pos
	Msg string
}

func (e *Error) Error() string { return e.Pos.String() + ": " + e.Msg }

// Errorf returns an *Error at pos.
func Errorf(pos Pos, format string, args ...any) *Error {
	return &Error{Pos: pos, Msg: fmt.Sprintf(format, args...)}
}

// Errors collects several config problems.
type Errors []*Error

func (es Errors) Error() string {
	lines := make([]string, len(es))
	for i, e := range es {
		lines[i] = e.Error()
	}
	return strings.Join(lines, "\n")
}

// Err returns es as an error, or nil if it is empty.
func (es Errors) Err() error {
	if len(es) == 0 {
		return nil
	}
	return es
}

// nodeUnmarshaler is implemented by types that decode themselves from a
// yaml.Node (for shorthand syntaxes). They receive the decoder so they can
// decode sub-values with positions.
type nodeUnmarshaler interface {
	unmarshalNode(d *decoder, n *yaml.Node) error
}

// decoder maps yaml.Node trees onto Go structs. It is stricter than
// yaml.v3's own decoder: unknown fields are errors, and every error (including
// a bad unit string) carries file and line.
type decoder struct {
	file string
	errs Errors
}

func (d *decoder) pos(n *yaml.Node) Pos { return Pos{File: d.file, Line: n.Line, Col: n.Column} }

func (d *decoder) errorf(n *yaml.Node, format string, args ...any) {
	d.errs = append(d.errs, Errorf(d.pos(n), format, args...))
}

var (
	posType       = reflect.TypeFor[Pos]()
	nodeType      = reflect.TypeFor[yaml.Node]()
	textUnmarshal = reflect.TypeFor[encoding.TextUnmarshaler]()
	nodeUnmarshal = reflect.TypeFor[nodeUnmarshaler]()
)

// decode fills v (which must be addressable) from n.
func (d *decoder) decode(n *yaml.Node, v reflect.Value) {
	for n.Kind == yaml.AliasNode {
		n = n.Alias
	}
	if n.Kind == yaml.DocumentNode {
		if len(n.Content) == 0 {
			return
		}
		n = n.Content[0]
	}
	if v.Type() == nodeType {
		v.Set(reflect.ValueOf(*n))
		return
	}
	if v.Kind() == reflect.Pointer {
		if n.Kind == yaml.ScalarNode && n.Tag == "!!null" {
			return
		}
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		d.decode(n, v.Elem())
		return
	}
	if v.Addr().Type().Implements(nodeUnmarshal) {
		if err := v.Addr().Interface().(nodeUnmarshaler).unmarshalNode(d, n); err != nil {
			d.errorf(n, "%v", err)
		}
		return
	}
	if v.Addr().Type().Implements(textUnmarshal) {
		if n.Kind != yaml.ScalarNode {
			d.errorf(n, "want a single value, got a %s", kindName(n))
			return
		}
		if err := v.Addr().Interface().(encoding.TextUnmarshaler).UnmarshalText([]byte(n.Value)); err != nil {
			d.errorf(n, "%v", err)
		}
		return
	}
	switch v.Kind() {
	case reflect.Struct:
		d.decodeStruct(n, v)
	case reflect.Slice:
		if n.Kind != yaml.SequenceNode {
			d.errorf(n, "want a list, got a %s", kindName(n))
			return
		}
		s := reflect.MakeSlice(v.Type(), len(n.Content), len(n.Content))
		for i, c := range n.Content {
			d.decode(c, s.Index(i))
		}
		v.Set(s)
	case reflect.Array:
		if n.Kind != yaml.SequenceNode || len(n.Content) != v.Len() {
			d.errorf(n, "want a list of %d values", v.Len())
			return
		}
		for i, c := range n.Content {
			d.decode(c, v.Index(i))
		}
	case reflect.Map:
		if n.Kind != yaml.MappingNode {
			d.errorf(n, "want a mapping, got a %s", kindName(n))
			return
		}
		m := reflect.MakeMapWithSize(v.Type(), len(n.Content)/2)
		for i := 0; i+1 < len(n.Content); i += 2 {
			k := reflect.New(v.Type().Key()).Elem()
			d.decode(n.Content[i], k)
			e := reflect.New(v.Type().Elem()).Elem()
			d.decode(n.Content[i+1], e)
			m.SetMapIndex(k, e)
		}
		v.Set(m)
	default:
		// Scalars and interface{} values: let yaml.v3 resolve them.
		if v.Kind() != reflect.Interface && n.Kind != yaml.ScalarNode {
			d.errorf(n, "want a single value, got a %s", kindName(n))
			return
		}
		if err := n.Decode(v.Addr().Interface()); err != nil {
			d.errorf(n, "%s", cleanYAMLError(err))
		} else if v.Kind() == reflect.Float32 || v.Kind() == reflect.Float64 {
			if f := v.Float(); math.IsNaN(f) || math.IsInf(f, 0) {
				d.errorf(n, "want a finite number, got %q", n.Value)
			}
		}
	}
}

func (d *decoder) decodeStruct(n *yaml.Node, v reflect.Value) {
	if n.Kind != yaml.MappingNode {
		d.errorf(n, "want a mapping, got a %s", kindName(n))
		return
	}
	fields := map[string][]int{}
	d.collectFields(n, v, nil, fields)
	seen := map[string]bool{}
	for i := 0; i+1 < len(n.Content); i += 2 {
		k, val := n.Content[i], n.Content[i+1]
		idx, ok := fields[k.Value]
		if !ok {
			d.errorf(k, "unknown field %q", k.Value)
			continue
		}
		if seen[k.Value] {
			d.errorf(k, "field %q given twice", k.Value)
			continue
		}
		seen[k.Value] = true
		if val.Tag == "!!null" && v.Type().FieldByIndex(idx).Tag.Get("required") == "true" {
			d.errorf(val, "missing %s", k.Value)
			continue
		}
		d.decode(val, v.FieldByIndex(idx))
	}
	for name, idx := range fields {
		if !seen[name] && v.Type().FieldByIndex(idx).Tag.Get("required") == "true" {
			d.errorf(n, "missing %s", name)
		}
	}
}

// collectFields maps YAML keys to field index paths, descending into
// `,inline` structs, and sets every Pos field it passes to n's position.
func (d *decoder) collectFields(n *yaml.Node, v reflect.Value, prefix []int, fields map[string][]int) {
	t := v.Type()
	for i := range t.NumField() {
		f := t.Field(i)
		idx := append(append([]int(nil), prefix...), i)
		if f.Type == posType {
			v.Field(i).Set(reflect.ValueOf(d.pos(n)))
			continue
		}
		name, opts, _ := strings.Cut(f.Tag.Get("yaml"), ",")
		if name == "-" || !f.IsExported() {
			continue
		}
		if opts == "inline" && f.Type.Kind() == reflect.Struct {
			d.collectFields(n, v.Field(i), idx, fields)
			continue
		}
		if name == "" {
			name = strings.ToLower(f.Name)
		}
		fields[name] = idx
	}
}

// reflectValue returns the addressable value ptr points to.
func reflectValue(ptr any) reflect.Value { return reflect.ValueOf(ptr).Elem() }

func kindName(n *yaml.Node) string {
	switch n.Kind {
	case yaml.SequenceNode:
		return "list"
	case yaml.MappingNode:
		return "mapping"
	case yaml.ScalarNode:
		return "value"
	default:
		return "node"
	}
}

// cleanYAMLError strips yaml.v3's "yaml: unmarshal errors:\n  line N: " noise,
// since our errors carry the position already.
func cleanYAMLError(err error) string {
	s := err.Error()
	s = strings.TrimPrefix(s, "yaml: unmarshal errors:\n")
	s = strings.TrimSpace(s)
	if _, rest, ok := strings.Cut(s, ": "); ok && strings.HasPrefix(s, "line ") {
		s = rest
	}
	return s
}

// decodeFile parses data as YAML and decodes it into out (a pointer to
// struct), checking the top-level `schema:` version.
func decodeFile(file string, data []byte, out any) Errors {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return Errors{{Pos: Pos{File: file}, Msg: strings.TrimPrefix(err.Error(), "yaml: ")}}
	}
	d := &decoder{file: file}
	if root.Kind == 0 || len(root.Content) == 0 {
		return Errors{{Pos: Pos{File: file}, Msg: "file is empty; want at least `schema: 1`"}}
	}
	doc := root.Content[0]
	if doc.Kind != yaml.MappingNode {
		d.errorf(doc, "want a mapping at the top level")
		return d.errs
	}
	schemaOK := false
	for i := 0; i+1 < len(doc.Content); i += 2 {
		if doc.Content[i].Value == "schema" {
			if doc.Content[i+1].Value != "1" {
				d.errorf(doc.Content[i+1], "unsupported schema %q; this Glowstack reads schema 1", doc.Content[i+1].Value)
				return d.errs
			}
			schemaOK = true
		}
	}
	if !schemaOK {
		d.errorf(doc, "missing `schema: 1`")
		return d.errs
	}
	d.decode(&root, reflect.ValueOf(out).Elem())
	return d.errs
}
