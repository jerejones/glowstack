// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"strings"
	"testing"
)

func TestDevices(t *testing.T) {
	const head = "schema: 1\nareas:\n  - { id: x, include: [a] }\nzones:\n"
	for _, tt := range []struct{ name, zones, want string }{
		{"ok", "  - { id: z1, area: x, device: { ip: 192.0.2.50, mac: \"02:00:00:00:00:01\" } }\n" +
			"  - { id: z2, area: x, device: { ip: 192.0.2.51, mac: \"02:00:00:00:00:02\" } }\n" +
			"  - { id: z3, area: x, device: { ip: 192.0.2.50, mac: \"02:00:00:00:00:03\", port: 8080 } }\n", ""},
		{"duplicate mac", "  - { id: z1, area: x, device: { ip: 192.0.2.50, mac: \"02:00:00:00:00:01\" } }\n" +
			"  - { id: z2, area: x, device: { ip: 192.0.2.51, mac: \"02-00-00-00-00-01\" } }\n",
			`areas.yaml:6: zone "z2": device mac 02-00-00-00-00-01 is already used at areas.yaml:5`},
		{"missing mac", "  - { id: z1, area: x, device: { ip: 192.0.2.50 } }\n",
			`zone "z1": device needs a mac`},
		{"bad mac", "  - { id: z1, area: x, device: { mac: \"02:00:00\" } }\n",
			`zone "z1": device mac "02:00:00": want six hex bytes`},
		{"bad ip", "  - { id: z1, area: x, device: { ip: porch, mac: \"02:00:00:00:00:01\" } }\n",
			`zone "z1": device ip "porch" is not an IP address`},
		{"bad port", "  - { id: z1, area: x, device: { mac: \"02:00:00:00:00:01\", port: 70000 } }\n",
			`device port 70000 is out of range`},
		{"same address", "  - { id: z1, area: x, device: { ip: 192.0.2.50, mac: \"02:00:00:00:00:01\" } }\n" +
			"  - { id: z2, area: x, device: { ip: 192.0.2.50, mac: \"02:00:00:00:00:02\" } }\n",
			`zone "z2": device 192.0.2.50:80 clashes with the device at areas.yaml:5`},
		{"every address", "  - { id: z1, area: x, device: { mac: \"02:00:00:00:00:01\" } }\n" +
			"  - { id: z2, area: x, device: { ip: 192.0.2.50, mac: \"02:00:00:00:00:02\" } }\n",
			`zone "z2": device 192.0.2.50:80 clashes`},
		{"explicit wildcard", "  - { id: z1, area: x, device: { ip: 0.0.0.0, mac: \"02:00:00:00:00:01\" } }\n" +
			"  - { id: z2, area: x, device: { ip: 192.0.2.50, mac: \"02:00:00:00:00:02\" } }\n",
			`zone "z2": device 192.0.2.50:80 clashes`},
		{"equivalent addresses", "  - { id: z1, area: x, device: { ip: '::ffff:192.0.2.50', mac: \"02:00:00:00:00:01\" } }\n" +
			"  - { id: z2, area: x, device: { ip: 192.0.2.50, mac: \"02:00:00:00:00:02\" } }\n",
			`zone "z2": device 192.0.2.50:80 clashes`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c, err := Load(writeConfig(t, map[string]string{AreasFileName: head + tt.zones}), "")
			if tt.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				d := c.Zones[0].Device
				if d.Name != "z1" || d.Port != DefaultDevicePort {
					t.Errorf("defaults: name %q port %d", d.Name, d.Port)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error:\n%v\nwant it to contain %q", err, tt.want)
			}
		})
	}
}
