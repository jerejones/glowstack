// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package storage

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
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

func TestWriteFileAtomicReportsDirectorySyncFailure(t *testing.T) {
	dir := t.TempDir()
	// Write and search permissions allow file creation and rename, but no
	// read permission means the directory cannot be opened for syncing.
	if err := os.Chmod(dir, 0o300); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0o700)
	if f, err := os.Open(dir); err == nil {
		f.Close()
		t.Skip("directory permissions are not enforced for this user")
	}
	if err := WriteFileAtomic(filepath.Join(dir, "state.json"), []byte("new"), 0o644); err == nil {
		t.Fatal("reported a durable write despite being unable to sync its directory")
	}
}

func TestSaverCloseStopsTriggersBeforeFinalSave(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var saves atomic.Int32
	s := NewSaver(time.Hour, func() error {
		if saves.Add(1) == 1 {
			close(started)
			<-release
		}
		return nil
	}, nil)
	// Defer the initial background save so Close performs it.
	s.last = time.Now()
	s.Trigger()
	done := make(chan error, 1)
	go func() { done <- s.Close() }()
	<-started
	s.Trigger() // Close is already doing its final save.
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if got := saves.Load(); got != 1 {
		t.Fatalf("accepted a trigger during Close: %d saves, want 1", got)
	}
}

func TestSaverFlushCancelsChangesQueuedDuringSave(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var saves atomic.Int32
	s := NewSaver(time.Hour, func() error {
		if saves.Add(1) == 1 {
			close(started)
			<-release
		}
		return nil
	}, nil)
	s.Trigger()
	<-started
	// Give Flush a timer to stop, then wait until it has stopped it and
	// is blocked behind the in-flight save.
	s.Trigger()
	done := make(chan error, 1)
	go func() { done <- s.Flush() }()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		stopped := s.timer == nil
		s.mu.Unlock()
		if stopped {
			break
		}
		if time.Now().After(deadline) {
			close(release)
			t.Fatal("Flush did not stop its pending timer")
		}
		runtime.Gosched()
	}
	// A later change arms another timer while Flush waits.
	s.Trigger()
	s.mu.Lock()
	pending := s.timer
	s.mu.Unlock()
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if pending != nil && pending.Stop() {
		t.Fatal("Flush left a timer armed for a change it already saved")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}
