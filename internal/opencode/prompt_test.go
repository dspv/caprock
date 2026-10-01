package opencode

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/store"
)

// userPart writes a text part of a user message in the shape a real OpenCode
// database holds: `{"type":"text","text":…}` with no time, plus `synthetic` or
// `metadata` when OpenCode wrote it itself (scrubbed from the owner's database).
func (f *fixture) userPart(id, msgID, sessionID, text string, extra map[string]any, at int64) {
	f.t.Helper()
	d := map[string]any{"type": "text", "text": text}
	for k, v := range extra {
		d[k] = v
	}
	b, _ := json.Marshal(d)
	if _, err := f.db.Exec(
		`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`,
		id, msgID, sessionID, at, at, string(b)); err != nil {
		f.t.Fatalf("insert user part: %v", err)
	}
}

func storedPrompt(t *testing.T, h *harness, msgID string) (prompt string, sidechain bool, ok bool) {
	t.Helper()
	var side int
	err := h.out.QueryRowContext(context.Background(), `
		SELECT COALESCE(json_extract(payload,'$.prompt'),''), COALESCE(json_extract(payload,'$.sidechain'),0)
		FROM events WHERE key = ? AND kind = 'turn.user' AND source = 'opencode'`, "oc-user:"+msgID).Scan(&prompt, &side)
	if err != nil {
		return "", false, false
	}
	return prompt, side == 1, true
}

// What the person typed reaches turn.user in the shape every prompt reader
// already reads, so an OpenCode reply is found by the question asked and the
// session is described by it.
func TestIngestStoresPrompts(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	h.f.userPart("prt_u1", "msg_a2", "ses_a", "  почему SSO заголовок резолвится так?  ", nil, 1_700_000_050_001)
	h.f.text(textOpts{ID: "prt_t1", MessageID: "msg_a1", SessionID: "ses_a",
		Text: "The room set is checked before the body.", Start: 1_700_000_101_000})
	h.poll()

	p, side, ok := storedPrompt(t, h, "msg_a2")
	if !ok || p != "почему SSO заголовок резолвится так?" || side {
		t.Fatalf("prompt = %q sidechain=%v stored=%v", p, side, ok)
	}
	ctx := context.Background()
	if got, _ := store.SearchNotes(ctx, h.out, "SSO заголовок", 0, 0); len(got) != 1 || !strings.Contains(got[0].Text, "room set") {
		t.Fatalf("search by the question returned %+v", got)
	}
	if got, _ := store.FirstPrompts(ctx, h.out, "ses_a", 8); len(got) != 1 || got[0] != p {
		t.Fatalf("first prompts = %q", got)
	}
	// A second pass stores nothing new.
	before := count(t, h.out, `SELECT COUNT(*) FROM events`)
	h.in.seen = map[string]int64{}
	h.poll()
	if after := count(t, h.out, `SELECT COUNT(*) FROM events`); after != before {
		t.Fatalf("a re-read stored %d more events", after-before)
	}
}

// Text OpenCode wrote itself, and context another program injected through
// it, is not something the person typed. A user message made only of those
// stores no prompt at all.
func TestIngestSkipsInjectedPromptText(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	// After a compaction OpenCode writes its own "continue" message.
	h.f.message(messageOpts{ID: "msg_cont", SessionID: "ses_a", Role: "user", Created: 1_700_000_500_000})
	h.f.userPart("prt_c", "msg_cont", "ses_a",
		"Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
		map[string]any{"synthetic": true, "metadata": map[string]any{"compaction_continue": true}}, 1_700_000_500_001)
	// An agent app greets through OpenCode with a system-reminder block.
	h.f.message(messageOpts{ID: "msg_rem", SessionID: "ses_b", Role: "user", Created: 1_700_000_405_000})
	h.f.userPart("prt_r", "msg_rem", "ses_b",
		"<system-reminder>\nAfter this greeting, follow the user's actual language.\n</system-reminder>", nil, 1_700_000_405_001)
	// A person mentioning the tag is still a person.
	h.f.message(messageOpts{ID: "msg_q", SessionID: "ses_b", Role: "user", Created: 1_700_000_406_000})
	h.f.userPart("prt_q", "msg_q", "ses_b", "why does <system-reminder> show up in the log?", nil, 1_700_000_406_001)
	h.poll()

	for _, id := range []string{"msg_cont", "msg_rem"} {
		if p, _, ok := storedPrompt(t, h, id); ok {
			t.Fatalf("%s stored as a prompt: %q", id, p)
		}
	}
	if p, _, ok := storedPrompt(t, h, "msg_q"); !ok || !strings.HasPrefix(p, "why does") {
		t.Fatalf("a typed prompt mentioning the tag was dropped: %q", p)
	}
}

// A child session's prompt is the task its parent agent wrote. It is kept, as
// a Claude Code subagent's is, and marked sidechain like the child's replies.
func TestIngestMarksChildSessionPromptAsSidechain(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	h.f.message(messageOpts{ID: "msg_cu", SessionID: "ses_child", Role: "user", Created: 1_700_000_205_000})
	h.f.userPart("prt_cu", "msg_cu", "ses_child", "Explore the codebase at /home/dev/api thoroughly.", nil, 1_700_000_205_001)
	h.poll()
	if _, side, ok := storedPrompt(t, h, "msg_cu"); !ok || !side {
		t.Fatalf("child prompt stored=%v sidechain=%v", ok, side)
	}
}

// Sessions imported before prompts were read get them on the first pass after
// a start — once, under a stable key — and their replies become findable by
// the question even though the prompt's row is newer than every reply.
func TestIngestBackfillsPromptsOfSessionsAlreadyImported(t *testing.T) {
	h := newHarness(t)
	h.f.typical()
	h.f.userPart("prt_u1", "msg_a2", "ses_a", "where is the SSO header resolved?", nil, 1_700_000_050_001)
	h.f.text(textOpts{ID: "prt_t1", MessageID: "msg_a1", SessionID: "ses_a",
		Text: "In the middleware, before the body is read.", Start: 1_700_000_101_000})
	h.poll()
	// What an earlier version left: everything but the prompt.
	if _, err := h.out.Exec(`DELETE FROM events WHERE kind = 'turn.user'`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if got, _ := store.SearchNotes(ctx, h.out, "SSO header", 0, 0); len(got) != 0 {
		t.Fatalf("precondition: found without a prompt: %+v", got)
	}

	h.in.seen = map[string]int64{} // a restart
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind = 'turn.user'`); n != 1 {
		t.Fatalf("%d prompts after the backfill, want 1", n)
	}
	if got, _ := store.SearchNotes(ctx, h.out, "SSO header", 0, 0); len(got) != 1 {
		t.Fatalf("the reply is not found by its backfilled question: %+v", got)
	}
	h.in.seen = map[string]int64{}
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind = 'turn.user'`); n != 1 {
		t.Fatalf("%d prompts after another start, want 1", n)
	}
}

// Clipped on runes to the cap every agent's text shares.
func TestPromptTextClipsOnRunes(t *testing.T) {
	got := PromptText([]string{strings.Repeat("я", ingest.MaxAssistantText+5)})
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) != ingest.MaxAssistantText+1 {
		t.Fatalf("clipped to %d runes", utf8.RuneCountInString(got))
	}
	if PromptText([]string{"<system-reminder>x</system-reminder>"}) != "" {
		t.Fatal("an injected-only message produced a prompt")
	}
}
