// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled_test

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestPythonWLED runs test/pywled/test_pywled.py, which drives the devices
// with python-wled (Home Assistant's WLED library), against glowstack on
// the fictional example with its devices on loopback ports. It needs a
// Python with python-wled installed: $GLOWSTACK_PYWLED_PYTHON, else
// /tmp/pywled-venv/bin/python, else python3. Without one it's skipped:
//
//	python3 -m venv /tmp/pywled-venv && /tmp/pywled-venv/bin/pip install wled
func TestPythonWLED(t *testing.T) {
	if testing.Short() {
		t.Skip("-short")
	}
	py := findPython(t)
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "glowstack")
	build := exec.Command("go", "build", "-o", bin, "./cmd/glowstack")
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	data := t.TempDir()
	if err := os.CopyFS(data, os.DirFS(filepath.Join(root, "examples/fictional/data"))); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--config", filepath.Join(root, "examples/fictional/config"),
		"--data", data, "--http", "127.0.0.1:0", "--wled-bind", "127.0.0.1:0", "--output", "none")
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.WaitDelay = 5 * time.Second
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cancel()
		_ = cmd.Wait()
	}()

	// The addresses come from the log: "http listening" and one "wled
	// device listening" per zone device. The log is shown if the test fails.
	type addrs struct {
		api     string
		devices map[string]string
	}
	found := make(chan addrs, 1)
	var logMu sync.Mutex
	var logBuf strings.Builder
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		addrRE := regexp.MustCompile(`addr=(\S+)`)
		zoneRE := regexp.MustCompile(`zone=(\S+)`)
		got := addrs{devices: map[string]string{}}
		sent := false
		lines := bufio.NewScanner(stderr)
		for lines.Scan() {
			line := lines.Text()
			logMu.Lock()
			logBuf.WriteString(line + "\n")
			logMu.Unlock()
			a := addrRE.FindStringSubmatch(line)
			switch {
			case a == nil:
			case strings.Contains(line, `msg="http listening"`):
				got.api = a[1]
			case strings.Contains(line, `msg="wled device listening"`):
				if z := zoneRE.FindStringSubmatch(line); z != nil {
					got.devices[z[1]] = a[1]
				}
			}
			if !sent && got.api != "" && len(got.devices) == 2 {
				found <- got
				sent = true
			}
		}
	}()
	defer func() {
		cancel()
		<-readDone
		if t.Failed() {
			logMu.Lock()
			t.Logf("glowstack's log:\n%s", logBuf.String())
			logMu.Unlock()
		}
	}()
	var got addrs
	select {
	case got = <-found:
	case <-time.After(30 * time.Second):
		t.Fatal("glowstack didn't log its listen addresses")
	}

	args := []string{"-I", filepath.Join(root, "test/pywled/test_pywled.py"), "--api", "http://" + got.api}
	for z, a := range got.devices {
		args = append(args, "--device", z+"="+a)
	}
	out, err := exec.CommandContext(ctx, py, args...).CombinedOutput()
	t.Logf("test_pywled.py:\n%s", out)
	if err != nil {
		t.Fatalf("test_pywled.py: %v", err)
	}
}

func findPython(t *testing.T) string {
	t.Helper()
	var cands []string
	if p := os.Getenv("GLOWSTACK_PYWLED_PYTHON"); p != "" {
		cands = append(cands, p)
	}
	cands = append(cands, "/tmp/pywled-venv/bin/python", "python3")
	for _, c := range cands {
		p, err := exec.LookPath(c)
		if err != nil {
			continue
		}
		if exec.Command(p, "-I", "-c", "import wled, aiohttp").Run() == nil {
			return p
		}
	}
	t.Skip("no python with python-wled (pip install wled); set GLOWSTACK_PYWLED_PYTHON")
	return ""
}
