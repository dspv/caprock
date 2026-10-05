// Package ptyhost keeps an owned session's terminal alive across daemon
// restarts (ADR-033).
//
// A session Caprock starts used to live inside the daemon: the daemon held the
// PTY master, so stopping the daemon — an upgrade, `launchctl kickstart -k`,
// `caprock down` — closed the terminal and took the session with it. Here the
// PTY belongs to a small process of its own, `caprock pty-host`, one per
// session: it starts the agent, keeps the PTY master and a scrollback ring,
// and serves one daemon at a time over a token-guarded loopback socket. The
// daemon is a client. It can go away and a new one, even a newer binary, can
// connect to the same holder and carry on.
//
// The holder never signals or types into anything but its own child (rule 7),
// exits when the child does, and removes its registry entry on the way out.
//
// # Wire protocol
//
// Every message is a frame: one type byte, a 4-byte big-endian payload length,
// the payload. The first frame on a connection is the client's Hello; the
// holder answers Welcome and then a Snapshot of its ring, and from then on
// streams Output and, once, Exit.
//
// The protocol is versioned by Proto, carried in Hello and Welcome. A holder
// started by one release must keep working with the daemon of the next, so
// the rule is additive: frame types are never renumbered or repurposed, and
// a side that receives a frame type it does not know ignores it. A change that
// cannot be made that way raises Proto, and a daemon keeps speaking every
// older version for as long as a holder of that version can still be running.
package ptyhost

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Proto is the protocol version this binary speaks.
const Proto = 1

// Frame types. Never renumber; only add.
const (
	frameHello    byte = 'H' // client → holder: JSON hello
	frameWelcome  byte = 'W' // holder → client: JSON welcome
	frameSnapshot byte = 'S' // holder → client: the ring, once, after Welcome
	frameOutput   byte = 'O' // holder → client: terminal bytes
	frameExit     byte = 'X' // holder → client: JSON exit, then the holder closes
	frameError    byte = 'E' // holder → client: a refusal, as text, then close
	frameInput    byte = 'I' // client → holder: typed bytes
	frameResize   byte = 'R' // client → holder: JSON resize
	frameSignal   byte = 'G' // client → holder: JSON signal
	frameSeqInput byte = 'J' // client → holder: sequenced input (see encodeSeqInput)
	frameSeqAck   byte = 'K' // holder → client: JSON seqAck, the answer to one J
)

// maxFrame bounds a payload. Output is read 32 KiB at a time and the ring is
// 256 KiB, so anything near this is a corrupt or hostile stream.
const maxFrame = 8 << 20

type hello struct {
	Proto int    `json:"proto"`
	Token string `json:"token"`
	// Resume skips the snapshot: the client already has the screen and is
	// reconnecting after a dropped connection, not attaching fresh.
	Resume bool `json:"resume,omitempty"`
	// Since asks a resuming holder for the output from this offset on, so
	// nothing printed while the connection was down is lost. A holder that
	// no longer has it sends a snapshot instead. Older holders ignore it.
	Since *uint64 `json:"since,omitempty"`
}

type welcome struct {
	Proto    int    `json:"proto"`
	ChildPID int    `json:"child_pid"`
	Paused   bool   `json:"paused,omitempty"`
	Version  string `json:"version,omitempty"`
	// Offset is the offset one past the newest byte the holder has output,
	// and RingStart that of the oldest byte its ring holds: the snapshot that
	// follows is the mode prefix plus bytes [RingStart, Offset). Absent from
	// holders that predate terminal protocol v2.
	Offset    *uint64 `json:"offset,omitempty"`
	RingStart *uint64 `json:"ring_start,omitempty"`
	// SeqInput says the holder understands J frames.
	SeqInput bool `json:"seq_input,omitempty"`
}

// seqAck answers one J frame: the client's last applied sequence after it,
// which is at least Req when Req was applied now or before.
type seqAck struct {
	Client string `json:"client"`
	Req    uint64 `json:"req"`
	Seq    uint64 `json:"seq"`
	Error  string `json:"error,omitempty"`
}

type resizeMsg struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type signalMsg struct {
	Signal string `json:"signal"`
}

type exitMsg struct {
	Code int `json:"code"`
}

// writeFrame writes one frame in a single Write, so concurrent writers that
// share a lock never interleave a header with someone else's payload.
func writeFrame(w io.Writer, typ byte, payload []byte) error {
	buf := make([]byte, 5+len(payload))
	buf[0] = typ
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(payload))) //nolint:gosec // bounded by maxFrame on every path that builds one
	copy(buf[5:], payload)
	_, err := w.Write(buf)
	return err
}

func encodeFrame(typ byte, payload []byte) []byte {
	buf := make([]byte, 5+len(payload))
	buf[0] = typ
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(payload))) //nolint:gosec // see writeFrame
	copy(buf[5:], payload)
	return buf
}

// encodeSeqInput is a J payload: the client id's length (one byte), the id,
// the 8-byte big-endian sequence, the typed bytes.
func encodeSeqInput(client string, seq uint64, p []byte) []byte {
	b := make([]byte, 0, 1+len(client)+8+len(p))
	b = append(b, byte(len(client)))
	b = append(b, client...)
	b = binary.BigEndian.AppendUint64(b, seq)
	return append(b, p...)
}

var errBadSeqInput = errors.New("ptyhost: malformed sequenced input")

func decodeSeqInput(b []byte) (string, uint64, []byte, error) {
	if len(b) < 1 {
		return "", 0, nil, errBadSeqInput
	}
	n := int(b[0])
	if n == 0 || len(b) < 1+n+8 {
		return "", 0, nil, errBadSeqInput
	}
	return string(b[1 : 1+n]), binary.BigEndian.Uint64(b[1+n : 1+n+8]), b[1+n+8:], nil
}

var errFrameTooLarge = errors.New("ptyhost: frame too large")

func readFrame(r io.Reader) (byte, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:5])
	if n > maxFrame {
		return 0, nil, fmt.Errorf("%w: %d bytes", errFrameTooLarge, n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return hdr[0], payload, nil
}
