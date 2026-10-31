// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package storage

import (
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestDirAtomicWrite(t *testing.T) {
	d := Dir(filepath.Join(t.TempDir(), "data"))
	if _, err := d.Read("state.json"); !IsNotExist(err) {
		t.Fatalf("read missing: %v", err)
	}
	for _, body := range []string{"one", "two, longer"} {
		if err := d.Write("state.json", []byte(body)); err != nil {
			t.Fatal(err)
		}
		got, err := d.Read("state.json")
		if err != nil || string(got) != body {
			t.Fatalf("read = %q, %v", got, err)
		}
	}
	entries, _ := os.ReadDir(string(d))
	if len(entries) != 1 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

func TestWriteFileAtomicFailureKeepsOld(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f")
	if err := WriteFileAtomic(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Renaming over a directory fails; the old file must survive.
	if err := WriteFileAtomic(filepath.Join(dir, "missing", "f"), []byte("x"), 0o644); err == nil {
		t.Fatal("want error")
	}
	if b, _ := os.ReadFile(path); string(b) != "old" {
		t.Errorf("content = %q", b)
	}
}

func TestSaverDebounces(t *testing.T) {
	var saves atomic.Int32
	s := NewSaver(50*time.Millisecond, func() error { saves.Add(1); return nil }, nil)
	for range 20 {
		s.Trigger()
		time.Sleep(time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond)
	// The first trigger saves immediately; the rest collapse into one.
	if n := saves.Load(); n < 1 || n > 2 {
		t.Errorf("saves = %d, want 1–2", n)
	}
	before := saves.Load()
	s.Trigger()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if saves.Load() != before+1 {
		t.Errorf("close didn't flush: %d → %d", before, saves.Load())
	}
	s.Trigger() // after close: ignored
	time.Sleep(60 * time.Millisecond)
	if saves.Load() != before+1 {
		t.Errorf("saved after close")
	}
}

func TestSaverFlushNothingToDo(t *testing.T) {
	var saves atomic.Int32
	s := NewSaver(time.Hour, func() error { saves.Add(1); return nil }, nil)
	if err := s.Flush(); err != nil || saves.Load() != 0 {
		t.Errorf("flush clean: %v, %d", err, saves.Load())
	}
}

func TestSaverRetriesAfterError(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	var errs atomic.Int32
	s := NewSaver(0, func() error {
		if fail.Load() {
			return errors.New("disk full")
		}
		return nil
	}, func(error) { errs.Add(1) })
	s.Trigger()
	time.Sleep(20 * time.Millisecond)
	if errs.Load() != 1 {
		t.Fatalf("errors = %d", errs.Load())
	}
	fail.Store(false)
	if err := s.Flush(); err != nil {
		t.Errorf("flush after error: %v", err)
	}
}

func TestMemory(t *testing.T) {
	var m Memory
	if _, err := m.Read("x"); !IsNotExist(err) {
		t.Errorf("err = %v", err)
	}
	m.Write("x", []byte("y"))
	if b, _ := m.Read("x"); string(b) != "y" {
		t.Errorf("b = %q", b)
	}
}
