// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package calibrate

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/jerejones/glowstack/internal/app"
	"github.com/jerejones/glowstack/internal/config"
	"github.com/jerejones/glowstack/internal/layout"
	"github.com/jerejones/glowstack/internal/stack"
	"github.com/jerejones/glowstack/internal/storage"
	"github.com/jerejones/glowstack/internal/units"
)

// Error is a calibration error with an HTTP status.
type Error struct {
	Status  int
	Message string
	Details []string // config errors, file:line
}

func (e *Error) Error() string { return e.Message }

// Statuses used by Error.
const (
	StatusInvalid  = 400
	StatusNotFound = 404
	StatusConflict = 409
	StatusConfig   = 422
)

func invalidf(format string, args ...any) error {
	return &Error{Status: StatusInvalid, Message: fmt.Sprintf(format, args...)}
}

func notFound(format string, args ...any) error {
	return &Error{Status: StatusNotFound, Message: fmt.Sprintf(format, args...)}
}

func conflictf(format string, args ...any) error {
	return &Error{Status: StatusConflict, Message: fmt.Sprintf(format, args...)}
}

// Sender is implemented by an output sink that knows which controllers it
// sends to (wire.Outputs: the --output selection).
type Sender interface {
	Sends(controller string) bool
}

// Manager runs calibration sessions for an App. There is one session per
// Glowstack, shared by every client (a phone outside and a laptop inside
// see the same one). Its methods are safe for concurrent use.
type Manager struct {
	app *app.App

	mu      sync.Mutex
	active  bool
	target  *Target
	plan    *plan
	side    int
	layers  []string // ids of our layers on the stack, top first
	seq     int
	gen     uint64 // reload generation the plan was resolved against
	message string // what the last action did

	reloaded atomic.Bool
}

// New returns the App's calibration manager. The calibration effect must
// be registered in the App's effects (see Register).
func New(a *app.App) *Manager {
	m := &Manager{app: a}
	m.gen = a.Current().Gen
	a.OnReload(func() { m.reloaded.Store(true) })
	return m
}

// State is a session as the API reports it.
type State struct {
	Active  bool     `json:"active"`
	Target  *Target  `json:"target,omitempty"`
	Label   string   `json:"label,omitempty"`
	Cursors []Cursor `json:"cursors,omitempty"`
	Side    int      `json:"side"`
	// Length is a gap's current length in metres.
	Length *float64 `json:"length,omitempty"`
	// Layers are the calibration layers on the stack, top first.
	Layers []string `json:"layers,omitempty"`
	// Controllers are the ones the target lights, and whether each is
	// receiving output (nil if the sink can't say).
	Controllers []ControllerState `json:"controllers,omitempty"`
	Warning     string            `json:"warning,omitempty"`
	Message     string            `json:"message,omitempty"`
	// Progress lists every anchor, link and gap, with counts.
	Progress []Item `json:"progress"`
	Measured int    `json:"measured"` // anchors measured
	Anchors  int    `json:"anchors"`  // anchors in all
	// File is anchors.yaml in the data folder ("" without one).
	File string `json:"file,omitempty"`
}

// ControllerState says whether a controller the target lights gets frames.
type ControllerState struct {
	ID      string `json:"id"`
	Sending *bool  `json:"sending,omitempty"`
}

// State returns the session's state.
func (m *Manager) State() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	return m.state()
}

func (m *Manager) state() State {
	v := m.app.Current()
	st := State{Active: m.active, Side: m.side, Layers: slices.Clone(m.layers), Message: m.message}
	if m.target != nil && m.plan != nil {
		t := *m.target
		st.Target, st.Label = &t, t.String()
		st.Cursors = slices.Clone(m.plan.cursors)
		if t.Kind == KindGap {
			length := m.plan.length
			st.Length = &length
		}
		sender, _ := m.app.Sink().(Sender)
		var off []string
		for _, id := range controllersOf(v.Layout, layers(v.Layout, t, m.plan.cursors, m.side)) {
			cs := ControllerState{ID: id}
			if sender != nil {
				on := sender.Sends(id)
				cs.Sending = &on
				if !on {
					off = append(off, id)
				}
			}
			st.Controllers = append(st.Controllers, cs)
		}
		if len(off) > 0 {
			st.Warning = fmt.Sprintf("not sending to %v (--output), so the lights there won't show calibration; the map still does", off)
		}
	}
	st.Progress = progress(v.Layout, v.Config)
	for _, it := range st.Progress {
		if it.Target.Kind == KindAnchor {
			st.Anchors++
			if it.Done {
				st.Measured++
			}
		}
	}
	if v.Config.DataDir != "" {
		st.File = filepath.Join(v.Config.DataDir, config.AnchorsFileName)
	}
	return st
}

// synced syncs the layers and returns the state after.
func (m *Manager) synced() (State, error) {
	err := m.sync()
	return m.state(), err
}

// Start starts a session at target t, or with t nil at the first
// unmeasured anchor (if any).
func (m *Manager) Start(t *Target) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	if t == nil && m.active && m.target != nil {
		return m.state(), nil
	}
	if t == nil {
		if next, ok := m.nextAnchor(1); ok {
			t = &next
		}
	}
	if t != nil {
		if err := m.selectLocked(*t); err != nil {
			return State{}, err
		}
	}
	m.active = true
	if t == nil {
		m.message = "started; pick something to calibrate"
	} else {
		m.message = "calibrating " + t.String()
	}
	return m.synced()
}

// Select calibrates target t (starting a session if needed).
func (m *Manager) Select(t Target) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	if err := m.selectLocked(t); err != nil {
		return State{}, err
	}
	m.active = true
	m.message = "calibrating " + t.String()
	return m.synced()
}

func (m *Manager) selectLocked(t Target) error {
	v := m.app.Current()
	p, err := resolve(v.Layout, v.Config, t)
	if err != nil {
		return err
	}
	m.target, m.plan, m.gen = &t, p, v.Gen
	m.side = 0
	for i, c := range p.cursors {
		if !c.Fixed {
			m.side = i
			break
		}
	}
	return nil
}

// Next moves to the next unmeasured anchor in run order (dir -1: the
// previous one), wrapping around.
func (m *Manager) Next(dir int) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	t, ok := m.nextAnchor(dir)
	if !ok {
		return State{}, conflictf("every anchor is measured")
	}
	if err := m.selectLocked(t); err != nil {
		return State{}, err
	}
	m.active = true
	m.message = "calibrating " + t.String()
	return m.synced()
}

// nextAnchor finds the next unmeasured anchor after the current target.
func (m *Manager) nextAnchor(dir int) (Target, bool) {
	v := m.app.Current()
	var anchors []Item
	for _, it := range progress(v.Layout, v.Config) {
		if it.Target.Kind == KindAnchor {
			anchors = append(anchors, it)
		}
	}
	n := len(anchors)
	if n == 0 {
		return Target{}, false
	}
	cur := -1
	if m.target != nil && m.target.Kind == KindAnchor {
		cur = slices.IndexFunc(anchors, func(it Item) bool {
			return it.Target.Run == m.target.Run && it.Target.Node == m.target.Node
		})
	}
	if dir < 0 {
		dir = -1
	} else {
		dir = 1
	}
	if cur < 0 && dir < 0 {
		cur = 0
	}
	for k := 1; k <= n; k++ {
		i := ((cur+dir*k)%n + n) % n
		if !anchors[i].Done {
			return anchors[i].Target, true
		}
	}
	return Target{}, false
}

// Nudge moves cursor side (-1: the active one) by delta pixels along the
// run (positive: towards the run's end).
func (m *Manager) Nudge(side, delta int) (State, error) {
	return m.move(side, func(c *Cursor) int { return c.Index + delta*m.step(c) })
}

// Set puts cursor side (-1: the active one) at controller index index.
func (m *Manager) Set(side, index int) (State, error) {
	return m.move(side, func(*Cursor) int { return index })
}

// step is +1 if the cursor's run counts up (or it isn't on a run).
func (m *Manager) step(c *Cursor) int {
	if c.Run == "" {
		return 1
	}
	if r, err := findRun(m.app.Current().Layout, c.Run); err == nil {
		return r.Step
	}
	return 1
}

func (m *Manager) move(side int, to func(*Cursor) int) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	c, err := m.cursor(side)
	if err != nil {
		return State{}, err
	}
	if c.Fixed {
		return State{}, conflictf("%s can't be moved here: it's a run end or has no pixel; calibrate the run's end instead", c.Label)
	}
	idx := max(c.Min, min(c.Max, to(c)))
	c.Index, c.Moved = idx, idx != c.Estimate
	if m.target.Kind == KindDead && m.plan.cursors[0].Index > m.plan.cursors[1].Index {
		// Keep from ≤ to; the cursor being moved stays active.
		m.plan.cursors[0], m.plan.cursors[1] = m.plan.cursors[1], m.plan.cursors[0]
		m.plan.cursors[0].Label, m.plan.cursors[1].Label = "from", "to"
		m.side = 1 - m.side
	}
	m.message = fmt.Sprintf("%s at %s:%d (%+d from the layout's %d)", c.Label, c.Controller, idx, (idx-c.Estimate)*m.step(c), c.Estimate)
	return m.synced()
}

// cursor returns cursor side (-1: the active one), making it active.
func (m *Manager) cursor(side int) (*Cursor, error) {
	if !m.active || m.target == nil {
		return nil, conflictf("no calibration target; start a session and pick one")
	}
	if len(m.plan.cursors) == 0 {
		return nil, conflictf("%s has nothing to move", m.target)
	}
	if side < 0 {
		side = m.side
	}
	if side >= len(m.plan.cursors) {
		return nil, invalidf("side %d: %s has %d", side, m.target, len(m.plan.cursors))
	}
	m.side = side
	return &m.plan.cursors[side], nil
}

// SetSide makes cursor side the active one.
func (m *Manager) SetSide(side int) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	if _, err := m.cursor(side); err != nil {
		return State{}, err
	}
	return m.synced()
}

// ConfirmOptions are optional for Confirm.
type ConfirmOptions struct {
	// Length is a gap's measured length ("1.25 m", "4 ft"; a bare number
	// is metres).
	Length string `json:"length,omitempty"`
	// Next moves on to the next unmeasured anchor afterwards.
	Next bool `json:"next,omitempty"`
}

// Confirm records the current target as measured: it's written to
// anchors.yaml in the data folder, the config is reloaded (so the layout
// is re-solved and the remaining estimates on the run move with it), and
// the session stays on the target (or moves on with opts.Next).
func (m *Manager) Confirm(opts ConfirmOptions) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	if !m.active || m.target == nil {
		return State{}, conflictf("no calibration target to confirm")
	}
	t, cs := *m.target, m.plan.cursors
	var what string
	err := m.change(func(ms *measurements) error {
		switch t.Kind {
		case KindAnchor:
			ms.setAnchor(cs[0].Run, cs[0].Node, cs[0].Index)
			what = fmt.Sprintf("%s on %s measured at %s:%d", cs[0].Node, cs[0].Run, cs[0].Controller, cs[0].Index)
		case KindEnd:
			ms.setEnd(cs[0].Run, t.End, cs[0].Index)
			what = fmt.Sprintf("%s end of %s measured at %s:%d", t.End, cs[0].Run, cs[0].Controller, cs[0].Index)
		case KindLink:
			n := 0
			for _, c := range cs {
				if !c.Fixed && c.Run != "" {
					ms.setAnchor(c.Run, c.Node, c.Index)
					n++
				}
			}
			if n == 0 {
				return conflictf("both ends of %s are run ends; nothing to measure here", t)
			}
			what = fmt.Sprintf("%s confirmed", t)
		case KindGap:
			if opts.Length == "" {
				return invalidf("confirm a gap with its measured length, e.g. {\"length\": \"1.2 m\"}")
			}
			l, err := parseLength(opts.Length)
			if err != nil {
				return err
			}
			ms.setGap(t.From, t.To, l)
			what = fmt.Sprintf("%s measured at %s", t, formatMetres(l))
		case KindDead:
			ms.addDead(t.Controller, cs[0].Index, cs[1].Index)
			what = fmt.Sprintf("%s:%d–%d marked dead", t.Controller, cs[0].Index, cs[1].Index)
		default:
			return conflictf("%s has nothing to confirm", t)
		}
		return nil
	})
	if err != nil {
		return State{}, err
	}
	m.message = what
	m.reselect()
	if opts.Next {
		if next, ok := m.nextAnchor(1); ok {
			if err := m.selectLocked(next); err == nil {
				m.message = what + "; next: " + next.String()
			}
		} else {
			m.message = what + "; every anchor is measured"
		}
	}
	return m.synced()
}

// Forget drops the measurement for target t (nil: the current target)
// from anchors.yaml, so layout.yaml and the drawing's estimates apply
// again.
func (m *Manager) Forget(t *Target) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	if t == nil {
		if m.target == nil {
			return State{}, conflictf("no target to forget")
		}
		cur := *m.target
		if cur.Kind == KindDead {
			cur.Indices = []int{m.plan.cursors[0].Index, m.plan.cursors[1].Index}
		}
		t = &cur
	}
	tt := *t
	err := m.change(func(ms *measurements) error {
		found := false
		switch tt.Kind {
		case KindAnchor:
			found = ms.forgetAnchor(tt.Run, tt.Node)
		case KindEnd:
			found = ms.forgetEnd(tt.Run, tt.End)
		case KindLink:
			v := m.app.Current()
			for _, n := range []string{tt.From, tt.To} {
				if c := nodeCursor(v.Layout, n, false); c.Run != "" && !c.Fixed {
					found = ms.forgetAnchor(c.Run, n) || found
				}
			}
		case KindGap:
			found = ms.forgetGap(tt.From, tt.To)
		case KindDead:
			if len(tt.Indices) == 0 {
				return invalidf("dead: give the indices to un-mark")
			}
			lo, hi := tt.Indices[0], tt.Indices[len(tt.Indices)-1]
			found = ms.forgetDead(tt.Controller, min(lo, hi), max(lo, hi))
		default:
			return invalidf("%s isn't something calibration measures", tt)
		}
		if !found {
			return notFound("anchors.yaml has no measurement for %s", tt)
		}
		return nil
	})
	if err != nil {
		return State{}, err
	}
	m.message = "forgot " + tt.String()
	m.reselect()
	return m.synced()
}

// End ends the session: the calibration layers are removed and the stack
// below shows again.
func (m *Manager) End() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.removeLayers()
	m.active, m.target, m.plan, m.side = false, nil, nil, 0
	m.message = "calibration ended"
	return m.state()
}

// Keep re-applies the session's layers if they were removed or something
// was pushed above them, and follows reloads. Mount runs it every half
// second.
func (m *Manager) Keep() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refresh()
	if !m.active {
		return nil
	}
	return m.sync()
}

// refresh re-resolves the target after a config reload, keeping cursors
// that were nudged where they are (if the target still exists).
func (m *Manager) refresh() {
	if !m.reloaded.Swap(false) && m.gen == m.app.Current().Gen {
		return
	}
	if m.target == nil {
		m.gen = m.app.Current().Gen
		return
	}
	old := m.plan
	m.reselect()
	if m.plan == nil || old == nil || len(old.cursors) != len(m.plan.cursors) {
		return
	}
	for i := range m.plan.cursors {
		o, c := old.cursors[i], &m.plan.cursors[i]
		if o.Moved && !c.Fixed && o.Index >= c.Min && o.Index <= c.Max {
			c.Index, c.Moved = o.Index, o.Index != c.Estimate
		}
	}
}

// reselect resolves the current target again, from the layout as it is
// now. A target that no longer exists is dropped.
func (m *Manager) reselect() {
	if m.target == nil {
		return
	}
	t, side := *m.target, m.side
	if t.Kind == KindDead && m.plan != nil {
		t.Indices = []int{m.plan.cursors[0].Index, m.plan.cursors[1].Index}
	}
	if err := m.selectLocked(t); err != nil {
		m.message = fmt.Sprintf("%s: %v; pick another target", t, err)
		m.target, m.plan = nil, nil
		return
	}
	if side < len(m.plan.cursors) && !m.plan.cursors[side].Fixed {
		m.side = side
	}
}

// sync makes the stack's calibration layers match the session: the
// session's layers must be the top of the stack, else they're pushed again.
func (m *Manager) sync() error {
	var specs []spec
	if m.active && m.target != nil {
		specs = layers(m.app.Current().Layout, *m.target, m.plan.cursors, m.side)
	}
	st := m.app.Stack
	top := st.List()
	onTop := len(m.layers) == len(specs) && len(top) >= len(specs)
	for i := range m.layers {
		if !onTop {
			break
		}
		onTop = top[i].ID == m.layers[i]
	}
	if !onTop {
		m.removeLayers()
		// Push bottom first, so the active side ends up on top.
		for i := len(specs) - 1; i >= 0; i-- {
			l := m.layer(specs[i])
			l.ID = m.newID()
			l, err := st.Push(l)
			if err != nil {
				m.removeLayers()
				return fmt.Errorf("pushing the calibration layer: %w", err)
			}
			m.layers = append([]string{l.ID}, m.layers...)
		}
		return nil
	}
	for i, s := range specs {
		cur := top[i]
		want := m.layer(s)
		if cur.Effect == want.Effect && cur.Preset == want.Preset && cur.Target == want.Target && reflect.DeepEqual(normalise(cur.Params), normalise(want.Params)) {
			continue
		}
		if _, err := st.Edit(m.layers[i], func(l *stack.Layer) {
			l.Effect, l.Preset = want.Effect, want.Preset
			l.Target, l.Params = want.Target, want.Params
		}); err != nil {
			return fmt.Errorf("updating the calibration layer: %w", err)
		}
	}
	return nil
}

// layer makes the stack layer for s, without an id.
func (m *Manager) layer(s spec) stack.Layer {
	params := maps.Clone(s.params)
	params["fade_in"], params["fade_out"] = "0s", "0s"
	return stack.Layer{Owner: stack.OwnerCalibration, Target: s.target, Effect: EffectID, Params: params, Ephemeral: true}
}

// newID picks an unused layer id: cal1, cal2, …
func (m *Manager) newID() string {
	for {
		m.seq++
		id := "cal" + strconv.Itoa(m.seq)
		if _, taken := m.app.Stack.Get(id); !taken {
			return id
		}
	}
}

// normalise makes ints and float64s compare equal (params that went
// through JSON, or a clone, are the same values).
func normalise(p map[string]any) map[string]any {
	out := make(map[string]any, len(p))
	for k, v := range p {
		if i, ok := v.(int); ok {
			v = float64(i)
		}
		out[k] = v
	}
	return out
}

func (m *Manager) removeLayers() {
	for _, id := range m.layers {
		_ = m.app.Stack.Remove(id) // already gone is fine
	}
	m.layers = nil
	// Layers someone else pushed as calibration's (say, a session before
	// a crash can't leave any, but a client might) go too.
	for _, l := range m.app.Stack.ByOwner(stack.OwnerCalibration) {
		_ = m.app.Stack.Remove(l.ID)
	}
}

// change applies fn to anchors.yaml's measurements, checks the result
// loads and solves (in a scratch copy of the data folder), writes it
// atomically and reloads the config. If the new file wouldn't load, nothing
// is written and the config errors are returned.
func (m *Manager) change(fn func(*measurements) error) error {
	v := m.app.Current()
	if v.Config.DataDir == "" {
		return conflictf("calibration needs a data folder (--data) to write %s", config.AnchorsFileName)
	}
	ms := loaded(v.Config)
	if err := fn(ms); err != nil {
		return err
	}
	data := ms.format(v.Layout)
	if err := check(v.Config.Dir, v.Config.DataDir, data); err != nil {
		return err
	}
	if err := storage.Dir(v.Config.DataDir).Write(config.AnchorsFileName, data); err != nil {
		return fmt.Errorf("writing %s: %w", config.AnchorsFileName, err)
	}
	if _, err := m.app.Reload(); err != nil {
		return configErr(err)
	}
	m.gen = m.app.Current().Gen
	m.reloaded.Store(false)
	return nil
}

// check loads the config with anchors.yaml replaced by data, without
// touching the real data folder.
func check(configDir, dataDir string, data []byte) error {
	tmp, err := os.MkdirTemp("", "glowstack-calibrate-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if saved, err := os.ReadFile(filepath.Join(dataDir, config.SavedPresetsFileName)); err == nil {
		if err := os.WriteFile(filepath.Join(tmp, config.SavedPresetsFileName), saved, 0o644); err != nil {
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(tmp, config.AnchorsFileName), data, 0o644); err != nil {
		return err
	}
	cfg, err := config.Load(configDir, tmp)
	if err != nil {
		return configErr(err)
	}
	lay, err := layout.Build(cfg)
	if err != nil {
		return configErr(err)
	}
	if _, err := layout.SolveMappings(lay, cfg); err != nil {
		return configErr(err)
	}
	return nil
}

// configErr reports config errors as a 422 that names what's wrong. The
// positions point into the scratch copy's anchors.yaml, which has the same
// name and lines as the file that would have been written.
func configErr(err error) error {
	var errs config.Errors
	if !errors.As(err, &errs) {
		return err
	}
	e := &Error{Status: StatusConfig, Message: "that measurement doesn't fit the layout; nothing was written"}
	for _, x := range errs {
		e.Details = append(e.Details, x.Error())
	}
	return e
}

// parseLength reads "1.2 m", "4 ft" or a bare number of metres.
func parseLength(s string) (float64, error) {
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		s = strconv.FormatFloat(f, 'g', -1, 64) + " m"
	}
	l, err := units.ParseLength(s)
	if err != nil {
		return 0, invalidf("length: %v", err)
	}
	if l.PX || l.Value <= 0 {
		return 0, invalidf("length: want a positive length in metres, feet, …")
	}
	return l.Value, nil
}
