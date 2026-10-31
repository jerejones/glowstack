// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package units parses and formats the physical quantities used in config
// and effect parameters: lengths, speeds, durations, rates, densities,
// angles, fractions and colours.
//
// Values are normalised to SI: metres, seconds, radians. A quantity given in
// `px` (one LED pitch of the run in question) can't be normalised until the
// pitch is known, so Length, Speed and Density keep a PX flag and convert
// with Metres(pitch) and friends.
//
// Every type implements encoding.TextUnmarshaler and TextMarshaler, so it can
// be used directly in YAML (gopkg.in/yaml.v3) and JSON structs.
//
// Number syntax: a decimal (`0.5`, `-3`, `1e-2`) or a fraction (`1/60`).
// A space between number and unit is optional.
package units

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"
)

// Metre conversion factors for the accepted length units.
var lengthUnits = map[string]float64{
	"m":  1,
	"cm": 0.01,
	"mm": 0.001,
	"ft": 0.3048,
	"in": 0.0254,
}

// Second conversion factors for the accepted time units.
var timeUnits = map[string]float64{
	"ms":  0.001,
	"s":   1,
	"min": 60,
	"h":   3600,
}

// parseNumber parses a decimal or a fraction like "1/60".
func parseNumber(s string) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("missing number")
	}
	if num, den, ok := strings.Cut(s, "/"); ok {
		n, err := strconv.ParseFloat(strings.TrimSpace(num), 64)
		if err != nil {
			return 0, fmt.Errorf("bad number %q", s)
		}
		d, err := strconv.ParseFloat(strings.TrimSpace(den), 64)
		if err != nil || d == 0 {
			return 0, fmt.Errorf("bad fraction %q", s)
		}
		return n / d, nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsInf(v, 0) || math.IsNaN(v) {
		return 0, fmt.Errorf("bad number %q", s)
	}
	return v, nil
}

// splitNumber splits "1/60 m" or "20px" into number text and unit text. The
// number ends at the first letter (other than an exponent) or at whitespace
// followed by a non-digit. A leading '/' in the remainder (as in "2 /s")
// stays with the unit.
func splitNumber(s string) (num, unit string) {
	num, unit = splitNumberRaw(strings.TrimSpace(s))
	// "2/s": the slash belongs to the unit.
	if strings.HasSuffix(num, "/") {
		num, unit = strings.TrimSpace(num[:len(num)-1]), "/"+unit
	}
	return num, unit
}

func splitNumberRaw(s string) (num, unit string) {
	for i, r := range s {
		if unicode.IsLetter(r) || r == '°' || r == '%' {
			if (r == 'e' || r == 'E') && i > 0 && i+1 < len(s) && isExpTail(s[i+1:]) && isDigitOrDot(s[i-1]) {
				continue
			}
			return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i:])
		}
		if r == ' ' {
			rest := strings.TrimSpace(s[i:])
			// "1/60 m": the fraction is complete; "2 /s": unit starts with '/'.
			if rest != "" && !isDigitOrDot(rest[0]) {
				return strings.TrimSpace(s[:i]), rest
			}
		}
	}
	return s, ""
}

func isDigitOrDot(c byte) bool { return c >= '0' && c <= '9' || c == '.' }

func isExpTail(s string) bool {
	if s == "" {
		return false
	}
	if s[0] == '+' || s[0] == '-' {
		s = s[1:]
	}
	return s != "" && s[0] >= '0' && s[0] <= '9'
}

// formatFloat prints v compactly without trailing zeros.
func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// unitError builds a consistent error for a bad quantity string.
func unitError(kind, s, hint string) error {
	return fmt.Errorf("bad %s %q: %s", kind, s, hint)
}
