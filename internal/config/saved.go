// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"bytes"

	"gopkg.in/yaml.v3"
)

// savedHeader starts presets.saved.yaml when Glowstack writes it.
const savedHeader = `# Written by Glowstack: presets saved through the API. Adds to (and may
# shadow) presets.yaml. Copy it into the config repo to keep it versioned.
`

// DecodePresetsFile reads presets.saved.yaml (or presets.yaml) with the
// same checks as Load, so a file Glowstack is about to rewrite is known to
// be valid first.
func DecodePresetsFile(name string, data []byte) (*PresetsFile, error) {
	var f PresetsFile
	if err := decodeFile(name, data, &f).Err(); err != nil {
		return nil, err
	}
	return &f, nil
}

// EncodePresetsFile writes f as presets.saved.yaml, readable by Load.
func EncodePresetsFile(f *PresetsFile) ([]byte, error) {
	type preset struct {
		ID     string         `yaml:"id"`
		Name   string         `yaml:"name,omitempty"`
		Effect string         `yaml:"effect"`
		Params map[string]any `yaml:"params,omitempty"`
	}
	type layer struct {
		Name    string         `yaml:"name,omitempty"`
		Effect  string         `yaml:"effect"`
		Blend   string         `yaml:"blend,omitempty"`
		Opacity *float64       `yaml:"opacity,omitempty"`
		Params  map[string]any `yaml:"params,omitempty"`
	}
	type composite struct {
		ID     string  `yaml:"id"`
		Name   string  `yaml:"name,omitempty"`
		Layers []layer `yaml:"layers"`
	}
	out := struct {
		Schema     int         `yaml:"schema"`
		Presets    []preset    `yaml:"presets"`
		Composites []composite `yaml:"composites,omitempty"`
	}{Schema: 1, Presets: []preset{}}
	for _, p := range f.Presets {
		out.Presets = append(out.Presets, preset{p.ID, p.Name, p.Effect, p.Params})
	}
	for _, c := range f.Composites {
		oc := composite{ID: c.ID, Name: c.Name}
		for _, l := range c.Layers {
			oc.Layers = append(oc.Layers, layer{l.Name, l.Effect, l.Blend, l.Opacity, l.Params})
		}
		out.Composites = append(out.Composites, oc)
	}
	var b bytes.Buffer
	b.WriteString(savedHeader)
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	if err := enc.Encode(out); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
