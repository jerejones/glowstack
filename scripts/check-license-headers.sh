#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Checks that every source file carries the MPL-2.0 notice near the top.
#
#   scripts/check-license-headers.sh          check files staged for commit
#   scripts/check-license-headers.sh --all    check every tracked file (CI)
#
# Run by .githooks/pre-commit. See AGENTS.md for the exact header text.

set -euo pipefail

# How far into a file the notice may start. Leaves room for a shebang,
# //go:build lines and an SPDX tag.
readonly HEAD_LINES=15
readonly PHRASE='This Source Code Form is subject to the terms of the Mozilla Public'
readonly URL='mozilla.org/MPL/2.0/'

# Paths that are source code and need the notice.
is_source() {
  case "$1" in
    vendor/* | third_party/* | testdata/* | */vendor/* | */third_party/* | */testdata/*) return 1 ;;
    *.go | *.sh | *.bash | *.js | *.mjs | *.ts | *.css | *.html | *.py) return 0 ;;
    Dockerfile | */Dockerfile | Dockerfile.* | */Dockerfile.*) return 0 ;;
    Makefile | */Makefile | .githooks/*) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ "${1:-}" == "--all" ]]; then
  mode=all
  mapfile -t files < <(git ls-files)
else
  mode=staged
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
fi

missing=()
for f in "${files[@]}"; do
  is_source "$f" || continue
  if [[ $mode == staged ]]; then
    # sed reads all its input; head would exit early and, with pipefail,
    # fail the check when git show gets SIGPIPE on a larger file.
    content=$(git show ":$f" | sed -n "1,${HEAD_LINES}p")
  else
    content=$(head -n "$HEAD_LINES" -- "$f")
  fi
  # Generated files are rebuilt from their sources and are exempt.
  grep -q 'Code generated .* DO NOT EDIT\.' <<<"$content" && continue
  if ! grep -qF "$PHRASE" <<<"$content" || ! grep -qF "$URL" <<<"$content"; then
    missing+=("$f")
  fi
done

if ((${#missing[@]})); then
  echo "Missing MPL-2.0 header (see AGENTS.md):" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi
