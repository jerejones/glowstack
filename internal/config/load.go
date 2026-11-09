// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package config holds the YAML schema types and the loader for Glowstack's
// configuration (see docs/design.md, "Configuration files").
//
// Two folders are read. The config folder is hand-edited and read-only:
// glowstack.yaml (optional settings), controllers.yaml, layout.yaml,
// areas.yaml, mappings.yaml, palettes.yaml and presets.yaml. The data folder
// is written by Glowstack: anchors.yaml (measured anchors that override
// layout.yaml) and presets.saved.yaml. Every file carries `schema: 1`.
//
// Load checks everything that can be checked per file and across files by
// id (controllers, areas, mappings). Graph checks (nodes, anchors, overlaps)
// belong to the layout solver, which reports them with the same positions.
package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
)

// File names in the config and data folders.
const (
	SettingsFileName     = "glowstack.yaml"
	ControllersFileName  = "controllers.yaml"
	LayoutFileName       = "layout.yaml"
	AreasFileName        = "areas.yaml"
	MappingsFileName     = "mappings.yaml"
	PalettesFileName     = "palettes.yaml"
	PresetsFileName      = "presets.yaml"
	AnchorsFileName      = "anchors.yaml"       // data dir
	SavedPresetsFileName = "presets.saved.yaml" // data dir
	StateFileName        = "state.json"         // data dir; owned by package stack
)

// Built-in mapping ids, available without declaring them.
const (
	MappingLocal = "local"
	MappingIndex = "index"
	MappingPlan  = "plan"
)

// Config is the whole loaded configuration.
type Config struct {
	Dir     string // config folder
	DataDir string // data folder; may be empty

	Settings       Settings
	Controllers    []Controller
	Layout         Layout
	Areas          []Area
	Zones          []Zone
	DefaultMapping string
	Flows          []Flow
	Mappings       []Mapping
	Palettes       []Palette
	PresetPins     map[string]bool
	Presets        []Preset         // presets.yaml then presets.saved.yaml (Saved set)
	Composites     []Composite      // presets.yaml then presets.saved.yaml
	Shows          []Show           // presets.yaml
	Anchors        []AnchorOverride // anchors.yaml from the data dir
	// The rest of anchors.yaml. Load has already applied them to Layout
	// (see measured.go); they're kept so calibration can rewrite the file.
	Ends         []EndOverride
	Gaps         []GapOverride
	MeasuredDead []Dead
	// Warnings are problems that don't stop the config loading, e.g.
	// anchors measured when a run had a different length. The layout
	// solver passes them on in Layout.Warnings.
	Warnings Errors
}

// Load reads and validates the config folder dir and the data folder
// dataDir (which may be "" or not exist yet). Errors are an Errors value
// listing every problem found with its file and line.
func Load(dir, dataDir string) (*Config, error) {
	c := &Config{Dir: dir, DataDir: dataDir}
	var errs Errors
	load := func(base, name string, required bool, out any) {
		if base == "" {
			return
		}
		path := filepath.Join(base, name)
		data, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) && !required {
			return
		}
		if err != nil {
			errs = append(errs, &Error{Pos: Pos{File: name}, Msg: err.Error()})
			return
		}
		errs = append(errs, decodeFile(name, data, out)...)
	}

	var settings SettingsFile
	var controllers ControllersFile
	var layout LayoutFile
	var areas AreasFile
	var mappings MappingsFile
	var palettes PalettesFile
	var presets, saved PresetsFile
	var anchors AnchorsFile
	load(dir, SettingsFileName, false, &settings)
	load(dir, ControllersFileName, true, &controllers)
	load(dir, LayoutFileName, true, &layout)
	load(dir, AreasFileName, false, &areas)
	load(dir, MappingsFileName, false, &mappings)
	load(dir, PalettesFileName, false, &palettes)
	load(dir, PresetsFileName, false, &presets)
	load(dataDir, AnchorsFileName, false, &anchors)
	load(dataDir, SavedPresetsFileName, false, &saved)
	if len(errs) > 0 {
		return nil, errs
	}

	c.Settings = settings.Settings
	c.Controllers = controllers.Controllers
	c.Layout = layout.Layout
	c.Areas, c.Zones = areas.Areas, areas.Zones
	c.DefaultMapping, c.Flows, c.Mappings = mappings.Default, mappings.Flows, mappings.Mappings
	c.Palettes = palettes.Palettes
	c.Presets = presets.Presets
	for _, p := range saved.Presets {
		p.Saved = true
		c.Presets = append(c.Presets, p)
	}
	c.Presets = slices.DeleteFunc(c.Presets, func(p Preset) bool { return slices.Contains(saved.Hidden, p.ID) })
	c.PresetPins = saved.Pins
	c.Composites = append(presets.Composites, saved.Composites...)
	c.Shows = presets.Shows
	c.Anchors = anchors.Anchors
	c.Ends, c.Gaps, c.MeasuredDead = anchors.Ends, anchors.Gaps, anchors.Dead
	if err := c.resolve(); err != nil {
		return nil, err
	}
	if err := c.applyMeasured(); err != nil {
		return nil, err
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return c, nil
}

// Controller returns the controller with the given id.
func (c *Config) Controller(id string) (*Controller, bool) {
	for i := range c.Controllers {
		if c.Controllers[i].ID == id {
			return &c.Controllers[i], true
		}
	}
	return nil, false
}

// MappingIDs lists every mapping id: flows, other mappings and built-ins.
func (c *Config) MappingIDs() []string {
	ids := []string{MappingLocal, MappingIndex, MappingPlan}
	for _, f := range c.Flows {
		ids = append(ids, f.ID)
	}
	for _, m := range c.Mappings {
		ids = append(ids, m.ID)
	}
	return ids
}

// ReadAnchors decodes dataDir's anchors.yaml as written, in offset form,
// without resolving it against the layout. A missing file is an empty
// one. It's for tools that fix the file when the config won't load.
func ReadAnchors(dataDir string) (*AnchorsFile, error) {
	data, err := os.ReadFile(filepath.Join(dataDir, AnchorsFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return &AnchorsFile{Schema: 1}, nil
	}
	if err != nil {
		return nil, err
	}
	var f AnchorsFile
	if errs := decodeFile(AnchorsFileName, data, &f); len(errs) > 0 {
		return nil, errs
	}
	return &f, nil
}
