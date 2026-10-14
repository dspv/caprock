package agents

import (
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/narrate"
)

// spawnNudged is spawnOwned that also records every nudge announced.
func spawnNudged(t *testing.T) (*Manager, func() []narrate.Nudge) {
	t.Helper()
	m, _, _ := spawnOwned(t)
	var mu sync.Mutex
	var got []narrate.Nudge
	m.OnNudge = func(id, _ string, n narrate.Nudge) {
		if id != "fixed-session-id" {
			t.Errorf("nudge for %q", id)
		}
		mu.Lock()
		got = append(got, n)
		mu.Unlock()
	}
	return m, func() []narrate.Nudge {
		mu.Lock()
		defer mu.Unlock()
		return append([]narrate.Nudge(nil), got...)
	}
}

// waitNudge waits for the session's nudge to be of kind: a menu answered by
// a key is read off the screen on a goroutine of its own.
func waitNudge(t *testing.T, m *Manager, kind string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		n, ok := m.Nudge("fixed-session-id")
		if ok && n.Kind == kind {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("nudge = %+v, %v; want %s", n, ok, kind)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestEnterAtThePromptIsASubmit(t *testing.T) {
	for _, tc := range []struct {
		name  string
		typed string
		want  bool
	}{
		{"enter", "\r", true},
		{"a message and enter in one write", "fix the test\r", true},
		{"a line break inside the prompt", "\x1b\r", false},
		{"a letter", "a", false},
		{"an arrow", "\x1b[A", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, nudges := spawnNudged(t)
			if err := m.Input("fixed-session-id", []byte(tc.typed)); err != nil {
				t.Fatal(err)
			}
			n, ok := m.Nudge("fixed-session-id")
			if ok != tc.want || (ok && n.Kind != narrate.NudgeSubmit) {
				t.Fatalf("nudge = %+v, %v; want submit = %v", n, ok, tc.want)
			}
			if got := len(nudges()); (got == 1) != tc.want {
				t.Fatalf("announced %d", got)
			}
		})
	}
}

// A sequenced write from a terminal (protocol v2) is input like any other.
func TestSequencedEnterIsASubmit(t *testing.T) {
	m, _ := spawnNudged(t)
	if _, err := m.InputSeq("fixed-session-id", "c1", 1, []byte("\r")); err != nil {
		t.Fatal(err)
	}
	waitNudge(t, m, narrate.NudgeSubmit)
}

func TestAMenuAnsweredInTheTerminalSaysHow(t *testing.T) {
	for _, tc := range []struct {
		name, typed, want string
	}{
		{"1 is yes", "1", narrate.NudgeApproved},
		{"2 is yes, don't ask again", "2", narrate.NudgeApproved},
		{"3 is no", "3", narrate.NudgeRejected},
		{"enter on the marked yes", "\r", narrate.NudgeApproved},
		{"esc rejects", "\x1b", narrate.NudgeRejected},
		{"ctrl+c rejects", "\x03", narrate.NudgeRejected},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, _ := spawnNudged(t)
			m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
			show(t, m, bashRuleMenu)
			if err := m.Input("fixed-session-id", []byte(tc.typed)); err != nil {
				t.Fatal(err)
			}
			waitNudge(t, m, tc.want)
		})
	}
}

// Enter picks the option the marker is on, which the arrows move.
func TestEnterOnAMarkedNoRejects(t *testing.T) {
	m, _ := spawnNudged(t)
	m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	show(t, m, diffed(0, " Bash command", `   python3 -c "print(1)"`, "", " Do you want to proceed?", "   1. Yes",
		"   2. Yes, and don't ask again for: python3 *", " ❯ 3. No, and tell Claude what to do differently (esc)"))
	if err := m.Input("fixed-session-id", []byte("\r")); err != nil {
		t.Fatal(err)
	}
	waitNudge(t, m, narrate.NudgeRejected)
}

func TestAButtonSaysHowItAnswered(t *testing.T) {
	for _, tc := range []struct {
		choice PermissionChoice
		want   string
	}{{PermissionAllow, narrate.NudgeApproved}, {PermissionAlways, narrate.NudgeApproved}, {PermissionDeny, narrate.NudgeRejected}} {
		t.Run(string(tc.choice), func(t *testing.T) {
			m, nudges := spawnNudged(t)
			m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
			show(t, m, bashRuleMenu)
			p, _ := m.PendingPermission("fixed-session-id")
			if err := m.AnswerPermission("fixed-session-id", p.ID, tc.choice); err != nil {
				t.Fatal(err)
			}
			// Before the request returns, not later: the card that pressed
			// it reads the status next.
			if n, ok := m.Nudge("fixed-session-id"); !ok || n.Kind != tc.want {
				t.Fatalf("nudge = %+v, %v", n, ok)
			}
			if len(nudges()) != 1 {
				t.Fatalf("announced %v", nudges())
			}
		})
	}
}

// Enter while a prompt waits answers the prompt; it is not a message.
func TestEnterAtADialogIsNotASubmit(t *testing.T) {
	m, _ := spawnNudged(t)
	m.ObserveHook(signalFrom(t, "fixed-session-id", bashRule))
	m.ObserveHook(signalFrom(t, "fixed-session-id", bashDir))
	// Two outstanding: a key answers one Caprock cannot name, and is
	// neither a message nor a known answer.
	if err := m.Input("fixed-session-id", []byte("\r")); err != nil {
		t.Fatal(err)
	}
	if n, ok := m.Nudge("fixed-session-id"); ok {
		t.Fatalf("nudge %+v", n)
	}
}

// Rule 7 holds: only a session Caprock started is ever nudged.
func TestNoNudgeForASessionNotOwned(t *testing.T) {
	m, _ := spawnNudged(t)
	if _, ok := m.Nudge("someone-elses"); ok {
		t.Fatal("a nudge for a session not held")
	}
}

// An older nudge never overwrites a newer one: a key's answer is read off the
// screen after it is typed.
func TestAnOlderNudgeDoesNotReplaceANewerOne(t *testing.T) {
	m, _ := spawnNudged(t)
	a, _ := m.Get("fixed-session-id")
	now := time.Now()
	m.noteNudge(a, narrate.NudgeSubmit, now)
	m.noteNudge(a, narrate.NudgeApproved, now.Add(-time.Second))
	if n, _ := m.Nudge("fixed-session-id"); n.Kind != narrate.NudgeSubmit {
		t.Fatalf("nudge %+v", n)
	}
}
