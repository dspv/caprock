package agents

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/termbuf"
)

// The menus below are the wording Claude Code's permission dialogs use, drawn
// the two ways its renderers write them: whole lines inside a box (Ink), and
// words between absolute column moves with the previous frame erased first
// (`Do\x1b[5Gyou`, the 2.1 renderer). They are rebuilt from the text of real
// dialogs, not byte captures: a captured stream needs a logged-in claude,
// which a test cannot start.

// boxed draws lines inside a rounded border, as Ink did.
func boxed(lines ...string) string {
	const w = 70
	var b strings.Builder
	b.WriteString("╭" + strings.Repeat("─", w) + "╮\r\n")
	for _, l := range lines {
		pad := w - 1 - len([]rune(l))
		if pad < 0 {
			pad = 0
		}
		b.WriteString("│ " + l + strings.Repeat(" ", pad) + "│\r\n")
	}
	b.WriteString("╰" + strings.Repeat("─", w) + "╯\r\n")
	return b.String()
}

// diffed draws lines the way the 2.1 renderer does: the previous frame of
// prev lines is erased upward, then each word is placed with a column move,
// in colour.
func diffed(prev int, lines ...string) string {
	var b strings.Builder
	for range prev {
		b.WriteString("\x1b[2K\x1b[1A")
	}
	b.WriteString("\x1b[2K\x1b[G")
	for _, l := range lines {
		col := 0
		for _, word := range strings.SplitAfter(l, " ") {
			w := strings.TrimRight(word, " ")
			if w != "" {
				fmt.Fprintf(&b, "\x1b[%dG\x1b[38;5;153m%s\x1b[39m", col+1, w)
			}
			col += len([]rune(word))
		}
		b.WriteString("\r\n")
	}
	return b.String()
}

const transcriptBefore = "⏺ I'll run the tests first.\r\n\r\n"

var menus = map[string]struct {
	screen              string
	cols                int
	allow, always, deny string // "" = refused
}{
	"bash rule, boxed": {
		screen: transcriptBefore + boxed(
			"Bash command",
			"",
			`  python3 -c "print(1)"`,
			"  Run Python print statement",
			"",
			"Do you want to proceed?",
			"❯ 1. Yes",
			"  2. Yes, and don't ask again for python3 commands in /work/proj",
			"  3. No, and tell Claude what to do differently (esc)",
		),
		allow: "1", always: "2", deny: "\x1b",
	},
	"bash rule with auto mode, diffed": {
		screen: transcriptBefore + diffed(3, "Bash command", "", `   python3 -c "print(1)"`, "", " Do you want to proceed?",
			" ❯ 1. Yes",
			"   2. Yes, and don’t ask again for: python3 *",
			"   3. Yes, and switch to auto mode",
			"   4. No",
			"", " Esc to cancel · Tab to amend · ctrl+e to explain"),
		allow: "1", always: "2", deny: "\x1b",
	},
	// The menu the owner lost work to: auto mode's classifier asks with two
	// options, and "2" is No.
	"auto mode classifier, two options": {
		screen: transcriptBefore + diffed(2, " This command requires approval", "", "   git push --force origin feat", "",
			" Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"),
		allow: "1", always: "", deny: "\x1b",
	},
	"write, accept edits": {
		screen: transcriptBefore + diffed(0, " Create file", " a.txt", " ╌╌╌╌╌╌╌╌", " hi", " ╌╌╌╌╌╌╌╌",
			" Do you want to create a.txt?", " ❯ 1. Yes",
			"   2. Yes, allow all edits during this session (shift+tab)",
			"   3. No, and tell Claude what to do differently (esc)"),
		allow: "1", always: "2", deny: "\x1b",
	},
	"edit, boxed": {
		screen: boxed("Edit file", "Do you want to make this edit to main.go?", "❯ 1. Yes",
			"  2. Yes, allow all edits during this session (shift+tab)", "  3. No, and tell Claude what to do differently (esc)"),
		allow: "1", always: "2", deny: "\x1b",
	},
	"webfetch": {
		screen: diffed(0, " Fetch", "   https://example.com/docs", "", " Do you want to allow Claude to fetch this content?",
			" ❯ 1. Yes", "   2. Yes, and don't ask again for example.com", "   3. No, and tell Claude what to do differently (esc)"),
		allow: "1", always: "2", deny: "\x1b",
	},
	"bash outside the project, add directory": {
		screen: diffed(0, " Bash command", "   date > /work/proj/out.txt", "", " Do you want to proceed?", " ❯ 1. Yes",
			"   2. Yes, and always allow access to /work/proj from this project", "   3. No"),
		allow: "1", always: "2", deny: "\x1b",
	},
	// A phone-width terminal wraps the long option onto a second row.
	"wrapped at 40 columns": {
		cols: 40,
		screen: diffed(0, " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for", "      python3 commands in /work/proj",
			"   3. No, and tell Claude what to", "      do differently (esc)"),
		allow: "1", always: "2", deny: "\x1b",
	},
	// The cursor moved down: the marker is on 2, the keys are the same.
	"selection moved": {
		screen: diffed(0, " Do you want to proceed?", "   1. Yes", " ❯ 2. Yes, and don't ask again for npm test", "   3. No"),
		allow:  "1", always: "2", deny: "\x1b",
	},
	// Plan approval has no plain Yes and no "don't ask again".
	"exit plan mode": {
		screen: diffed(0, " Would you like to proceed?", " ❯ 1. Yes, and auto-accept edits", "   2. Yes, and manually approve edits", "   3. No, keep planning"),
		allow:  "", always: "", deny: "\x1b",
	},
	"no dialog, Claude working": {
		screen: transcriptBefore + "✻ Thinking… (12s · esc to interrupt)\r\n",
	},
	// A prompt being typed that looks like a list is not a menu: no No.
	"a typed prompt that looks like a menu": {
		screen: transcriptBefore + diffed(0, "─────", "❯ 1. Yes do it", "  2. then the docs", "─────"),
	},
	// A question's answers are not a permission menu.
	"ask user question": {
		screen: diffed(0, " Which database?", " ❯ 1. Postgres", "   2. SQLite", "   3. Type something."),
	},
	// The dialog was answered and erased; the old menu is not read.
	"an erased dialog": {
		screen: diffed(0, " Do you want to proceed?", " ❯ 1. Yes", "   2. No") + diffed(3, "⏺ Bash(ls)", "  ⎿  a.txt"),
	},
	// A menu left in the scrollback with output under it is not waiting.
	// A waiting dialog has its footer, the status line and a task line under
	// it, never seven rows of output.
	"a menu scrolled up by output": {
		screen: diffed(0, " Do you want to proceed?", " ❯ 1. Yes", "   2. No") + "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n",
	},
	// The footer, a status line, a task line and the plan windows under a
	// dialog: still waiting.
	"a dialog over a busy footer": {
		screen: diffed(0, " Do you want to proceed?", " ❯ 1. Yes", "   2. No") +
			"\r\n Esc to cancel · Tab to amend\r\n────\r\n ctx 66%\r\n 1 shell · ← for agents\r\n",
		allow: "1", always: "", deny: "\x1b",
	},
	// Two dialogs in turn: the second one is on the screen now.
	"the next dialog replaced the first": {
		screen: diffed(0, " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for ls", "   3. No") +
			diffed(4, " This command requires approval", " Do you want to proceed?", " ❯ 1. Yes", "   2. No"),
		allow: "1", always: "", deny: "\x1b",
	},
}

func TestMenuKeyIsReadOffTheScreen(t *testing.T) {
	for name, tc := range menus {
		t.Run(name, func(t *testing.T) {
			screen := termbuf.Screen([]byte(tc.screen), tc.cols, 30)
			for _, c := range []struct {
				choice PermissionChoice
				want   string
			}{{PermissionAllow, tc.allow}, {PermissionAlways, tc.always}, {PermissionDeny, tc.deny}} {
				got, err := menuKey(screen, c.choice)
				if c.want == "" {
					if !errors.Is(err, ErrNotOnPrompt) || got != "" {
						t.Errorf("%s: got %q, %v; want refused\n%s", c.choice, got, err, strings.Join(screen, "\n"))
					}
					continue
				}
				if err != nil || got != c.want {
					t.Errorf("%s: got %q, %v; want %q\n%s", c.choice, got, err, c.want, strings.Join(screen, "\n"))
				}
			}
		})
	}
}

func TestAlwaysWording(t *testing.T) {
	for text, want := range map[string]bool{
		"Yes, and don't ask again for: python3 *":                         true,
		"Yes, and don’t ask again this session":                           true,
		"Yes, allow all edits during this session (shift+tab)":            true,
		"Yes, and always allow access to /work/proj from this project":    true,
		"Yes, for the rest of this session":                               true,
		"Yes":                                                             false,
		"Yes (y)":                                                         false,
		"Yes, and switch to auto mode":                                    false,
		"Yes, and manually approve edits":                                 false,
		"Yesterday's session was allowed":                                 false,
		"No, and tell Claude what to do differently, allow nothing (esc)": false,
	} {
		if got := isAlwaysYes(text); got != want {
			t.Errorf("%q: %v, want %v", text, got, want)
		}
	}
}

// After a restart the ring starts mid-frame, and a dialog drawn with cursor
// moves relative to a screen the replay never saw lands on top of stale rows
// (owner, 2026-10-08). The bytes since the prompt's hook alone still show it.
func TestDialogKeyFallsBackToTheBytesSinceTheHook(t *testing.T) {
	var stale strings.Builder
	for i := range 30 {
		fmt.Fprintf(&stale, "stale output row %d\r\n", i)
	}
	dialog := diffed(0, " Do you want to proceed?", " ❯ 1. Yes", "   2. No")
	// An absolute move from a context the ring lost puts the dialog mid-screen.
	ring := []byte(stale.String() + "\x1b[5;1H" + dialog)
	if _, err := menuKey(termbuf.Screen(ring, 80, 24), PermissionAllow); !errors.Is(err, errNoMenu) {
		t.Fatalf("the replay of the whole ring should hide the dialog, got err=%v", err)
	}
	key, err := dialogKey(ring, []byte(dialog), 80, 24, PermissionAllow)
	if err != nil || key != "1" {
		t.Fatalf("dialogKey = %q, %v; want \"1\" from the bytes since the hook", key, err)
	}
	// Without those bytes (a prompt restored after a restart) it stays an
	// honest "no menu".
	if _, err := dialogKey(ring, nil, 80, 24, PermissionAllow); !errors.Is(err, errNoMenu) {
		t.Fatalf("with no bytes since the hook, err = %v, want errNoMenu", err)
	}
}
