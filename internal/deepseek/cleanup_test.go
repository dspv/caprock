package deepseek

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// storeOldPrompt writes a turn.user row the way the importer did before it
// skipped DSH's own records: keyed on the record's seq, text in payload.text.
func storeOldPrompt(t *testing.T, ctx context.Context, in *Ingester, session, key, text string, ts int64) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"text": text})
	if _, err := in.rec.Record(ctx, &event.Event{
		Ts: time.UnixMilli(ts), SessionID: session, Source: event.SourceDeepseek,
		Kind: event.KindTurnUser, Payload: payload, Key: key,
	}, rollup.SessionInfo{Cwd: "/home/u/proj", Agent: Agent}); err != nil {
		t.Fatal(err)
	}
}

func keysOf(t *testing.T, ctx context.Context, st *store.Store, session string) map[string]bool {
	t.Helper()
	rows, err := st.DB().QueryContext(ctx,
		`SELECT key FROM events WHERE session_id = ? AND kind = 'turn.user'`, session)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			t.Fatal(err)
		}
		out[k] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// The rows an earlier version stored for DSH's injected records are deleted
// once, and only those: which record a row came from is read from the
// transcript, so a person's prompt that happens to quote the same words, and
// a session whose transcript is gone, keep everything.
func TestRemoveInjectedDeletesOnlyWhatTheTranscriptMarks(t *testing.T) {
	ctx, in, st, dir := newIngestHarness(t)
	writeSessionFile(t, dir, fixture(t, "session-v3.jsonl"))

	// What an earlier version left behind for session-1: the question (seq 8)
	// and the two records DSH injected after it (seq 9, 10).
	storeOldPrompt(t, ctx, in, "session-1", "dsh:user:8", "hello", 1789135308420)
	storeOldPrompt(t, ctx, in, "session-1", "dsh:user:9", "<system-reminder>\nInstructions from: AGENTS.md", 1789135308421)
	storeOldPrompt(t, ctx, in, "session-1", "dsh:user:10", "Current runtime context.", 1789135308421)
	// The same key and text in a session with no transcript on disk: there
	// is nothing to verify it against, so it stays.
	storeOldPrompt(t, ctx, in, "session-gone", "dsh:user:9", "<system-reminder>\nInstructions from: AGENTS.md", 1789135308421)

	if err := in.once(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := List(in.dir)
	if err != nil {
		t.Fatal(err)
	}
	in.removeInjected(ctx, files)

	if got := keysOf(t, ctx, st, "session-1"); len(got) != 1 || !got["dsh:user:8"] {
		t.Fatalf("session-1 prompts after cleanup = %v, want only dsh:user:8", got)
	}
	if got := keysOf(t, ctx, st, "session-gone"); !got["dsh:user:9"] {
		t.Fatal("a row with no transcript to verify it against was deleted")
	}
	if done, _ := st.GetMeta(ctx, store.MetaDeepseekInjectedRemoved); done != "1" {
		t.Fatalf("flag = %q, want 1", done)
	}

	// Gated: a row stored again after the flag is set is left alone, and the
	// next start reads no transcript for this.
	storeOldPrompt(t, ctx, in, "session-1", "dsh:user:9", "again", 1789135308421)
	in.removeInjected(ctx, files)
	if got := keysOf(t, ctx, st, "session-1"); !got["dsh:user:9"] {
		t.Fatal("the cleanup ran a second time")
	}
}

// A deleted row may have been the session's last piece of work or its first
// event; those times are recomputed from what is left, in the same
// transaction, and are not touched when another row set them.
func TestRemoveInjectedRepairsSessionTimes(t *testing.T) {
	ctx, in, st, dir := newIngestHarness(t)
	content := `{"type":"session","version":3,"id":"s-times","createdAt":1000,"cwd":"/home/u/proj"}
{"type":"user/message","seq":1,"time":1000,"data":{"content":[{"type":"text","text":"plan snapshot"}],"source":{"kind":"plugin"}}}
{"type":"user/message","seq":2,"time":2000,"data":{"content":[{"type":"text","text":"the question"}],"source":{"kind":"user"}}}
{"type":"user/message","seq":3,"time":3000,"data":{"content":[{"type":"text","text":"Updated instructions from: CLAUDE.md"}],"source":{"kind":"agent-instructions"}}}
`
	writeSessionFile(t, dir, content)
	storeOldPrompt(t, ctx, in, "s-times", "dsh:user:1", "plan snapshot", 1000)
	storeOldPrompt(t, ctx, in, "s-times", "dsh:user:2", "the question", 2000)
	storeOldPrompt(t, ctx, in, "s-times", "dsh:user:3", "Updated instructions from: CLAUDE.md", 3000)

	files, err := List(in.dir)
	if err != nil {
		t.Fatal(err)
	}
	in.removeInjected(ctx, files)

	s, err := store.GetSession(ctx, st.DB(), "s-times")
	if err != nil {
		t.Fatal(err)
	}
	if s.StartedAt != 2000 || s.LastEventAt != 2000 || s.WorkedAt != 2000 {
		t.Fatalf("started/last/worked = %d/%d/%d, want 2000 for each", s.StartedAt, s.LastEventAt, s.WorkedAt)
	}
	// Prompts carry no tokens, cost or turn count, so the rollups are as they were.
	stats, err := store.GetStats(ctx, st.DB(), "s-times")
	if err != nil {
		t.Fatal(err)
	}
	if stats.Turns != 0 || stats.ToolCalls != 0 || stats.CostUSD != 0 {
		t.Fatalf("stats moved: %+v", stats)
	}
}
