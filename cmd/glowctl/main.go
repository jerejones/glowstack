// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command glowctl is the control API's command-line client, the same as
// `glowstack ctl`. Run `glowctl help` for the commands.
package main

import (
	"os"

	"github.com/jerejones/glowstack/internal/ctl"
)

func main() {
	os.Exit(ctl.Main(os.Args[1:], os.Stdout, os.Stderr))
}
