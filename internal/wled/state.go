// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"bytes"
	"encoding/json"
	"math"
	"net"
	"runtime"
	"strings"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/output"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
	"github.com/jerejones/glowstack/internal/units"
)

// Version is the WLED version the devices report. python-wled reads
// per-segment light capabilities and custom palette ids the WLED 16 way
// from 16.0.0 on.
const Version = "16.0.0"

// build is WLED's "vid", a build date (YYMMDDB).
const build = 2610310

// Product is the devices' "product". python-wled finds no firmware
// repository for it, so Home Assistant offers no firmware updates.
const Product = "Glowstack"

// maxSegments is WLED's segment limit on an ESP32 (info.leds.maxseg).
const maxSegments = 32

// State is WLED's /json/state.
type State struct {
	On         bool       `json:"on"`
	Bri        int        `json:"bri"`
	Transition int        `json:"transition"`
	BS         int        `json:"bs"`
	PS         int        `json:"ps"`
	PL         int        `json:"pl"`
	Ledmap     int        `json:"ledmap"`
	NL         Nightlight `json:"nl"`
	UDPN       UDPSync    `json:"udpn"`
	LOR        int        `json:"lor"`
	Mainseg    int        `json:"mainseg"`
	Seg        []Segment  `json:"seg"`
}

// Nightlight is always reported off: Glowstack has no nightlight.
type Nightlight struct {
	On   bool `json:"on"`
	Dur  int  `json:"dur"`
	Mode int  `json:"mode"`
	TBri int  `json:"tbri"`
	Rem  int  `json:"rem"`
}

// UDPSync is always reported off: Glowstack devices don't sync over UDP.
type UDPSync struct {
	Send bool `json:"send"`
	Recv bool `json:"recv"`
	SGrp int  `json:"sgrp"`
	RGrp int  `json:"rgrp"`
}

// Segment is one segment of /json/state.
type Segment struct {
	ID    int     `json:"id"`
	Start int     `json:"start"`
	Stop  int     `json:"stop"`
	Len   int     `json:"len"`
	Grp   int     `json:"grp"`
	Spc   int     `json:"spc"`
	Of    int     `json:"of"`
	On    bool    `json:"on"`
	Frz   bool    `json:"frz"`
	Bri   int     `json:"bri"`
	CCT   int     `json:"cct"`
	Set   int     `json:"set"`
	LC    int     `json:"lc"`
	N     string  `json:"n"`
	Col   [][]int `json:"col"`
	FX    int     `json:"fx"`
	SX    int     `json:"sx"`
	IX    int     `json:"ix"`
	Pal   int     `json:"pal"`
	C1    int     `json:"c1"`
	C2    int     `json:"c2"`
	C3    int     `json:"c3"`
	Sel   bool    `json:"sel"`
	Rev   bool    `json:"rev"`
	Mi    bool    `json:"mi"`
	O1    bool    `json:"o1"`
	O2    bool    `json:"o2"`
	O3    bool    `json:"o3"`
	SI    int     `json:"si"`
	M12   int     `json:"m12"`
	BM    int     `json:"bm"`
}

// Info is WLED's /json/info, with the fields python-wled reads.
type Info struct {
	Ver        string   `json:"ver"`
	VID        int      `json:"vid"`
	CN         string   `json:"cn"`
	Release    string   `json:"release"`
	Repo       string   `json:"repo"`
	Leds       Leds     `json:"leds"`
	Str        bool     `json:"str"`
	Name       string   `json:"name"`
	UDPPort    int      `json:"udpport"`
	Simplified bool     `json:"simplifiedui"`
	Live       bool     `json:"live"`
	LiveSeg    int      `json:"liveseg"`
	LM         string   `json:"lm"`
	LIP        string   `json:"lip"`
	WS         int      `json:"ws"`
	FXCount    int      `json:"fxcount"`
	PalCount   int      `json:"palcount"`
	CPalCount  int      `json:"cpalcount"`
	UMPalCount int      `json:"umpalcount"`
	CPalMax    int      `json:"cpalmax"`
	Maps       []ledmap `json:"maps"`
	WiFi       WiFi     `json:"wifi"`
	FS         FS       `json:"fs"`
	NDC        int      `json:"ndc"`
	Arch       string   `json:"arch"`
	Core       string   `json:"core"`
	Clock      int      `json:"clock"`
	Flash      int      `json:"flash"`
	LWIP       int      `json:"lwip"`
	FreeHeap   int      `json:"freeheap"`
	Uptime     int64    `json:"uptime"`
	Time       string   `json:"time"`
	Opt        int      `json:"opt"`
	Brand      string   `json:"brand"`
	Product    string   `json:"product"`
	MAC        string   `json:"mac"`
	IP         string   `json:"ip"`
}

// Leds is info.leds.
type Leds struct {
	Count  int   `json:"count"`
	Pwr    int   `json:"pwr"`
	FPS    int   `json:"fps"`
	MaxPwr int   `json:"maxpwr"`
	MaxSeg int   `json:"maxseg"`
	BootPS int   `json:"bootps"`
	SegLC  []int `json:"seglc"`
	LC     int   `json:"lc"`
	RGBW   bool  `json:"rgbw"`
	WV     bool  `json:"wv"`
	CCT    bool  `json:"cct"`
}

type ledmap struct {
	ID int `json:"id"`
}

// WiFi is info.wifi. Glowstack is wired: no BSSID, RSSI 0 (python-wled
// then reports no signal).
type WiFi struct {
	BSSID   string `json:"bssid"`
	RSSI    int    `json:"rssi"`
	Signal  int    `json:"signal"`
	Channel int    `json:"channel"`
	Band    string `json:"band"`
	AP      bool   `json:"ap"`
}

// FS is info.fs. PMT, the presets' modification time, tells python-wled
// when to fetch /presets.json again.
type FS struct {
	U   int   `json:"u"`
	T   int   `json:"t"`
	PMT int64 `json:"pmt"`
}

// Light capabilities (WLED's segment lc).
const (
	lcRGB   = 1
	lcWhite = 2
)

// view is one zone device as of one config generation.
type view struct {
	app.View
	zone  *config.Zone
	segs  []segView
	count int
	lc    int // OR of the segments'
	rgbw  bool
}

type segView struct {
	area        string
	owner       string
	start, stop int // in the device's LED numbering
	lc          int
}

// view returns the zone's device view. Call with d.mu held.
func (d *Devices) view(zone string) (*view, error) {
	cur := d.a.Current()
	var z *config.Zone
	for _, zz := range deviceZones(cur.Config) {
		if zz.ID == zone {
			z = zz
		}
	}
	if z == nil {
		return nil, errNoZone
	}
	zm := d.zoneMem(zone)
	if zm.view != nil && zm.view.Gen == cur.Gen {
		return zm.view, nil
	}
	if zm.mainseg >= len(z.Segments) {
		zm.mainseg = 0
	}
	v := &view{View: cur, zone: z}
	// The device's LEDs are the zone's pixels in global id order, then any
	// segment pixels outside the zone's area. A segment spans its first to
	// its last pixel in that order.
	pos := map[int32]int{}
	add := func(px []int32) {
		for _, p := range px {
			if _, ok := pos[p]; !ok {
				pos[p] = len(pos)
			}
		}
	}
	if a, ok := cur.Layout.Area(z.Area); ok {
		add(a.Pixels)
	}
	for i, s := range z.Segments {
		sv := segView{area: s.Area, owner: stack.WLEDOwner(zone, i), lc: lcRGB}
		if a, ok := cur.Layout.Area(s.Area); ok {
			add(a.Pixels)
			sv.start, sv.stop = math.MaxInt, 0
			for _, p := range a.Pixels {
				sv.start = min(sv.start, pos[p])
				sv.stop = max(sv.stop, pos[p]+1)
				c := cur.Layout.Controllers[cur.Layout.Pixels[p].Controller].Config
				if strings.EqualFold(c.Channels, "rgbw") {
					sv.lc |= lcWhite
				}
			}
			if sv.stop == 0 {
				sv.start = 0
			}
		}
		v.lc |= sv.lc
		v.segs = append(v.segs, sv)
	}
	v.count = len(pos)
	v.rgbw = v.lc&lcWhite != 0
	zm.view = v
	return v, nil
}

// state builds the device's /json/state. Call with d.mu held.
func (d *Devices) state(v *view) *State {
	zm := d.zoneMem(v.zone.ID)
	zb := d.a.Brightness().Zones[v.zone.ID]
	st := &State{
		On: zb > 0, Bri: zm.bri,
		Transition: d.transition(v, zm),
		PS:         -1, PL: -1,
		NL:      Nightlight{Dur: 60, Mode: 1, Rem: -1},
		UDPN:    UDPSync{SGrp: 1},
		Mainseg: zm.mainseg,
		Seg:     []Segment{},
	}
	if st.On {
		st.Bri = max(1, int(math.Round(zb*255)))
	}
	for i := range v.segs {
		seg, l := d.segment(v, i)
		st.Seg = append(st.Seg, seg)
		if i == zm.mainseg && l != nil && l.Preset != "" {
			if n, ok := d.presetNumber(v.Config, l.Preset); ok {
				st.PS = n
			}
		}
	}
	return st
}

// transition is the device's default transition, in 100 ms units: what
// Home Assistant set, or else the config's default fade-out.
func (d *Devices) transition(v *view, zm *zoneMem) int {
	if zm.transition >= 0 {
		return zm.transition
	}
	if f := v.Config.Settings.Fade.Out; f != nil {
		return int(math.Round(time.Duration(*f).Seconds() * 10))
	}
	return 0
}

// segment reports segment i, and its layer if it's on.
func (d *Devices) segment(v *view, i int) (Segment, *stack.Layer) {
	sv := v.segs[i]
	sm := d.segMem(v, i)
	l := d.layer(sv.owner)
	lk := sm.look
	if l != nil {
		lk = lookOf(l)
	}
	rep, _ := d.report(v, i, lk, sm)
	seg := Segment{
		ID: i, Start: sv.start, Stop: sv.stop, Len: sv.stop - sv.start, Grp: 1,
		On: l != nil, Bri: rep.bri, CCT: sm.cct, LC: sv.lc, N: sv.area,
		Col: rep.colJSON(sv.lc&lcWhite != 0),
		FX:  rep.fx, SX: rep.ctl.SX, IX: rep.ctl.IX, Pal: rep.ctl.Pal,
		C1: rep.ctl.C1, C2: rep.ctl.C2, C3: rep.ctl.C3,
		O1: rep.ctl.O1, O2: rep.ctl.O2, O3: rep.ctl.O3,
		Sel: sm.sel, Rev: rep.rev,
	}
	return seg, l
}

// layer is the top live layer with owner, or nil.
func (d *Devices) layer(owner string) *stack.Layer {
	if ls := d.a.Stack.ByOwner(owner); len(ls) > 0 {
		return &ls[0]
	}
	return nil
}

// reported is a look as WLED controls.
type reported struct {
	fx  int
	bri int
	rev bool
	ctl controls
	def *render.Def
	env render.Env
}

func (r *reported) colJSON(white bool) [][]int {
	out := make([][]int, 3)
	for i, c := range r.ctl.Col {
		out[i] = []int{int(c.R), int(c.G), int(c.B)}
		if white {
			out[i] = append(out[i], int(c.W))
		}
	}
	return out
}

// controlSliders are the 0–255 controls, in WLED order.
var controlSliders = []render.Slider{render.SliderSpeed, render.SliderIntensity, render.SliderC1, render.SliderC2, render.SliderC3}

var controlOptions = []render.Slider{render.SliderO1, render.SliderO2, render.SliderO3}

var controlColors = []render.Slider{render.SliderColor0, render.SliderColor1, render.SliderColor2}

// report reads a look's WLED controls: bound ones from its parameters
// (through the bindings' inverse curves), the rest from what was set last.
func (d *Devices) report(v *view, i int, lk look, sm *segMem) (*reported, error) {
	r := &reported{bri: 255, ctl: sm.ctl}
	L, err := v.Engine.Inspect(lk.layer(v.segs[i]))
	if err != nil {
		return r, err
	}
	r.def, r.env = L.Def, render.Env{Pitch: L.Pitch, Palettes: v.Palettes}
	if w := L.Def.WLED; w != nil && w.FX >= 0 {
		r.fx = w.FX
	}
	r.bri = int(math.Round(float64(L.Common.Brightness) * 255))
	r.rev = L.Common.Reverse
	get := func(s render.Slider) (any, bool) {
		x, ok, err := L.Def.GetWLED(L.Params, s, r.env)
		return x, ok && err == nil
	}
	for _, s := range controlSliders {
		if x, ok := get(s); ok {
			n := x.(int)
			if s == render.SliderC3 {
				n = n * 31 / 255 // WLED's c3 is 5 bits
			}
			*r.ctl.slider(s) = n
		}
	}
	for _, s := range controlOptions {
		if x, ok := get(s); ok {
			*r.ctl.option(s) = x.(bool)
		}
	}
	for k, s := range controlColors {
		if x, ok := get(s); ok {
			r.ctl.Col[k] = x.(units.Color)
		}
	}
	if x, ok := get(render.SliderPalette); ok {
		r.ctl.Pal = max(0, x.(int)) // an inline palette has no WLED id
	}
	return r, nil
}

// info builds the device's /json/info. Call with d.mu held.
func (d *Devices) info(v *view) *Info {
	dev := v.zone.Device
	hw, _ := net.ParseMAC(dev.MAC)
	mac := strings.ReplaceAll(hw.String(), ":", "")
	ip := dev.IP
	if ip == "" || net.ParseIP(ip).IsUnspecified() {
		ip = ""
	}
	fxNames := effects.WLEDEffectNames(d.a.Effects)
	now := time.Now()
	in := &Info{
		Ver: Version, VID: build, CN: "Glowstack", Release: "Glowstack", Repo: "unknown",
		Leds: Leds{
			Count: v.count, FPS: int(math.Round(d.a.Ticker.FPS())), MaxSeg: maxSegments,
			LC: v.lc, RGBW: v.rgbw, WV: v.rgbw,
		},
		Name: dev.Name, UDPPort: 21324, LiveSeg: -1, WS: d.wsCount(v.zone.ID),
		FXCount: len(fxNames), PalCount: len(paletteNames(v)),
		Maps: []ledmap{{ID: 0}},
		WiFi: WiFi{Band: "not connected"},
		FS:   FS{U: 4, T: 64, PMT: d.presetsModified(v.Config)},
		NDC:  -1, Arch: runtime.GOARCH, Core: runtime.Version(),
		Uptime: int64(now.Sub(d.started).Seconds()),
		Time:   now.Format("2006-1-2, 15:04:05"),
		// Filesystem only: no OTA, so python-wled never tries to upgrade.
		Opt:   0x08,
		Brand: "WLED", Product: Product, MAC: mac, IP: ip,
	}
	for _, s := range v.segs {
		in.Leds.SegLC = append(in.Leds.SegLC, s.lc)
	}
	in.Leds.Pwr = d.current(v)
	return in
}

// current estimates the zone's current draw in mA: the drawn current of
// every controller with pixels in the zone, from the output stage.
func (d *Devices) current(v *view) int {
	pr, ok := d.a.Stage().(output.PowerReporter)
	if !ok {
		return 0
	}
	ctrls := map[string]bool{}
	if a, ok := v.Layout.Area(v.zone.Area); ok {
		for _, p := range a.Pixels {
			ctrls[v.Layout.Controllers[v.Layout.Pixels[p].Controller].ID] = true
		}
	}
	total := 0.0
	for _, m := range pr.Power().Controllers {
		if ctrls[m.Controller] {
			total += m.DrawnMA
		}
	}
	return int(math.Round(total))
}

// paletteNames is /json/pal: names by WLED palette id. WLED lists only its
// fixed palettes and names custom ones (ids 200 down) "Custom n" from
// info.cpalcount. Glowstack lists its user palettes' own names at their
// ids instead, with nulls between, which python-wled skips; cpalcount is 0.
func paletteNames(v *view) []any {
	var out []any
	for _, p := range v.Palettes.WLEDList() {
		for len(out) <= p.WLED {
			out = append(out, nil)
		}
		out[p.WLED] = p.Name
	}
	return out
}

// fxData is /json/fxdata: per fx id, WLED's metadata string saying which
// sliders, options and colours an effect uses and whether it takes a
// palette, labelled with Glowstack's parameter names.
func fxData(r *render.Registry) []string {
	names := effects.WLEDEffectNames(r)
	out := make([]string, len(names))
	for _, def := range effects.WLEDEffects(r) {
		label := func(s render.Slider) string {
			if bs := def.Bindings(s); len(bs) > 0 {
				return paramLabel(bs[0].Param)
			}
			return ""
		}
		var ctl []string
		for _, s := range append(append([]render.Slider{}, controlSliders...), controlOptions...) {
			ctl = append(ctl, label(s))
		}
		var cols []string
		for _, s := range controlColors {
			cols = append(cols, label(s))
		}
		pal := ""
		if len(def.Bindings(render.SliderPalette)) > 0 {
			pal = "!"
		}
		out[def.WLED.FX] = strings.Join([]string{trimEmpty(ctl), trimEmpty(cols), pal, "1"}, ";")
	}
	return out
}

func trimEmpty(s []string) string {
	for len(s) > 0 && s[len(s)-1] == "" {
		s = s[:len(s)-1]
	}
	return strings.Join(s, ",")
}

// paramLabel turns a parameter path into a slider label: "sparkle.density"
// is "Sparkle density", "bands.1.width" is "Bands 2 width".
func paramLabel(path string) string {
	parts := strings.Split(path, ".")
	for i, p := range parts {
		if n, err := parseIndex(p); err == nil {
			parts[i] = itoa(n + 1)
		}
		parts[i] = strings.ReplaceAll(parts[i], "_", " ")
	}
	s := strings.Join(parts, " ")
	s = strings.NewReplacer(",", " ", ";", " ").Replace(s)
	if s == "" {
		return "!"
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// cfgJSON is a minimal /json/cfg: the LED setup python-wled reads (one
// output covering every LED; SK6812 RGBW or WS2812 RGB).
func cfgJSON(v *view) map[string]any {
	typ := 22
	if v.rgbw {
		typ = 30
	}
	return map[string]any{
		"id": map[string]any{"name": v.zone.Device.Name, "mdns": mdnsHost(v.zone.ID)},
		"hw": map[string]any{"led": map[string]any{
			"total": v.count, "maxseg": maxSegments, "cct": false, "cr": false, "cb": 0, "rgbwm": 255,
			"ins": []map[string]any{{"start": 0, "len": v.count, "type": typ, "order": 0, "rev": false, "skip": 0, "rgbwm": 0}},
		}},
	}
}

// marshal is json.Marshal without HTML escaping, like WLED's output.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}
