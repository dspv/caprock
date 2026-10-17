package agents

import (
	"context"
	"strings"
	"testing"
)

const tellMsg = "[Caprock] Heads-up: in the last 27 seconds you ran the same command 5 times: `write_stdin`. If you're stuck, step back and try a different approach, or tell me what's blocking. (Sent by Caprock's loop alert — not by the user.)"

// wrap cuts s into rows of n runes, as a narrow terminal shows a long line.
func wrap(s string, n int) []string {
	r := []rune(s)
	var out []string
	for len(r) > n {
		out = append(out, string(r[:n]))
		r = r[n:]
	}
	return append(out, string(r))
}

func TestHoldsMessage(t *testing.T) {
	rule := strings.Repeat("─", 60)
	box := func(rows ...string) []string {
		s := []string{"⏺ Done. The build is green.", "", rule}
		s = append(s, rows...)
		return append(s, rule, "  ⏵⏵ bypass permissions on · ? for shortcuts")
	}
	wrapped := wrap(tellMsg, 58)
	wrapped[0] = "❯ " + wrapped[0]

	for name, tc := range map[string]struct {
		screen []string
		want   bool
	}{
		"Claude Code: the message sits in the box, wrapped": {box(wrapped...), true},
		"Claude Code: a paste placeholder in the box":       {box("❯ [Pasted text #1 +3 lines]"), true},
		"Claude Code: sent, echoed above an empty box": {append(append([]string{"> " + tellMsg[:40]}, wrap(tellMsg[40:], 58)...),
			"", "✻ Thinking…", "", rule, "❯ ", rule, "  ? for shortcuts"), false},
		"Codex: the composer holds it": {append([]string{"• Ran the build", ""}, append(wrap("› "+tellMsg, 70), "", "  ⏎ send   ⌃J newline")...), true},
		"Codex: a paste placeholder":   {[]string{"• Ran the build", "", "› [Pasted Content 1200 chars]", "", "  ⏎ send"}, true},
		"Codex: an empty composer":     {[]string{"• Ran the build", "", "› Ask Codex to do anything", "", "  ⏎ send"}, false},
		"a menu is up: never":          {append(box(wrapped...), " Do you want to proceed?", " ❯ 1. Yes", "   2. No"), false},
		"an empty screen":              {nil, false},
	} {
		if got := HoldsMessage(tc.screen, tellMsg); got != tc.want {
			t.Errorf("%s: HoldsMessage = %v, want %v\n%s", name, got, tc.want, strings.Join(tc.screen, "\n"))
		}
	}
	if HoldsMessage(box("❯ "), "") {
		t.Error("an empty message is never held")
	}
	// A multi-line message is looked for by its last line.
	if !HoldsMessage(box("❯ first line", "  and the last one here"), "first line\nand the last one here\n") {
		t.Error("a multi-line message in the box must be found by its last line")
	}
}

// PasteMode reads mode 2004 off what the session printed; a session Caprock
// did not start has none.
func TestPasteModeFollowsTheOutput(t *testing.T) {
	m, _, f := newMgr(t)
	defer m.Shutdown()
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if m.PasteMode(a.SessionID) {
		t.Fatal("paste mode before the session set it")
	}
	f.session.out <- []byte("\x1b[?2004h> ")
	if err := waitFor(func() bool { return m.PasteMode(a.SessionID) }); err != nil {
		t.Fatal("ESC[?2004h did not turn paste mode on")
	}
	f.session.out <- []byte("\x1b[?2004l")
	if err := waitFor(func() bool { return !m.PasteMode(a.SessionID) }); err != nil {
		t.Fatal("ESC[?2004l did not turn it off")
	}
	if m.PasteMode("nobody") || m.PromptHolds("nobody", "x") {
		t.Fatal("a session Caprock did not start has no prompt to read")
	}
}
