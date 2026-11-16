package agents

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/termbuf"
)

// Answering a Claude Code question dialog (AskUserQuestion) from Jarvis's
// decision card (ADR-096): one tap presses the option, in a session Caprock
// started (rule 7), and only while the dialog the card was drawn from is the
// one on the screen.
//
// **The keys are Claude Code's own.** Read from the bundled JavaScript of
// Claude Code 2.1.325 (the Bun-compiled executable
// ~/.local/share/claude/versions/2.1.325, read with strings; nothing was run),
// 2026-11-16:
//
//   - A single-select question draws its options as a Select, then an input
//     row {type:"input", value:"__other__", label:"Other", placeholder
//     "Type something."}, then a divider and "N. Chat about this".
//   - The Select's keydown: a digit 1–9 picks the option at that number at
//     once (onChange(value)); on an input row it focuses the row instead
//     while the row is empty. Typed characters then go into the row, and its
//     Enter (onSubmit) with text in it is onChange("__other__").
//   - With one question, the answer is submitted on that onChange: there is
//     no review step and no Submit tab (hideSubmitTab).
//   - A question whose options carry previews draws another view: a digit
//     only moves the focus there, Enter picks, and there is no Other row.
//
// So an option is its digit (and Enter after it in the preview view), and
// free text is the Other row's digit, the text, and Enter — written as three
// writes with a pause between them, since the focus moves on a render.
// QuestionKeys is that table; TestQuestionKeysMatchClaudeCode pins it.
//
// **The screen is read first, as a permission button's is.** The hook says
// what was asked; the screen says whether that dialog is still up. The
// numbered options at the bottom of the screen must start with the asked
// labels, in order, with the selection marker on one of them; otherwise
// nothing is typed (ErrQuestionGone). Several questions in one dialog, or a
// multi-select one, are not answered from here (ErrQuestionNotAnswerable):
// the keys differ and a wrong one submits a half answer.

// ErrQuestionGone means the dialog the answer was for is not on the
// session's screen: it was answered, cancelled, or another took its place.
// Nothing was typed.
var ErrQuestionGone = errors.New("that question is no longer on the screen")

// ErrQuestionNotAnswerable means the dialog is one a tap cannot answer:
// several questions, a multi-select, or free text where there is no Other
// row. Nothing was typed.
var ErrQuestionNotAnswerable = errors.New("this question has to be answered in the terminal")

// QuestionOption is one answer a question offers.
type QuestionOption struct {
	// Label is as the agent wrote it, "(Recommended)" included: the screen
	// shows it so.
	Label       string `json:"-"`
	Display     string `json:"label"`
	Description string `json:"description,omitempty"`
	Recommended bool   `json:"recommended"`
}

// QuestionDialog is what one AskUserQuestion call asks, from its input.
type QuestionDialog struct {
	Question string
	// Options are the first question's.
	Options []QuestionOption
	// More is how many further questions the dialog has.
	More        int
	MultiSelect bool
	// Previews: an option carries a preview, which Claude Code draws in
	// another view.
	Previews bool
}

// recommended is the marker an agent puts on the option it would pick.
var recommended = regexp.MustCompile(`(?i)\s*\(recommended\)\s*`)

// ParseQuestion reads an AskUserQuestion tool input; false when it has no
// question.
func ParseQuestion(input json.RawMessage) (QuestionDialog, bool) {
	var in struct {
		Questions []struct {
			Question    string `json:"question"`
			MultiSelect bool   `json:"multiSelect"`
			Options     []struct {
				Label       string          `json:"label"`
				Description string          `json:"description"`
				Preview     json.RawMessage `json:"preview"`
			} `json:"options"`
		} `json:"questions"`
	}
	if json.Unmarshal(input, &in) != nil || len(in.Questions) == 0 {
		return QuestionDialog{}, false
	}
	q := in.Questions[0]
	d := QuestionDialog{Question: q.Question, More: len(in.Questions) - 1, MultiSelect: q.MultiSelect}
	for _, o := range q.Options {
		if strings.TrimSpace(o.Label) == "" {
			continue
		}
		disp := strings.TrimSpace(recommended.ReplaceAllString(o.Label, " "))
		d.Options = append(d.Options, QuestionOption{
			Label: o.Label, Display: firstNonBlank(disp, o.Label), Description: strings.TrimSpace(o.Description),
			Recommended: recommended.MatchString(o.Label),
		})
		if len(o.Preview) > 0 && string(o.Preview) != "null" {
			d.Previews = true
		}
	}
	return d, true
}

func firstNonBlank(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// Answerable reports whether a tap can answer the dialog: one question,
// single-select, with options numbered by one digit each (the Other row
// included).
func (d QuestionDialog) Answerable() bool {
	return d.More == 0 && !d.MultiSelect && len(d.Options) > 0 && len(d.Options) < 9
}

// QuestionKeys is what is written to answer d: option (0-based) when text is
// empty, else text on the Other row. Each element is one write; a pause goes
// between them. paste wraps the text as a bracketed paste, for a session
// whose output turned it on.
func QuestionKeys(d QuestionDialog, option int, text string, paste bool) ([]string, error) {
	if !d.Answerable() {
		return nil, ErrQuestionNotAnswerable
	}
	text = oneLineText(text)
	if text == "" {
		if option < 0 || option >= len(d.Options) {
			return nil, errors.New("no such option")
		}
		key := strconv.Itoa(option + 1)
		if d.Previews {
			return []string{key, "\r"}, nil
		}
		return []string{key}, nil
	}
	if d.Previews {
		return nil, ErrQuestionNotAnswerable
	}
	body := text
	if paste {
		body = "\x1b[200~" + text + "\x1b[201~"
	}
	return []string{strconv.Itoa(len(d.Options) + 1), body, "\r"}, nil
}

// questionTextMax bounds an Other answer.
const questionTextMax = 2000

// oneLineText is free text as typed into the Other row: one line, control
// characters dropped (an escape sequence typed into a TUI is a key), at
// most questionTextMax runes.
func oneLineText(s string) string {
	var b strings.Builder
	for _, r := range strings.Join(strings.Fields(s), " ") {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	if utf8.RuneCountInString(out) > questionTextMax {
		out = string([]rune(out)[:questionTextMax])
	}
	return out
}

// questionKeyGap is the pause between the writes of one answer: the Other
// row takes focus on a render, and the text must not reach the Select.
var questionKeyGap = 150 * time.Millisecond

// noteQuestion keeps where a session's question dialog starts in its output.
func (m *Manager) noteQuestion(sessionID string) {
	a, ok := m.Get(sessionID)
	if !ok {
		return
	}
	at := a.ring.r.Total()
	m.permMu.Lock()
	if m.questionAt == nil {
		m.questionAt = map[string]uint64{}
	}
	m.questionAt[sessionID] = at
	m.permMu.Unlock()
}

func (m *Manager) forgetQuestion(sessionID string) {
	m.permMu.Lock()
	delete(m.questionAt, sessionID)
	m.permMu.Unlock()
}

// AnswerQuestion answers the AskUserQuestion dialog input asked, in an owned
// session: option (0-based), or text on its Other row when text is not
// empty. It types only when that dialog is on the screen now
// (ErrQuestionGone otherwise) and a tap can answer it
// (ErrQuestionNotAnswerable).
func (m *Manager) AnswerQuestion(sessionID string, input json.RawMessage, option int, text string) error {
	a, ok := m.Get(sessionID)
	if !ok {
		return errNotOwned(sessionID)
	}
	d, ok := ParseQuestion(input)
	if !ok {
		return ErrQuestionGone
	}
	keys, err := QuestionKeys(d, option, text, m.PasteMode(sessionID))
	if err != nil {
		return err
	}
	m.permMu.Lock()
	at := m.questionAt[sessionID]
	m.permMu.Unlock()
	cols, rows := a.size()
	var since []byte
	if at > 0 {
		since, _ = a.ring.r.Since(at)
	}
	if !questionOnScreen(termbuf.Screen(a.ring.snapshot(), cols, rows), d) &&
		(len(since) == 0 || !questionOnScreen(termbuf.Screen(since, cols, rows), d)) {
		m.log.Info("a question answer found no matching dialog on the screen", "component", "agents", "session_id", sessionID)
		return ErrQuestionGone
	}
	for i, k := range keys {
		if i > 0 {
			time.Sleep(questionKeyGap)
		}
		if _, err := a.sess.Write([]byte(k)); err != nil {
			return err
		}
	}
	a.TouchIO(time.Now())
	m.noteNudge(a, narrate.NudgeApproved, m.now())
	return nil
}

// questionRows is how far up from the bottom the dialog is looked for.
const questionRows = 60

// questionMatchRunes is how much of a label must match on the screen: the
// preview view draws options in a narrow column with the preview beside it,
// so a long label wraps and its row continues with the preview's text.
const questionMatchRunes = 20

// questionOnScreen reports whether the dialog d describes is the one at the
// bottom of screen: a run of options numbered from 1, the selection marker
// on one of them, the first len(d.Options) starting with d's labels in
// order, and little under it.
func questionOnScreen(screen []string, d QuestionDialog) bool {
	opts, end, ok := readNumbered(screen)
	if !ok || len(opts) < len(d.Options) {
		return false
	}
	for i, o := range d.Options {
		want := []rune(strings.Join(strings.Fields(o.Label), " "))
		if len(want) > questionMatchRunes {
			want = want[:questionMatchRunes]
		}
		if !strings.HasPrefix(opts[i].text, string(want)) {
			return false
		}
	}
	below := 0
	for i := end + 1; i < len(screen); i++ {
		if strings.TrimSpace(trimFrame(screen[i])) != "" {
			below++
		}
	}
	return below <= maxBelowMenu
}

// readNumbered finds the lowest run of numbered options on a screen that
// starts at 1, counts up by one and has the selection marker on one of its
// options. Blank rows may sit between options (a description, a divider);
// a row indented further than an option's number continues its text, and
// any other row ends the run. end is the row index of its last line.
func readNumbered(screen []string) (opts []menuOption, end int, ok bool) {
	start := max(0, len(screen)-questionRows)
	var cur []menuOption
	curMarked, curEnd, col := false, -1, -1
	found := false
	flush := func() {
		if len(cur) > 0 && curMarked {
			opts, end, found = cur, curEnd, true
		}
		cur, curMarked, curEnd, col = nil, false, -1, -1
	}
	for i := start; i < len(screen); i++ {
		row := trimFrame(screen[i])
		if m := optionLine.FindStringSubmatch(row); m != nil {
			n, _ := strconv.Atoi(m[3])
			switch {
			case n == 1:
				flush()
			case len(cur) == 0 || n != cur[len(cur)-1].n+1:
				flush()
				continue
			}
			cur = append(cur, menuOption{n: n, text: strings.Join(strings.Fields(cutBox(m[4])), " ")})
			curMarked = curMarked || m[2] != ""
			curEnd, col = i, indentOf(row)
			continue
		}
		if strings.TrimSpace(row) == "" || len(cur) == 0 {
			continue
		}
		if indentOf(row) > col && !isFooter(row) {
			o := &cur[len(cur)-1]
			o.text = strings.Join(strings.Fields(o.text+" "+cutBox(row)), " ")
			curEnd = i
			continue
		}
		flush()
	}
	flush()
	return opts, end, found
}

// cutBox is a row up to its first box-drawing rune: the preview view draws
// the preview in a frame beside the options.
func cutBox(row string) string {
	if i := strings.IndexFunc(row, isBoxRune); i >= 0 {
		return row[:i]
	}
	return row
}

// isFooter is a dialog's key hint row ("Enter to select · ↑/↓ to navigate").
func isFooter(row string) bool {
	t := strings.TrimLeftFunc(row, unicode.IsSpace)
	return strings.HasPrefix(t, "Enter to") || strings.HasPrefix(t, "Esc to") || strings.Contains(t, " · ")
}
