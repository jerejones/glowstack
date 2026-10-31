// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package storage writes Glowstack's own files (state.json, anchors.yaml,
// presets.saved.yaml) safely: every write goes to a temporary file in the
// same folder, is synced, then renamed over the old file, so a crash or
// power cut never leaves a partial file. Saver debounces frequent changes.
package storage

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Store reads and writes named files. Implementations must make Write
// atomic: a reader sees the old content or the new, never a mix.
type Store interface {
	// Read returns the file's content, or an error wrapping fs.ErrNotExist.
	Read(name string) ([]byte, error)
	// Write replaces the file's content atomically.
	Write(name string, data []byte) error
}

// Dir is a Store backed by a folder on disk.
type Dir string

// Read implements Store.
func (d Dir) Read(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(string(d), name))
}

// Write implements Store.
func (d Dir) Write(name string, data []byte) error {
	if err := os.MkdirAll(string(d), 0o755); err != nil {
		return err
	}
	return WriteFileAtomic(filepath.Join(string(d), name), data, 0o644)
}

// WriteFileAtomic writes data to a temp file next to path, syncs it and
// renames it over path, then syncs the folder so the rename is durable.
func WriteFileAtomic(path string, data []byte, perm fs.FileMode) (err error) {
	dir, base := filepath.Split(path)
	if dir == "" {
		dir = "."
	}
	f, err := os.CreateTemp(dir, "."+base+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(tmp)
		}
	}()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Chmod(perm); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	// Best effort: some filesystems can't sync a directory.
	if d, derr := os.Open(dir); derr == nil {
		d.Sync()
		d.Close()
	}
	return nil
}

// Memory is an in-memory Store for tests.
type Memory struct {
	mu    sync.Mutex
	files map[string][]byte
}

// Read implements Store.
func (m *Memory) Read(name string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.files[name]
	if !ok {
		return nil, fmt.Errorf("%s: %w", name, fs.ErrNotExist)
	}
	return append([]byte(nil), b...), nil
}

// Write implements Store.
func (m *Memory) Write(name string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.files == nil {
		m.files = map[string][]byte{}
	}
	m.files[name] = append([]byte(nil), data...)
	return nil
}

// Saver runs a save function at most once per interval however often
// Trigger is called, plus once more on Flush or Close if anything changed.
type Saver struct {
	interval time.Duration
	save     func() error
	onError  func(error)

	mu     sync.Mutex
	dirty  bool
	last   time.Time
	timer  *time.Timer
	closed bool
	saving sync.Mutex // serialises save calls
}

// NewSaver returns a Saver calling save at most once per interval. Errors
// from background saves go to onError (which may be nil).
func NewSaver(interval time.Duration, save func() error, onError func(error)) *Saver {
	return &Saver{interval: interval, save: save, onError: onError}
}

// Trigger records a change. The save happens interval after the previous
// save, or right away if that's already past.
func (s *Saver) Trigger() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.dirty = true
	if s.timer != nil {
		return
	}
	wait := max(0, s.interval-time.Since(s.last))
	s.timer = time.AfterFunc(wait, func() {
		if err := s.run(); err != nil && s.onError != nil {
			s.onError(err)
		}
	})
}

// run saves if dirty.
func (s *Saver) run() error {
	s.saving.Lock()
	defer s.saving.Unlock()
	s.mu.Lock()
	s.timer = nil
	dirty := s.dirty
	s.dirty = false
	if dirty {
		s.last = time.Now()
	}
	s.mu.Unlock()
	if !dirty {
		return nil
	}
	if err := s.save(); err != nil {
		s.mu.Lock()
		s.dirty = true // retry on the next trigger or flush
		s.mu.Unlock()
		return err
	}
	return nil
}

// Flush saves now if anything changed since the last save.
func (s *Saver) Flush() error {
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.mu.Unlock()
	return s.run()
}

// Close flushes and stops further saves.
func (s *Saver) Close() error {
	err := s.Flush()
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return err
}

// IsNotExist reports whether err means the file doesn't exist yet.
func IsNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
