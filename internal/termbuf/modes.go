package termbuf

import (
	"bytes"
	"maps"
	"strconv"
	"strings"
)

// trackedModes are the DEC private modes a full-screen app sets once, at
// startup, and a terminal must still know about when it attaches later.
//
// The ring keeps only the last 256 KB of output. Claude Code redraws
// constantly, so within minutes the `ESC[?2004h` it sent on startup has been
// pushed out, and a terminal attached after that — a tab switch, a reload —
// starts with bracketed paste off. xterm then sends a paste raw, with every
// newline turned into a carriage return, and Claude Code can no longer tell a
// paste from typing: a long paste shows in full instead of collapsing into
// "[Pasted text]" (FB-034). The same loss hits application cursor keys (what
// the arrows send), focus reporting and cursor visibility.
//
// And the screen and the mouse. Codex (codex-cli 0.161) runs on the alternate
// screen (1049) and owns its transcript there: it asks for mouse reports
// (1000, 1002, 1003, SGR-encoded with 1006) and scrolls on the wheel reports
// it gets. Once those had scrolled out of the ring, a terminal attached later
// stayed on the normal screen with the mouse off: the wheel moved xterm's own
// scrollback, which an alternate-screen app never fills, and Codex was never
// told — "scrolling does not work in Codex" (owner, 2026-10-18).
var trackedModes = []int{1, 25, 1000, 1002, 1003, 1004, 1006, 1049, 2004}

// mouseTracking are the modes that pick what the mouse reports. A terminal
// has one tracking mode at a time: setting one replaces the others, and
// resetting any of them turns reporting off (xterm, and xterm.js after it).
var mouseTracking = []int{1000, 1002, 1003}

// modeTracker remembers the last value the output set for each tracked mode,
// across chunk boundaries.
type modeTracker struct {
	set   map[int]bool // mode → on/off, only for modes the output has touched
	carry []byte       // an escape sequence cut off at the end of the last chunk
}

// maxCarry bounds the partial sequence kept between chunks; a DEC private mode
// sequence is a dozen bytes, so anything longer is not one.
const maxCarry = 64

func (t *modeTracker) feed(p []byte) {
	data := p
	if len(t.carry) > 0 {
		t.carry = append(t.carry, p...)
		data, t.carry = t.carry, nil
	}
	for i := 0; i < len(data); i++ {
		k := bytes.IndexByte(data[i:], 0x1b)
		if k < 0 {
			return
		}
		i += k
		// ESC [ ? params h|l
		j := i + 1
		if j >= len(data) {
			t.keep(data[i:])
			return
		}
		if data[j] != '[' {
			continue
		}
		j++
		if j >= len(data) {
			t.keep(data[i:])
			return
		}
		if data[j] != '?' {
			continue
		}
		j++
		start := j
		for j < len(data) && (data[j] >= '0' && data[j] <= '9' || data[j] == ';') {
			j++
		}
		if j >= len(data) {
			t.keep(data[i:])
			return
		}
		if final := data[j]; final == 'h' || final == 'l' {
			for _, param := range strings.Split(string(data[start:j]), ";") {
				n, err := strconv.Atoi(param)
				if err != nil || !tracked(n) {
					continue
				}
				t.apply(n, final == 'h')
			}
		}
		i = j
	}
}

func (t *modeTracker) apply(n int, on bool) {
	if t.set == nil {
		t.set = map[int]bool{}
	}
	if isMouseTracking(n) {
		for _, m := range mouseTracking {
			t.set[m] = false
		}
	}
	t.set[n] = on
}

func (t *modeTracker) keep(tail []byte) {
	if len(tail) <= maxCarry {
		t.carry = append([]byte(nil), tail...)
	}
}

// clone is a copy that can be fed without changing t.
func (t *modeTracker) clone() modeTracker {
	return modeTracker{set: maps.Clone(t.set), carry: append([]byte(nil), t.carry...)}
}

// prefix is the sequence that puts a fresh terminal into the modes the output
// has set. Every reset comes before every set: resetting any mouse tracking
// mode turns the mouse off, so an `ESC[?1002l` after an `ESC[?1003h` would
// undo it.
func (t *modeTracker) prefix() []byte {
	var b []byte
	for _, want := range []bool{false, true} {
		for _, m := range trackedModes {
			on, ok := t.set[m]
			if !ok || on != want {
				continue
			}
			b = append(b, "\x1b[?"...)
			b = strconv.AppendInt(b, int64(m), 10)
			if on {
				b = append(b, 'h')
			} else {
				b = append(b, 'l')
			}
		}
	}
	return b
}

func tracked(n int) bool {
	for _, m := range trackedModes {
		if m == n {
			return true
		}
	}
	return false
}

func isMouseTracking(n int) bool {
	for _, m := range mouseTracking {
		if m == n {
			return true
		}
	}
	return false
}
