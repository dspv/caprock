package agents

import (
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
var trackedModes = []int{1, 25, 1004, 2004}

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
		if data[i] != 0x1b {
			continue
		}
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
				if t.set == nil {
					t.set = map[int]bool{}
				}
				t.set[n] = final == 'h'
			}
		}
		i = j
	}
}

func (t *modeTracker) keep(tail []byte) {
	if len(tail) <= maxCarry {
		t.carry = append([]byte(nil), tail...)
	}
}

// prefix is the sequence that puts a fresh terminal into the modes the output
// has set, to be sent ahead of the scrollback snapshot. The snapshot may set
// some of them again; it comes later, so it wins, which is correct — it is
// the more recent output.
func (t *modeTracker) prefix() []byte {
	var b []byte
	for _, m := range trackedModes {
		on, ok := t.set[m]
		if !ok {
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
