package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// seedUnlinkedToolCalls writes a transcript with one assistant message issuing
// n pathless tool calls, and inserts the matching unlinked tool.pre rows.
func seedUnlinkedToolCalls(t *testing.T, st *store.Store, n int) {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	proj := filepath.Join(dir, ".claude", "projects", "-Users-x-dev-app")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	blocks := make([]any, 0, n)
	for i := 0; i < n; i++ {
		blocks = append(blocks, map[string]any{
			"type": "tool_use", "id": "tu_" + itoa(i), "name": "Bash",
			"input": map[string]any{"command": "echo " + itoa(i)},
		})
	}
	line := map[string]any{
		"type": "assistant", "sessionId": "s1", "uuid": "u1",
		"timestamp": "2026-08-20T10:00:00Z",
		"message":   map[string]any{"id": "msg_1", "model": "claude-opus-5", "content": blocks},
	}
	enc, _ := json.Marshal(line)
	transcript := filepath.Join(proj, "session.jsonl")
	if err := os.WriteFile(transcript, append(enc, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		payload, _ := json.Marshal(map[string]any{
			"tool_name": "Bash", "tool_use_id": "tu_" + itoa(i), "_from": "transcript",
		})
		ev := &event.Event{
			SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindToolPre,
			Tool: "Bash", Key: "pre:tu_" + itoa(i), Payload: payload,
		}
		if _, err := store.InsertEvent(ctx, st.DB(), ev); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.UpsertSession(ctx, st.DB(), "s1", store.SessionPatch{TranscriptPath: transcript}); err != nil {
		t.Fatal(err)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func countUnlinked(t *testing.T, st *store.Store) int {
	t.Helper()
	var n int
	if err := st.DB().QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM events WHERE kind='tool.pre' AND msg_id IS NULL`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// The background runner must link every unlinked call across as many batches as
// it takes, and then record the sentinel so later starts skip the scan.
//
// Replacing the `for` loop body with a single BackfillToolMessageIDs call makes
// this fail with "5 tool calls still unlinked after the backfill, want 0".
func TestBackfillToolLinksRunsToCompletion(t *testing.T) {
	st := memStore(t)
	seedUnlinkedToolCalls(t, st, 5)
	if countUnlinked(t, st) != 5 {
		t.Fatalf("fixture: want 5 unlinked rows, got %d", countUnlinked(t, st))
	}

	d := &Daemon{log: quietLog(), store: st}
	d.backfillToolLinks(context.Background())

	if n := countUnlinked(t, st); n != 0 {
		t.Errorf("%d tool calls still unlinked after the backfill, want 0", n)
	}
	cur, _ := st.GetMeta(context.Background(), store.MetaToolLinkCursor)
	if cur != store.ToolLinkDone {
		t.Errorf("cursor = %q after a complete pass, want %q", cur, store.ToolLinkDone)
	}
}

// A database whose backfill already finished must not rescan the transcripts on
// every start — that is the whole reason the sentinel exists.
//
// Removing the `if cur == store.ToolLinkDone { return }` guard makes this fail
// with "a finished backfill re-linked 3 rows".
func TestBackfillToolLinksSkipsWhenDone(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)
	seedUnlinkedToolCalls(t, st, 3)
	if err := st.SetMeta(ctx, store.MetaToolLinkCursor, store.ToolLinkDone); err != nil {
		t.Fatal(err)
	}

	d := &Daemon{log: quietLog(), store: st}
	d.backfillToolLinks(ctx)

	// Nothing was touched: the rows are exactly as seeded.
	if n := countUnlinked(t, st); n != 3 {
		t.Errorf("a finished backfill re-linked %d rows", 3-n)
	}
}

// A database that finished the ORIGINAL path-only pass still has every pathless
// call unlinked. Treating that old marker as "done" would skip exactly the
// machines the widening (OQ-10) exists for.
//
// Making backfillToolLinks return early on MetaToolLinkBackfilled == "1" makes
// this fail with "4 pathless calls left unlinked on a database the narrow pass
// had marked complete".
func TestBackfillToolLinksIgnoresTheNarrowPassMarker(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)
	seedUnlinkedToolCalls(t, st, 4)
	// Exactly the state of a database upgraded from the narrow backfill.
	if err := st.SetMeta(ctx, store.MetaToolLinkBackfilled, "1"); err != nil {
		t.Fatal(err)
	}

	d := &Daemon{log: quietLog(), store: st}
	d.backfillToolLinks(ctx)

	if n := countUnlinked(t, st); n != 0 {
		t.Errorf("%d pathless calls left unlinked on a database the narrow pass had marked complete", n)
	}
}
