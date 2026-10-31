// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReloadSwapsDeviceAddresses(t *testing.T) {
	f := newFixture(t)
	// Reserve two loopback ports, then put them into the fictional config.
	var ports []int
	var reservations []net.Listener
	for range 2 {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		reservations = append(reservations, ln)
		ports = append(ports, ln.Addr().(*net.TCPAddr).Port)
	}
	path := filepath.Join(f.config, "areas.yaml")
	base, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	write := func(front, porch int) {
		t.Helper()
		body := strings.ReplaceAll(string(base), "ip: 192.0.2.50,", fmt.Sprintf("ip: 127.0.0.1, port: %d,", front))
		body = strings.ReplaceAll(body, "ip: 192.0.2.51,", fmt.Sprintf("ip: 127.0.0.1, port: %d,", porch))
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := f.a.Reload(); err != nil {
			t.Fatal(err)
		}
	}
	write(ports[0], ports[1])
	// Release the reservations immediately before starting the listeners.
	for _, ln := range reservations {
		ln.Close()
	}
	defer f.d.stopAll()
	f.d.sync(context.Background())
	if len(f.d.Addrs()) != 2 {
		t.Fatal("initial listeners did not start")
	}
	write(ports[1], ports[0])
	f.d.sync(context.Background())
	for zone, port := range map[string]int{"front": ports[1], "porch": ports[0]} {
		addr := f.d.Addrs()[zone]
		if addr == nil || addr.(*net.TCPAddr).Port != port {
			t.Errorf("%s after reload: %v, want loopback port %d", zone, addr, port)
		}
	}
}
