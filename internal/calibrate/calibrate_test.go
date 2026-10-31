// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/clock"
	"github.com/jerejones/glowstack/internal/color"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/effects"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/render"
	"github.com/jerejones/glowstack/internal/stack"
)

const exampleDir = "../../examples/fictional"

var t0 = time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)

type fixture struct {
	t            *testing.T
	config, data string
	clock        *clock.Manual
	app          *app.App
	m            *Manager
	pix          []color.Color
}

func copyDir(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

func registerAll(r *render.Registry) error {
	if err := effects.Register(r); err != nil {
		return err
	}
	return Register(r)
}

// newFixture runs the fictional installation from copies of its folders.
// edit may change the config copy first; data "" starts with an empty data
// folder.
func newFixture(t *testing.T, data string, edit func(dir string)) *fixture {
	t.Helper()
	f := &fixture{t: t, clock: clock.NewManual(t0), config: copyDir(t, exampleDir+"/config")}
	if data == "" {
		f.data = t.TempDir()
	} else {
		f.data = copyDir(t, data)
	}
	if edit != nil {
		edit(f.config)
	}
	f.start()
	return f
}

func (f *fixture) start() {
	f.t.Helper()
	a, err := app.New(app.Options{ConfigDir: f.config, DataDir: f.data, Clock: f.clock,
		Effects: registerAll, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { a.Close() })
	a.OnFrame(func(_ clock.Frame, buf *render.Buffer) { f.pix = append(f.pix[:0], buf.Pix...) })
	f.app, f.m = a, New(a)
}

// frame renders one frame (after time moves on, so fades finish).
func (f *fixture) frame() {
	f.t.Helper()
	f.clock.Advance(100 * time.Millisecond)
	if err := f.app.RenderFrame(clock.Frame{Time: f.clock.Now(), T: clock.Seconds(f.clock.Now())}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) px(controller string, index int) color.Color {
	f.t.Helper()
	g, ok := f.app.Current().Layout.PixelID(controller, index)
	if !ok {
		f.t.Fatalf("no pixel %s:%d", controller, index)
	}
	return f.pix[g]
}

func (f *fixture) anchor(run, node string) layout.Anchor {
	f.t.Helper()
	l := f.app.Current().Layout
	r, err := findRun(l, run)
	if err != nil {
		f.t.Fatal(err)
	}
	a, ok := anchorOn(l, r, node)
	if !ok {
		f.t.Fatalf("no anchor %s on %s", node, run)
	}
	return a
}

func (f *fixture) file() string {
	f.t.Helper()
	b, err := os.ReadFile(filepath.Join(f.data, config.AnchorsFileName))
	if err != nil {
		f.t.Fatal(err)
	}
	return string(b)
}

func (f *fixture) ok(st State, err error) State {
	t := f.t
	t.Helper()
	if err != nil {
		var e *Error
		if errors.As(err, &e) {
			t.Fatalf("%v %v", err, e.Details)
		}
		t.Fatal(err)
	}
	return st
}

func same(a, b color.Color) bool {
	d := func(x, y float32) bool { return x-y < 1e-4 && y-x < 1e-4 }
	return d(a.R, b.R) && d(a.G, b.G) && d(a.B, b.B) && d(a.W, b.W)
}

// unmeasureNW makes shed-nw an estimate too, so the eave has three
// estimated anchors in a row between its ends.
func unmeasureNW(dir string) {
	p := filepath.Join(dir, config.LayoutFileName)
	b, _ := os.ReadFile(p)
	s := strings.Replace(string(b), "{ node: shed-nw, index: 305, source: measured }", "{ node: shed-nw }", 1)
	_ = os.WriteFile(p, []byte(s), 0o644)
}

func TestConfirmWritesAnchorsAndReestimatesNeighbours(t *testing.T) {
	f := newFixture(t, "", unmeasureNW)
	nw := f.anchor("shed-eave", "shed-nw")
	sw := f.anchor("shed-eave", "shed-sw")
	if nw.Source != layout.SourceEstimated || sw.Source != layout.SourceEstimated {
		t.Fatalf("setup: nw %+v sw %+v", nw, sw)
	}
	st := f.ok(f.m.Select(Target{Kind: KindAnchor, Run: "shed-eave", Node: "shed-nw"}))
	if st.Cursors[0].Index != nw.Index || st.Cursors[0].Source != layout.SourceEstimated {
		t.Fatalf("cursor = %+v", st.Cursors[0])
	}
	f.ok(f.m.Nudge(-1, 10))
	f.ok(f.m.Nudge(-1, 10))
	st = f.ok(f.m.Set(-1, 320))
	if st.Cursors[0].Index != 320 || !st.Cursors[0].Moved {
		t.Fatalf("cursor after set = %+v", st.Cursors[0])
	}
	st = f.ok(f.m.Confirm(ConfirmOptions{}))

	if !strings.Contains(f.file(), "  - { run: shed-eave, node: shed-nw, index: 320, source: measured }\n") {
		t.Errorf("anchors.yaml:\n%s", f.file())
	}
	if a := f.anchor("shed-eave", "shed-nw"); a.Index != 320 || a.Source != layout.SourceMeasured {
		t.Errorf("shed-nw after confirm = %+v", a)
	}
	// shed-sw is 60% of the drawn way from the run's start to shed-nw, so
	// it's re-estimated within that stretch: 0.6 × 320.5 = 192.3, pixel 192.
	if a := f.anchor("shed-eave", "shed-sw"); a.Index != 192 || a.Source != layout.SourceEstimated {
		t.Errorf("shed-sw re-estimated = %+v, want 192 (was %d)", a, sw.Index)
	}
	if st.Cursors[0].Source != layout.SourceMeasured || st.Cursors[0].Moved {
		t.Errorf("cursor after confirm = %+v", st.Cursors[0])
	}
	if st.Measured != 1 || st.Anchors != 4 {
		t.Errorf("progress %d/%d", st.Measured, st.Anchors)
	}

	// Next goes to the first unmeasured anchor in run order.
	st = f.ok(f.m.Next(1))
	if st.Target.Node != "shed-eave-mid" {
		t.Errorf("next = %v", st.Target)
	}
	st = f.ok(f.m.Next(1))
	if st.Target.Node != "tower-top" {
		t.Errorf("next = %v", st.Target)
	}
	st = f.ok(f.m.Next(1))
	if st.Target.Node != "shed-sw" {
		t.Errorf("next wraps to %v", st.Target)
	}

	// Forgetting it brings back the estimate.
	f.ok(f.m.Forget(&Target{Kind: KindAnchor, Run: "shed-eave", Node: "shed-nw"}))
	if a := f.anchor("shed-eave", "shed-nw"); a.Index != nw.Index || a.Source != layout.SourceEstimated {
		t.Errorf("shed-nw after forget = %+v", a)
	}
}

func TestSessionLightsTheGuessAndEndRestoresTheStack(t *testing.T) {
	f := newFixture(t, exampleDir+"/data", nil)
	if _, err := f.app.Stack.Push(stack.Layer{Owner: stack.OwnerAPI, Target: "everything", Effect: "solid",
		Params: map[string]any{"color": "#123456", "fade_in": "0s"}}); err != nil {
		t.Fatal(err)
	}
	f.frame()
	before := slices.Clone(f.pix)
	base := before[0]

	mid := f.anchor("shed-eave", "shed-eave-mid")
	st := f.ok(f.m.Start(&Target{Kind: KindAnchor, Run: "shed-eave", Node: "shed-eave-mid"}))
	if len(st.Layers) != 1 || st.Controllers[0].ID != "shed" || st.Controllers[0].Sending != nil {
		t.Fatalf("state = %+v", st)
	}
	f.frame()
	at := mid.Index
	for _, c := range []struct {
		i    int
		want color.Color
	}{
		{at, colFocus}, {at + 10, colAfter}, {at - 10, colBefore}, {at + 1, colNearA}, {at - 1, colNearB},
		{at + 5, colDim}, {at + 80, colAfter}, {at - 100, colBefore}, {at - 110, colDim},
	} {
		if got := f.px("shed", c.i); !same(got, c.want) {
			t.Errorf("shed:%d = %+v, want %+v", c.i, got, c.want)
		}
	}
	// Outside the run (the tower, the yard) the house look is untouched.
	if got := f.px("shed", 500); !same(got, base) {
		t.Errorf("tower pixel = %+v, want the house's %+v", got, base)
	}
	if got := f.px("yard", 10); !same(got, base) {
		t.Errorf("yard pixel = %+v, want the house's %+v", got, base)
	}

	// The calibration layer is never saved.
	data, err := f.app.Stack.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "calibration") {
		t.Errorf("state.json has the calibration layer:\n%s", data)
	}

	// Nudging moves the white pixel (+1 is towards the run's end).
	f.ok(f.m.Nudge(-1, 1))
	f.frame()
	if !same(f.px("shed", at+1), colFocus) || !same(f.px("shed", at), colNearB) {
		t.Errorf("after nudge: %v %v", f.px("shed", at+1), f.px("shed", at))
	}

	f.m.End()
	f.frame()
	f.frame()
	if !slices.EqualFunc(f.pix, before, same) {
		t.Error("ending the session didn't restore the frame")
	}
	if n := len(f.app.Stack.ByOwner(stack.OwnerCalibration)); n != 0 {
		t.Errorf("%d calibration layers left", n)
	}
}

func TestReversedRunRulerFollowsTheRun(t *testing.T) {
	// The porch is wired from its east end (indices 479 → 390), so +1
	// moves to a lower index and "after" marks are below the focus.
	f := newFixture(t, exampleDir+"/data", nil)
	f.ok(f.m.Select(Target{Kind: KindEnd, Run: "porch", End: EndLast}))
	st := f.ok(f.m.Nudge(-1, 1))
	if st.Cursors[0].Index != 389 {
		t.Fatalf("porch last end nudged to %d, want 389", st.Cursors[0].Index)
	}
	f.ok(f.m.Nudge(-1, -11))
	f.frame()
	// Cursor at 400; the run's start is towards 479.
	if !same(f.px("yard", 400), colFocus) || !same(f.px("yard", 410), colBefore) || !same(f.px("yard", 390), colAfter) {
		t.Errorf("porch ruler: %v %v %v", f.px("yard", 400), f.px("yard", 410), f.px("yard", 390))
	}
	// Past the run's end (index 389 is the fence's controller pixel, not in
	// the porch) the end view is black unless marked.
	if !same(f.px("yard", 389), colOff) {
		t.Errorf("yard:389 = %v, want black", f.px("yard", 389))
	}
	f.ok(f.m.Set(-1, 392))
	f.ok(f.m.Confirm(ConfirmOptions{}))
	if !strings.Contains(f.file(), "  - { run: porch, last: 392 }\n") {
		t.Errorf("anchors.yaml:\n%s", f.file())
	}
	r, _ := findRun(f.app.Current().Layout, "porch")
	if r.Last != 392 || r.Count != 88 {
		t.Errorf("porch after confirm: last %d, %d px", r.Last, r.Count)
	}
}

func TestCalibrationLayerStaysOnTop(t *testing.T) {
	f := newFixture(t, exampleDir+"/data", nil)
	f.ok(f.m.Start(nil))
	st := f.m.State()
	if st.Target == nil || st.Target.Node != "shed-eave-mid" {
		t.Fatalf("start picks %v, want the first unmeasured anchor", st.Target)
	}
	if _, err := f.app.Stack.Push(stack.Layer{Owner: stack.OwnerAPI, Target: "shed", Effect: "solid"}); err != nil {
		t.Fatal(err)
	}
	if err := f.m.Keep(); err != nil {
		t.Fatal(err)
	}
	top := f.app.Stack.List()
	if top[0].Owner != stack.OwnerCalibration || top[1].Owner != stack.OwnerAPI {
		t.Errorf("stack = %s, %s", top[0].Owner, top[1].Owner)
	}
	// Removed from outside: put back.
	f.app.Stack.Clear()
	if err := f.m.Keep(); err != nil {
		t.Fatal(err)
	}
	if got := f.app.Stack.ByOwner(stack.OwnerCalibration); len(got) != 1 {
		t.Errorf("calibration layers after clear+keep: %d", len(got))
	}
}

func TestAnchorsYAMLOverridesLayoutOnReloadAndRestart(t *testing.T) {
	f := newFixture(t, exampleDir+"/data", nil)
	if a := f.anchor("shed-eave", "shed-nw"); a.Index != 305 {
		t.Fatalf("layout.yaml's shed-nw = %+v", a)
	}
	body := "schema: 1\nanchors:\n  - { run: shed-eave, node: shed-nw, index: 312 }\n" +
		"gaps:\n  - { from: gate-w, to: gate-e, length: 1.3 m }\n"
	if err := os.WriteFile(filepath.Join(f.data, config.AnchorsFileName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.Reload(); err != nil {
		t.Fatal(err)
	}
	if a := f.anchor("shed-eave", "shed-nw"); a.Index != 312 || a.Source != layout.SourceMeasured {
		t.Errorf("after reload shed-nw = %+v", a)
	}
	gap := gapEdge(t, f.app.Current().Layout, "gate-w", "gate-e")
	if gap.Length != 1.3 {
		t.Errorf("gap = %v", gap.Length)
	}
	// A session that's running follows the reload.
	f.ok(f.m.Select(Target{Kind: KindAnchor, Run: "shed-eave", Node: "shed-nw"}))
	if err := f.app.Stack.Save(f.app.Store); err != nil {
		t.Fatal(err)
	}
	// After a restart, anchors.yaml still wins and no calibration layer
	// comes back.
	f.app.Close()
	f.start()
	if a := f.anchor("shed-eave", "shed-nw"); a.Index != 312 {
		t.Errorf("after restart shed-nw = %+v", a)
	}
	if n := len(f.app.Stack.ByOwner(stack.OwnerCalibration)); n != 0 {
		t.Errorf("restart restored %d calibration layers", n)
	}
}

func gapEdge(t *testing.T, l *layout.Layout, from, to string) layout.Edge {
	t.Helper()
	a, _ := l.NodeIndex(from)
	b, _ := l.NodeIndex(to)
	for _, e := range l.Edges {
		if e.Kind == layout.Gap && (e.From == a && e.To == b || e.From == b && e.To == a) {
			return e
		}
	}
	t.Fatalf("no gap %s–%s", from, to)
	return layout.Edge{}
}

func TestLinkGapAndDead(t *testing.T) {
	f := newFixture(t, exampleDir+"/data", nil)
	top, mid := f.anchor("tower", "tower-top"), f.anchor("shed-eave", "shed-eave-mid")

	// The link's two nodes: each lit on its own run, nudged one at a time.
	st := f.ok(f.m.Select(Target{Kind: KindLink, From: "tower-top", To: "shed-eave-mid"}))
	if len(st.Cursors) != 2 || st.Cursors[0].Run != "tower" || st.Cursors[1].Run != "shed-eave" || len(st.Layers) != 2 {
		t.Fatalf("link state = %+v", st)
	}
	f.ok(f.m.Nudge(1, -3))
	f.ok(f.m.Nudge(0, 2))
	f.frame()
	if !same(f.px("shed", top.Index+2), colFocus) || !same(f.px("shed", mid.Index-3), colFocus) {
		t.Errorf("link pixels: %v %v", f.px("shed", top.Index+2), f.px("shed", mid.Index-3))
	}
	f.ok(f.m.Confirm(ConfirmOptions{}))
	if a := f.anchor("tower", "tower-top"); a.Index != top.Index+2 || a.Source != layout.SourceMeasured {
		t.Errorf("tower-top = %+v", a)
	}
	if a := f.anchor("shed-eave", "shed-eave-mid"); a.Index != mid.Index-3 || a.Source != layout.SourceMeasured {
		t.Errorf("shed-eave-mid = %+v", a)
	}

	// The gate: its ends are run ends, so they're fixed; the length is typed in.
	st = f.ok(f.m.Select(Target{Kind: KindGap, From: "gate-w", To: "gate-e"}))
	if !st.Cursors[0].Fixed || st.Cursors[0].Index != 239 || st.Cursors[1].Index != 240 || *st.Length != 1.2 {
		t.Fatalf("gap state = %+v", st)
	}
	if _, err := f.m.Nudge(-1, 1); err == nil {
		t.Error("nudged a fixed cursor")
	}
	if _, err := f.m.Confirm(ConfirmOptions{}); err == nil {
		t.Error("confirmed a gap without a length")
	}
	f.ok(f.m.Confirm(ConfirmOptions{Length: "4 ft"}))
	if g := gapEdge(t, f.app.Current().Layout, "gate-w", "gate-e"); g.Length < 1.2191 || g.Length > 1.2193 {
		t.Errorf("gap = %v m, want 4 ft", g.Length)
	}

	// Dead pixels: a range, both ends nudgeable.
	f.ok(f.m.Select(Target{Kind: KindDead, Controller: "yard", Indices: []int{100, 101}}))
	f.ok(f.m.Nudge(1, 2))
	f.frame()
	if !same(f.px("yard", 100), colMark) || !same(f.px("yard", 103), colFocus) {
		t.Errorf("dead marks: %v %v", f.px("yard", 100), f.px("yard", 103))
	}
	f.ok(f.m.Confirm(ConfirmOptions{}))
	g, _ := f.app.Current().Layout.PixelID("yard", 102)
	if !f.app.Current().Layout.Pixels[g].Dead {
		t.Error("yard:102 isn't dead")
	}

	want := Header + `schema: 1
anchors:
  - { run: shed-eave, node: shed-sw, index: 186, source: measured }
  - { run: shed-eave, node: shed-eave-mid, index: 390, source: measured }
  - { run: tower, node: tower-top, index: 546, source: measured }
gaps:
  - { from: gate-w, to: gate-e, length: 1.2192 m }
dead:
  - { controller: yard, indices: [100, 103] }
`
	if got := f.file(); got != want {
		t.Errorf("anchors.yaml:\n%s\nwant:\n%s", got, want)
	}

	// Un-marking part of the range splits it.
	f.ok(f.m.Forget(&Target{Kind: KindDead, Controller: "yard", Indices: []int{101, 102}}))
	if !strings.Contains(f.file(), "[100, 100] }\n  - { controller: yard, indices: [103, 103] }") {
		t.Errorf("after forget:\n%s", f.file())
	}
}

func TestMeasurementThatDoesntFitIsNotWritten(t *testing.T) {
	f := newFixture(t, exampleDir+"/data", nil)
	before := f.file()
	// shed-sw past the measured shed-nw (305): out of order.
	f.ok(f.m.Select(Target{Kind: KindAnchor, Run: "shed-eave", Node: "shed-sw"}))
	f.ok(f.m.Set(-1, 320))
	_, err := f.m.Confirm(ConfirmOptions{})
	var e *Error
	if !errors.As(err, &e) || e.Status != StatusConfig || len(e.Details) == 0 || !strings.Contains(e.Details[0], "in order") {
		t.Fatalf("confirm error = %v (%+v)", err, e)
	}
	if f.file() != before {
		t.Errorf("anchors.yaml changed:\n%s", f.file())
	}
	if a := f.anchor("shed-eave", "shed-sw"); a.Index != 186 {
		t.Errorf("shed-sw = %+v", a)
	}
}

func TestBandsAndErrors(t *testing.T) {
	f := newFixture(t, exampleDir+"/data", nil)
	f.ok(f.m.Select(Target{Kind: KindBands, Controller: "yard"}))
	f.frame()
	for _, c := range []struct {
		i    int
		want color.Color
	}{{0, colFocus}, {5, colBlockA}, {110, colFocus}, {155, colBlockB}, {205, colBlockA}} {
		if got := f.px("yard", c.i); !same(got, c.want) {
			t.Errorf("yard:%d = %v, want %v", c.i, got, c.want)
		}
	}
	if _, err := f.m.Confirm(ConfirmOptions{}); err == nil {
		t.Error("confirmed the band view")
	}
	for _, tt := range []Target{
		{Kind: KindAnchor, Run: "nope", Node: "x"},
		{Kind: KindAnchor, Run: "shed-eave", Node: "shed-se"}, // a run end
		{Kind: KindEnd, Run: "porch", End: "middle"},
		{Kind: KindLink, From: "gate-w", To: "gate-e"}, // a gap, not a link
		{Kind: KindDead, Controller: "yard", Indices: []int{900}},
		{Kind: "corner"},
	} {
		if _, err := f.m.Select(tt); err == nil {
			t.Errorf("selected %+v", tt)
		}
	}
	if _, err := f.m.Forget(&Target{Kind: KindGap, From: "gate-w", To: "gate-e"}); err == nil {
		t.Error("forgot a gap that was never measured")
	}
}

func TestNoDataFolder(t *testing.T) {
	f := &fixture{t: t, clock: clock.NewManual(t0), config: exampleDir + "/config"}
	a, err := app.New(app.Options{ConfigDir: f.config, Clock: f.clock, Effects: registerAll, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	f.app, f.m = a, New(a)
	f.ok(f.m.Start(nil))
	if _, err := f.m.Confirm(ConfirmOptions{}); err == nil || !strings.Contains(err.Error(), "data folder") {
		t.Errorf("confirm without a data folder: %v", err)
	}
}

func TestEffectIsInternal(t *testing.T) {
	r := render.NewRegistry()
	if err := registerAll(r); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.Get(EffectID); !ok {
		t.Fatal("not registered")
	}
	for _, d := range r.All() {
		if d.ID == EffectID {
			t.Error("listed by All")
		}
	}
}

func TestCalibrationIgnoresMappingDomain(t *testing.T) {
	f := newFixture(t, "", func(dir string) {
		p := filepath.Join(dir, config.MappingsFileName)
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(strings.Replace(string(b), "default: front-sweep", "default: from-gate", 1)), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	// The porch is outside the default flow's domain. Calibration still
	// needs to identify its physical pixels.
	f.ok(f.m.Select(Target{Kind: KindEnd, Run: "porch", End: EndLast}))
	f.frame()
	if got := f.px("yard", 390); !same(got, colFocus) {
		t.Errorf("unreached run's cursor = %v, want white", got)
	}
	// Index 482 has no run or mapping coordinate. A run-end cursor must
	// reach it so an underestimated run can be extended.
	f.ok(f.m.Select(Target{Kind: KindEnd, Run: "shed-eave", End: EndLast}))
	f.ok(f.m.Set(-1, 482))
	f.frame()
	if got := f.px("shed", 482); !same(got, colFocus) {
		t.Errorf("unassigned pixel's cursor = %v, want white", got)
	}
	f.ok(f.m.Select(Target{Kind: KindBands, Controller: "shed"}))
	f.frame()
	if got := f.px("shed", 482); !same(got, colBlockA) {
		t.Errorf("unassigned pixel's band = %v, want %v", got, colBlockA)
	}
}

func TestKeepRestoresEditedCalibrationEffect(t *testing.T) {
	f := newFixture(t, "", nil)
	st := f.ok(f.m.Start(nil))
	// A normal layer edit can switch effects. The stay-on-top tick must
	// restore the calibration pattern as well as its target and params.
	if _, err := f.app.Stack.Edit(st.Layers[0], func(l *stack.Layer) {
		l.Effect = "solid"
		l.Params = map[string]any{"color": "#ff0000"}
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.m.Keep(); err != nil {
		t.Fatal(err)
	}
	f.frame()
	if got := f.px(st.Cursors[0].Controller, st.Cursors[0].Index); !same(got, colFocus) {
		t.Errorf("cursor after keep = %v, want white", got)
	}
}

func TestConfirmDoesNotWriteWhenSavedPresetsCannotBeRead(t *testing.T) {
	f := newFixture(t, exampleDir+"/data", nil)
	before := f.file()
	f.ok(f.m.Select(Target{Kind: KindAnchor, Run: "shed-eave", Node: "shed-eave-mid"}))
	f.ok(f.m.Nudge(-1, 1))
	// The real reload will reject an unreadable saved-presets path. The
	// scratch validation must reject it before replacing anchors.yaml.
	if err := os.Mkdir(filepath.Join(f.data, config.SavedPresetsFileName), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := f.m.Confirm(ConfirmOptions{}); err == nil {
		t.Fatal("confirmed with unreadable saved presets")
	}
	if got := f.file(); got != before {
		t.Errorf("failed confirm changed anchors.yaml:\n%s", got)
	}
}
