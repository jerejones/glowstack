// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package ddp sends controller frames to WLED over DDP (Distributed
// Display Protocol, http://www.3waylabs.com/ddp/), and parses DDP for the
// fake WLED device.
//
// # Packet format
//
// Checked against the DDP spec and WLED's receiver (wled00/e131.cpp
// handleDDPPacket, constants in src/dependencies/e131/ESPAsyncE131.h):
//
//	byte 0    flags: 0x40 (version 1), | 0x01 (push) on a frame's last packet
//	byte 1    sequence: low 4 bits, 1–15; 0 means unused
//	byte 2    data type: 0x0B RGB, 0x1B RGBW (8 bits per channel). WLED
//	          reads bits 3–5: 011 means 4 channels, anything else 3
//	byte 3    destination id: 1 (default output device)
//	bytes 4–7 data offset in bytes, big-endian
//	bytes 8–9 data length in bytes, big-endian
//	bytes 10… pixel data, R G B [W] per pixel
//
// WLED turns the byte offset into a pixel index by dividing by the
// channel count, so every packet starts on a pixel boundary: 1440 data
// bytes is 480 RGB or 360 RGBW pixels.
//
// All packets of one frame carry the same sequence number, and it
// advances by one (1–15, skipping 0) per frame. WLED's optional
// "skip out-of-sequence packets" check drops packets whose number is
// within the four before the last push's, which per-frame numbering never
// hits however many packets a frame takes.
package ddp

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Protocol constants.
const (
	Port      = 4048 // default UDP port
	HeaderLen = 10
	MaxData   = 1440 // data bytes per packet; a multiple of 3 and 4

	FlagVer1    = 0x40
	FlagVerMask = 0xC0
	FlagPush    = 0x01
	FlagQuery   = 0x02
	FlagReply   = 0x04
	FlagStorage = 0x08
	FlagTime    = 0x10

	TypeRGB  = 0x0B // 00 001 011: RGB, 8 bits per channel
	TypeRGBW = 0x1B // 00 011 011: RGBW, 8 bits per channel

	IDDisplay = 1
	IDControl = 246
	IDConfig  = 250
	IDStatus  = 251
)

// Header is a parsed DDP header.
type Header struct {
	Flags  byte
	Seq    byte // 0–15
	Type   byte
	ID     byte
	Offset uint32 // bytes
	Len    uint16 // data bytes
}

// Push reports whether the packet ends a frame.
func (h Header) Push() bool { return h.Flags&FlagPush != 0 }

// Channels is the bytes per pixel the data type says, the way WLED reads
// it: 4 for an RGBW type, otherwise 3.
func (h Header) Channels() int {
	if (h.Type>>3)&0b111 == 0b011 {
		return 4
	}
	return 3
}

// DataType returns the type byte for 3 or 4 channels per pixel.
func DataType(channels int) byte {
	if channels == 4 {
		return TypeRGBW
	}
	return TypeRGB
}

// AppendPacket appends one packet with the given header fields and data to
// dst.
func AppendPacket(dst []byte, flags, seq, dataType byte, offset uint32, data []byte) []byte {
	dst = append(dst, flags, seq&0x0F, dataType, IDDisplay)
	dst = binary.BigEndian.AppendUint32(dst, offset)
	dst = binary.BigEndian.AppendUint16(dst, uint16(len(data)))
	return append(dst, data...)
}

// Packets splits one frame of pixel data into packets and calls fn for
// each, in order, with the push flag on the last. pkt is reused between
// calls. An empty frame sends nothing.
func Packets(frame []byte, channels int, seq byte, pkt []byte, fn func(pkt []byte) error) error {
	typ := DataType(channels)
	for off := 0; off < len(frame); off += MaxData {
		end := min(off+MaxData, len(frame))
		flags := byte(FlagVer1)
		if end == len(frame) {
			flags |= FlagPush
		}
		pkt = AppendPacket(pkt[:0], flags, seq, typ, uint32(off), frame[off:end])
		if err := fn(pkt); err != nil {
			return err
		}
	}
	return nil
}

// NextSeq returns the sequence number after s: 1–15, skipping 0.
func NextSeq(s byte) byte {
	if s >= 15 {
		return 1
	}
	return s + 1
}

// Errors from Parse.
var (
	ErrShort   = errors.New("ddp: packet shorter than its header")
	ErrVersion = errors.New("ddp: not version 1")
)

// Parse splits a packet into its header and pixel data. A timecode (flag
// 0x10) is skipped. Data longer than the header's length is trimmed.
func Parse(pkt []byte) (Header, []byte, error) {
	if len(pkt) < HeaderLen {
		return Header{}, nil, ErrShort
	}
	h := Header{
		Flags:  pkt[0],
		Seq:    pkt[1] & 0x0F,
		Type:   pkt[2],
		ID:     pkt[3],
		Offset: binary.BigEndian.Uint32(pkt[4:8]),
		Len:    binary.BigEndian.Uint16(pkt[8:10]),
	}
	if h.Flags&FlagVerMask != FlagVer1 {
		return h, nil, ErrVersion
	}
	start := HeaderLen
	if h.Flags&FlagTime != 0 {
		start += 4
	}
	if len(pkt) < start+int(h.Len) {
		return h, nil, fmt.Errorf("ddp: packet has %d data bytes, header says %d", len(pkt)-start, h.Len)
	}
	return h, pkt[start : start+int(h.Len)], nil
}
