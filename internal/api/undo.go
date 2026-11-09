// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/stack"
)

// Undo after apply. Applying is the one step that changes the real lights,
// so the server keeps one undo point: the live stack exactly as it was just
// before the last change someone marked. A client marks the point (PUT),
// makes its change through the layer API, and can put the stack back
// (POST) with the id the mark returned.
//
//	PUT  /api/v1/undo   mark: remember the live stack as it is now
//	GET  /api/v1/undo   the undo point: {id, layers, taken}, or 404
//	POST /api/v1/undo   {"id": "..."} restore that point, once
//
// One level only: a new mark replaces the old one, whose id then answers
// 409. The snapshot is kept on the server because a layer's seed is a
// uint64 and its times have more digits than a browser's numbers hold; the
// restore is exact, down to ids, order and seeds.
//
// Restoring changes the layer stack and nothing else. It is not a power
// command: it sends nothing to a controller that pushing or removing a
// layer could not send, it never turns a controller off, and it does not
// touch master or zone brightness. An undo point with no layers restores
// an empty stack, which removing every layer already allows.
type undoPoint struct {
	mu     sync.Mutex
	id     string
	layers []stack.Layer
	taken  time.Time
}

// undoInfo is an undo point as the API describes it.
type undoInfo struct {
	ID     string    `json:"id"`
	Layers int       `json:"layers"` // how many layers the restored stack would have
	Taken  time.Time `json:"taken"`
}

func (u *undoPoint) info() undoInfo {
	return undoInfo{ID: u.id, Layers: len(u.layers), Taken: u.taken}
}

// undoMark is PUT /api/v1/undo.
func (api *API) undoMark(w http.ResponseWriter, r *http.Request) error {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return err
	}
	u := &api.undo
	u.mu.Lock()
	defer u.mu.Unlock()
	u.id, u.layers, u.taken = hex.EncodeToString(b[:]), api.app.Stack.Snapshot(), api.app.Clock.Now()
	return writeJSON(w, http.StatusOK, u.info())
}

// undoGet is GET /api/v1/undo.
func (api *API) undoGet(w http.ResponseWriter, r *http.Request) error {
	u := &api.undo
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.id == "" {
		return errorf(http.StatusNotFound, "nothing to undo")
	}
	return writeJSON(w, http.StatusOK, u.info())
}

// undoRestore is POST /api/v1/undo: the live stack goes back to the undo
// point, which is then used up.
func (api *API) undoRestore(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	var id string
	if raw, ok := body["id"]; ok {
		if err := json.Unmarshal(raw, &id); err != nil {
			return errorf(http.StatusBadRequest, "id: want a string")
		}
	}
	if id == "" {
		return errorf(http.StatusBadRequest, "give the undo point's id")
	}
	u := &api.undo
	u.mu.Lock()
	if u.id == "" {
		u.mu.Unlock()
		return errorf(http.StatusNotFound, "nothing to undo")
	}
	if u.id != id {
		u.mu.Unlock()
		return errorf(http.StatusConflict, "that change can no longer be undone: a later one took its place")
	}
	snapshot := u.layers
	u.id, u.layers = "", nil
	u.mu.Unlock()
	warnings := api.app.Stack.Reinstate(snapshot)
	return writeJSON(w, http.StatusOK, map[string]any{"layers": layers(api.app.Stack, false), "warnings": nonNil(warnings)})
}
