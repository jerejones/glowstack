// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package units

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// Length is a distance. Value is meters, or pitches when PX is set.
type Length struct {
	Value float64
	PX    bool
}

// Meters resolves the length using pitch (meters per pixel) for px values.
func (l Length) Meters(pitch float64) float64 {
	if l.PX {
		return l.Value * pitch
	}
	return l.Value
}

// ParseLength parses "0.5 m", "20 px", "3 ft", "1/60 m". A bare 0 is allowed.
func ParseLength(s string) (Length, error) {
	num, unit := splitNumber(s)
	v, err := parseNumber(num)
	if err != nil {
		return Length{}, unitError("length", s, err.Error())
	}
	if unit == "px" {
		return Length{Value: v, PX: true}, nil
	}
	if unit == "" && v == 0 {
		return Length{}, nil
	}
	f, ok := lengthUnits[unit]
	if !ok {
		return Length{}, unitError("length", s, "want a unit: m, cm, mm, ft, in or px")
	}
	return Length{Value: v * f}, nil
}

func (l Length) String() string {
	if l.PX {
		return formatFloat(l.Value) + " px"
	}
	return formatFloat(l.Value) + " m"
}

func (l Length) MarshalText() ([]byte, error) { return []byte(l.String()), nil }

func (l *Length) UnmarshalText(b []byte) (err error) {
	*l, err = ParseLength(string(b))
	return err
}

// Speed is a signed velocity. Value is meters per second, or pitches per
// second when PX is set. Negative means reverse.
type Speed struct {
	Value float64
	PX    bool
}

// MetersPerSecond resolves the speed using pitch for px values.
func (s Speed) MetersPerSecond(pitch float64) float64 {
	if s.PX {
		return s.Value * pitch
	}
	return s.Value
}

// ParseSpeed parses "0.02 m/s", "1 px/8s", "-3 ft/min", "20 px/s". A bare 0
// is allowed.
func ParseSpeed(s string) (Speed, error) {
	num, unit := splitNumber(s)
	v, err := parseNumber(num)
	if err != nil {
		return Speed{}, unitError("speed", s, err.Error())
	}
	if unit == "" && v == 0 {
		return Speed{}, nil
	}
	lu, tu, ok := strings.Cut(unit, "/")
	if !ok {
		return Speed{}, unitError("speed", s, "want length/time, e.g. m/s or px/8s")
	}
	per, err := parseTimeUnit(tu)
	if err != nil {
		return Speed{}, unitError("speed", s, err.Error())
	}
	lu = strings.TrimSpace(lu)
	if lu == "px" {
		return Speed{Value: v / per, PX: true}, nil
	}
	f, ok := lengthUnits[lu]
	if !ok {
		return Speed{}, unitError("speed", s, "unknown length unit "+lu)
	}
	return Speed{Value: v * f / per}, nil
}

// parseTimeUnit parses the time part of a compound unit, like "s", "min" or
// "8s", returning seconds.
func parseTimeUnit(s string) (float64, error) {
	num, unit := splitNumber(s)
	n := 1.0
	if num != "" {
		var err error
		if n, err = parseNumber(num); err != nil {
			return 0, err
		}
		if n <= 0 {
			return 0, fmt.Errorf("time must be positive")
		}
	}
	f, ok := timeUnits[unit]
	if !ok {
		return 0, fmt.Errorf("unknown time unit %q", unit)
	}
	return n * f, nil
}

func (s Speed) String() string {
	if s.PX {
		return formatFloat(s.Value) + " px/s"
	}
	return formatFloat(s.Value) + " m/s"
}

func (s Speed) MarshalText() ([]byte, error) { return []byte(s.String()), nil }

func (s *Speed) UnmarshalText(b []byte) (err error) {
	*s, err = ParseSpeed(string(b))
	return err
}

// Duration is a non-negative time span.
type Duration time.Duration

// ParseDuration parses "250 ms", "5 s", "1.5 min", "2 h", or Go syntax like
// "1m30s". A bare 0 is allowed.
func ParseDuration(s string) (Duration, error) {
	num, unit := splitNumber(s)
	v, err := parseNumber(num)
	if err == nil {
		if unit == "" && v == 0 {
			return 0, nil
		}
		if f, ok := timeUnits[unit]; ok {
			if v < 0 {
				return 0, unitError("duration", s, "must not be negative")
			}
			return Duration(math.Round(v * f * float64(time.Second))), nil
		}
	}
	d, gerr := time.ParseDuration(strings.ReplaceAll(s, " ", ""))
	if gerr != nil {
		return 0, unitError("duration", s, "want e.g. 250 ms, 5 s, 2 min")
	}
	if d < 0 {
		return 0, unitError("duration", s, "must not be negative")
	}
	return Duration(d), nil
}

// Seconds returns the duration in seconds.
func (d Duration) Seconds() float64 { return time.Duration(d).Seconds() }

func (d Duration) String() string {
	td := time.Duration(d)
	switch {
	case td == 0:
		return "0 s"
	case td%time.Second != 0 && td < time.Second:
		return formatFloat(float64(td)/float64(time.Millisecond)) + " ms"
	default:
		return formatFloat(td.Seconds()) + " s"
	}
}

func (d Duration) MarshalText() ([]byte, error) { return []byte(d.String()), nil }

func (d *Duration) UnmarshalText(b []byte) (err error) {
	*d, err = ParseDuration(string(b))
	return err
}

// Rate is events per second.
type Rate float64

// ParseRate parses "2 /s", "2/s", "10 /min".
func ParseRate(s string) (Rate, error) {
	num, unit := splitNumber(s)
	v, err := parseNumber(num)
	if err != nil {
		return 0, unitError("rate", s, err.Error())
	}
	if unit == "" && v == 0 {
		return 0, nil
	}
	tu, ok := strings.CutPrefix(unit, "/")
	if !ok {
		return 0, unitError("rate", s, "want events per time, e.g. 2 /s")
	}
	per, err := parseTimeUnit(tu)
	if err != nil {
		return 0, unitError("rate", s, err.Error())
	}
	return Rate(v / per), nil
}

func (r Rate) String() string { return formatFloat(float64(r)) + " /s" }

func (r Rate) MarshalText() ([]byte, error) { return []byte(r.String()), nil }

func (r *Rate) UnmarshalText(b []byte) (err error) {
	*r, err = ParseRate(string(b))
	return err
}

// Density is events per length per second. Value is per meter per second, or
// per pitch per second when PX is set.
type Density struct {
	Value float64
	PX    bool
}

// PerMeterSecond resolves the density using pitch for px values.
func (d Density) PerMeterSecond(pitch float64) float64 {
	if d.PX {
		return d.Value / pitch
	}
	return d.Value
}

// ParseDensity parses "0.5 /m/s", "2 /ft/min", "0.01 /px/s".
func ParseDensity(s string) (Density, error) {
	num, unit := splitNumber(s)
	v, err := parseNumber(num)
	if err != nil {
		return Density{}, unitError("density", s, err.Error())
	}
	if unit == "" && v == 0 {
		return Density{}, nil
	}
	parts := strings.Split(unit, "/")
	if len(parts) != 3 || parts[0] != "" {
		return Density{}, unitError("density", s, "want events per length per time, e.g. 0.5 /m/s")
	}
	per, err := parseTimeUnit(parts[2])
	if err != nil {
		return Density{}, unitError("density", s, err.Error())
	}
	lu := strings.TrimSpace(parts[1])
	if lu == "px" {
		return Density{Value: v / per, PX: true}, nil
	}
	f, ok := lengthUnits[lu]
	if !ok {
		return Density{}, unitError("density", s, "unknown length unit "+lu)
	}
	return Density{Value: v / f / per}, nil
}

func (d Density) String() string {
	if d.PX {
		return formatFloat(d.Value) + " /px/s"
	}
	return formatFloat(d.Value) + " /m/s"
}

func (d Density) MarshalText() ([]byte, error) { return []byte(d.String()), nil }

func (d *Density) UnmarshalText(b []byte) (err error) {
	*d, err = ParseDensity(string(b))
	return err
}

// Angle is in radians.
type Angle float64

// ParseAngle parses "90 deg", "90°", "1.57 rad", "0.25 turn". A bare 0 is
// allowed.
func ParseAngle(s string) (Angle, error) {
	num, unit := splitNumber(s)
	v, err := parseNumber(num)
	if err != nil {
		return 0, unitError("angle", s, err.Error())
	}
	switch unit {
	case "deg", "°":
		return Angle(v * math.Pi / 180), nil
	case "rad":
		return Angle(v), nil
	case "turn":
		return Angle(v * 2 * math.Pi), nil
	case "":
		if v == 0 {
			return 0, nil
		}
	}
	return 0, unitError("angle", s, "want deg, rad or turn")
}

// Degrees returns the angle in degrees.
func (a Angle) Degrees() float64 { return float64(a) * 180 / math.Pi }

func (a Angle) String() string { return formatFloat(a.Degrees()) + " deg" }

func (a Angle) MarshalText() ([]byte, error) { return []byte(a.String()), nil }

func (a *Angle) UnmarshalText(b []byte) (err error) {
	*a, err = ParseAngle(string(b))
	return err
}

// Fraction is a value in [0, 1].
type Fraction float64

// ParseFraction parses "0.25" or "25%".
func ParseFraction(s string) (Fraction, error) {
	num, unit := splitNumber(s)
	v, err := parseNumber(num)
	if err != nil {
		return 0, unitError("fraction", s, err.Error())
	}
	switch unit {
	case "%":
		v /= 100
	case "":
	default:
		return 0, unitError("fraction", s, "want a number 0–1 or a percentage")
	}
	if v < 0 || v > 1 {
		return 0, unitError("fraction", s, "must be between 0 and 1")
	}
	return Fraction(v), nil
}

func (f Fraction) String() string { return formatFloat(float64(f)) }

func (f Fraction) MarshalText() ([]byte, error) { return []byte(f.String()), nil }

func (f *Fraction) UnmarshalText(b []byte) (err error) {
	*f, err = ParseFraction(string(b))
	return err
}
