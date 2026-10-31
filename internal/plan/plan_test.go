// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package plan

import (
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func parseSVG(t *testing.T, svg string) *Drawing {
	t.Helper()
	d, err := Parse(strings.NewReader(svg))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return d
}

func mustPath(t *testing.T, d *Drawing, id string) *Path {
	t.Helper()
	p, err := d.Path(id)
	if err != nil {
		t.Fatalf("Path(%q): %v", id, err)
	}
	return p
}

func TestViewBox(t *testing.T) {
	d := parseSVG(t, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"></svg>`)
	if d.ViewBox != [4]float64{0, 0, 400, 300} {
		t.Errorf("ViewBox = %v, want [0 0 400 300]", d.ViewBox)
	}

	d = parseSVG(t, `<svg viewBox="-10.5, 2 100 50.25"></svg>`)
	if d.ViewBox != [4]float64{-10.5, 2, 100, 50.25} {
		t.Errorf("ViewBox = %v, want [-10.5 2 100 50.25]", d.ViewBox)
	}

	d = parseSVG(t, `<svg><path id="p" d="M0 0 H1"/></svg>`)
	if d.ViewBox != [4]float64{} {
		t.Errorf("ViewBox = %v, want all zero when absent", d.ViewBox)
	}

	// A nested <svg> viewBox must not overwrite the root's.
	d = parseSVG(t, `<svg viewBox="0 0 10 10"><svg viewBox="5 5 1 1"/></svg>`)
	if d.ViewBox != [4]float64{0, 0, 10, 10} {
		t.Errorf("ViewBox = %v, want the root's [0 0 10 10]", d.ViewBox)
	}

	if _, err := Parse(strings.NewReader(`<svg viewBox="1 2 3"/>`)); err == nil {
		t.Error("expected error for malformed viewBox")
	}
}

func TestBasicShapes(t *testing.T) {
	d := parseSVG(t, `<svg viewBox="0 0 300 200">
		<polyline id="run" points="0,0 10,0 10,10"/>
		<polygon id="tri" points="0,0 10,0 0,10"/>
		<line id="seg" x1="1" y1="2" x2="4" y2="6"/>
		<path id="p" d="M0 0 H5"/>
	</svg>`)

	run := mustPath(t, d, "run")
	checkPoints(t, run.Points, []Point{{0, 0}, {10, 0}, {10, 10}})
	if got := run.Length(); !within(got, 20, 1e-9) {
		t.Errorf("polyline length = %g, want 20", got)
	}

	tri := mustPath(t, d, "tri")
	checkPoints(t, tri.Points, []Point{{0, 0}, {10, 0}, {0, 10}, {0, 0}})
	want := 20 + math.Sqrt(200)
	if got := tri.Length(); !within(got, want, 1e-9) {
		t.Errorf("polygon length = %g, want %g (closing segment included)", got, want)
	}

	seg := mustPath(t, d, "seg")
	checkPoints(t, seg.Points, []Point{{1, 2}, {4, 6}})
	if got := seg.Length(); !within(got, 5, 1e-9) {
		t.Errorf("line length = %g, want 5", got)
	}

	if ids := d.PathIDs(); !reflect.DeepEqual(ids, []string{"run", "tri", "seg", "p"}) {
		t.Errorf("PathIDs = %v, want document order [run tri seg p]", ids)
	}
}

func TestShapesWithoutIDAreSkipped(t *testing.T) {
	d := parseSVG(t, `<svg>
		<path d="M0 0 H10"/>
		<polyline points="0,0 1,1"/>
		<path id="kept" d="M0 0 H1"/>
	</svg>`)
	if ids := d.PathIDs(); !reflect.DeepEqual(ids, []string{"kept"}) {
		t.Errorf("PathIDs = %v, want [kept]", ids)
	}
}

func TestInkscapeLabelLookup(t *testing.T) {
	// Namespaced inkscape:label, declared.
	d := parseSVG(t, `<svg xmlns="http://www.w3.org/2000/svg"
		xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
		<path inkscape:label="porch" d="M0 0 H10"/>
	</svg>`)
	p := mustPath(t, d, "porch")
	if p.ID != "porch" {
		t.Errorf("ID = %q, want label fallback %q", p.ID, "porch")
	}
	if ids := d.PathIDs(); !reflect.DeepEqual(ids, []string{"porch"}) {
		t.Errorf("PathIDs = %v, want [porch]", ids)
	}

	// Literal inkscape:label without a namespace declaration.
	d = parseSVG(t, `<svg><path inkscape:label="barn" d="M0 0 H5"/></svg>`)
	if _, err := d.Path("barn"); err != nil {
		t.Errorf("lookup by literal inkscape:label: %v", err)
	}

	// An id match anywhere beats a label match.
	d = parseSVG(t, `<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
		<path id="a" inkscape:label="b" d="M0 0 H1"/>
		<path id="b" d="M0 0 H2"/>
	</svg>`)
	p = mustPath(t, d, "b")
	if got := p.Length(); !within(got, 2, 1e-9) {
		t.Errorf("Path(\"b\") picked the labeled shape; length = %g, want 2", got)
	}
	// With no id match, the first matching label wins.
	p = mustPath(t, d, "a")
	if got := p.Length(); !within(got, 1, 1e-9) {
		t.Errorf("Path(\"a\") length = %g, want 1", got)
	}
}

func TestPathNotFound(t *testing.T) {
	d := parseSVG(t, `<svg><path id="here" d="M0 0 H1"/></svg>`)
	_, err := d.Path("missing-run")
	if err == nil || !strings.Contains(err.Error(), "missing-run") {
		t.Fatalf("error = %v, want mention of %q", err, "missing-run")
	}
}

func TestTransforms(t *testing.T) {
	tests := []struct {
		name string
		svg  string
		id   string
		want []Point
	}{
		{
			"nested translate+scale+rotate",
			`<svg><g transform="translate(10,20)"><g transform="scale(2)">
				<path id="p" transform="rotate(90)" d="M0 0 L10 0"/>
			</g></g></svg>`,
			"p",
			[]Point{{10, 20}, {10, 40}},
		},
		{
			"matrix",
			`<svg><path id="m" transform="matrix(0 1 -1 0 10 0)" d="M10 0 L10 5"/></svg>`,
			"m",
			[]Point{{10, 10}, {5, 10}},
		},
		{
			"rotate about a point",
			`<svg><path id="r" transform="rotate(90 10 10)" d="M10 0 L10 10"/></svg>`,
			"r",
			[]Point{{20, 10}, {10, 10}},
		},
		{
			"multiple functions, comma separators",
			`<svg><path id="c" transform="translate(10), scale(2)" d="M1 1 L2 1"/></svg>`,
			"c",
			[]Point{{12, 2}, {14, 2}},
		},
		{
			"translate single arg means ty=0",
			`<svg><g transform="translate(5)"><line id="l" x1="0" y1="0" x2="1" y2="0"/></g></svg>`,
			"l",
			[]Point{{5, 0}, {6, 0}},
		},
		{
			"scale single arg is uniform",
			`<svg><g transform="scale(3)"><line id="l" x1="1" y1="2" x2="2" y2="2"/></g></svg>`,
			"l",
			[]Point{{3, 6}, {6, 6}},
		},
		{
			"skewX",
			`<svg><path id="s" transform="skewX(45)" d="M0 10 L1 10"/></svg>`,
			"s",
			[]Point{{10, 10}, {11, 10}},
		},
		{
			"skewY",
			`<svg><path id="s" transform="skewY(45)" d="M10 0 L10 1"/></svg>`,
			"s",
			[]Point{{10, 10}, {10, 11}},
		},
		{
			"transform applies to polyline too",
			`<svg><g transform="translate(1,1)"><polyline id="pl" points="0,0 2,0"/></g></svg>`,
			"pl",
			[]Point{{1, 1}, {3, 1}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := parseSVG(t, tt.svg)
			p := mustPath(t, d, tt.id)
			if len(p.Points) != len(tt.want) {
				t.Fatalf("got %d points %v, want %v", len(p.Points), p.Points, tt.want)
			}
			for i := range tt.want {
				if !pointNear(p.Points[i], tt.want[i], 1e-9) {
					t.Errorf("point %d = %v, want %v", i, p.Points[i], tt.want[i])
				}
			}
		})
	}
}

func TestTransformErrors(t *testing.T) {
	for _, svg := range []string{
		`<svg><path id="p" transform="spin(90)" d="M0 0 H1"/></svg>`,
		`<svg><path id="p" transform="matrix(1 2 3)" d="M0 0 H1"/></svg>`,
		`<svg><path id="p" transform="rotate(90 1)" d="M0 0 H1"/></svg>`,
		`<svg><path id="p" transform="translate(1" d="M0 0 H1"/></svg>`,
	} {
		if _, err := Parse(strings.NewReader(svg)); err == nil {
			t.Errorf("expected transform error for %s", svg)
		}
	}
}

func TestScaledArcStaysAccurate(t *testing.T) {
	// A unit quarter circle scaled by 10: flattening must tighten its local
	// tolerance so the plan-unit polyline is still within 0.1% on length.
	d := parseSVG(t, `<svg><g transform="scale(10)">
		<path id="arc" d="M1 0 A1 1 0 0 1 0 1"/>
	</g></svg>`)
	p := mustPath(t, d, "arc")
	want := math.Pi * 10 / 2
	if got := p.Length(); math.Abs(got-want)/want > 0.001 {
		t.Errorf("length = %g, want %g within 0.1%%", got, want)
	}
	last := p.Points[len(p.Points)-1]
	if !pointNear(last, Point{0, 10}, 1e-9) {
		t.Errorf("endpoint = %v, want (0,10)", last)
	}
}

func TestDataNodesLabels(t *testing.T) {
	d := parseSVG(t, `<svg>
		<path id="eave" d="M220 180 H100 V100 L160 100 220 100"
		      data-nodes="shed-se,shed-sw,shed-nw,shed-eave-mid,shed-ne"/>
	</svg>`)
	p := mustPath(t, d, "eave")
	wantLabels := []string{"shed-se", "shed-sw", "shed-nw", "shed-eave-mid", "shed-ne"}
	if !reflect.DeepEqual(p.Labels, wantLabels) {
		t.Errorf("Labels = %v, want %v", p.Labels, wantLabels)
	}
	idx, dist, ok := p.Vertex("shed-nw")
	if !ok || idx != 2 || !within(dist, 200, 1e-9) {
		t.Errorf("Vertex(shed-nw) = (%d, %g, %v), want (2, 200, true)", idx, dist, ok)
	}
}

func TestDataNodesVariants(t *testing.T) {
	tests := []struct {
		name       string
		svg        string
		id         string
		wantLabels []string
		wantErr    string
	}{
		{
			"empty entries leave vertices unlabeled",
			`<svg><path id="p" d="M0 0 H10 V10" data-nodes="a,,c"/></svg>`,
			"p", []string{"a", "", "c"}, "",
		},
		{
			"fewer entries than vertices",
			`<svg><path id="p" d="M0 0 H10 V10" data-nodes="a"/></svg>`,
			"p", []string{"a", "", ""}, "",
		},
		{
			"whitespace is trimmed",
			`<svg><path id="p" d="M0 0 H10" data-nodes=" a , b "/></svg>`,
			"p", []string{"a", "b"}, "",
		},
		{
			"Z vertex is labelable",
			`<svg><path id="p" d="M0 0 H10 V10 Z" data-nodes="a,b,c,d"/></svg>`,
			"p", []string{"a", "b", "c", "d"}, "",
		},
		{
			"curve flattening points are not labelable",
			`<svg><path id="p" d="M0 0 C0 10 10 10 10 0" data-nodes="a,b"/></svg>`,
			"p", nil, "",
		},
		{
			"polygon closing vertex is labelable",
			`<svg><polygon id="g" points="0,0 10,0 10,10" data-nodes="a,b,c,d"/></svg>`,
			"g", []string{"a", "b", "c", "d"}, "",
		},
		{
			"line endpoints",
			`<svg><line id="l" x1="0" y1="0" x2="3" y2="4" data-nodes="start,end"/></svg>`,
			"l", []string{"start", "end"}, "",
		},
		{
			"too many entries",
			`<svg><path id="over" d="M0 0 H10" data-nodes="a,b,c"/></svg>`,
			"over", nil, "over",
		},
		{
			"duplicate label",
			`<svg><path id="dup" d="M0 0 H10 V10" data-nodes="a,a"/></svg>`,
			"dup", nil, `"a"`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, err := Parse(strings.NewReader(tt.svg))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %v, want mention of %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			p := mustPath(t, d, tt.id)
			if len(p.Labels) != len(p.Points) {
				t.Fatalf("len(Labels)=%d != len(Points)=%d", len(p.Labels), len(p.Points))
			}
			if tt.wantLabels != nil && !reflect.DeepEqual(p.Labels, tt.wantLabels) {
				t.Errorf("Labels = %v, want %v", p.Labels, tt.wantLabels)
			}
			if tt.name == "curve flattening points are not labelable" {
				if p.Labels[0] != "a" || p.Labels[len(p.Labels)-1] != "b" {
					t.Errorf("curve labels = first %q last %q, want a/b", p.Labels[0], p.Labels[len(p.Labels)-1])
				}
				for _, l := range p.Labels[1 : len(p.Labels)-1] {
					if l != "" {
						t.Errorf("interior flattening point carries label %q", l)
					}
				}
			}
		})
	}
}

func TestZeroLengthSegmentDedup(t *testing.T) {
	// H0 returns to the start, then Z adds a coincident closing vertex.
	// The duplicate is dropped and the surviving point keeps the label.
	d := parseSVG(t, `<svg><path id="p" d="M0 0 H10 H0 Z" data-nodes="a,b,,z"/></svg>`)
	p := mustPath(t, d, "p")
	checkPoints(t, p.Points, []Point{{0, 0}, {10, 0}, {0, 0}})
	if !reflect.DeepEqual(p.Labels, []string{"a", "b", "z"}) {
		t.Errorf("Labels = %v, want [a b z]", p.Labels)
	}

	// Label on the first duplicate also survives.
	d = parseSVG(t, `<svg><path id="p" d="M0 0 H10 H0 Z" data-nodes="a,b,c,"/></svg>`)
	p = mustPath(t, d, "p")
	if !reflect.DeepEqual(p.Labels, []string{"a", "b", "c"}) {
		t.Errorf("Labels = %v, want [a b c]", p.Labels)
	}

	// Conflicting labels on coincident vertices is an error.
	_, err := Parse(strings.NewReader(
		`<svg><path id="clash" d="M0 0 H10 H0 Z" data-nodes="a,b,c,z"/></svg>`))
	if err == nil || !strings.Contains(err.Error(), "clash") {
		t.Fatalf("error = %v, want conflict naming shape %q", err, "clash")
	}

	// A repeated point mid-path is also collapsed.
	d = parseSVG(t, `<svg><path id="p" d="M0 0 L5 0 L5 0 L10 0"/></svg>`)
	p = mustPath(t, d, "p")
	checkPoints(t, p.Points, []Point{{0, 0}, {5, 0}, {10, 0}})
}

func TestParseFile(t *testing.T) {
	dir := t.TempDir()
	name := filepath.Join(dir, "plan.svg")
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">
		<g transform="translate(100,100)">
			<path id="eave" d="M120 80 H0 V0 L60 0 120 0"
			      data-nodes="shed-se,shed-sw,shed-nw,shed-eave-mid,shed-ne"/>
		</g>
	</svg>`
	if err := os.WriteFile(name, []byte(svg), 0o644); err != nil {
		t.Fatal(err)
	}
	d, err := ParseFile(name)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}
	p := mustPath(t, d, "eave")
	checkPoints(t, p.Points, []Point{{220, 180}, {100, 180}, {100, 100}, {160, 100}, {220, 100}})
	if d.ViewBox != [4]float64{0, 0, 300, 200} {
		t.Errorf("ViewBox = %v", d.ViewBox)
	}

	if _, err := ParseFile(filepath.Join(dir, "no-such.svg")); err == nil {
		t.Error("expected error for missing file")
	}

	bad := filepath.Join(dir, "bad.svg")
	if err := os.WriteFile(bad, []byte("<svg><unclosed></svg>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseFile(bad); err == nil {
		t.Error("expected error for malformed XML")
	}
}

func TestShapeErrorsNameTheShape(t *testing.T) {
	for _, tt := range []struct{ svg, want string }{
		{`<svg><path id="brokenrun" d="M0 0 X"/></svg>`, "brokenrun"},
		{`<svg><polyline id="oddpoints" points="0,0 1"/></svg>`, "oddpoints"},
		{`<svg><line id="badline" x1="zz"/></svg>`, "badline"},
	} {
		_, err := Parse(strings.NewReader(tt.svg))
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("error = %v, want mention of %q", err, tt.want)
		}
	}
}

func TestRejectNonFinitePlanCoordinates(t *testing.T) {
	for _, shape := range []string{
		`<line id="run" x2="NaN"/>`,
		`<line id="run" y2="+Inf"/>`,
		`<path id="run" d="M0 0 L2 0" transform="scale(1e308)"/>`,
	} {
		if _, err := Parse(strings.NewReader("<svg>" + shape + "</svg>")); err == nil {
			t.Errorf("accepted non-finite plan geometry: %s", shape)
		}
	}
}
