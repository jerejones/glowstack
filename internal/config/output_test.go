// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package config

import (
	"strings"
	"testing"
	"time"
)

func TestOutputSettings(t *testing.T) {
	c, err := Load("../../examples/fictional/config", "")
	if err != nil {
		t.Fatal(err)
	}
	s := c.Settings
	if s.Power.Group != "global" || time.Duration(*s.Power.Release) != 2*time.Second || !*s.Dither {
		t.Errorf("settings %+v", s)
	}
	if c.Controllers[0].HTTPPort != DefaultHTTP || c.Controllers[0].Port != DefaultPort {
		t.Errorf("ports %d %d", c.Controllers[0].Port, c.Controllers[0].HTTPPort)
	}
	c.Settings.Power.Group = "house"
	c.Controllers[1].HTTPPort = 70000
	err = c.Validate()
	if err == nil || !strings.Contains(err.Error(), `power group "house"`) || !strings.Contains(err.Error(), "http_port 70000") {
		t.Errorf("validate: %v", err)
	}
}
