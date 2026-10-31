// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package layout

import (
	"slices"

	"github.com/jerejones/glowstack/internal/config"
)

// areas resolves every area to a sorted set of global pixel ids. Areas may
// include other areas; cycles are errors.
func (b *builder) areas() {
	cfgByID := map[string]*config.Area{}
	for i := range b.cfg.Areas {
		cfgByID[b.cfg.Areas[i].ID] = &b.cfg.Areas[i]
	}
	resolved := map[string][]int32{}
	visiting := map[string]bool{}
	var resolve func(a *config.Area) []int32
	resolve = func(a *config.Area) []int32 {
		if px, ok := resolved[a.ID]; ok {
			return px
		}
		if visiting[a.ID] {
			b.errorf(a.Pos, "area %s includes itself", a.ID)
			return nil
		}
		visiting[a.ID] = true
		var px []int32
		for _, part := range a.Include {
			if part.Area != "" {
				if sub, ok := cfgByID[part.Area]; ok {
					px = append(px, resolve(sub)...)
				}
				continue
			}
			px = append(px, b.runPart(part)...)
		}
		slices.Sort(px)
		px = slices.Compact(px)
		resolved[a.ID] = px
		return px
	}
	for i := range b.cfg.Areas {
		a := &b.cfg.Areas[i]
		b.l.areaByID[a.ID] = len(b.l.Areas)
		b.l.Areas = append(b.l.Areas, Area{ID: a.ID, Pixels: resolve(a)})
	}
}

// runPart resolves `{run, from, to}` to global ids, inclusive at both ends.
func (b *builder) runPart(part config.AreaPart) []int32 {
	ri, ok := b.l.runByID[part.Run]
	if !ok {
		return nil // reported by config validation
	}
	r := &b.l.Runs[ri]
	end := func(x *config.NodeOrIndex, dflt int) (int, bool) {
		if x == nil {
			return dflt, true
		}
		if x.IsIndex {
			k := r.Offset(x.Index)
			if k < 0 {
				b.errorf(part.Pos, "run %s has no pixel %d", r.ID, x.Index)
			}
			return k, k >= 0
		}
		n, ok := b.l.nodeByID[x.Node]
		if ok {
			for _, a := range r.Anchors {
				if a.Node == n {
					return r.Offset(a.Index), true
				}
			}
		}
		b.errorf(part.Pos, "node %q isn't on run %s", x.Node, r.ID)
		return 0, false
	}
	from, ok1 := end(part.From, 0)
	to, ok2 := end(part.To, r.Count-1)
	if !ok1 || !ok2 {
		return nil
	}
	if from > to {
		from, to = to, from
	}
	px := make([]int32, 0, to-from+1)
	for k := from; k <= to; k++ {
		px = append(px, r.Pixel(b.l, k))
	}
	return px
}

// implicitAreas makes the run:<id> and controller:<id> areas.
func (b *builder) implicitAreas() {
	for _, c := range b.l.Controllers {
		px := make([]int32, c.Pixels)
		for k := range px {
			px[k] = c.Base + int32(k)
		}
		id := AreaControllerPrefix + c.ID
		b.l.implicit[id] = &Area{ID: id, Pixels: px}
	}
	for i := range b.l.Runs {
		r := &b.l.Runs[i]
		px := make([]int32, r.Count)
		for k := range px {
			px[k] = r.Pixel(b.l, k)
		}
		slices.Sort(px)
		id := AreaRunPrefix + r.ID
		b.l.implicit[id] = &Area{ID: id, Pixels: px}
	}
}
