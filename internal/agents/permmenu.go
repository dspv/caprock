package agents

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The menu a permission dialog shows, read off the session's screen at the
// moment a button is pressed (ADR-035, amended).
//
// The hook says what Claude Code asked; only the screen says which menu it
// drew. They differ: in auto mode the classifier's "This command requires
// approval" dialog offers just "1. Yes  2. No", while the hook still carries
// suggestions that used to mean "2 = don't ask again" — so a button that typed
// "2" blind rejected the very call it was meant to allow. A key is now picked
// by the text of the option it selects, and nothing is typed when the option
// is not on the screen.

// ErrNotOnPrompt means the choice is not an option on the menu the session's
// terminal shows now — or no permission menu is showing at all. Nothing was
// typed.
var ErrNotOnPrompt = errors.New("that option is not on the prompt — answer in the terminal")

// menuOption is one numbered line of a dialog's menu.
type menuOption struct {
	n    int
	text string
}

// optionLine is "❯ 1. Yes" or "  2. No": an optional selection marker, the
// number, a dot and the text.
var optionLine = regexp.MustCompile(`^(\s*)([❯›]\s*)?(\d{1,2})\.\s+(\S.*)$`)

// trimFrame drops a dialog border ("│ … │") from a screen row, keeping the
// indentation inside it.
func trimFrame(line string) string {
	line = strings.TrimRightFunc(line, func(r rune) bool { return unicode.IsSpace(r) || isBoxRune(r) })
	t := strings.TrimLeftFunc(line, unicode.IsSpace)
	if r, size := utf8.DecodeRuneInString(t); isBoxRune(r) {
		return t[size:]
	}
	return line
}

func isBoxRune(r rune) bool { return r >= 0x2500 && r <= 0x257f }

// indentOf is the column of a row's first visible character.
func indentOf(line string) int {
	n := 0
	for _, r := range line {
		if !unicode.IsSpace(r) {
			return n
		}
		n++
	}
	return -1
}

// maxBelowMenu is how many rows may sit under a waiting dialog's menu: its
// footer, a hint, a status line.
const maxBelowMenu = 4

// readMenu finds the permission menu at the bottom of a screen: the lowest
// run of numbered options with a selection marker on one of them, numbered
// 1, 2, … and offering a "No". Anything else — a prompt being typed that
// happens to start with "1.", a question's answers, an empty screen — is not
// a permission menu.
func readMenu(screen []string) ([]menuOption, bool) {
	rows := make([]string, len(screen))
	for i, l := range screen {
		rows[i] = trimFrame(l)
	}
	marked := -1
	for i := len(rows) - 1; i >= 0; i-- {
		if m := optionLine.FindStringSubmatch(rows[i]); m != nil && m[2] != "" {
			marked = i
			break
		}
	}
	if marked < 0 {
		return nil, false
	}
	// The block is the run of non-blank rows around the marked option.
	first, last := marked, marked
	for first > 0 && strings.TrimSpace(rows[first-1]) != "" {
		first--
	}
	for last < len(rows)-1 && strings.TrimSpace(rows[last+1]) != "" {
		last++
	}
	// The menu starts at the option numbered 1 at or above the marked one.
	start := marked
	for start > first {
		if m := optionLine.FindStringSubmatch(rows[start]); m != nil && m[3] == "1" {
			break
		}
		start--
	}
	var opts []menuOption
	col := -1 // the indentation of the option text, for wrapped lines
	end := start
	for i := start; i <= last; i++ {
		if m := optionLine.FindStringSubmatch(rows[i]); m != nil {
			n, _ := strconv.Atoi(m[3])
			opts = append(opts, menuOption{n: n, text: strings.TrimSpace(m[4])})
			col = indentOf(rows[i])
			end = i
			continue
		}
		// A wrapped option continues further in than its number; a footer
		// or the question sits at or left of it.
		if len(opts) > 0 && col >= 0 && indentOf(rows[i]) > col {
			o := &opts[len(opts)-1]
			o.text += " " + strings.TrimSpace(rows[i])
			end = i
			continue
		}
		break
	}
	if len(opts) < 2 || end < marked {
		return nil, false
	}
	// A dialog is the last thing drawn: below it there is a footer ("Esc to
	// cancel") and little else. A menu with output under it is one that was
	// answered and scrolled up, not one waiting.
	below := 0
	for i := end + 1; i < len(rows); i++ {
		if strings.TrimSpace(rows[i]) != "" {
			below++
		}
	}
	if below > maxBelowMenu {
		return nil, false
	}
	hasNo := false
	for i, o := range opts {
		if o.n != i+1 {
			return nil, false
		}
		o.text = strings.Join(strings.Fields(o.text), " ")
		opts[i] = o
		if isNo(o.text) {
			hasNo = true
		}
	}
	if !hasNo {
		return nil, false
	}
	return opts, true
}

// startsWithWord reports whether text begins with word as a whole word.
func startsWithWord(text, word string) bool {
	if len(text) < len(word) || !strings.EqualFold(text[:len(word)], word) {
		return false
	}
	if len(text) == len(word) {
		return true
	}
	r := []rune(text[len(word):])[0]
	return !unicode.IsLetter(r)
}

func isNo(text string) bool { return startsWithWord(text, "No") }

// isPlainYes is "Yes" with nothing that changes what it does: a key hint in
// brackets at most.
func isPlainYes(text string) bool {
	if strings.EqualFold(text, "Yes") {
		return true
	}
	return len(text) > 4 && strings.EqualFold(text[:4], "Yes ") && strings.HasPrefix(strings.TrimSpace(text[4:]), "(")
}

// isAlwaysYes is a "Yes" that also stops the question coming back: "Yes, and
// don't ask again for …", "Yes, allow all edits during this session", "Yes,
// and always allow access to … from this project".
func isAlwaysYes(text string) bool {
	if !startsWithWord(text, "Yes") || isPlainYes(text) {
		return false
	}
	rest := strings.TrimLeft(text[3:], " ")
	if !strings.HasPrefix(rest, ",") && !strings.HasPrefix(strings.ToLower(rest), "and ") {
		return false
	}
	low := strings.ToLower(strings.ReplaceAll(text, "’", "'"))
	for _, w := range []string{"session", "don't ask", "dont ask", "do not ask", "allow"} {
		if strings.Contains(low, w) {
			return true
		}
	}
	return false
}

// menuKey is the key that picks choice on the menu a screen shows, or
// ErrNotOnPrompt when the screen shows no permission menu or that option is
// not on it.
func menuKey(screen []string, choice PermissionChoice) (string, error) {
	opts, ok := readMenu(screen)
	if !ok {
		return "", ErrNotOnPrompt
	}
	for _, o := range opts {
		switch {
		case choice == PermissionAllow && isPlainYes(o.text),
			choice == PermissionAlways && isAlwaysYes(o.text):
			return strconv.Itoa(o.n), nil
		}
	}
	if choice == PermissionDeny {
		// Esc is "No" on every permission menu; the menu was checked above,
		// because Esc with no dialog up interrupts the turn instead.
		return "\x1b", nil
	}
	return "", ErrNotOnPrompt
}
