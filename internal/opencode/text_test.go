package opencode

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/store"
)

// storedText reads payload.text of one stored OpenCode turn.
func storedText(t *testing.T, h *harness, msgID string) string {
	t.Helper()
	var s string
	if err := h.out.QueryRowContext(context.Background(),
		`SELECT COALESCE(json_extract(payload,'$.text'),'') FROM events WHERE msg_id = ? AND kind = 'turn.assistant'`,
		msgID).Scan(&s); err != nil {
		t.Fatalf("stored text of %s: %v", msgID, err)
	}
	return s
}

// The prose an OpenCode turn wrote reaches payload.text — the field the Memory
// screen reads for every agent — and is findable there, by its own words and by
// the session it belongs to. Reasoning is the model's private thinking and must
// never be stored; synthetic text is OpenCode's, not the model's.
func TestIngestStoresAssistantProse(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	h.f.text(textOpts{ID: "prt_t0", MessageID: "msg_a1", SessionID: "ses_a", Type: "reasoning",
		Text: "secret thinking about the token", Start: 1_700_000_100_500})
	h.f.text(textOpts{ID: "prt_t1", MessageID: "msg_a1", SessionID: "ses_a",
		Text: "  Проверил оба пути.  ", Start: 1_700_000_101_000})
	h.f.text(textOpts{ID: "prt_t2", MessageID: "msg_a1", SessionID: "ses_a",
		Text: "The SSO header now resolves to user_id.", Start: 1_700_000_130_000})
	h.f.text(textOpts{ID: "prt_t3", MessageID: "msg_a2", SessionID: "ses_a", Synthetic: true,
		Text: "Continue if you have next steps, or stop and ask for clarification."})
	h.poll()

	want := "Проверил оба пути.\nThe SSO header now resolves to user_id."
	if got := storedText(t, h, "msg_a1"); got != want {
		t.Fatalf("payload.text = %q, want %q", got, want)
	}

	ctx := context.Background()
	notes, err := store.SessionNotes(ctx, h.out, "ses_a", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 || notes[0].Text != want {
		t.Fatalf("session notes = %+v", notes)
	}
	if got, _ := store.SearchNotes(ctx, h.out, "SSO header", 0, 0); len(got) != 1 || got[0].SessionID != "ses_a" {
		t.Fatalf("search for the prose returned %+v", got)
	}
	if got, _ := store.SearchNotes(ctx, h.out, "secret thinking", 0, 0); len(got) != 0 {
		t.Fatalf("reasoning was stored as prose: %+v", got)
	}
	if got, _ := store.SearchNotes(ctx, h.out, "next steps", 0, 0); len(got) != 0 {
		t.Fatalf("synthetic text was stored as prose: %+v", got)
	}
}

// A subagent runs in a child session in OpenCode. Its words are a sidechain in
// Claude Code's terms, and kept out of Memory the same way — otherwise "what
// did the agent say" answers with a subagent's report.
func TestIngestMarksChildSessionProseAsSidechain(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	h.f.text(textOpts{ID: "prt_c1", MessageID: "msg_c1", SessionID: "ses_child",
		Text: "Found three call sites of the subagent marker.", Start: 1_700_000_211_000})
	h.poll()

	if got := storedText(t, h, "msg_c1"); got == "" {
		t.Fatal("child session prose was not stored at all")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE msg_id='msg_c1' AND json_extract(payload,'$.sidechain') = 1`); n != 1 {
		t.Fatal("child session turn not marked sidechain")
	}
	if got, _ := store.SearchNotes(context.Background(), h.out, "subagent marker", 0, 0); len(got) != 0 {
		t.Fatalf("a subagent's prose surfaced in Memory: %+v", got)
	}
}

// Turns stored before the importer read text, or caught while OpenCode was
// still writing the reply, keep a key that a re-read never inserts again. The
// next read of the session must fill them in and touch nothing else.
func TestIngestFillsTextOfTurnsAlreadyStored(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	h.poll() // no text parts yet: the reply is still being written

	if got := storedText(t, h, "msg_a1"); got != "" {
		t.Fatalf("text before any part exists = %q", got)
	}
	row := func() (id int64, cost float64) {
		t.Helper()
		if err := h.out.QueryRow(`SELECT id, cost_usd FROM events WHERE msg_id='msg_a1' AND kind='turn.assistant'`).Scan(&id, &cost); err != nil {
			t.Fatal(err)
		}
		return id, cost
	}
	idBefore, costBefore := row()

	h.f.text(textOpts{ID: "prt_t1", MessageID: "msg_a1", SessionID: "ses_a",
		Text: "Done: the migration is in.", Start: 1_700_000_101_000})
	h.f.touchSession("ses_a", 1_700_000_700_000)
	h.poll()

	if got := storedText(t, h, "msg_a1"); got != "Done: the migration is in." {
		t.Fatalf("text after the reply finished = %q", got)
	}
	if idAfter, costAfter := row(); idAfter != idBefore || costAfter != costBefore {
		t.Fatalf("refresh changed the row: id %d→%d cost %v→%v", idBefore, idAfter, costBefore, costAfter)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE msg_id='msg_a1' AND kind='turn.assistant'`); n != 1 {
		t.Fatalf("%d rows for one turn; the refresh must update, not insert", n)
	}
	// Other payload keys survive the rewrite.
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE msg_id='msg_a1' AND json_extract(payload,'$.cwd') = '/home/dev/api'`); n != 1 {
		t.Fatal("the refresh dropped payload.cwd")
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE msg_id='msg_a1' AND json_type(payload,'$.sidechain') = 'false'`); n != 1 {
		t.Fatal("the refresh did not keep sidechain a JSON boolean")
	}

	// A fresh poller — a daemon restart — re-reads every session. That pass is
	// the backfill for history, and with nothing to change it leaves the text
	// as it is.
	h.in.seen = map[string]int64{}
	h.poll()
	if got := storedText(t, h, "msg_a1"); got != "Done: the migration is in." {
		t.Fatalf("text after a second pass = %q", got)
	}
}

// The cap is the Claude Code parser's, in runes: Cyrillic is two bytes a
// character, and a byte cap would halve it and could split a character.
func TestTextsClipOnRunes(t *testing.T) {
	f := newFixture(t)
	f.session(sessionOpts{ID: "s", Directory: "/d", Title: "t"})
	f.message(messageOpts{ID: "m", SessionID: "s"})
	f.text(textOpts{ID: "p", MessageID: "m", SessionID: "s", Text: strings.Repeat("я", ingest.MaxAssistantText+5)})

	texts, err := Texts(context.Background(), f.open(), "s")
	if err != nil {
		t.Fatal(err)
	}
	got := texts["m"]
	if !utf8.ValidString(got) {
		t.Fatal("clipped text is not valid UTF-8")
	}
	if n := utf8.RuneCountInString(got); n != ingest.MaxAssistantText+1 || !strings.HasSuffix(got, "…") {
		t.Fatalf("clipped to %d runes, want %d plus an ellipsis", n, ingest.MaxAssistantText)
	}
}
