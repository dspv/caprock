package agents

import (
	"bytes"
	"time"

	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/termbuf"
)

// Input a session has not answered with an event yet (narrate.Nudge).
//
// A session's status is read from the events it writes, and two things a
// person does write none at the moment they do them. Answering a permission
// dialog fires no hook: the next is the call's PostToolUse, when the call
// finishes, so an agent set going by "1" read "waiting for approval" for as
// long as its build ran. And Enter at the prompt is seen only once Claude
// Code has fired UserPromptSubmit and the event has crossed the daemon — or,
// for an agent read from its transcript, once the next poll reads it
// (owner, 2026-10-14: "waiting for you" 10-20 s after he set it going).
//
// Every key and button into a session Caprock started passes through here,
// so the daemon knows at once. What it learns is kept as the session's
// newest nudge, which narrate reads only while no event has come after it,
// and OnNudge tells the screens to ask again.

// typedInput notes what typed bytes did before they are written: a
// permission menu answered or rejected, or a message submitted.
func (m *Manager) typedInput(a *Agent, data []byte) {
	at := m.now()
	t := m.typedIntoMenu(a.SessionID, data)
	switch {
	case t.interrupted:
		m.noteNudge(a, narrate.NudgeRejected, at)
	case t.answered:
		// Which option the key picked is on the screen. The bytes are
		// copied now, before the key redraws it; replaying them is off the
		// keystroke's goroutine. A prompt is answered a few times a turn
		// at most, so the copy is not on the typing path.
		cols, rows := a.size()
		ring := a.ring.snapshot()
		var since []byte
		if t.ringAt > 0 {
			since, _ = a.ring.r.Since(t.ringAt)
		}
		key := data[0]
		go func() {
			kind := narrate.NudgeApproved
			if pickedNo(ring, since, cols, rows, key) {
				kind = narrate.NudgeRejected
			}
			m.noteNudge(a, kind, at)
		}()
	case !t.had && isSubmit(data):
		m.noteNudge(a, narrate.NudgeSubmit, at)
	}
}

// isSubmit reports whether typed bytes end in the key that submits a prompt:
// a carriage return, but not ESC CR, which Caprock types for a line break
// inside the prompt.
func isSubmit(data []byte) bool {
	return bytes.HasSuffix(data, []byte("\r")) && !bytes.HasSuffix(data, []byte("\x1b\r"))
}

// pickedNo reports whether key, typed at the dialog a session's output shows,
// picks its "No" option: a digit names one, Enter picks the one marked. The
// screen is read as dialogKey reads it: the whole ring, else the bytes since
// the prompt's hook alone. A dialog neither shows is taken as answered Yes,
// the option Enter picks unless the arrows moved off it.
func pickedNo(ring, since []byte, cols, rows int, key byte) bool {
	opts, marked, ok := readMenuMarked(termbuf.Screen(ring, cols, rows))
	if !ok && len(since) > 0 {
		opts, marked, ok = readMenuMarked(termbuf.Screen(since, cols, rows))
	}
	if !ok {
		return false
	}
	n := marked
	if key >= '0' && key <= '9' {
		n = int(key - '0')
	}
	for _, o := range opts {
		if o.n == n {
			return isNo(o.text)
		}
	}
	return false
}

// noteNudge keeps n as the session's newest nudge and tells OnNudge. An
// older nudge never replaces a newer one: a menu's option is read after the
// key, and Enter typed meanwhile is the newer news.
func (m *Manager) noteNudge(a *Agent, kind string, at time.Time) {
	n := narrate.Nudge{At: at, Kind: kind}
	m.nudgeMu.Lock()
	if old, ok := m.nudges[a.SessionID]; ok && old.At.After(at) {
		m.nudgeMu.Unlock()
		return
	}
	if m.nudges == nil {
		m.nudges = map[string]narrate.Nudge{}
	}
	m.nudges[a.SessionID] = n
	m.nudgeMu.Unlock()
	if m.OnNudge != nil {
		m.OnNudge(a.SessionID, a.Kind, n)
	}
}

// Nudge is the newest input noted for a session Caprock holds; false for
// any other session, and for one nothing was typed into.
func (m *Manager) Nudge(sessionID string) (narrate.Nudge, bool) {
	if _, ok := m.Get(sessionID); !ok {
		return narrate.Nudge{}, false
	}
	m.nudgeMu.Lock()
	defer m.nudgeMu.Unlock()
	n, ok := m.nudges[sessionID]
	return n, ok
}

// forgetNudge drops a session's nudge when it ends.
func (m *Manager) forgetNudge(sessionID string) {
	m.nudgeMu.Lock()
	delete(m.nudges, sessionID)
	m.nudgeMu.Unlock()
}
