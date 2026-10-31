# AGENTS.md

## What this is

Glowstack is a Go program that renders every pixel of a large addressable LED
installation and streams frames to many WLED controllers over DDP. It presents
itself to Home Assistant as several ordinary WLED devices. See `README.md` for
the design. Status: planning. There is no code yet.

## License header: required in every source file

The project is **MPL-2.0** (full text in `LICENSE`). Every source file must
start with Mozilla's Exhibit A notice, as a comment in that file's syntax.
That covers Go, shell, JS/TS, HTML, CSS, Python, Dockerfiles, Makefiles and
git hooks.

Go:

```go
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package stack
```

Shell, Dockerfile, Makefile and Python use `#`. HTML uses `<!-- … -->`. CSS
and JS use `/* … */` or `//`.

Rules:

- The notice must appear within the first 15 lines. Only a shebang,
  `//go:build` lines or an SPDX tag may come before it.
- In Go, leave a **blank line** between the notice and the `package` line. A
  comment directly above `package` becomes the package doc.
- Don't change the wording. The check matches it exactly.
- Generated files containing `Code generated … DO NOT EDIT.` are exempt.
  So are `vendor/`, `third_party/` and `testdata/`.
- Docs and data (`*.md`, `go.mod`, `go.sum`, JSON, YAML, SVG) don't need it.

### Code ported from WLED

WLED is EUPL-1.2. Code translated from WLED is allowed because MPL-2.0 is on
EUPL-1.2's compatibility list. Such files must keep WLED's copyright, so add
this below the MPL notice, before the package comment:

```go
// Portions ported from WLED (https://github.com/wled/WLED), wled00/FX.cpp.
// Copyright (c) 2016-present Christian Schwinne and individual WLED
// contributors. Originally EUPL-1.2.
```

Name the actual source file. Code from FastLED (MIT) needs FastLED's
copyright and MIT notice kept in the same way. Never remove existing
copyright or license notices from any file.

### The check

`scripts/check-license-headers.sh` checks staged files. With `--all` it
checks every tracked file, for CI. Enable the pre-commit hook once per clone:

```sh
git config core.hooksPath .githooks
```

Don't bypass it with `--no-verify`. Add the header instead.

## No site data in this repo

This repo is public. It must never contain anything from a real
installation: IP addresses, MAC addresses, SSIDs, coordinates, addresses,
room or family names, floor plans, or real area maps. That applies to code,
tests, examples, fixtures, commit messages and docs alike. Use made-up sample
data (e.g. `192.0.2.0/24` documentation addresses, `02:00:00:…` MACs, generic
area names like `porch`). Real site config is mounted into the container at
runtime and lives outside this repo.

## Conventions

- Effects keep WLED's effect IDs and names, so HA automations and presets
  carry over.
- WLED API compatibility is tested against Home Assistant's own `python-wled`
  library.
