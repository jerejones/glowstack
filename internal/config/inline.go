// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"

	"gopkg.in/yaml.v3"
)

// InlinePrefix starts the id of an inline mapping.
const InlinePrefix = "inline:"

// InlineMapping is a mapping written into a layer's `mapping` parameter
// instead of named in mappings.yaml, for experiments. It takes the same
// fields as a mappings.yaml entry: a flow's (with `kind: flow`, or just an
// `origin`) or a mapping's (`kind: axis`, …). An `id` is allowed and
// ignored.
//
// ID is InlinePrefix plus a hash of the content, so equal mappings share
// an id (and a solve) wherever they're written.
type InlineMapping struct {
	ID      string
	Flow    *Flow    // a flow, or
	Mapping *Mapping // any other kind
}

// ParseInlineMapping decodes and checks an inline mapping from its raw
// value (decoded JSON or YAML). It checks the fields, not the layout:
// whether its nodes exist is found when it's solved.
func ParseInlineMapping(raw map[string]any) (*InlineMapping, error) {
	fields := maps.Clone(raw)
	delete(fields, "id")
	kind, _ := fields["kind"].(string)
	if _, ok := fields["kind"]; ok && kind == "" {
		return nil, errors.New("inline mapping: kind: want a string")
	}
	if kind == "" {
		if _, ok := fields["origin"]; !ok {
			return nil, fmt.Errorf("inline mapping: give a kind (%s, %s, %s, %s, %s or %s), or an origin for a flow",
				KindFlow, KindLocal, KindIndex, KindAxis, KindRadial, KindPlan)
		}
		kind = KindFlow
	}
	if kind == KindFlow {
		delete(fields, "kind")
	}
	canon, err := json.Marshal(fields) // map keys are sorted, so equal content hashes equally
	if err != nil {
		return nil, fmt.Errorf("inline mapping: %v", err)
	}
	sum := sha256.Sum256(canon)
	m := &InlineMapping{ID: InlinePrefix + hex.EncodeToString(sum[:6])}
	data, err := yaml.Marshal(fields)
	if err != nil {
		return nil, fmt.Errorf("inline mapping: %v", err)
	}
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("inline mapping: %v", err)
	}
	d := &decoder{file: "mapping"}
	v := &validator{}
	if kind == KindFlow {
		m.Flow = &Flow{}
		d.decode(&root, reflectValue(m.Flow))
		m.Flow.ID = m.ID
		if len(d.errs) == 0 {
			v.flow(m.Flow)
		}
	} else {
		m.Mapping = &Mapping{}
		d.decode(&root, reflectValue(m.Mapping))
		m.Mapping.ID = m.ID
		if len(d.errs) == 0 {
			v.mapping(m.Mapping)
		}
	}
	if err := InlineError(append(d.errs, v.errs...).Err()); err != nil {
		return nil, err
	}
	return m, nil
}

// InlineError rewrites errors about an inline mapping (from parsing or
// solving it) without file positions, which mean nothing for a value
// that came from an API request: "inline mapping: unknown field "x"".
func InlineError(err error) error {
	if err == nil {
		return nil
	}
	var msgs []string
	var es Errors
	var e *Error
	switch {
	case errors.As(err, &es):
		for _, x := range es {
			msgs = append(msgs, x.Msg)
		}
	case errors.As(err, &e):
		msgs = append(msgs, e.Msg)
	default:
		msgs = append(msgs, err.Error())
	}
	return errors.New("inline mapping: " + strings.Join(msgs, "; "))
}
