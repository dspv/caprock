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
