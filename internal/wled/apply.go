// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"strconv"
	"strings"

	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
	"github.com/jerejones/glowstack/internal/units"
)

var wledEffects = effects.WLEDEffects

// stateReq is a POST to /json/state (or a websocket message). Numbers
// that WLED also takes as strings ("~" to step, "r" for random) are raw.
type stateReq struct {
	On         json.RawMessage `json:"on"`
	Bri        json.RawMessage `json:"bri"`
	Transition *float64        `json:"transition"`
	TT         *float64        `json:"tt"`
	Mainseg    *int            `json:"mainseg"`
	Seg        json.RawMessage `json:"seg"`
	PS         json.RawMessage `json:"ps"`
	PSave      *int            `json:"psave"`
	PDel       *int            `json:"pdel"`
	N          string          `json:"n"`
	V          bool            `json:"v"`
}

// segReq is one segment of a state request.
type segReq struct {
	ID  *int              `json:"id"`
	On  json.RawMessage   `json:"on"`
	Bri json.RawMessage   `json:"bri"`
	FX  json.RawMessage   `json:"fx"`
	SX  json.RawMessage   `json:"sx"`
	IX  json.RawMessage   `json:"ix"`
	Pal json.RawMessage   `json:"pal"`
	C1  json.RawMessage   `json:"c1"`
	C2  json.RawMessage   `json:"c2"`
	C3  json.RawMessage   `json:"c3"`
	O1  json.RawMessage   `json:"o1"`
	O2  json.RawMessage   `json:"o2"`
	O3  json.RawMessage   `json:"o3"`
	Rev json.RawMessage   `json:"rev"`
	Sel json.RawMessage   `json:"sel"`
	CCT json.RawMessage   `json:"cct"`
	Col []json.RawMessage `json:"col"`
}

// errBadRequest marks errors that are the request's fault.
var errBadRequest = errors.New("bad request")

// apply applies a state request to a zone's device. Only a malformed
// request, or a preset that can't be saved or deleted, is an error; parts
// that can't be applied (a palette id that doesn't exist, say) are logged
// and skipped, as WLED ignores them.
func (d *Devices) apply(zone string, body []byte) (wantState bool, err error) {
	var req stateReq
	if err := json.Unmarshal(body, &req); err != nil {
		return false, fmt.Errorf("%w: %v", errBadRequest, err)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	defer d.signal()
	v, err := d.view(zone)
	if err != nil {
		return false, err
	}
	zm := d.zoneMem(zone)
	if req.Transition != nil {
		zm.transition = int(max(0, min(65535, *req.Transition)))
	}
	fade := zm.transition // -1: the stack's default
	if req.TT != nil {
		fade = int(max(0, min(65535, *req.TT)))
	}
	d.applyMaster(v, zm, req.On, req.Bri)
	if req.Mainseg != nil && *req.Mainseg >= 0 && *req.Mainseg < len(v.segs) {
		zm.mainseg = *req.Mainseg
	}
	if seg := bytes.TrimSpace(req.Seg); len(seg) > 0 {
		if err := d.applySegments(v, seg, fade); err != nil {
			return false, err
		}
	}
	if req.PSave != nil {
		if err := d.psave(v, *req.PSave, req.N); err != nil {
			return false, err
		}
		v, err = d.view(zone) // the config reloaded
		if err != nil {
			return false, err
		}
	}
	if req.PDel != nil {
		if err := d.pdel(v, *req.PDel); err != nil {
			return false, err
		}
		if v, err = d.view(zone); err != nil {
			return false, err
		}
	}
	if len(req.PS) > 0 && req.PSave == nil {
		var n int
		if json.Unmarshal(req.PS, &n) != nil {
			var s string
			if json.Unmarshal(req.PS, &s) == nil {
				n, _ = strconv.Atoi(s)
			}
		}
		if n > 0 {
			d.applyPreset(v, zm, n, fade)
		}
	}
	return req.V, nil
}

// applyMaster applies the device's on and bri to the zone brightness.
func (d *Devices) applyMaster(v *view, zm *zoneMem, onRaw, briRaw json.RawMessage) {
	if len(onRaw) == 0 && len(briRaw) == 0 {
		return
	}
	zone := v.zone.ID
	zb := d.a.Brightness().Zones[zone]
	wasOn := zb > 0
	bri := zm.bri
	if wasOn {
		bri = max(1, int(math.Round(zb*255)))
	}
	on, oldBri := wasOn, bri
	if b, ok := getVal(briRaw, bri, 0, 255); ok {
		bri = b
		on = bri > 0 // WLED: setting a brightness turns the light on
	}
	toggleFrom := wasOn
	if wasOn {
		toggleFrom = on
	}
	if b, ok := getBool(onRaw, toggleFrom); ok {
		on = b
	}
	if bri == 0 {
		bri = oldBri
	}
	if on == wasOn && bri == oldBri {
		return
	}
	level := 0.0
	if on {
		level = float64(bri) / 255
	}
	d.setLastBri(zone, zm, bri)
	if err := d.a.SetZoneBrightness(zone, level); err != nil {
		d.log.Warn("setting zone brightness", "zone", zone, "err", err)
	}
}

// applySegments applies "seg": an object (one segment by id, or every
// selected segment) or an array (by id, or by position).
func (d *Devices) applySegments(v *view, raw json.RawMessage, fade int) error {
	if raw[0] == '{' {
		var s segReq
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("%w: seg: %v", errBadRequest, err)
		}
		if s.ID != nil {
			if *s.ID >= 0 && *s.ID < len(v.segs) {
				d.applySegment(v, *s.ID, &s, fade)
			}
			return nil
		}
		for i := range v.segs {
			if d.segMem(v, i).sel {
				d.applySegment(v, i, &s, fade)
			}
		}
		return nil
	}
	var segs []segReq
	if err := json.Unmarshal(raw, &segs); err != nil {
		return fmt.Errorf("%w: seg: %v", errBadRequest, err)
	}
	for k := range segs {
		i := k
		if segs[k].ID != nil {
			i = *segs[k].ID
		}
		// Segments can't be added or removed: they're the zone's config.
		if i >= 0 && i < len(v.segs) {
			d.applySegment(v, i, &segs[k], fade)
		}
	}
	return nil
}

// edit is a look being changed by one segment request.
type edit struct {
	d       *Devices
	v       *view
	sv      segView
	lk      look
	def     *render.Def
	env     render.Env
	changed bool
}

// set applies one WLED control to the look if its effect binds it. A
// preset look becomes a copy of the preset first, so the change has
// somewhere to go. A value the effect can't take is logged and skipped.
func (e *edit) set(s render.Slider, value any) {
	if e.def == nil || len(e.def.Bindings(s)) == 0 {
		return
	}
	lk := e.lk
	if lk.Preset != "" {
		eff, params, err := e.v.Engine.Expand(lk.layer(e.sv))
		if err != nil {
			e.d.log.Warn("wled: preset can't be expanded", "preset", lk.Preset, "err", err)
			return
		}
		lk = look{Effect: eff, Params: cloneRaw(params)}
	}
	raw, err := e.def.SetWLED(lk.Params, s, value, e.env)
	if err == nil {
		lk.Params = raw
		_, err = e.v.Engine.Inspect(lk.layer(e.sv))
	}
	if err != nil {
		e.d.log.Warn("wled: control not applied", "segment", e.sv.owner, "control", s, "value", value, "err", err)
		return
	}
	e.lk, e.changed = lk, true
}

// common sets (or, with nil, clears) a common layer parameter.
func (e *edit) common(name string, value any) {
	if e.lk.Preset != "" {
		eff, params, err := e.v.Engine.Expand(e.lk.layer(e.sv))
		if err != nil {
			e.d.log.Warn("wled: preset can't be expanded", "preset", e.lk.Preset, "err", err)
			return
		}
		e.lk = look{Effect: eff, Params: cloneRaw(params)}
	}
	params := cloneRaw(e.lk.Params)
	if value == nil {
		delete(params, name)
	} else {
		params[name] = value
	}
	e.lk.Params, e.changed = params, true
}

// applySegment applies one segment's part of a request.
func (d *Devices) applySegment(v *view, i int, s *segReq, fade int) {
	sv := v.segs[i]
	sm := d.segMem(v, i)
	l := d.layer(sv.owner)
	cur := sm.look
	if l != nil {
		cur = lookOf(l)
	}
	rep, err := d.report(v, i, cur, sm)
	if err != nil {
		// The remembered look no longer resolves (a reload removed its
		// palette, say): start again from a new segment's.
		cur = d.defaultLook(v, i, sm)
		rep, _ = d.report(v, i, cur, sm)
	}
	// Remember every control as it reads now, so the ones a new effect
	// doesn't bind keep their positions.
	sm.ctl = rep.ctl
	e := &edit{d: d, v: v, sv: sv, lk: cur.clone(), def: rep.def, env: rep.env}

	wasOn := l != nil
	on := wasOn
	if b, ok := getVal(s.Bri, rep.bri, 0, 255); ok {
		on = b > 0
		if b > 0 && b != rep.bri {
			if b == 255 {
				e.common(render.ParamBrightness, nil)
			} else {
				e.common(render.ParamBrightness, float64(b)/255)
			}
		}
	}
	if b, ok := getBool(s.On, on); ok {
		on = b
	}
	if b, ok := getBool(s.Rev, rep.rev); ok && b != rep.rev {
		if b {
			e.common(render.ParamReverse, true)
		} else {
			e.common(render.ParamReverse, nil)
		}
	}
	if b, ok := getBool(s.Sel, sm.sel); ok {
		sm.sel = b
	}
	if c, ok := getVal(s.CCT, sm.cct, 0, 255); ok {
		sm.cct = c
	}
	if fx, ok := getVal(s.FX, rep.fx, 0, 255); ok && fx != rep.fx {
		if def, found := d.a.Effects.ByWLED(fx); found && !def.Internal {
			// A new effect: its own defaults, the common params kept, and
			// the colors and palette carried over. A black second or third
			// color is WLED's "unset" (its Glitter sparkles white then), so
			// those keep the new effect's defaults.
			_, params, err := v.Engine.Expand(e.lk.layer(sv))
			if err != nil {
				d.log.Warn("wled: effect change not applied", "segment", sv.owner, "err", err)
				return
			}
			common, _ := render.SplitParams(params)
			e.lk, e.def, e.changed = look{Effect: def.ID, Params: common}, def, true
			for k, cs := range controlColors {
				if c := rep.ctl.Col[k]; k == 0 || c.R|c.G|c.B|c.W != 0 {
					e.set(cs, c)
				}
			}
			e.set(render.SliderPalette, rep.ctl.Pal)
		}
	}
	for _, sl := range []struct {
		raw json.RawMessage
		s   render.Slider
	}{{s.SX, render.SliderSpeed}, {s.IX, render.SliderIntensity}, {s.C1, render.SliderC1}, {s.C2, render.SliderC2}, {s.C3, render.SliderC3}} {
		p := sm.ctl.slider(sl.s)
		hi := 255
		if sl.s == render.SliderC3 {
			hi = 31 // WLED's c3 is 5 bits
		}
		if x, ok := getVal(sl.raw, *p, 0, hi); ok {
			*p = x
			if sl.s == render.SliderC3 {
				x = x * 255 / 31
			}
			e.set(sl.s, x)
		}
	}
	for k, raw := range []json.RawMessage{s.O1, s.O2, s.O3} {
		p := sm.ctl.option(controlOptions[k])
		if b, ok := getBool(raw, *p); ok {
			*p = b
			e.set(controlOptions[k], b)
		}
	}
	if p, ok := getVal(s.Pal, rep.ctl.Pal, 0, 255); ok {
		if _, found := v.Palettes.ByWLED(p); found {
			sm.ctl.Pal = p
			e.set(render.SliderPalette, p)
		}
	}
	for k, raw := range s.Col {
		if k >= len(controlColors) {
			break
		}
		if c, ok := parseColor(raw, rep.ctl.Col[k]); ok {
			sm.ctl.Col[k] = c
			e.set(controlColors[k], c)
		}
	}
	sm.look = e.lk
	d.commit(v, sv, l, e, on, fade)
}

// commit puts a segment's new look on the stack: push, edit or remove.
func (d *Devices) commit(v *view, sv segView, l *stack.Layer, e *edit, on bool, fade int) {
	var err error
	switch {
	case on && l != nil:
		if e.changed {
			_, err = d.a.Stack.Edit(l.ID, func(x *stack.Layer) {
				x.Effect, x.Preset, x.Params = e.lk.Effect, e.lk.Preset, withFades(e.lk.Params, x.Params)
			})
		}
	case on:
		params := cloneRaw(e.lk.Params)
		if fade >= 0 {
			params[render.ParamFadeIn] = fadeValue(fade)
		}
		_, err = d.a.Stack.Push(stack.Layer{Owner: sv.owner, Target: sv.area, Effect: e.lk.Effect, Preset: e.lk.Preset, Params: params})
	case l != nil:
		for _, x := range d.a.Stack.ByOwner(sv.owner) {
			if fade >= 0 {
				_, _ = d.a.Stack.Edit(x.ID, func(x *stack.Layer) {
					x.Params = cloneRaw(x.Params)
					x.Params[render.ParamFadeOut] = fadeValue(fade)
				})
			}
			err = errors.Join(err, d.a.Stack.Remove(x.ID))
		}
	}
	if err != nil {
		d.log.Warn("wled: segment change not applied", "segment", sv.owner, "err", err)
	}
}

// applyPreset shows preset n on the main segment and turns the device on.
func (d *Devices) applyPreset(v *view, zm *zoneMem, n, fade int) {
	id, ok := d.presetByNumber(v.Config, n)
	if !ok || len(v.segs) == 0 {
		return
	}
	i := min(zm.mainseg, len(v.segs)-1)
	sv := v.segs[i]
	sm := d.segMem(v, i)
	e := &edit{lk: look{Preset: id, Params: map[string]any{}}, changed: true}
	sm.look = e.lk
	d.commit(v, sv, d.layer(sv.owner), e, true, fade)
	if d.a.Brightness().Zones[v.zone.ID] == 0 {
		if err := d.a.SetZoneBrightness(v.zone.ID, float64(zm.bri)/255); err != nil {
			d.log.Warn("setting zone brightness", "zone", v.zone.ID, "err", err)
		}
	}
}

// withFades keeps a layer's fade params (from when it was pushed) across
// an edit that replaces its params.
func withFades(params, old map[string]any) map[string]any {
	params = cloneRaw(params)
	for _, k := range []string{render.ParamFadeIn, render.ParamFadeOut} {
		if x, ok := old[k]; ok {
			if _, set := params[k]; !set {
				params[k] = x
			}
		}
	}
	return params
}

// fadeValue is a WLED transition (100 ms units) as a duration param.
func fadeValue(t int) string { return strconv.FormatFloat(float64(t)/10, 'f', -1, 64) + " s" }

// getVal reads a WLED number: an integer, or a string "~" / "~-" to step
// by one, "~N" / "~-N" to step by N (with a "w" prefix it wraps), "r" for
// random, or digits. The result is clamped to lo–hi. ok is false when raw
// is absent or not a number WLED would take.
func getVal(raw json.RawMessage, cur, lo, hi int) (int, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	var f float64
	if json.Unmarshal(raw, &f) == nil {
		if f < 0 {
			return 0, false
		}
		return max(lo, min(hi, int(f))), true
	}
	var s string
	if json.Unmarshal(raw, &s) != nil || s == "" || len(s) > 12 {
		return 0, false
	}
	if s == "r" {
		return lo + rand.IntN(hi-lo+1), true
	}
	wrap := strings.HasPrefix(s, "w")
	s = strings.TrimPrefix(s, "w")
	if rest, ok := strings.CutPrefix(s, "~"); ok {
		step := 1
		neg := strings.HasPrefix(rest, "-")
		rest = strings.TrimPrefix(rest, "-")
		if rest != "" {
			n, err := strconv.Atoi(rest)
			if err != nil {
				return 0, false
			}
			step = n
		}
		if neg {
			step = -step
		}
		x := cur + step
		if wrap {
			span := hi - lo + 1
			return lo + ((x-lo)%span+span)%span, true
		}
		return max(lo, min(hi, x)), true
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0, false
	}
	return max(lo, min(hi, n)), true
}

// getBool reads a WLED boolean: true, false, or "t" to toggle.
func getBool(raw json.RawMessage, cur bool) (bool, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return false, false
	}
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		return b, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && strings.HasPrefix(s, "t") {
		return !cur, true
	}
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return n != 0, true
	}
	return false, false
}

// parseColor reads one entry of a segment's "col": [r,g,b] or [r,g,b,w]
// (missing channels are 0), "RRGGBB" or "RRGGBBWW" hex, {r,g,b,w} (missing
// channels keep cur's), or 0 for black. A Kelvin temperature or "r" isn't
// a fixed color and is ignored, as is an empty array.
func parseColor(raw json.RawMessage, cur units.Color) (units.Color, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return units.Color{}, false
	}
	ch := func(f float64) uint8 { return uint8(max(0, min(255, f))) }
	switch raw[0] {
	case '[':
		var xs []float64
		if json.Unmarshal(raw, &xs) != nil || len(xs) == 0 {
			return units.Color{}, false
		}
		var c units.Color
		for k, x := range xs {
			switch k {
			case 0:
				c.R = ch(x)
			case 1:
				c.G = ch(x)
			case 2:
				c.B = ch(x)
			case 3:
				c.W, c.HasW = ch(x), true
			}
		}
		return c, true
	case '{':
		var o map[string]float64
		if json.Unmarshal(raw, &o) != nil {
			return units.Color{}, false
		}
		c := cur
		for k, x := range o {
			switch k {
			case "r":
				c.R = ch(x)
			case "g":
				c.G = ch(x)
			case "b":
				c.B = ch(x)
			case "w":
				c.W, c.HasW = ch(x), true
			}
		}
		return c, true
	case '"':
		var s string
		_ = json.Unmarshal(raw, &s)
		s = strings.TrimPrefix(s, "#")
		if len(s) == 8 {
			s = s[:6] + "/" + s[6:]
		}
		c, err := units.ParseColor("#" + s)
		return c, err == nil
	}
	var k float64
	if json.Unmarshal(raw, &k) == nil && k == 0 {
		return units.Color{}, true
	}
	return units.Color{}, false
}
