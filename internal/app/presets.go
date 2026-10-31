// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package app

import (
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"slices"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/preset"
)

// Errors from SavePreset and DeletePreset.
var (
	// ErrNoDataDir: there's no data folder to save presets in.
	ErrNoDataDir = errors.New("no data folder: saving presets needs --data")
	// ErrReadOnlyPreset: the preset is in the config folder's presets.yaml,
	// which Glowstack never rewrites.
	ErrReadOnlyPreset = errors.New("the preset is in presets.yaml, which Glowstack never changes")
	// ErrNoSavedPreset: there's no saved preset with that id.
	ErrNoSavedPreset = errors.New("no saved preset")
	// ErrBadPreset: the preset doesn't check out (id, effect, params,
	// palette or mapping).
	ErrBadPreset = errors.New("invalid preset")
)

var presetID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// SavePreset adds p to presets.saved.yaml in the data folder, or replaces
// the saved preset with its id, then reloads so it can be used at once.
// It's checked first against the effects, palettes and mappings. A preset
// that's only in presets.yaml can't be replaced (ErrReadOnlyPreset); save
// it under another id. created is false if a saved preset was replaced.
//
// The file is written atomically through the Store. If the reload fails,
// the old file is put back and nothing changes.
func (a *App) SavePreset(p config.Preset) (created bool, res *ReloadResult, err error) {
	if !presetID.MatchString(p.ID) {
		return false, nil, fmt.Errorf("%w: id %q: use letters, digits, '.', '_' and '-'", ErrBadPreset, p.ID)
	}
	a.presetMu.Lock()
	defer a.presetMu.Unlock()
	f, old, err := a.readSaved()
	if err != nil {
		return false, nil, err
	}
	i := slices.IndexFunc(f.Presets, func(q config.Preset) bool { return q.ID == p.ID })
	v := a.Current()
	if q, ok := v.Config.Preset(p.ID); ok && !q.Saved && i < 0 {
		return false, nil, fmt.Errorf("preset %q: %w; save it under another id", p.ID, ErrReadOnlyPreset)
	}
	if err := preset.CheckSpec(preset.Expand(p, nil), a.Effects, v.Palettes, v.Layout.Pitch, v.Engine.CheckMapping); err != nil {
		return false, nil, fmt.Errorf("%w %s: %v", ErrBadPreset, p.ID, err)
	}
	p.Pos, p.Saved = config.Pos{}, false
	if i >= 0 {
		f.Presets[i] = p
	} else {
		f.Presets = append(f.Presets, p)
	}
	res, err = a.writeSaved(f, old)
	return i < 0, res, err
}

// DeletePreset removes a preset from presets.saved.yaml and reloads. A
// configured preset with the same id, if any, takes effect again. Layers
// that named the preset and no longer validate are dropped (see
// ReloadResult.Dropped).
func (a *App) DeletePreset(id string) (*ReloadResult, error) {
	a.presetMu.Lock()
	defer a.presetMu.Unlock()
	f, old, err := a.readSaved()
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(f.Presets, func(q config.Preset) bool { return q.ID == id })
	if i < 0 {
		if _, ok := a.Current().Config.Preset(id); ok {
			return nil, fmt.Errorf("preset %q: %w", id, ErrReadOnlyPreset)
		}
		return nil, fmt.Errorf("%w %q", ErrNoSavedPreset, id)
	}
	f.Presets = slices.Delete(f.Presets, i, i+1)
	return a.writeSaved(f, old)
}

// readSaved reads presets.saved.yaml. old is its content, nil if there's
// no file yet.
func (a *App) readSaved() (f *config.PresetsFile, old []byte, err error) {
	if a.opts.DataDir == "" {
		return nil, nil, ErrNoDataDir
	}
	old, err = a.Store.Read(config.SavedPresetsFileName)
	if errors.Is(err, fs.ErrNotExist) {
		return &config.PresetsFile{Schema: 1}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if f, err = config.DecodePresetsFile(config.SavedPresetsFileName, old); err != nil {
		return nil, nil, fmt.Errorf("%s doesn't load, so it wasn't changed: %w", config.SavedPresetsFileName, err)
	}
	return f, old, nil
}

// writeSaved writes f and reloads, putting old back if the reload fails.
func (a *App) writeSaved(f *config.PresetsFile, old []byte) (*ReloadResult, error) {
	data, err := config.EncodePresetsFile(f)
	if err != nil {
		return nil, err
	}
	return a.writeConfig(config.SavedPresetsFileName, data, old)
}
