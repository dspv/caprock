package brain

import (
	"context"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

func TestBuildInputRedactsWhatIsSent(t *testing.T) {
	in := BuildInput("acme", nil, []store.BrainPassage{
		{EventID: 1, User: true, Text: "pay with 4242 4242 4242 4242 and use password: hunter2! on staging"},
		{EventID: 2, Text: "Done in commit 3ce9d978 for $30/year; the key sk-ant-api03-AbCdEf0123456789xyzXYZ_abcd is set."},
	})
	for _, gone := range []string{"4242", "hunter2", "sk-ant"} {
		if strings.Contains(in.Prompt, gone) {
			t.Fatalf("%q sent to the model: %s", gone, in.Prompt)
		}
	}
	if !strings.Contains(in.Prompt, "[redacted: card number]") || !strings.Contains(in.Prompt, "3ce9d978") || !strings.Contains(in.Prompt, "$30/year") {
		t.Fatalf("prompt %s", in.Prompt)
	}
	if !strings.Contains(System, "Never record a credential") {
		t.Fatal("the instructions do not forbid credentials")
	}
}

func TestScrubOnceRunsOnceAndMarksIt(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, nil)
	db := e.st.DB()
	if _, err := db.ExecContext(ctx, `INSERT INTO brain_nodes (kind, title, norm, summary, search, project, created_at, updated_at)
		VALUES ('finding', 'Card on file', 'card on file', 'card 4242 4242 4242 4242', '', 'acme', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	e.eng.ScrubOnce(ctx)
	var summary string
	if err := db.QueryRowContext(ctx, `SELECT summary FROM brain_nodes WHERE title = 'Card on file'`).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if summary != "card [redacted: card number]" {
		t.Fatalf("summary %q", summary)
	}
	if done, _ := e.st.GetMeta(ctx, store.MetaBrainScrubbed); done != "1" {
		t.Fatalf("not marked done: %q", done)
	}
	// Marked: a row written straight into the table afterwards is left for
	// the write path, not scrubbed again on every start.
	if _, err := db.ExecContext(ctx, `UPDATE brain_nodes SET summary = 'card 4242 4242 4242 4242'`); err != nil {
		t.Fatal(err)
	}
	e.eng.ScrubOnce(ctx)
	if err := db.QueryRowContext(ctx, `SELECT summary FROM brain_nodes WHERE title = 'Card on file'`).Scan(&summary); err != nil || !strings.Contains(summary, "4242") {
		t.Fatalf("ran twice: %q %v", summary, err)
	}
}
