// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package ctl is the command-line client for the control API, run as
// `glowstack ctl …` or `glowctl …`.
//
// Parameters are written k=v. A value that parses as JSON (a number,
// true/false, null, a list or an object) is sent as that; anything else
// is a string, so `color=#ff5a00` and `speed="1 px/8s"` both work. In an
// edit, `k=` removes an override.
package ctl

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"slices"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
)

// DefaultServer is used when neither --server nor $GLOWSTACK_URL is set.
const DefaultServer = "http://127.0.0.1:8080"

const usage = `usage: glowstack ctl [--server URL] [--json] <command> [args]

commands:
  layers [--preview]                      show the stack, top first
  push [--preview] [--id ID] <area> <effect|preset> [k=v ...]
                                          push a layer on top
  edit [--preview] [--replace] <id> [k=v ...]
                                          change a layer in place (k= removes)
  rm [--preview] <id>...                  remove layers (they fade out)
  rm [--preview] --all [--owner O]        remove every layer (or one owner's)
  bri [value]                             show or set master brightness
  bri <zone> <value>                      set a zone's brightness
  effects [id]                            list effects, or one effect's parameters
  presets | palettes | areas | zones | mappings | controllers
  save-preset <id> <effect> [--name N] [k=v ...]
  save-preset <id> --from-layer L [--preview] [--name N] [k=v ...]
                                          save a preset (presets.saved.yaml);
                                          from a layer, k=v override (k= removes)
  rm-preset <id>                          delete a saved preset
  status                                  frame rate, layout solve, health
  reload                                  re-read the config folder
  cal [command]                           calibration mode; "cal help" lists its commands

Special keys for push and edit: target=, effect=, preset=, for=10s,
until=23:00 (or RFC 3339), and the common layer parameters (blend=,
opacity=, brightness=, mapping=, fade_in=, …). Values: 0.5, true, "#ff0000",
"1 px/8s", [..], {..}.

The server is --server, else $GLOWSTACK_URL, else ` + DefaultServer + `.
`

// Main runs the CLI with args (without the program name) and returns the
// exit code.
func Main(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("ctl", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, usage) }
	server := fs.String("server", "", "control API address")
	asJSON := fs.Bool("json", false, "print the server's JSON replies")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	base := *server
	if base == "" {
		base = os.Getenv("GLOWSTACK_URL")
	}
	if base == "" {
		base = DefaultServer
	}
	if !strings.Contains(base, "://") {
		base = "http://" + base
	}
	c := &client{base: strings.TrimRight(base, "/") + "/api/v1/", out: stdout, json: *asJSON,
		http: &http.Client{Timeout: 15 * time.Second}, now: time.Now}
	cmd, rest := fs.Arg(0), fs.Args()[1:]
	err := c.run(cmd, rest)
	if err == nil {
		return 0
	}
	var ue usageError
	if errors.As(err, &ue) {
		fmt.Fprintf(stderr, "glowstack ctl %s: %v\n\n%s", cmd, err, usage)
		return 2
	}
	fmt.Fprintf(stderr, "glowstack ctl %s: %v\n", cmd, err)
	return 1
}

type usageError struct{ error }

func usagef(format string, args ...any) error { return usageError{fmt.Errorf(format, args...)} }

type client struct {
	base string
	out  io.Writer
	json bool
	http *http.Client
	now  func() time.Time
}

// apiError is an error reply from the server.
type apiError struct {
	Status  int
	Message string   `json:"error"`
	Details []string `json:"errors"`
}

func (e *apiError) Error() string {
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	for _, d := range e.Details {
		msg += "\n  " + d
	}
	return msg
}

// call sends a request and decodes a JSON reply into out (if not nil).
// It returns the raw reply too, for --json.
func (c *client) call(method, path string, body, out any) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		e := &apiError{Status: res.StatusCode}
		if json.Unmarshal(raw, e) != nil {
			e.Message = strings.TrimSpace(string(raw))
		}
		return nil, e
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return nil, fmt.Errorf("decoding the reply: %w", err)
		}
	}
	return raw, nil
}

// show prints the raw JSON with --json, or calls human otherwise.
func (c *client) show(raw []byte, human func()) {
	if c.json {
		c.out.Write(raw)
		if len(raw) > 0 && raw[len(raw)-1] != '\n' {
			fmt.Fprintln(c.out)
		}
		return
	}
	human()
}

func (c *client) run(cmd string, args []string) error {
	switch cmd {
	case "layers", "ls":
		return c.layers(args)
	case "push":
		return c.push(args)
	case "edit":
		return c.edit(args)
	case "rm", "remove":
		return c.remove(args)
	case "bri", "brightness":
		return c.brightness(args)
	case "effects":
		return c.effects(args)
	case "presets", "palettes", "areas", "zones", "mappings", "controllers":
		if len(args) > 0 {
			return usagef("%s takes no arguments", cmd)
		}
		return c.catalog(cmd)
	case "save-preset":
		return c.savePreset(args)
	case "rm-preset":
		return c.removePreset(args)
	case "status":
		return c.status()
	case "reload":
		return c.reload()
	case "cal", "calibrate":
		return c.calibrate(args)
	case "help":
		fmt.Fprint(c.out, usage)
		return nil
	}
	return usagef("unknown command %q", cmd)
}

func (c *client) table() *tabwriter.Writer {
	return tabwriter.NewWriter(c.out, 0, 4, 2, ' ', 0)
}

func layersPath(preview bool) string {
	if preview {
		return "preview/layers"
	}
	return "layers"
}

type layer struct {
	ID       string         `json:"id"`
	Owner    string         `json:"owner"`
	Target   string         `json:"target"`
	Effect   string         `json:"effect"`
	Preset   string         `json:"preset"`
	Params   map[string]any `json:"params"`
	Position int            `json:"position"`
	Expires  *time.Time     `json:"expires"`
}

func (l *layer) look() string {
	if l.Preset != "" {
		return "preset:" + l.Preset
	}
	return l.Effect
}

func (c *client) layers(args []string) error {
	fs := flag.NewFlagSet("layers", flag.ContinueOnError)
	preview := fs.Bool("preview", false, "the preview-only stack")
	if err := fs.Parse(args); err != nil {
		return usageError{err}
	}
	var reply struct{ Layers []layer }
	raw, err := c.call("GET", layersPath(*preview), nil, &reply)
	if err != nil {
		return err
	}
	c.show(raw, func() {
		if len(reply.Layers) == 0 {
			fmt.Fprintln(c.out, "no layers")
			return
		}
		tw := c.table()
		fmt.Fprintln(tw, "ID\tTARGET\tLOOK\tOWNER\tEXPIRES\tPARAMS")
		for _, l := range reply.Layers {
			exp := "-"
			if l.Expires != nil {
				exp = l.Expires.Local().Format("15:04:05")
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", l.ID, l.Target, l.look(), l.Owner, exp, formatParams(l.Params))
		}
		tw.Flush()
	})
	return nil
}

// formatParams writes params as sorted k=v pairs.
func formatParams(p map[string]any) string {
	keys := make([]string, 0, len(p))
	for k := range p {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, k+"="+formatValue(p[k]))
	}
	return strings.Join(parts, " ")
}

func formatValue(v any) string {
	if s, ok := v.(string); ok {
		if strings.ContainsAny(s, " \t") {
			return fmt.Sprintf("%q", s)
		}
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// parseValue reads a k=v value: JSON if it parses, else a string.
func parseValue(s string) any {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err == nil {
		return v
	}
	return s
}

// topLevel are k=v keys that go at the top of a push or edit body rather
// than into params.
var topLevel = map[string]bool{"target": true, "effect": true, "preset": true, "use": true, "for": true, "until": true, "owner": true}

// body builds a push or edit body from k=v arguments. In an edit an empty
// value is null (remove the override).
func (c *client) body(kvs []string, edit bool) (map[string]any, error) {
	body := map[string]any{}
	params := map[string]any{}
	for _, kv := range kvs {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			return nil, usagef("%q: want key=value", kv)
		}
		var val any = parseValue(v)
		if v == "" {
			if !edit {
				return nil, usagef("%q: no value", kv)
			}
			val = nil
		}
		switch {
		case k == "until" && val != nil:
			t, err := parseUntil(v, c.now())
			if err != nil {
				return nil, usagef("until: %v", err)
			}
			body[k] = t.Format(time.RFC3339)
		case k == "for" && val != nil:
			body[k] = v
		case topLevel[k]:
			body[k] = val
		default:
			params[k] = val
		}
	}
	if len(params) > 0 {
		body["params"] = params
	}
	return body, nil
}

// parseUntil reads an RFC 3339 time, or a local clock time "HH:MM" (or
// "HH:MM:SS") meaning its next occurrence.
func parseUntil(s string, now time.Time) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	for _, layout := range []string{"15:04", "15:04:05"} {
		if t, err := time.ParseInLocation(layout, s, now.Location()); err == nil {
			at := time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), t.Second(), 0, now.Location())
			if !at.After(now) {
				at = at.AddDate(0, 0, 1)
			}
			return at, nil
		}
	}
	return time.Time{}, fmt.Errorf("%q: want HH:MM or an RFC 3339 time", s)
}

func (c *client) push(args []string) error {
	fs := flag.NewFlagSet("push", flag.ContinueOnError)
	preview := fs.Bool("preview", false, "push to the preview-only stack")
	id := fs.String("id", "", "choose the layer id")
	if err := fs.Parse(args); err != nil {
		return usageError{err}
	}
	if fs.NArg() < 2 {
		return usagef("want <area> <effect|preset> [k=v ...]")
	}
	body, err := c.body(fs.Args()[2:], false)
	if err != nil {
		return err
	}
	body["target"], body["use"] = fs.Arg(0), fs.Arg(1)
	if _, ok := body["owner"]; !ok {
		body["owner"] = "cli"
	}
	if *id != "" {
		body["id"] = *id
	}
	if *preview {
		body["preview"] = true
	}
	var l layer
	raw, err := c.call("POST", "layers", body, &l)
	if err != nil {
		return err
	}
	c.show(raw, func() {
		where := ""
		if *preview {
			where = " (preview only)"
		}
		fmt.Fprintf(c.out, "pushed layer %s: %s on %s%s\n", l.ID, l.look(), l.Target, where)
	})
	return nil
}

func (c *client) edit(args []string) error {
	fs := flag.NewFlagSet("edit", flag.ContinueOnError)
	preview := fs.Bool("preview", false, "a preview-only layer")
	replace := fs.Bool("replace", false, "replace all params instead of merging")
	if err := fs.Parse(args); err != nil {
		return usageError{err}
	}
	if fs.NArg() < 2 {
		return usagef("want <id> k=v [k=v ...]")
	}
	body, err := c.body(fs.Args()[1:], true)
	if err != nil {
		return err
	}
	if *replace {
		body["replace"] = true
	}
	var l layer
	raw, err := c.call("PATCH", layersPath(*preview)+"/"+url.PathEscape(fs.Arg(0)), body, &l)
	if err != nil {
		return err
	}
	c.show(raw, func() {
		fmt.Fprintf(c.out, "edited layer %s: %s on %s %s\n", l.ID, l.look(), l.Target, formatParams(l.Params))
	})
	return nil
}

func (c *client) remove(args []string) error {
	fs := flag.NewFlagSet("rm", flag.ContinueOnError)
	preview := fs.Bool("preview", false, "preview-only layers")
	all := fs.Bool("all", false, "remove every layer")
	owner := fs.String("owner", "", "with --all: only this owner's layers")
	if err := fs.Parse(args); err != nil {
		return usageError{err}
	}
	path := layersPath(*preview)
	if *all {
		if fs.NArg() > 0 {
			return usagef("--all takes no ids")
		}
		if *owner != "" {
			path += "?owner=" + url.QueryEscape(*owner)
		}
		var reply struct{ Removed []string }
		raw, err := c.call("DELETE", path, nil, &reply)
		if err != nil {
			return err
		}
		c.show(raw, func() { fmt.Fprintf(c.out, "removed %d layers\n", len(reply.Removed)) })
		return nil
	}
	if *owner != "" {
		return usagef("--owner needs --all")
	}
	if fs.NArg() == 0 {
		return usagef("want layer ids, or --all")
	}
	var errs []error
	for _, id := range fs.Args() {
		if _, err := c.call("DELETE", path+"/"+url.PathEscape(id), nil, nil); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", id, err))
			continue
		}
		if !c.json {
			fmt.Fprintf(c.out, "removed layer %s\n", id)
		}
	}
	return errors.Join(errs...)
}

type brightness struct {
	Master float64            `json:"master"`
	Zones  map[string]float64 `json:"zones"`
}

func percent(v float64) string { return fmt.Sprintf("%.0f%%", v*100) }

// level reads a brightness argument: 0–1 or a percentage. WLED's 0–255
// isn't accepted, to avoid guessing whether 1 means 100% or 1/255.
func level(s string) (any, error) {
	if strings.HasSuffix(s, "%") {
		return s, nil
	}
	var v float64
	if _, err := fmt.Sscanf(s, "%g", &v); err != nil {
		return nil, usagef("%q: want 0–1 or a percentage such as 50%%", s)
	}
	return v, nil
}

func (c *client) brightness(args []string) error {
	var body map[string]any
	switch len(args) {
	case 0:
	case 1:
		v, err := level(args[0])
		if err != nil {
			return err
		}
		body = map[string]any{"master": v}
	case 2:
		v, err := level(args[1])
		if err != nil {
			return err
		}
		body = map[string]any{"zones": map[string]any{args[0]: v}}
	default:
		return usagef("want [value] or <zone> <value>")
	}
	var b brightness
	var raw []byte
	var err error
	if body == nil {
		raw, err = c.call("GET", "brightness", nil, &b)
	} else {
		raw, err = c.call("PUT", "brightness", body, &b)
	}
	if err != nil {
		return err
	}
	c.show(raw, func() {
		fmt.Fprintf(c.out, "master %s\n", percent(b.Master))
		zones := make([]string, 0, len(b.Zones))
		for z := range b.Zones {
			zones = append(zones, z)
		}
		sort.Strings(zones)
		for _, z := range zones {
			fmt.Fprintf(c.out, "zone %s %s\n", z, percent(b.Zones[z]))
		}
	})
	return nil
}

type param struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Default any      `json:"default"`
	Doc     string   `json:"doc"`
	Enum    []string `json:"enum"`
	Measure string   `json:"measure"`
	Fields  []param  `json:"fields"`
}

type effect struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Coords   []string `json:"coords"`
	Stateful bool     `json:"stateful"`
	Params   []param  `json:"params"`
	WLED     *struct {
		FX   int    `json:"fx"`
		Name string `json:"name"`
	} `json:"wled"`
}

func (c *client) effects(args []string) error {
	if len(args) > 1 {
		return usagef("want at most one effect id")
	}
	if len(args) == 1 {
		var e effect
		raw, err := c.call("GET", "effects/"+url.PathEscape(args[0]), nil, &e)
		if err != nil {
			return err
		}
		c.show(raw, func() {
			coords := strings.Join(e.Coords, ",")
			if coords == "" {
				coords = "none"
			}
			fmt.Fprintf(c.out, "%s (%s), coords %s", e.ID, e.Name, coords)
			if e.WLED != nil {
				fmt.Fprintf(c.out, ", WLED fx %d %q", e.WLED.FX, e.WLED.Name)
			}
			fmt.Fprintln(c.out)
			tw := c.table()
			fmt.Fprintln(tw, "PARAM\tTYPE\tDEFAULT\tDOC")
			writeParams(tw, e.Params, "")
			tw.Flush()
		})
		return nil
	}
	var reply struct {
		Effects []effect `json:"effects"`
		Common  []param  `json:"common"`
	}
	raw, err := c.call("GET", "effects", nil, &reply)
	if err != nil {
		return err
	}
	c.show(raw, func() {
		tw := c.table()
		fmt.Fprintln(tw, "ID\tNAME\tWLED\tPARAMS")
		for _, e := range reply.Effects {
			var names []string
			for _, p := range e.Params {
				names = append(names, p.Name)
			}
			fx := "-"
			if e.WLED != nil {
				fx = fmt.Sprint(e.WLED.FX)
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", e.ID, e.Name, fx, strings.Join(names, " "))
		}
		tw.Flush()
		var common []string
		for _, p := range reply.Common {
			common = append(common, p.Name)
		}
		fmt.Fprintf(c.out, "\ncommon to every layer: %s\n", strings.Join(common, " "))
	})
	return nil
}

func writeParams(tw io.Writer, ps []param, indent string) {
	for _, p := range ps {
		typ := p.Type
		if len(p.Enum) > 0 {
			typ += " " + strings.Join(p.Enum, "|")
		}
		if p.Measure != "" && p.Measure != "flow" {
			typ += " (" + p.Measure + ")"
		}
		def := "-"
		if p.Default != nil {
			def = formatValue(p.Default)
		}
		fmt.Fprintf(tw, "%s%s\t%s\t%s\t%s\n", indent, p.Name, typ, def, p.Doc)
		writeParams(tw, p.Fields, indent+"  ")
	}
}

func (c *client) catalog(what string) error {
	var reply map[string]json.RawMessage
	raw, err := c.call("GET", what, nil, &reply)
	if err != nil {
		return err
	}
	if c.json {
		c.show(raw, nil)
		return nil
	}
	var rows []map[string]any
	if err := json.Unmarshal(reply[what], &rows); err != nil {
		return fmt.Errorf("decoding the reply: %w", err)
	}
	tw := c.table()
	defer tw.Flush()
	cols := map[string][]string{
		"presets":     {"id", "effect", "name", "source", "params"},
		"palettes":    {"id", "name", "wled", "interpolate", "stops"},
		"areas":       {"id", "pixels", "runs", "zones"},
		"zones":       {"id", "area", "name", "mapping", "brightness", "segments"},
		"mappings":    {"id", "kind", "summary"},
		"controllers": {"id", "host", "port", "pixels", "channels", "base"},
	}[what]
	fmt.Fprintln(tw, strings.ToUpper(strings.Join(cols, "\t")))
	for _, r := range rows {
		var cells []string
		for _, col := range cols {
			cells = append(cells, cell(col, r[col]))
		}
		fmt.Fprintln(tw, strings.Join(cells, "\t"))
	}
	if what == "mappings" {
		var def string
		json.Unmarshal(reply["default"], &def)
		tw.Flush()
		fmt.Fprintf(c.out, "\ndefault: %s\n", def)
	}
	return nil
}

func cell(col string, v any) string {
	switch v := v.(type) {
	case nil:
		return "-"
	case string:
		if v == "" {
			return "-"
		}
		return v
	case bool:
		if v {
			return "yes"
		}
		return "-"
	case float64:
		if col == "brightness" {
			return percent(v)
		}
		return fmt.Sprint(v)
	case map[string]any:
		return formatParams(v)
	case []any:
		if col == "stops" {
			return fmt.Sprintf("%d stops", len(v))
		}
		var parts []string
		for _, x := range v {
			if m, ok := x.(map[string]any); ok {
				parts = append(parts, fmt.Sprint(m["area"]))
			} else {
				parts = append(parts, fmt.Sprint(x))
			}
		}
		return strings.Join(parts, ",")
	}
	return fmt.Sprint(v)
}

func (c *client) status() error {
	var s struct {
		Uptime        string     `json:"uptime"`
		Frames        uint64     `json:"frames"`
		FPS           float64    `json:"fps"`
		MeasuredFPS   float64    `json:"measured_fps"`
		FrameMS       float64    `json:"frame_ms"`
		MaxFrameMS    float64    `json:"max_frame_ms"`
		LateFrames    uint64     `json:"late_frames"`
		Layers        int        `json:"layers"`
		PreviewLayers int        `json:"preview_layers"`
		Brightness    brightness `json:"brightness"`
		Solve         struct {
			Pixels      int `json:"pixels"`
			Controllers int `json:"controllers"`
			Areas       int `json:"areas"`
			Zones       int `json:"zones"`
			Mappings    int `json:"mappings"`
			Anchors     struct {
				Measured  int `json:"measured"`
				Estimated int `json:"estimated"`
			} `json:"anchors"`
			Warnings []string `json:"warnings"`
		} `json:"solve"`
		Health    any    `json:"health"`
		ConfigGen uint64 `json:"config_gen"`
	}
	raw, err := c.call("GET", "status", nil, &s)
	if err != nil {
		return err
	}
	c.show(raw, func() {
		w := c.out
		fmt.Fprintf(w, "up %s, %d frames, %.1f fps (target %.0f), frame %.2f ms (max %.2f), %d late\n",
			s.Uptime, s.Frames, s.MeasuredFPS, s.FPS, s.FrameMS, s.MaxFrameMS, s.LateFrames)
		fmt.Fprintf(w, "layers %d (preview %d), master %s\n", s.Layers, s.PreviewLayers, percent(s.Brightness.Master))
		v := s.Solve
		fmt.Fprintf(w, "%d pixels, %d controllers, %d areas, %d zones, %d mappings; anchors %d measured, %d estimated\n",
			v.Pixels, v.Controllers, v.Areas, v.Zones, v.Mappings, v.Anchors.Measured, v.Anchors.Estimated)
		if s.ConfigGen > 0 {
			fmt.Fprintf(w, "config reloaded %d times\n", s.ConfigGen)
		}
		for _, warn := range v.Warnings {
			fmt.Fprintf(w, "warning: %s\n", warn)
		}
		c.showHealth(s.Health)
	})
	return nil
}

// controllerHealth is one controller in the health report of glowstack's
// own output (internal/output/wire).
type controllerHealth struct {
	Addr       string   `json:"addr"`
	Reachable  bool     `json:"reachable"`
	Checked    string   `json:"checked"`
	Version    string   `json:"version"`
	Count      int      `json:"led_count"`
	Reboots    int      `json:"reboots"`
	Mismatches []string `json:"mismatches"`
	Err        string   `json:"error"`
	Frames     uint64   `json:"frames"`
	Errors     uint64   `json:"send_errors"`
	LastError  string   `json:"last_send_error"`
}

// showHealth prints the health report as a table when it's the usual
// shape (a map by controller id), else as JSON.
func (c *client) showHealth(h any) {
	w := c.out
	if h == nil {
		fmt.Fprintln(w, "controller health: not reported")
		return
	}
	b, _ := json.Marshal(h)
	var m map[string]controllerHealth
	if json.Unmarshal(b, &m) != nil || len(m) == 0 {
		b, _ = json.MarshalIndent(h, "", "  ")
		fmt.Fprintf(w, "controller health: %s\n", b)
		return
	}
	t := c.table()
	fmt.Fprintln(t, "CONTROLLER\tADDR\tSTATE\tVERSION\tLEDS\tREBOOTS\tFRAMES\tSEND ERRORS\tPROBLEMS")
	for _, id := range slices.Sorted(maps.Keys(m)) {
		h := m[id]
		state := "reachable"
		switch {
		case h.Checked == "":
			state = "not checked yet"
		case !h.Reachable:
			state = "unreachable"
		}
		problems := slices.Clone(h.Mismatches)
		if h.Err != "" {
			problems = append(problems, h.Err)
		}
		if h.LastError != "" {
			problems = append(problems, "send: "+h.LastError)
		}
		fmt.Fprintf(t, "%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%s\n", id, h.Addr, state, dash(h.Version), h.Count,
			h.Reboots, h.Frames, h.Errors, dash(strings.Join(problems, "; ")))
	}
	t.Flush()
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func (c *client) reload() error {
	var r struct {
		Pixels     int      `json:"pixels"`
		PixelsWere int      `json:"pixels_were"`
		Dropped    []string `json:"dropped"`
		Warnings   []string `json:"warnings"`
	}
	raw, err := c.call("POST", "reload", nil, &r)
	if err != nil {
		return err
	}
	c.show(raw, func() {
		fmt.Fprintf(c.out, "reloaded: %d pixels (was %d)\n", r.Pixels, r.PixelsWere)
		for _, d := range r.Dropped {
			fmt.Fprintf(c.out, "dropped %s\n", d)
		}
		for _, w := range r.Warnings {
			fmt.Fprintf(c.out, "warning: %s\n", w)
		}
	})
	return nil
}

// parseInterspersed parses fs's flags wherever they appear among args and
// returns the other arguments in order, so `save-preset red --name Red`
// works as well as `save-preset --name Red red`.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return pos, nil
		}
		pos = append(pos, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

type savedPreset struct {
	ID      string   `json:"id"`
	Effect  string   `json:"effect"`
	Source  string   `json:"source"`
	Dropped []string `json:"dropped"`
}

func (c *client) savePreset(args []string) error {
	fs := flag.NewFlagSet("save-preset", flag.ContinueOnError)
	from := fs.String("from-layer", "", "save this layer's effect and params")
	preview := fs.Bool("preview", false, "with --from-layer: a preview-only layer")
	name := fs.String("name", "", "display name")
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		return usageError{err}
	}
	if len(pos) == 0 {
		return usagef("want <id> <effect> [k=v ...] or <id> --from-layer L [k=v ...]")
	}
	id, rest := pos[0], pos[1:]
	body := map[string]any{}
	if *from != "" {
		body["from_layer"] = *from
		if *preview {
			body["preview"] = true
		}
	} else {
		if len(rest) == 0 || strings.Contains(rest[0], "=") {
			return usagef("want an effect, or --from-layer")
		}
		body["effect"], rest = rest[0], rest[1:]
	}
	if *name != "" {
		body["name"] = *name
	}
	params := map[string]any{}
	for _, kv := range rest {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			return usagef("%q: want key=value", kv)
		}
		switch {
		case v != "":
			params[k] = parseValue(v)
		case *from != "":
			params[k] = nil
		default:
			return usagef("%q: no value", kv)
		}
	}
	if len(params) > 0 {
		body["params"] = params
	}
	var p savedPreset
	raw, err := c.call("PUT", "presets/"+url.PathEscape(id), body, &p)
	if err != nil {
		return err
	}
	c.show(raw, func() {
		fmt.Fprintf(c.out, "saved preset %s: %s\n", p.ID, p.Effect)
		if len(p.Dropped) > 0 {
			fmt.Fprintf(c.out, "dropped layers that no longer validate: %s\n", strings.Join(p.Dropped, "; "))
		}
	})
	return nil
}

func (c *client) removePreset(args []string) error {
	if len(args) != 1 {
		return usagef("want <id>")
	}
	var reply struct {
		Deleted string   `json:"deleted"`
		Dropped []string `json:"dropped"`
		Now     *savedPreset
	}
	raw, err := c.call("DELETE", "presets/"+url.PathEscape(args[0]), nil, &reply)
	if err != nil {
		return err
	}
	c.show(raw, func() {
		fmt.Fprintf(c.out, "deleted preset %s\n", reply.Deleted)
		if reply.Now != nil {
			fmt.Fprintf(c.out, "presets.yaml's %s (%s) is in effect again\n", reply.Now.ID, reply.Now.Effect)
		}
		if len(reply.Dropped) > 0 {
			fmt.Fprintf(c.out, "dropped layers that no longer validate: %s\n", strings.Join(reply.Dropped, "; "))
		}
	})
	return nil
}
