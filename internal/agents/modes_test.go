package agents

import (
	"bytes"
	"strings"
	"testing"
)

func TestModeTrackerRemembersTheLastValue(t *testing.T) {
	var m modeTracker
	m.feed([]byte("hello\x1b[?2004h\x1b[?25l\x1b[2Jtext\x1b[?1;1004h"))
	m.feed([]byte("\x1b[?25h more \x1b[?1049h")) // 1049 is not tracked
	if got, want := string(m.prefix()), "\x1b[?1h\x1b[?25h\x1b[?1004h\x1b[?2004h"; got != want {
		t.Fatalf("prefix = %q, want %q", got, want)
	}
	m.feed([]byte("\x1b[?2004l"))
	if !strings.Contains(string(m.prefix()), "\x1b[?2004l") {
		t.Fatalf("turning a mode off was not remembered: %q", m.prefix())
	}
}

// A PTY read can end in the middle of a sequence; the half must not be lost.
func TestModeTrackerAcrossChunkBoundaries(t *testing.T) {
	seq := "\x1b[?2004h"
	for cut := 1; cut < len(seq); cut++ {
		var m modeTracker
		m.feed([]byte("abc" + seq[:cut]))
		m.feed([]byte(seq[cut:] + "def"))
		if got := string(m.prefix()); got != seq {
			t.Errorf("cut at %d: prefix = %q, want %q", cut, got, seq)
		}
	}
}

func TestModeTrackerIgnoresOtherSequences(t *testing.T) {
	var m modeTracker
	m.feed([]byte("\x1b[2004h\x1b]0;title\x07\x1b[?2004x\x1b[?h"))
	if p := m.prefix(); len(p) != 0 {
		t.Fatalf("prefix = %q, want empty", p)
	}
}

// The case that broke paste: the startup sequence scrolled out of the ring,
// and a terminal attaching late must still be told bracketed paste is on.
func TestRingSnapshotRestoresModesThatScrolledOut(t *testing.T) {
	r := newRing(64)
	r.write([]byte("\x1b[?2004h"))
	r.write(bytes.Repeat([]byte("x"), 200))
	snap := r.snapshot()
	if !bytes.HasPrefix(snap, []byte("\x1b[?2004h")) {
		t.Fatalf("snapshot does not restore bracketed paste: %q", snap[:16])
	}
	if !bytes.HasSuffix(snap, bytes.Repeat([]byte("x"), 64)) {
		t.Fatal("scrollback lost")
	}
}
