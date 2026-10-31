// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package plan parses SVG floor plans into flattened polylines for the
// layout solver.
//
// # Plan units
//
// All returned coordinates are in the SVG root's user units with every
// transform attribute applied ("plan units"). The root viewBox→width/height
// mapping is deliberately ignored; the root viewBox is only reported via
// Drawing.ViewBox.
//
// # Extracted shapes
//
// Parse walks the whole document (any nesting of <g>, <svg>, …) and keeps
// every <path>, <polyline>, <polygon> and <line> element that carries an id
// attribute or an inkscape:label (matched in the Inkscape namespace
// http://www.inkscape.org/namespaces/inkscape, or as a literal
// "inkscape:label" prefix). A shape's ID is its id attribute, falling back
// to its inkscape:label. Shapes with neither are ignored.
//
// Each shape is flattened to a single polyline:
//
//   - <path d>: full SVG path grammar (M/m, L/l, H/h, V/v, C/c, S/s, Q/q,
//     T/t, A/a, Z/z, implicit repeats, compact numbers and arc flags).
//     Curves are subdivided so the polyline deviates from the true curve by
//     at most about 0.05 plan units (subject to a per-curve segment cap).
//   - <polyline points>: the listed points.
//   - <polygon points>: the listed points, closed by repeating the first
//     point as the last vertex.
//   - <line x1 y1 x2 y2>: the two endpoints.
//
// # Subpaths
//
// A moveto (M/m) after the first starts a new SVG subpath, but the returned
// polyline simply continues: the jump from the previous point to the new
// subpath start becomes an ordinary straight segment, contributing to
// Length and Cumulative like any other segment.
//
// # Transforms
//
// The transform attribute is honoured on the shape itself and on every
// ancestor element, composed outermost-ancestor first. Supported functions:
// matrix(a b c d e f), translate(tx [ty]), scale(sx [sy]),
// rotate(angle [cx cy]), skewX(angle) and skewY(angle), with any mix of
// comma and whitespace separators and multiple functions per attribute.
// Curves are flattened in local coordinates with the tolerance tightened by
// the transform's maximum scale factor, then the (affine) transform is
// applied to the flattened points.
//
// # Vertex labels (data-nodes)
//
// A shape may carry a data-nodes attribute: comma-separated layout node
// ids, whitespace-trimmed, one entry per drawn vertex in order. Drawn
// vertices are the endpoint of every path command (M, L, H, V, C, S, Q, T
// and A each contribute their endpoint; Z contributes the closing return to
// the subpath start), every listed polyline/polygon point (including the
// polygon's closing repeat) and both endpoints of a line. Points introduced
// by curve flattening are never labelled. Empty entries leave a vertex
// unlabelled; fewer entries than drawn vertices leave the rest unlabelled;
// more entries than drawn vertices is an error, as is using the same label
// twice on one shape.
//
// Consecutive duplicate points (zero-length segments, e.g. a Z that returns
// to a subpath start the path already reached) are dropped; a label carried
// by either duplicate is kept on the surviving point, and two different
// labels on the same surviving point is an error.
//
// Example:
//
//	<path id="eave" d="M220 180 H100 V100 L160 100 220 100"
//	      data-nodes="shed-se,shed-sw,shed-nw,shed-eave-mid,shed-ne"/>
package plan
