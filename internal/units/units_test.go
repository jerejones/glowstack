// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package units

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9*math.Max(1, math.Abs(b)) }

func TestParseLength(t *testing.T) {
	tests := []struct {
		in   string
		want Length
	}{
		{"0.5 m", Length{Value: 0.5}},
		{"0.5m", Length{Value: 0.5}},
		{"20 px", Length{Value: 20, PX: true}},
		{"20px", Length{Value: 20, PX: true}},
		{"3 ft", Length{Value: 0.9144}},
		{"12 in", Length{Value: 0.3048}},
		{"25 cm", Length{Value: 0.25}},
		{"5 mm", Length{Value: 0.005}},
		{"1/60 m", Length{Value: 1.0 / 60}},
		{"-2 m", Length{Value: -2}},
		{"1e-2 m", Length{Value: 0.01}},
		{"0", Length{}},
	}
	for _, tt := range tests {
		got, err := ParseLength(tt.in)
		if err != nil {
			t.Errorf("ParseLength(%q): %v", tt.in, err)
			continue
		}
		if got.PX != tt.want.PX || !near(got.Value, tt.want.Value) {
			t.Errorf("ParseLength(%q) = %+v, want %+v", tt.in, got, tt.want)
		}
	}
	for _, bad := range []string{"", "5", "m", "5 furlongs", "1/0 m", "abc m"} {
		if _, err := ParseLength(bad); err == nil {
			t.Errorf("ParseLength(%q): want error", bad)
		}
	}
	if m := (Length{Value: 20, PX: true}).Metres(1.0 / 60); !near(m, 1.0/3) {
		t.Errorf("Metres = %v", m)
	}
}

func TestParseSpeed(t *testing.T) {
	tests := []struct {
		in   string
		want Speed
	}{
		{"0.02 m/s", Speed{Value: 0.02}},
		{"1 px/8s", Speed{Value: 0.125, PX: true}},
		{"1 px/8 s", Speed{Value: 0.125, PX: true}},
		{"20 px/s", Speed{Value: 20, PX: true}},
		{"-3 ft/min", Speed{Value: -3 * 0.3048 / 60}},
		{"2 m/min", Speed{Value: 2.0 / 60}},
		{"500 mm/s", Speed{Value: 0.5}},
		{"0", Speed{}},
	}
	for _, tt := range tests {
		got, err := ParseSpeed(tt.in)
		if err != nil {
			t.Errorf("ParseSpeed(%q): %v", tt.in, err)
			continue
		}
		if got.PX != tt.want.PX || !near(got.Value, tt.want.Value) {
			t.Errorf("ParseSpeed(%q) = %+v, want %+v", tt.in, got, tt.want)
		}
	}
	for _, bad := range []string{"1 m", "1 m/", "1 m/0s", "1 x/s", "1 m/fortnight"} {
		if _, err := ParseSpeed(bad); err == nil {
			t.Errorf("ParseSpeed(%q): want error", bad)
		}
	}
}

func TestParseDuration(t *testing.T) {
	tests := []struct {
		in   string
		want time.Duration
	}{
		{"250 ms", 250 * time.Millisecond},
		{"5 s", 5 * time.Second},
		{"5s", 5 * time.Second},
		{"1.5 min", 90 * time.Second},
		{"2 h", 2 * time.Hour},
		{"1m30s", 90 * time.Second},
		{"0", 0},
	}
	for _, tt := range tests {
		got, err := ParseDuration(tt.in)
		if err != nil || time.Duration(got) != tt.want {
			t.Errorf("ParseDuration(%q) = %v, %v; want %v", tt.in, time.Duration(got), err, tt.want)
		}
	}
	for _, bad := range []string{"5", "-1 s", "soon"} {
		if _, err := ParseDuration(bad); err == nil {
			t.Errorf("ParseDuration(%q): want error", bad)
		}
	}
	if s := Duration(250 * time.Millisecond).String(); s != "250 ms" {
		t.Errorf("String = %q", s)
	}
	if s := Duration(90 * time.Second).String(); s != "90 s" {
		t.Errorf("String = %q", s)
	}
}

func TestParseRateDensity(t *testing.T) {
	for in, want := range map[string]float64{"2 /s": 2, "2/s": 2, "30 /min": 0.5, "1 /250ms": 4} {
		got, err := ParseRate(in)
		if err != nil || !near(float64(got), want) {
			t.Errorf("ParseRate(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := ParseRate("2 s"); err == nil {
		t.Error("ParseRate(2 s): want error")
	}
	tests := []struct {
		in   string
		want Density
	}{
		{"0.5 /m/s", Density{Value: 0.5}},
		{"0.5/m/s", Density{Value: 0.5}},
		{"6 /ft/min", Density{Value: 6 / 0.3048 / 60}},
		{"0.01 /px/s", Density{Value: 0.01, PX: true}},
	}
	for _, tt := range tests {
		got, err := ParseDensity(tt.in)
		if err != nil || got.PX != tt.want.PX || !near(got.Value, tt.want.Value) {
			t.Errorf("ParseDensity(%q) = %+v, %v; want %+v", tt.in, got, err, tt.want)
		}
	}
	if d := (Density{Value: 0.01, PX: true}).PerMetreSecond(0.01); !near(d, 1) {
		t.Errorf("PerMetreSecond = %v", d)
	}
	for _, bad := range []string{"0.5 /m", "0.5 m/s", "0.5 /x/s"} {
		if _, err := ParseDensity(bad); err == nil {
			t.Errorf("ParseDensity(%q): want error", bad)
		}
	}
}

func TestParseAngleFraction(t *testing.T) {
	for in, want := range map[string]float64{"90 deg": math.Pi / 2, "90°": math.Pi / 2, "1 rad": 1, "0.5 turn": math.Pi, "0": 0} {
		got, err := ParseAngle(in)
		if err != nil || !near(float64(got), want) {
			t.Errorf("ParseAngle(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := ParseAngle("90"); err == nil {
		t.Error("ParseAngle(90): want error")
	}
	for in, want := range map[string]float64{"0.25": 0.25, "25%": 0.25, "1": 1, "0": 0} {
		got, err := ParseFraction(in)
		if err != nil || !near(float64(got), want) {
			t.Errorf("ParseFraction(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"1.5", "-0.1", "50 m"} {
		if _, err := ParseFraction(bad); err == nil {
			t.Errorf("ParseFraction(%q): want error", bad)
		}
	}
}

func TestParseColor(t *testing.T) {
	tests := []struct {
		in   string
		want Color
		str  string
	}{
		{"#ff5a00", Color{R: 0xff, G: 0x5a}, "#ff5a00"},
		{"#FF5A00", Color{R: 0xff, G: 0x5a}, "#ff5a00"},
		{"#ff8000/40", Color{R: 0xff, G: 0x80, W: 0x40, HasW: true}, "#ff8000/40"},
		{"#ff800040", Color{R: 0xff, G: 0x80, W: 0x40, HasW: true}, "#ff8000/40"},
		{"#000000/00", Color{HasW: true}, "#000000/00"},
		{"#f80", Color{R: 0xff, G: 0x88}, "#ff8800"},
	}
	for _, tt := range tests {
		got, err := ParseColor(tt.in)
		if err != nil || got != tt.want {
			t.Errorf("ParseColor(%q) = %+v, %v; want %+v", tt.in, got, err, tt.want)
			continue
		}
		if got.String() != tt.str {
			t.Errorf("String(%q) = %q, want %q", tt.in, got.String(), tt.str)
		}
	}
	for _, bad := range []string{"ff5a00", "#ff5a0", "#gg0000", "#ff5a00/4", "#ff5a00/zz"} {
		if _, err := ParseColor(bad); err == nil {
			t.Errorf("ParseColor(%q): want error", bad)
		}
	}
}

func TestTextRoundTrip(t *testing.T) {
	type doc struct {
		L Length
		S Speed
		D Duration
		R Rate
		N Density
		A Angle
		F Fraction
		C Color
	}
	in := doc{
		L: Length{Value: 20, PX: true}, S: Speed{Value: -0.5}, D: Duration(250 * time.Millisecond),
		R: 2, N: Density{Value: 0.5}, A: Angle(math.Pi), F: 0.5, C: Color{R: 1, G: 2, B: 3, W: 4, HasW: true},
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out doc
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	if !near(float64(out.A), float64(in.A)) {
		t.Errorf("angle %v != %v", out.A, in.A)
	}
	out.A = in.A
	if out != in {
		t.Errorf("round trip %s: got %+v want %+v", b, out, in)
	}
}
