package agents

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

// An AskUserQuestion call's input as Claude Code sends it on the
// PermissionRequest hook, and the dialog as Claude Code 2.1.325 draws it:
// the options with their descriptions under them, the Other row ("Type
// something."), a divider, "Chat about this" and the key hints.
const (
	dbQuestion = `{"questions":[{"question":"Which database should we use?","header":"Database","multiSelect":false,` +
		`"options":[{"label":"Postgres (Recommended)","description":"Relational, what the team knows"},{"label":"SQLite","description":"One file, no server"}]}]}`
	twoQuestions = `{"questions":[{"question":"Which database?","options":[{"label":"Postgres","description":""},{"label":"SQLite","description":""}]},` +
		`{"question":"Which port?","options":[{"label":"5432","description":""},{"label":"6543","description":""}]}]}`
	previewQuestion = `{"questions":[{"question":"Which layout?","options":[{"label":"Grid","description":"","preview":"+--+--+"},{"label":"List","description":"","preview":"----"}]}]}`
)

var dbDialog = diffed(0, " ☐ Database", "", " Which database should we use?", "",
	" ❯ 1. Postgres (Recommended)", "      Relational, what the team knows",
	"   2. SQLite", "      One file, no server",
	"   3. Type something.", "", "   4. Chat about this", "",
	" Enter to select · ↑/↓ to navigate · Esc to cancel")

func questionSignal(input string) HookSignal {
	return HookSignal{SessionID: "fixed-session-id", Event: "PermissionRequest", Tool: "AskUserQuestion", Input: json.RawMessage(input)}
}

func TestParseQuestion(t *testing.T) {
	d, ok := ParseQuestion(json.RawMessage(dbQuestion))
	if !ok || d.Question != "Which database should we use?" || d.More != 0 || d.MultiSelect || d.Previews || !d.Answerable() {
		t.Fatalf("%+v %v", d, ok)
	}
	want := []QuestionOption{
		{Label: "Postgres (Recommended)", Display: "Postgres", Description: "Relational, what the team knows", Recommended: true},
		{Label: "SQLite", Display: "SQLite", Description: "One file, no server"},
	}
	if !reflect.DeepEqual(d.Options, want) {
		t.Fatalf("options %+v", d.Options)
	}
	if d, _ := ParseQuestion(json.RawMessage(twoQuestions)); d.More != 1 || d.Answerable() {
		t.Fatalf("two questions: %+v", d)
	}
	if d, _ := ParseQuestion(json.RawMessage(`{"questions":[{"question":"Q","multiSelect":true,"options":[{"label":"a"},{"label":"b"}]}]}`)); d.Answerable() {
		t.Fatal("a multi-select is answerable")
	}
	if d, _ := ParseQuestion(json.RawMessage(`{"questions":[{"question":"Q","options":[{"label":"Ship it (recommended)"}]}]}`)); !d.Options[0].Recommended || d.Options[0].Display != "Ship it" {
		t.Fatalf("lower case marker: %+v", d.Options)
	}
	if _, ok := ParseQuestion(json.RawMessage(`{}`)); ok {
		t.Fatal("no question parsed as one")
	}
}

// The keys are Claude Code's own, read from the bundled JavaScript of
// Claude Code 2.1.325 (~/.local/share/claude/versions/2.1.325, a
// Bun-compiled executable read with strings, 2026-11-16): in the Select's
// keydown a digit picks the option at that number (onChange) and, on the
// empty "__other__" input row, focuses it; the row's Enter with text submits
// it; a single single-select question is submitted on that onChange. In the
// preview view a digit only focuses and Enter picks, and there is no Other
// row. A change here is a change in what Caprock types into a user's
// session: read the installed Claude Code again before making it.
func TestQuestionKeysMatchClaudeCode(t *testing.T) {
	plain, _ := ParseQuestion(json.RawMessage(dbQuestion))
	preview, _ := ParseQuestion(json.RawMessage(previewQuestion))
	for _, tc := range []struct {
		name   string
		d      QuestionDialog
		option int
		text   string
		paste  bool
		want   []string
		err    error
	}{
		{"first option", plain, 0, "", false, []string{"1"}, nil},
		{"second option", plain, 1, "", false, []string{"2"}, nil},
		{"other, typed", plain, 0, "Use  MySQL\nplease", false, []string{"3", "Use MySQL please", "\r"}, nil},
		{"other, pasted", plain, 0, "Use MySQL", true, []string{"3", "\x1b[200~Use MySQL\x1b[201~", "\r"}, nil},
		{"control characters dropped", plain, 0, "a\x1b[Ab", false, []string{"3", "a[Ab", "\r"}, nil},
		{"preview view", preview, 1, "", false, []string{"2", "\r"}, nil},
		{"preview view has no Other row", preview, 0, "text", false, nil, ErrQuestionNotAnswerable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := QuestionKeys(tc.d, tc.option, tc.text, tc.paste)
			if !errors.Is(err, tc.err) || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %q, %v; want %q, %v", got, err, tc.want, tc.err)
			}
		})
	}
	if _, err := QuestionKeys(plain, 2, "", false); err == nil {
		t.Fatal("an option past the last was given a key")
	}
}

func fastQuestionKeys(t *testing.T) {
	old := questionKeyGap
	questionKeyGap = 0
	t.Cleanup(func() { questionKeyGap = old })
}

func TestAQuestionOptionIsPressed(t *testing.T) {
	fastQuestionKeys(t)
	m, f, _ := spawnOwned(t)
	m.ObserveHook(questionSignal(dbQuestion))
	show(t, m, dbDialog)
	if err := m.AnswerQuestion("fixed-session-id", json.RawMessage(dbQuestion), 1, ""); err != nil {
		t.Fatal(err)
	}
	if got := f.session.typed(); got != "2" {
		t.Fatalf("typed %q", got)
	}
}

func TestAQuestionIsAnsweredWithText(t *testing.T) {
	fastQuestionKeys(t)
	m, f, _ := spawnOwned(t)
	m.ObserveHook(questionSignal(dbQuestion))
	show(t, m, dbDialog)
	if err := m.AnswerQuestion("fixed-session-id", json.RawMessage(dbQuestion), 0, "MySQL, it is what prod runs"); err != nil {
		t.Fatal(err)
	}
	if got := f.session.typed(); got != "3MySQL, it is what prod runs\r" {
		t.Fatalf("typed %q", got)
	}
}

// Another dialog on the screen, none, or one the hook did not describe:
// nothing is typed.
func TestNothingIsTypedIntoAnotherDialog(t *testing.T) {
	fastQuestionKeys(t)
	for name, screen := range map[string]string{
		"a permission menu": bashRuleMenu,
		"nothing":           "⏺ Done.\r\n\r\n> ",
		"other options": diffed(0, " Which database should we use?", "", " ❯ 1. MySQL", "   2. SQLite", "   3. Type something.", "",
			" Enter to select · ↑/↓ to navigate · Esc to cancel"),
		"answered and scrolled up": dbDialog + "⏺ User answered Claude's questions:\r\n  ⎿ · Which database? → SQLite\r\n" +
			"⏺ Bash(go test ./...)\r\n  ⎿ ok\r\n⏺ Update(a.go)\r\n⏺ Update(b.go)\r\n⏺ Bash(make check)\r\n  ⎿ ok\r\n> ",
	} {
		t.Run(name, func(t *testing.T) {
			m, f, _ := spawnOwned(t)
			m.ObserveHook(questionSignal(dbQuestion))
			show(t, m, screen)
			if err := m.AnswerQuestion("fixed-session-id", json.RawMessage(dbQuestion), 0, ""); !errors.Is(err, ErrQuestionGone) {
				t.Fatalf("err %v", err)
			}
			if got := f.session.typed(); got != "" {
				t.Fatalf("typed %q", got)
			}
		})
	}
}

func TestSeveralQuestionsAreLeftToTheTerminal(t *testing.T) {
	m, f, _ := spawnOwned(t)
	if err := m.AnswerQuestion("fixed-session-id", json.RawMessage(twoQuestions), 0, ""); !errors.Is(err, ErrQuestionNotAnswerable) {
		t.Fatalf("err %v", err)
	}
	if f.session.typed() != "" {
		t.Fatal("typed into a dialog of two questions")
	}
}

func TestAQuestionInASessionNotStartedHereIsNotAnswered(t *testing.T) {
	m, _, _ := spawnOwned(t)
	if err := m.AnswerQuestion("someone-elses", json.RawMessage(dbQuestion), 0, ""); !errors.Is(err, ErrNotOwned) {
		t.Fatalf("err %v", err)
	}
}

// The preview view: the options sit in a narrow column with the preview
// beside them, and a long label wraps.
func TestAPreviewDialogIsRecognised(t *testing.T) {
	fastQuestionKeys(t)
	m, f, _ := spawnOwned(t)
	in := `{"questions":[{"question":"Which layout?","options":[{"label":"A grid of cards, three across","description":"","preview":"+--+"},{"label":"List","description":"","preview":"--"}]}]}`
	m.ObserveHook(questionSignal(in))
	show(t, m, diffed(0, " Which layout?", "", " ❯ 1. A grid of cards,       │ +--+", "      three across          │", "   2. List                  │",
		"", " Notes: press n to add notes", "", "   Chat about this", "", " Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"))
	if err := m.AnswerQuestion("fixed-session-id", json.RawMessage(in), 1, ""); err != nil {
		t.Fatal(err)
	}
	if got := f.session.typed(); got != "2\r" {
		t.Fatalf("typed %q", got)
	}
}
