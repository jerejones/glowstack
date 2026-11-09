// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"reflect"
	"strings"
	"testing"
)

func TestParamsToYAML(t *testing.T) {
	got, err := paramsToYAML([]byte(`{"color":"#ff0000","count":1000000,"speed":0.5,"enabled":true,"list":[{"at":2}]}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`color: '#ff0000'`, "count: 1000000\n", "speed: 0.5\n", "enabled: true\n", "- at: 2\n"} {
		if !strings.Contains(got, want) && !strings.Contains(got, strings.ReplaceAll(want, "'", `"`)) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if got, err := paramsToYAML([]byte(`{}`)); err != nil || got != "" {
		t.Errorf("empty params gave %q, %v", got, err)
	}
}

func TestParamsRoundTrip(t *testing.T) {
	text, err := paramsToYAML([]byte(`{"color":"#00ff00","n":3,"colors":["#111111","#222222"]}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := paramsFromYAML([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"color": "#00ff00", "n": 3, "colors": []any{"#111111", "#222222"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v, want %#v", got, want)
	}
}

func TestParamsFromYAMLErrors(t *testing.T) {
	for _, c := range []struct{ text, want string }{
		{"color: #ff0000\n", "color has no value"},
		{"stops:\n  - at: #123456\n", "stops[0].at has no value"},
		{"- a\n- b\n", "name: value"},
		{"a: 1\n---\nb: 2\n", "---"},
		{"a: [1\n", "line"},
		{"1: x\n", "names must be words"},
	} {
		if _, err := paramsFromYAML([]byte(c.text)); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%q: got %v, want %q", c.text, err, c.want)
		}
	}
	if got, err := paramsFromYAML([]byte("# nothing\n")); err != nil || len(got) != 0 {
		t.Errorf("comment only: %v, %v", got, err)
	}
}
