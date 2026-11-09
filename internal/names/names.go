// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package names turns config ids into what a person reads. It works at
// display time and never changes the config. The live map's humanize in
// static/util.js follows the same rules; testdata/humanize.json checks
// both.
package names

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	listIndex = regexp.MustCompile(`\.(\d+)`)
	separator = regexp.MustCompile(`[._-]+`)
	colorsN   = regexp.MustCompile(`\bcolors (\d)`)
	bandsN    = regexp.MustCompile(`\bbands (\d)`)
	compass   = regexp.MustCompile(`(?i)\b(ne|nw|se|sw|n|s|e|w)\b`)
)

// Humanize turns an id into words: "shed-sw" is "Shed SW", "gate-w" is
// "Gate west" and "colors.0" is "Color 1".
func Humanize(id string) string {
	s := listIndex.ReplaceAllStringFunc(id, func(m string) string {
		n, err := strconv.Atoi(m[1:])
		if err != nil {
			return m
		}
		return " " + strconv.Itoa(n+1)
	})
	s = strings.TrimSpace(separator.ReplaceAllString(s, " "))
	s = colorsN.ReplaceAllString(s, "color $1")
	s = bandsN.ReplaceAllString(s, "band $1")
	s = compass.ReplaceAllStringFunc(s, func(m string) string {
		switch strings.ToLower(m) {
		case "n":
			return "north"
		case "s":
			return "south"
		case "e":
			return "east"
		case "w":
			return "west"
		}
		return strings.ToUpper(m)
	})
	r, n := utf8.DecodeRuneInString(s)
	if n == 0 {
		return s
	}
	return string(unicode.ToUpper(r)) + s[n:]
}

const unassigned = "unassigned"

// Run is a run's or controller's name. An id's "unassigned" prefix marks
// a state, not part of what the strip is called.
func Run(id string) string {
	if rest, ok := strings.CutPrefix(id, unassigned); ok && rest != "" && strings.ContainsAny(rest[:1], "-_.") {
		return Humanize(rest[1:])
	}
	return Humanize(id)
}

// Node is a node's name from its id and configured label. A label can
// carry a slug and notes, "bend-1: pillar bend (estimate)": the slug is the
// name, the rest is shown on hover.
func Node(id, label string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		return Humanize(id)
	}
	if slug, _, ok := strings.Cut(label, ":"); ok && !strings.ContainsAny(strings.TrimSpace(slug), " \t") {
		return Humanize(strings.TrimSpace(slug))
	}
	if i := strings.LastIndex(label, " ("); i > 0 && strings.HasSuffix(label, ")") {
		label = strings.TrimSpace(label[:i])
	}
	return Humanize(label)
}

// product is what a zone's WLED device name usually starts with; it says
// nothing inside the product's own page.
const product = "glowstack"

// Zone is a zone's name from its id and configured device name.
func Zone(id, name string) string {
	name = strings.TrimSpace(name)
	if len(name) >= len(product) && strings.EqualFold(name[:len(product)], product) {
		name = strings.TrimLeft(name[len(product):], " -_.:")
	}
	if name == "" || name == id {
		return Humanize(id)
	}
	return name
}

// InternalArea reports whether an area exists for bookkeeping, not as a
// place to put a look: "status-…" areas and ones starting with "_".
func InternalArea(id string) bool {
	return strings.HasPrefix(id, "status-") || strings.HasPrefix(id, "status_") || strings.HasPrefix(id, "_")
}
