// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package scene

import (
	"bytes"
	"encoding/binary"
)

// GLB wraps a glTF JSON document as a glTF binary with no binary chunk. It
// is for tests and sample scenes; real scenes come from a modeling tool.
func GLB(doc []byte) []byte {
	for len(doc)%4 != 0 {
		doc = append(doc, ' ')
	}
	var b bytes.Buffer
	le := binary.LittleEndian
	b.WriteString("glTF")
	binary.Write(&b, le, uint32(2))
	binary.Write(&b, le, uint32(12+8+len(doc)))
	binary.Write(&b, le, uint32(len(doc)))
	b.WriteString("JSON")
	b.Write(doc)
	return b.Bytes()
}
