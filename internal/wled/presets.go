// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/preset"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/storage"
)

// SavedFile is the devices' file in the data folder: the WLED preset id
// of every Glowstack preset seen, so they don't move, and each device's
// last brightness, so it turns on where it was after a restart.
const SavedFile = "wled.json"

// maxPreset is WLED's highest preset id.
const maxPreset = 250

type savedFile struct {
	Schema  int                  `json:"schema"`
	Presets map[string]int       `json:"presets"`
	Zones   map[string]savedZone `json:"zones,omitempty"`
}

type savedZone struct {
	Bri int `json:"bri"`
}

func (d *Devices) loadSaved() {
	d.saved = savedFile{Schema: 1, Presets: map[string]int{}, Zones: map[string]savedZone{}}
	data, err := d.a.Store.Read(SavedFile)
	if storage.IsNotExist(err) {
		return
	}
	var f savedFile
	if err == nil {
		err = json.Unmarshal(data, &f)
	}
	if err == nil && f.Schema != 1 {
		err = fmt.Errorf("schema %d, want 1", f.Schema)
	}
	if err != nil {
		d.log.Warn("ignoring "+SavedFile, "err", err)
		return
	}
	for id, n := range f.Presets {
		if n >= 1 && n <= maxPreset {
			d.saved.Presets[id] = n
		}
	}
	for z, b := range f.Zones {
		if b.Bri >= 1 && b.Bri <= 255 {
			d.saved.Zones[z] = b
		}
	}
}

func (d *Devices) writeSaved() {
	data, err := json.MarshalIndent(d.saved, "", "  ")
	if err == nil {
		err = d.a.Store.Write(SavedFile, data)
	}
	if err != nil {
		d.log.Error("writing "+SavedFile, "err", err)
	}
}

// setLastBri remembers the brightness a device turns on at.
func (d *Devices) setLastBri(zone string, zm *zoneMem, bri int) {
	zm.bri = bri
	if d.saved.Zones[zone].Bri != bri {
		d.saved.Zones[zone] = savedZone{Bri: bri}
		d.writeSaved()
	}
}

// presets returns the effective presets and makes sure each has a WLED id:
// new ones get the lowest free id, in list order. Ids of presets that are
// gone are kept for when they come back, unless every id is taken.
func (d *Devices) presets(cfg *config.Config) []config.Preset {
	list := preset.New(cfg.Presets).List()
	used := map[int]string{}
	for id, n := range d.saved.Presets {
		used[n] = id
	}
	alive := map[string]bool{}
	for _, p := range list {
		alive[p.ID] = true
	}
	changed := false
	for _, p := range list {
		if _, ok := d.saved.Presets[p.ID]; ok {
			continue
		}
		n := 1
		for n <= maxPreset && used[n] != "" {
			n++
		}
		if n > maxPreset { // reclaim an id from a preset that's gone
			n = 1
			for n <= maxPreset && alive[used[n]] {
				n++
			}
			if n > maxPreset {
				continue // more than 250 presets: the rest have no WLED id
			}
			delete(d.saved.Presets, used[n])
		}
		d.saved.Presets[p.ID] = n
		used[n] = p.ID
		changed = true
	}
	if changed {
		d.writeSaved()
	}
	return list
}

// presetNumber is a preset's WLED id.
func (d *Devices) presetNumber(cfg *config.Config, id string) (int, bool) {
	d.presets(cfg)
	n, ok := d.saved.Presets[id]
	return n, ok
}

// presetByNumber is the preset with WLED id n.
func (d *Devices) presetByNumber(cfg *config.Config, n int) (string, bool) {
	for _, p := range d.presets(cfg) {
		if d.saved.Presets[p.ID] == n {
			return p.ID, true
		}
	}
	return "", false
}

// presetsModified is info.fs.pmt: when the preset list (ids and names)
// last changed, so python-wled knows to fetch /presets.json again.
func (d *Devices) presetsModified(cfg *config.Config) int64 {
	var b strings.Builder
	for _, p := range d.presets(cfg) {
		fmt.Fprintf(&b, "%d\x00%s\x00%s\x00%s\n", d.saved.Presets[p.ID], p.ID, p.Name, p.Effect)
	}
	if key := b.String(); key != d.pkey {
		if d.pkey != "" {
			d.pmt = max(d.pmt+1, time.Now().Unix())
		}
		d.pkey = key
	}
	return d.pmt
}

// presetsJSON is /presets.json: WLED's presets file, with Glowstack's
// presets under their WLED ids. Each says it turns the light on and shows
// its effect on the main segment.
func (d *Devices) presetsJSON(v *view) map[string]any {
	out := map[string]any{"0": map[string]any{}}
	for _, p := range d.presets(v.Config) {
		n, ok := d.saved.Presets[p.ID]
		if !ok {
			continue
		}
		seg := map[string]any{"id": 0}
		if def, ok := d.a.Effects.Get(p.Effect); ok && def.WLED != nil && def.WLED.FX >= 0 {
			seg["fx"] = def.WLED.FX
		}
		out[strconv.Itoa(n)] = map[string]any{
			"n": cmpOrStr(p.Name, p.ID), "on": true, "mainseg": 0, "seg": []any{seg},
		}
	}
	return out
}

func cmpOrStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// psave saves the main segment's look (or, if it's off, the first segment
// that's on) as WLED preset n, through App.SavePreset. A preset already
// under that id is replaced if it's a saved one; presets.yaml's can't be.
// A new preset gets an id from its name.
func (d *Devices) psave(v *view, n int, name string) error {
	if n < 1 || n > maxPreset {
		return fmt.Errorf("%w: psave %d: WLED presets are 1–%d", errBadRequest, n, maxPreset)
	}
	if len(v.segs) == 0 {
		return fmt.Errorf("%w: the device has no segments", errBadRequest)
	}
	zm := d.zoneMem(v.zone.ID)
	i := min(zm.mainseg, len(v.segs)-1)
	if d.layer(v.segs[i].owner) == nil {
		for k := range v.segs {
			if d.layer(v.segs[k].owner) != nil {
				i = k
				break
			}
		}
	}
	lk := d.segMem(v, i).look
	if l := d.layer(v.segs[i].owner); l != nil {
		lk = lookOf(l)
	}
	effect, params, err := v.Engine.Expand(lk.layer(v.segs[i]))
	if err != nil {
		return err
	}
	params = cloneRaw(params)
	delete(params, render.ParamFadeIn)
	delete(params, render.ParamFadeOut)

	id, existing := d.presetByNumber(v.Config, n)
	if existing {
		if p, ok := v.Config.Preset(id); ok && name == "" {
			name = p.Name
		}
	} else {
		id = d.newPresetID(v.Config, name, n)
	}
	if name == "" {
		name = "Preset " + strconv.Itoa(n)
	}
	if _, _, err := d.a.SavePreset(config.Preset{ID: id, Name: name, Effect: effect, Params: params}); err != nil {
		return fmt.Errorf("psave %d: %w", n, err)
	}
	if !existing {
		// An explicit save reassigns this slot, including any reservation
		// for a previously deleted preset. It must have only one owner.
		for old, slot := range d.saved.Presets {
			if slot == n {
				delete(d.saved.Presets, old)
			}
		}
		d.saved.Presets[id] = n
		d.writeSaved()
	}
	return nil
}

// newPresetID makes a preset id from a WLED preset name: a slug of it,
// or wled-<n>, made unique.
func (d *Devices) newPresetID(cfg *config.Config, name string, n int) string {
	id := slug(name)
	if id == "" {
		id = "wled-" + strconv.Itoa(n)
	}
	taken := func(s string) bool {
		if _, ok := cfg.Preset(s); ok {
			return true
		}
		_, ok := d.saved.Presets[s]
		return ok
	}
	for base, k := id, 2; taken(id); k++ {
		id = base + "-" + strconv.Itoa(k)
	}
	return id
}

func slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			dash = false
		} else {
			dash = true
		}
	}
	return b.String()
}

// pdel deletes the saved preset with WLED id n.
func (d *Devices) pdel(v *view, n int) error {
	id, ok := d.presetByNumber(v.Config, n)
	if !ok {
		return nil
	}
	if _, err := d.a.DeletePreset(id); err != nil {
		return fmt.Errorf("pdel %d: %w", n, err)
	}
	return nil
}

// presetIDs lists the WLED ids in use, sorted (for tests and logs).
func (d *Devices) presetIDs() []int {
	var out []int
	for _, n := range d.saved.Presets {
		out = append(out, n)
	}
	slices.Sort(out)
	return out
}
