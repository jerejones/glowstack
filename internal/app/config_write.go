// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package app

import (
	"errors"
	"fmt"
	"io/fs"
)

// WriteDataConfig writes a machine-maintained config file in the data
// folder and reloads it. The write, reload and any rollback are serialized
// with preset saves and other reloads, so no reload can publish a
// provisional file. The hand-edited config folder is never changed.
func (a *App) WriteDataConfig(name string, data []byte) (*ReloadResult, error) {
	a.presetMu.Lock()
	defer a.presetMu.Unlock()
	old, err := a.Store.Read(name)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return a.writeConfig(name, data, old)
}

// writeConfig runs with presetMu held. An empty schema document restores
// the absence of measurements/presets when no previous file existed.
func (a *App) writeConfig(name string, data, old []byte, preserve ...string) (*ReloadResult, error) {
	if err := a.Store.Write(name, data); err != nil {
		return nil, err
	}
	res, err := a.reloadPreserving(preserve)
	if err == nil {
		return res, nil
	}
	if old == nil {
		old = []byte("schema: 1\n")
	}
	if werr := a.Store.Write(name, old); werr != nil {
		a.Log.Error("restoring "+name, "err", werr)
		return nil, fmt.Errorf("reload failed: %v; restoring %s: %w", err, name, werr)
	}
	return nil, err
}
