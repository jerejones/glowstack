// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate

import (
	"fmt"
	"path/filepath"
	"slices"

	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/storage"
)

// Ways to settle a run whose measurements were taken at a different LED
// count (see config.AnchorOverride.Pixels).
const (
	// AdjustAccept: the LEDs were added or removed at the run's far end,
	// so every offset still holds. Record the new count.
	AdjustAccept = "accept"
	// AdjustShift: N LEDs were added (or removed, N < 0) before offset
	// At. Move the offsets at or past At by N, then record the new count.
	AdjustShift = "shift"
	// AdjustClear: drop the run's measurements.
	AdjustClear = "clear"
)

// Adjustment is one Adjust request.
type Adjustment struct {
	Op  string // AdjustAccept, AdjustShift or AdjustClear
	Run string
	At  int // shift: the first offset that moves
	N   int // shift: by how many LEDs
}

// Adjust settles a run's measurements in dataDir's anchors.yaml after its
// LED count changed. It works on the file's offsets, so it runs even when
// stale measurements stop the full config from loading. It writes the file
// and returns a summary, then checks the result: a non-nil Errors means
// the file was written but the config still doesn't load.
func Adjust(configDir, dataDir string, adj Adjustment) (string, error) {
	cfg, err := config.Load(configDir, "") // the layout without measurements
	if err != nil {
		return "", err
	}
	lay, err := layout.Build(cfg)
	if err != nil {
		return "", err
	}
	ri, ok := lay.RunIndex(adj.Run)
	if !ok {
		return "", fmt.Errorf("unknown run %q", adj.Run)
	}
	count := lay.Runs[ri].Config.Count()
	f, err := config.ReadAnchors(dataDir)
	if err != nil {
		return "", err
	}

	n := 0
	mine := func(run string) bool {
		if run == adj.Run {
			n++
			return true
		}
		return false
	}
	shift := func(off *int) {
		if adj.Op == AdjustShift && *off >= adj.At {
			*off += adj.N
		}
	}
	switch adj.Op {
	case AdjustClear:
		f.Anchors = slices.DeleteFunc(f.Anchors, func(a config.AnchorOverride) bool { return mine(a.Run) })
		f.Ends = slices.DeleteFunc(f.Ends, func(e config.EndOverride) bool { return mine(e.Run) })
		f.Dead = slices.DeleteFunc(f.Dead, func(d config.Dead) bool { return mine(d.Run) })
	case AdjustAccept, AdjustShift:
		for i := range f.Anchors {
			if a := &f.Anchors[i]; mine(a.Run) {
				shift(&a.Offset)
				a.Pixels = count
			}
		}
		for i := range f.Ends {
			if e := &f.Ends[i]; mine(e.Run) {
				if e.First != nil {
					shift(e.First)
				}
				if e.Last != nil {
					shift(e.Last)
				}
				e.Pixels = count
			}
		}
		for i := range f.Dead {
			if d := &f.Dead[i]; mine(d.Run) && d.Offsets != nil {
				shift(&d.Offsets[0])
				shift(&d.Offsets[1])
				d.Pixels = count
			}
		}
	default:
		return "", fmt.Errorf("unknown adjustment %q: want %s, %s or %s", adj.Op, AdjustAccept, AdjustShift, AdjustClear)
	}
	if n == 0 {
		return "", fmt.Errorf("%s has no measurements for run %s", config.AnchorsFileName, adj.Run)
	}
	path := filepath.Join(dataDir, config.AnchorsFileName)
	if err := storage.WriteFileAtomic(path, encode(f, lay), 0o644); err != nil {
		return "", err
	}
	what := fmt.Sprintf("%d measurements", n)
	if n == 1 {
		what = "1 measurement"
	}
	var msg string
	switch adj.Op {
	case AdjustClear:
		msg = fmt.Sprintf("cleared %s on %s", what, adj.Run)
	case AdjustAccept:
		msg = fmt.Sprintf("accepted %s on %s at %d LEDs", what, adj.Run, count)
	case AdjustShift:
		msg = fmt.Sprintf("shifted %s's measurements at offset %d or later by %+d; %s now at %d LEDs", adj.Run, adj.At, adj.N, what, count)
	}
	msg += "; wrote " + path + ". Reload Glowstack (SIGHUP or POST /api/v1/reload) if it's running."
	if cfg, err := config.Load(configDir, dataDir); err != nil {
		return msg, err
	} else if _, err := layout.Build(cfg); err != nil {
		return msg, err
	}
	return msg, nil
}
