package agents

import (
	"strings"
	"unicode"
)

// Typing a message into an agent's prompt and checking that it went
// (ADR-053, the 2026-10-17 amendment).
//
// A message is two writes: the text, then — after a pause — the Enter that
// submits it. A TUI that reads a fast run of characters as a paste keeps an
// Enter that arrives inside that run as a line break: Codex's composer has a
// paste-burst detector for exactly this, and Claude Code merges a burst of
// input into one paste. The pause between the writes is not a pause between
// the reads: an agent busy redrawing reads both at once. So a session whose
// output turned bracketed paste on (ESC[?2004h — Claude Code and Codex both
// do) gets the text wrapped in ESC[200~ … ESC[201~, which says where the
// paste ends whatever the timing, and the Enter after it is a key. That is
// how Claude Code itself types a reply into another Claude Code's terminal
// (2.1.302: the paste, then "\r" 10 ms later).
//
// And because nothing on the daemon's side can see the TUI's keyboard
// handling, the screen is read afterwards: when the prompt still holds the
// message, Enter is pressed once more (PromptHolds).

// bracketedPasteMode is DEC private mode 2004.
const bracketedPasteMode = 2004

// PasteMode reports whether an owned session's output has turned bracketed
// paste on and not off again.
func (m *Manager) PasteMode(sessionID string) bool {
	a, ok := m.Get(sessionID)
	if !ok || a.ring == nil {
		return false
	}
	on, _ := a.ring.r.Mode(bracketedPasteMode)
	return on
}

// PromptHolds reports whether an owned session's screen still shows text in
// its prompt — typed but not sent — and nothing else that an Enter would
// answer: no permission or question menu on the screen.
func (m *Manager) PromptHolds(sessionID, text string) bool {
	a, ok := m.Get(sessionID)
	if !ok || a.ring == nil {
		return false
	}
	return HoldsMessage(m.screen(a), text)
}

// promptTailRunes is how much of a message's end is looked for on the screen:
// enough not to match by chance, short enough to survive one wrap.
const promptTailRunes = 24

// promptRows is how many non-empty rows at the bottom of the screen count as
// the prompt when no bordered input box is found (Codex's composer).
const promptRows = 8

// HoldsMessage reports whether screen (rows, top to bottom) shows text still
// sitting in the prompt: the input box's rows hold the end of the message or
// a paste placeholder ("[Pasted text #1 +3 lines]", Codex's "[Pasted Content
// 1200 chars]"). A screen with a menu on it never holds a message — an Enter
// there would answer the menu.
//
// The input box is Claude Code's: the rows between two horizontal rules with
// a "❯" or ">" prompt line in them, the lowest such pair. Anything else is
// read from its last few non-empty rows. A message already sent and echoed
// above the box is outside it; where no box is found an echo can still
// match, and the cost is one Enter at an empty prompt, which does nothing.
func HoldsMessage(screen []string, text string) bool {
	if _, ok := readMenu(screen); ok {
		return false
	}
	region := inputRegion(screen)
	if len(region) == 0 {
		return false
	}
	joined := collapse(strings.Join(region, " "))
	tight := collapse(strings.Join(region, ""))
	if strings.Contains(joined, "[Pasted text #") || strings.Contains(joined, "[Pasted Content") {
		return true
	}
	probe := messageTail(text)
	if probe == "" {
		return false
	}
	return strings.Contains(joined, probe) || strings.Contains(tight, probe)
}

// messageTail is the end of a message's last non-empty line, whitespace
// collapsed, as the screen would show it.
func messageTail(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r", "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := collapse(lines[i])
		if l == "" {
			continue
		}
		r := []rune(l)
		if len(r) > promptTailRunes {
			r = r[len(r)-promptTailRunes:]
		}
		return strings.TrimSpace(string(r))
	}
	return ""
}

// inputRegion is the rows of the screen that make up the prompt, each with
// its box border and prompt marker trimmed.
func inputRegion(screen []string) []string {
	var rules []int
	for i, row := range screen {
		if isRule(row) {
			rules = append(rules, i)
		}
	}
	for k := len(rules) - 1; k >= 1; k-- {
		top, bottom := rules[k-1], rules[k]
		rows := screen[top+1 : bottom]
		if hasPromptLine(rows) {
			return trimRows(rows)
		}
	}
	var tail []string
	for i := len(screen) - 1; i >= 0 && len(tail) < promptRows; i-- {
		if strings.TrimSpace(screen[i]) != "" {
			tail = append([]string{screen[i]}, tail...)
		}
	}
	return trimRows(tail)
}

func isRule(row string) bool {
	t := strings.TrimSpace(row)
	if len([]rune(t)) < 3 {
		return false
	}
	for _, r := range t {
		if r != '─' && r != '━' {
			return false
		}
	}
	return true
}

func hasPromptLine(rows []string) bool {
	for _, row := range rows {
		t := strings.TrimLeft(row, " │┃")
		if strings.HasPrefix(t, "❯") || strings.HasPrefix(t, ">") {
			return true
		}
	}
	return false
}

func trimRows(rows []string) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		t := strings.Trim(row, " │┃▌")
		for _, p := range []string{"❯", "›", ">"} {
			if strings.HasPrefix(t, p) {
				t = strings.TrimSpace(strings.TrimPrefix(t, p))
				break
			}
		}
		out = append(out, t)
	}
	return out
}

// collapse folds every run of whitespace to one space and trims the ends.
func collapse(s string) string {
	return strings.Join(strings.FieldsFunc(s, unicode.IsSpace), " ")
}
