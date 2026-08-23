package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The v1 parser cut assistant prose at 2000 bytes and sliced mid-rune. This
// proves the repair restores the full text from the transcript and clears the
// corrupted tail — on the closing summaries that motivated the whole feature.
func TestRepairAssistantText(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	// A realistic Russian summary: 1400 runes is 2800 bytes, so v1 would have
	// cut it at ~1000 runes and left a broken rune behind.
	full := strings.TrimSpace(strings.Repeat("Готово, вот что изменилось в проекте. ", 40))
	if utf8.RuneCountInString(full) < 1200 {
		t.Fatalf("fixture too short: %d runes", utf8.RuneCountInString(full))
	}

	transcript := filepath.Join(dir, "session.jsonl")
	line := map[string]any{
		"type":      "assistant",
		"sessionId": "s1",
		"uuid":      "u1",
		"timestamp": "2026-08-20T10:00:00Z",
		"message": map[string]any{
			"id":      "msg_1",
			"model":   "claude-opus-5",
			"content": []any{map[string]any{"type": "text", "text": full}},
		},
	}
	enc, _ := json.Marshal(line)
	if err := os.WriteFile(transcript, append(enc, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(ctx, filepath.Join(dir, "db.sqlite"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	// Reproduce exactly what v1 wrote: a byte slice through a rune. Nudge the
	// offset until it lands mid-rune so the corruption is always exercised
	// rather than depending on where the fixture happens to fall.
	var damaged string
	for off := 2000; off < 2004; off++ {
		if cand := string([]byte(full)[:off]) + "…"; HasReplacementChar(cand) {
			damaged = cand
			break
		}
	}
	if damaged == "" {
		t.Fatal("could not construct a mid-rune truncation from the fixture")
	}
	payload, _ := json.Marshal(map[string]any{
		"model": "claude-opus-5", "message_id": "msg_1", "text": damaged,
		"tools": []string{}, "sidechain": false, "_from": "transcript",
	})
	ev := &event.Event{
		SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Key: "msg:msg_1", Payload: payload,
	}
	if _, err := store.InsertEvent(ctx, st.DB(), ev); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(ctx, st.DB(), "s1", store.SessionPatch{TranscriptPath: transcript}); err != nil {
		t.Fatal(err)
	}

	n, err := RepairAssistantText(ctx, st.DB(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("repaired %d rows, want 1", n)
	}

	var raw string
	if err := st.DB().QueryRowContext(ctx, `SELECT payload FROM events WHERE session_id='s1'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatal(err)
	}
	text, _ := got["text"].(string)
	if text != full {
		t.Fatalf("text not restored: got %d runes, want %d", utf8.RuneCountInString(text), utf8.RuneCountInString(full))
	}
	if HasReplacementChar(text) {
		t.Fatal("repaired text still contains a replacement character")
	}
	// Everything else in the payload must survive untouched.
	for _, k := range []string{"model", "message_id", "sidechain", "_from"} {
		if _, ok := got[k]; !ok {
			t.Fatalf("repair dropped payload key %q", k)
		}
	}

	// Idempotent: a second pass finds nothing left to do.
	if n2, err := RepairAssistantText(ctx, st.DB(), nil); err != nil || n2 != 0 {
		t.Fatalf("second pass repaired %d rows (err %v), want 0", n2, err)
	}
}

// A row whose transcript has been deleted must keep the text it has rather than
// lose it or block startup.
func TestRepairSurvivesMissingTranscript(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(ctx, filepath.Join(dir, "db.sqlite"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	payload, _ := json.Marshal(map[string]any{"message_id": "msg_gone", "text": "clipped…"})
	ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Key: "msg:msg_gone", Payload: payload}
	if _, err := store.InsertEvent(ctx, st.DB(), ev); err != nil {
		t.Fatal(err)
	}
	_ = store.UpsertSession(ctx, st.DB(), "s1", store.SessionPatch{
		TranscriptPath: filepath.Join(dir, "does-not-exist.jsonl"),
	})

	n, err := RepairAssistantText(ctx, st.DB(), nil)
	if err != nil {
		t.Fatalf("a missing transcript must not be an error: %v", err)
	}
	if n != 0 {
		t.Fatalf("repaired %d rows from a missing file", n)
	}
	var raw string
	_ = st.DB().QueryRowContext(ctx, `SELECT payload FROM events`).Scan(&raw)
	if !strings.Contains(raw, "clipped") {
		t.Fatal("the existing text was lost")
	}
}

func TestNeedsTextRepair(t *testing.T) {
	cases := map[string]bool{
		"":                        false, // fresh database, nothing to repair
		"1":                       true,  // written by the byte-capping parser
		fmt.Sprint(SchemaVersion): false, // already current
	}
	for in, want := range cases {
		if got := NeedsTextRepair(in); got != want {
			t.Errorf("NeedsTextRepair(%q) = %v, want %v", in, got, want)
		}
	}
}

// A transcript containing lines with no message (system lines) must not crash
// the repair — and therefore must not stop the daemon from starting.
func TestRepairSkipsLinesWithoutAMessage(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	transcript := filepath.Join(dir, "s.jsonl")

	full := strings.TrimSpace(strings.Repeat("Вот итог работы. ", 60))
	lines := []map[string]any{
		// A system line: parses fine, but carries no message at all.
		{"type": "system", "sessionId": "s1", "uuid": "u0", "timestamp": "2026-08-20T09:00:00Z"},
		{"type": "assistant", "sessionId": "s1", "uuid": "u1", "timestamp": "2026-08-20T10:00:00Z",
			"message": map[string]any{"id": "msg_1", "model": "claude-opus-5",
				"content": []any{map[string]any{"type": "text", "text": full}}}},
	}
	var buf strings.Builder
	for _, l := range lines {
		enc, _ := json.Marshal(l)
		buf.Write(enc)
		buf.WriteString("\n")
	}
	if err := os.WriteFile(transcript, []byte(buf.String()), 0o600); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(ctx, filepath.Join(dir, "db.sqlite"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	payload, _ := json.Marshal(map[string]any{"message_id": "msg_1", "text": "short…"})
	ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Key: "msg:msg_1", Payload: payload}
	if _, err := store.InsertEvent(ctx, st.DB(), ev); err != nil {
		t.Fatal(err)
	}
	_ = store.UpsertSession(ctx, st.DB(), "s1", store.SessionPatch{TranscriptPath: transcript})

	n, err := RepairAssistantText(ctx, st.DB(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("repaired %d rows, want 1", n)
	}
}

// Subagent transcripts nest at varying depths under a session directory, and a
// row's recorded path may be any of them while the message it needs lives in
// the main transcript. The sweep must climb to the project directory whatever
// the depth, and must not escape past it.
func TestProjectRoot(t *testing.T) {
	root := filepath.Join("home", ".claude", "projects")
	project := filepath.Join(root, "-Users-x-dev-app")
	cases := map[string]string{
		project: project,
		filepath.Join(project, "sess-1", "subagents"):                        project,
		filepath.Join(project, "sess-1", "subagents", "workflows", "wf_abc"): project,
		filepath.Join(project, "a", "b", "c", "d"):                           project,
	}
	for in, want := range cases {
		if got := projectRoot(in); got != want {
			t.Errorf("projectRoot(%q) = %q, want %q", in, got, want)
		}
	}
	// With no projects marker anywhere, stay put rather than wander upward.
	orphan := filepath.Join("tmp", "somewhere", "else")
	if got := projectRoot(orphan); got != orphan {
		t.Errorf("projectRoot(%q) = %q, want it unchanged", orphan, got)
	}
}

// toolLinkFixture writes a transcript holding one assistant message that issued
// two tool calls — one naming a file, one not — and inserts the matching
// unlinked tool.pre rows. It returns the database and the two event ids.
func toolLinkFixture(t *testing.T, ctx context.Context) (*store.Store, int64, int64) {
	t.Helper()
	dir := t.TempDir()
	// The project layout the sibling sweep expects, so the fixture exercises
	// the same path resolution production uses.
	proj := filepath.Join(dir, ".claude", "projects", "-Users-x-dev-app")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(proj, "session.jsonl")
	line := map[string]any{
		"type": "assistant", "sessionId": "s1", "uuid": "u1",
		"timestamp": "2026-08-20T10:00:00Z",
		"message": map[string]any{
			"id": "msg_1", "model": "claude-opus-5",
			"content": []any{
				map[string]any{"type": "tool_use", "id": "tu_bash", "name": "Bash", "input": map[string]any{"command": "go test ./..."}},
				map[string]any{"type": "tool_use", "id": "tu_edit", "name": "Edit", "input": map[string]any{"file_path": "/Users/x/dev/app/main.go"}},
			},
		},
	}
	enc, _ := json.Marshal(line)
	if err := os.WriteFile(transcript, append(enc, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(ctx, filepath.Join(dir, "db.sqlite"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	insert := func(toolName, toolUseID, touchDir string) int64 {
		payload, _ := json.Marshal(map[string]any{
			"tool_name": toolName, "tool_use_id": toolUseID, "_from": "transcript",
		})
		ev := &event.Event{
			SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindToolPre,
			Tool: toolName, Key: "pre:" + toolUseID, Payload: payload,
		}
		ev.TouchDir = touchDir
		id, err := store.InsertEvent(ctx, st.DB(), ev)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	// Bash names no file, so touch_dir stays NULL — the case the original
	// backfill filtered out and OQ-10 is about.
	bashID := insert("Bash", "tu_bash", "")
	editID := insert("Edit", "tu_edit", "/Users/x/dev/app")
	if err := store.UpsertSession(ctx, st.DB(), "s1", store.SessionPatch{TranscriptPath: transcript}); err != nil {
		t.Fatal(err)
	}
	return st, bashID, editID
}

func msgIDOf(t *testing.T, ctx context.Context, st *store.Store, id int64) string {
	t.Helper()
	var msg *string
	if err := st.DB().QueryRowContext(ctx, `SELECT msg_id FROM events WHERE id = ?`, id).Scan(&msg); err != nil {
		t.Fatal(err)
	}
	if msg == nil {
		return ""
	}
	return *msg
}

// OQ-10: a tool call that named no file must be linked to the turn that paid
// for it. Bash alone is roughly half of all tool calls, so leaving these out
// made the work-kind breakdown report most spend as "no tool call".
func TestBackfillLinksPathlessToolCalls(t *testing.T) {
	ctx := context.Background()
	st, bashID, editID := toolLinkFixture(t, ctx)

	n, last, err := BackfillToolMessageIDs(ctx, st.DB(), nil, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("linked %d rows, want 2 (the pathless call and the one with a path)", n)
	}
	if got := msgIDOf(t, ctx, st, bashID); got != "msg_1" {
		t.Fatalf("pathless Bash call linked to %q, want %q", got, "msg_1")
	}
	if got := msgIDOf(t, ctx, st, editID); got != "msg_1" {
		t.Fatalf("Edit call linked to %q, want %q", got, "msg_1")
	}
	if last < editID {
		t.Fatalf("cursor = %d, want at least the last row examined (%d)", last, editID)
	}
}

// A daemon restart must not redo the work, and — more importantly — a second
// pass must never change a link it already wrote.
func TestBackfillIsIdempotent(t *testing.T) {
	ctx := context.Background()
	st, bashID, _ := toolLinkFixture(t, ctx)

	n1, _, err := BackfillToolMessageIDs(ctx, st.DB(), nil, 0, 100)
	if err != nil || n1 != 2 {
		t.Fatalf("first pass linked %d (err %v), want 2", n1, err)
	}
	first := msgIDOf(t, ctx, st, bashID)

	// Re-run from the very start, as a database whose cursor was lost would.
	n2, _, err := BackfillToolMessageIDs(ctx, st.DB(), nil, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 {
		t.Fatalf("second pass linked %d rows, want 0 — already-linked rows must not be rewritten", n2)
	}
	if got := msgIDOf(t, ctx, st, bashID); got != first {
		t.Fatalf("second pass changed the link: %q then %q", first, got)
	}
}

// A daemon killed mid-backfill resumes from its cursor instead of rescanning
// the whole history, and finishes the rows the interrupted pass never reached.
func TestBackfillResumesFromCursor(t *testing.T) {
	ctx := context.Background()
	st, bashID, editID := toolLinkFixture(t, ctx)

	// One row per batch: the first pass is the "interrupted" one.
	n1, cursor, err := BackfillToolMessageIDs(ctx, st.DB(), nil, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if n1 != 1 {
		t.Fatalf("first batch linked %d rows, want 1", n1)
	}
	if cursor != bashID {
		t.Fatalf("cursor = %d, want the first row's id %d", cursor, bashID)
	}
	if msgIDOf(t, ctx, st, editID) != "" {
		t.Fatal("second row was linked by a batch that should not have reached it")
	}

	// Make the already-examined row unrecoverable-looking by clearing the link
	// the first batch wrote. A resume must NOT come back to it: the cursor, not
	// the row's state, is what says the pass has moved on. Without that, a
	// database holding rows whose transcripts are gone would re-examine them on
	// every batch and never reach the end.
	if _, err := st.DB().ExecContext(ctx, `UPDATE events SET msg_id = NULL WHERE id = ?`, bashID); err != nil {
		t.Fatal(err)
	}

	// Resume: only the rows past the cursor are considered.
	n2, cursor2, err := BackfillToolMessageIDs(ctx, st.DB(), nil, cursor, 1)
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 1 {
		t.Fatalf("resumed batch linked %d rows, want 1", n2)
	}
	if got := msgIDOf(t, ctx, st, bashID); got != "" {
		t.Fatalf("resumed pass went back behind the cursor and re-linked row %d (%q)", bashID, got)
	}
	if cursor2 != editID {
		t.Fatalf("resumed cursor = %d, want %d", cursor2, editID)
	}
	if got := msgIDOf(t, ctx, st, editID); got != "msg_1" {
		t.Fatalf("resumed row linked to %q, want %q", got, "msg_1")
	}

	// Nothing left: the cursor must not advance, which is how the caller knows
	// to stop and record completion.
	n3, cursor3, err := BackfillToolMessageIDs(ctx, st.DB(), nil, cursor2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if n3 != 0 {
		t.Fatalf("exhausted pass linked %d rows, want 0", n3)
	}
	if cursor3 != cursor2 {
		t.Fatalf("exhausted pass advanced the cursor to %d, want it to stay at %d", cursor3, cursor2)
	}
}

// A call whose transcript is gone must stay unlinked. Guessing would silently
// move money between work-kind rows, which is worse than reporting the gap.
func TestBackfillLeavesUnrecoverableRowsUnlinked(t *testing.T) {
	ctx := context.Background()
	st, bashID, _ := toolLinkFixture(t, ctx)

	// Delete every transcript, keeping the recorded path — the pruned-history
	// case a fresh install or an old database is in.
	var path string
	if err := st.DB().QueryRowContext(ctx, `SELECT transcript_path FROM sessions WHERE session_id='s1'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	n, last, err := BackfillToolMessageIDs(ctx, st.DB(), nil, 0, 100)
	if err != nil {
		t.Fatalf("a missing transcript must not be an error: %v", err)
	}
	if n != 0 {
		t.Fatalf("linked %d rows with no transcript on disk, want 0 — a link must never be guessed", n)
	}
	if got := msgIDOf(t, ctx, st, bashID); got != "" {
		t.Fatalf("row linked to %q with no transcript to read it from, want it left NULL", got)
	}
	// The cursor still advances past the unrecoverable rows, or the backfill
	// would retry them forever and never finish.
	if last < bashID {
		t.Fatalf("cursor = %d, want it past the rows this pass examined (%d)", last, bashID)
	}
}
