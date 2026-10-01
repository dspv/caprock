package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/store"
)

const proseFixture = "../../testdata/codex/rollout-prose.jsonl"

// A Codex message is written before the token_count of the request that
// produced it, so its text belongs to the NEXT turn. The item_completed copy of
// every message must not be read as a second one, and a message written after
// the request's last token_count joins that turn.
func TestAssistantProseLandsOnItsTurn(t *testing.T) {
	s, err := ParseFile(proseFixture)
	if err != nil {
		t.Fatal(err)
	}
	if s.Imported || s.Subagent {
		t.Fatalf("a session a person started read as imported=%v subagent=%v", s.Imported, s.Subagent)
	}
	if len(s.Turns) != 3 {
		t.Fatalf("want 3 turns, got %d", len(s.Turns))
	}
	want := []string{
		"I'll read the CI log first.",
		"TestHome sets HOME, which Windows ignores.\nSet USERPROFILE as well.\nWant me to push the fix?",
		"",
	}
	for i, w := range want {
		if s.Turns[i].Text != w {
			t.Errorf("turn %d text = %q, want %q", i, s.Turns[i].Text, w)
		}
	}
}

// The cap is the one Claude Code's prose is cut with: runes, not bytes, so
// multi-byte text is never split mid-character.
func TestAssistantProseIsClippedOnRunes(t *testing.T) {
	long := strings.Repeat("д", ingest.MaxAssistantText+50)
	src := `{"timestamp":"2026-09-15T09:25:25.100Z","type":"session_meta","payload":{"id":"s-clip","cwd":"/p","source":"cli"}}
{"timestamp":"2026-09-15T09:25:31.001Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"` + long + `"}]}}
{"timestamp":"2026-09-15T09:25:31.500Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}
`
	s, err := Parse(strings.NewReader(src), "")
	if err != nil {
		t.Fatal(err)
	}
	got := s.Turns[0].Text
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) != ingest.MaxAssistantText+1 || !strings.HasSuffix(got, "…") {
		t.Fatalf("clipped to %d runes (valid=%v)", utf8.RuneCountInString(got), utf8.ValidString(got))
	}
}

// A thread Codex imported from Claude Code replays that session's prose and
// tool calls as assistant messages. Caprock already stores the prose from the
// original transcript, so none of it may appear again as Codex's.
func TestImportedThreadKeepsNoProse(t *testing.T) {
	src := `{"timestamp":"2026-08-27T19:22:47.224Z","type":"session_meta","payload":{"session_id":"s-imp","id":"s-imp","cwd":"/p","originator":"Codex Desktop","source":"vscode"}}
{"timestamp":"2026-08-27T19:22:47.224Z","type":"event_msg","payload":{"type":"task_started","turn_id":"external-import-turn-1","started_at":1787069222}}
{"timestamp":"2026-08-27T19:22:47.300Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"[external_agent_tool_call: Bash]\ncommand: ls\n[/external_agent_tool_call]"}]}}
{"timestamp":"2026-08-27T19:22:47.400Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done: the docs are rewritten."}]}}
{"timestamp":"2026-08-27T19:22:48.175Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"external-import-turn-1","item":{"type":"AgentMessage","id":"item-2","content":[{"type":"Text","text":"<EXTERNAL SESSION IMPORTED>"}]}}}
{"timestamp":"2026-08-27T19:22:48.175Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":0,"output_tokens":0,"total_tokens":3921927}}}}
`
	s, err := Parse(strings.NewReader(src), "")
	if err != nil {
		t.Fatal(err)
	}
	if !s.Imported {
		t.Fatal("an external-import thread was not recognised")
	}
	for i, tn := range s.Turns {
		if tn.Text != "" {
			t.Errorf("turn %d kept imported prose %q", i, tn.Text)
		}
	}
}

// A subagent's file opens with its own session_meta, then a copy of the
// parent's, and carries the parent's session id; only the first meta says
// what the file is. Its prose is kept out, as Claude Code's sidechains are.
func TestSubagentThreadKeepsNoProse(t *testing.T) {
	src := `{"timestamp":"2026-09-24T09:26:30.191Z","type":"session_meta","payload":{"session_id":"s-parent","id":"s-child","forked_from_id":"s-parent","cwd":"/p","source":{"subagent":{"thread_spawn":{"parent_thread_id":"s-parent","depth":1}}}}}
{"timestamp":"2026-09-24T09:26:30.192Z","type":"session_meta","payload":{"session_id":"s-parent","id":"s-parent","cwd":"/p","source":"cli"}}
{"timestamp":"2026-09-24T09:26:40.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Audit finished."}]}}
{"timestamp":"2026-09-24T09:26:41.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}
`
	s, err := Parse(strings.NewReader(src), "")
	if err != nil {
		t.Fatal(err)
	}
	if !s.Subagent {
		t.Fatal("a subagent thread was not recognised")
	}
	if len(s.Turns) != 1 || s.Turns[0].Text != "" {
		t.Fatalf("subagent prose kept: %+v", s.Turns)
	}
}

func (h *harness) putFile(src, name string) {
	h.t.Helper()
	b, err := os.ReadFile(src)
	if err != nil {
		h.t.Fatal(err)
	}
	sub := filepath.Join(h.dir, "2026", "09", "15")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		h.t.Fatal(err)
	}
	p := filepath.Join(sub, name)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		h.t.Fatal(err)
	}
}

// Imported prose reaches the Memory screen through the same query as Claude
// Code's: the source-agnostic store.SearchNotes.
func TestProseIsSearchableInMemory(t *testing.T) {
	h := newHarness(t)
	h.putFile(proseFixture, "rollout-prose.jsonl")
	h.poll()
	notes, err := store.SearchNotes(context.Background(), h.out, "USERPROFILE", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 || !strings.Contains(notes[0].Text, "Set USERPROFILE as well.") {
		t.Fatalf("Codex prose not found by search: %+v", notes)
	}
	all, err := store.SessionNotes(context.Background(), h.out, "01a0a462-0000-7f11-b1f5-000000000001", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("want 2 notes (the tool-only turn has none), got %d", len(all))
	}
}

// Turns imported before prose was read have none, and the ordinary pass never
// re-reads their files. The one-time backfill must reach them, touch only
// payload.text, and not run again once it has finished.
func TestBackfillGivesOldTurnsTheirText(t *testing.T) {
	h := newHarness(t)
	h.putFile(proseFixture, "rollout-prose.jsonl")
	h.poll()
	// Make the store look like an older importer wrote it: no text anywhere,
	// the file remembered as read, the backfill never run.
	if _, err := h.out.Exec(`UPDATE events SET payload = json_remove(payload, '$.text') WHERE source = 'codex'`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.out.Exec(`DELETE FROM meta WHERE k = ?`, store.MetaCodexTextBackfilled); err != nil {
		t.Fatal(err)
	}
	costBefore := count(t, h.out, `SELECT CAST(SUM(cost_usd)*1e6 AS INTEGER) FROM events WHERE source='codex'`)

	restarted := NewIngester(h.in.dirs, h.in.rec, h.in.log, time.Second)
	if err := restarted.once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='turn.assistant' AND COALESCE(json_extract(payload,'$.text'),'') != ''`); n != 2 {
		t.Fatalf("backfill filled %d turns, want 2", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND json_extract(payload,'$.model') = 'gpt-5-codex' AND kind='turn.assistant'`); n != 3 {
		t.Fatalf("backfill disturbed the other payload keys: %d turns keep their model", n)
	}
	if after := count(t, h.out, `SELECT CAST(SUM(cost_usd)*1e6 AS INTEGER) FROM events WHERE source='codex'`); after != costBefore {
		t.Fatalf("backfill changed cost: %d → %d", costBefore, after)
	}
	if done, _ := h.in.rec.Store.GetMeta(context.Background(), store.MetaCodexTextBackfilled); done != "1" {
		t.Fatalf("backfill not marked done: %q", done)
	}

	// Done means done: a later start does not parse every transcript again.
	if _, err := h.out.Exec(`UPDATE events SET payload = json_remove(payload, '$.text') WHERE source = 'codex'`); err != nil {
		t.Fatal(err)
	}
	again := NewIngester(h.in.dirs, h.in.rec, h.in.log, time.Second)
	if err := again.once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND COALESCE(json_extract(payload,'$.text'),'') != ''`); n != 0 {
		t.Fatalf("a finished backfill ran again and filled %d turns", n)
	}
}

// Text is written only onto the row that came from the same record: a
// subagent's file shares its parent's session id and line-number keys, so a
// key alone could name a row from another file.
func TestTextSyncMatchesKeyAndTime(t *testing.T) {
	h := newHarness(t)
	h.putFile(proseFixture, "rollout-prose.jsonl")
	h.poll()
	if _, err := h.out.Exec(`UPDATE events SET payload = json_remove(payload, '$.text'), ts = ts + 1 WHERE source = 'codex' AND kind = 'turn.assistant'`); err != nil {
		t.Fatal(err)
	}
	s, err := ParseFile(proseFixture)
	if err != nil {
		t.Fatal(err)
	}
	n, err := h.in.syncText(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("text written onto %d rows from a different record", n)
	}
}
