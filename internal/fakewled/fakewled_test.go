// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package fakewled

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/jerejones/glowstack/internal/output/ddp"
)

func pkt(flags, seq, typ byte, off uint32, data ...byte) []byte {
	return ddp.AppendPacket(nil, ddp.FlagVer1|flags, seq, typ, off, data)
}

func TestReassembly(t *testing.T) {
	d, err := New(Config{Name: "t", Pixels: 4, Channels: "rgbw"})
	if err != nil {
		t.Fatal(err)
	}
	// Before any push, WLED shows every packet.
	d.HandlePacket(pkt(0, 1, ddp.TypeRGBW, 0, 1, 2, 3, 4), "x")
	if f, st := d.Frame(); st.Frames != 1 || !bytes.Equal(f[:4], []byte{1, 2, 3, 4}) {
		t.Fatalf("%v %+v", f, st)
	}
	// Once a push has been seen, only pushes show.
	d.HandlePacket(pkt(ddp.FlagPush, 2, ddp.TypeRGBW, 4, 5, 6, 7, 8), "x")
	d.HandlePacket(pkt(0, 3, ddp.TypeRGBW, 8, 9, 9, 9, 9), "x")
	f, st := d.Frame()
	if st.Frames != 2 || !bytes.Equal(f, []byte{1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0}) {
		t.Fatalf("after push: %v %+v", f, st)
	}
	// RGB data into an RGBW device: offset in RGB pixels, W 0. Data past
	// the end is ignored.
	d.HandlePacket(pkt(ddp.FlagPush, 3, ddp.TypeRGB, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18), "x")
	f, _ = d.Frame()
	if !bytes.Equal(f[8:], []byte{10, 11, 12, 0, 13, 14, 15, 0}) {
		t.Errorf("rgb into rgbw: %v", f)
	}
	// Query and control packets are rejected.
	d.HandlePacket(pkt(ddp.FlagQuery|ddp.FlagPush, 4, ddp.TypeRGB, 0, 0, 0, 0), "x")
	d.HandlePacket(append(pkt(ddp.FlagPush, 4, ddp.TypeRGB, 0, 0, 0, 0)[:3], ddp.IDStatus), "x")
	if _, st := d.Frame(); st.Rejected != 2 {
		t.Errorf("rejected %d", st.Rejected)
	}
}

func TestJSON(t *testing.T) {
	d, _ := New(Config{Name: "t", Pixels: 7, Channels: "rgbw", AutoWhite: 1, LedMaps: 2})
	for path, check := range map[string]func(map[string]any) bool{
		"/json/info": func(m map[string]any) bool {
			return m["leds"].(map[string]any)["count"] == 7.0 && len(m["maps"].([]any)) == 2
		},
		"/json/cfg": func(m map[string]any) bool {
			live := m["if"].(map[string]any)["live"].(map[string]any)
			return live["no-gc"] == true && live["timeout"] == 25.0
		},
	} {
		w := httptest.NewRecorder()
		d.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		var m map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil || !check(m) {
			t.Errorf("%s: %v %s", path, err, w.Body)
		}
	}
	w := httptest.NewRecorder()
	d.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if !bytes.Contains(w.Body.Bytes(), []byte("fake WLED <b>t</b>")) {
		t.Errorf("page: %s", w.Body)
	}
}
