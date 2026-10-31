package ingest

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// boundaryLine is a compact_boundary line in the shape Claude Code 2.1.295
// writes it (fields Caprock does not read cut).
func boundaryLine(uuid, ts, trigger string, pre int64) string {
	b, _ := json.Marshal(map[string]any{
		"parentUuid": nil, "logicalParentUuid": "p-1", "isSidechain": false, "type": "system",
		"subtype": "compact_boundary", "content": "Conversation compacted", "isMeta": false,
		"timestamp": ts, "uuid": uuid, "level": "info",
		"compactMetadata": map[string]any{"trigger": trigger, "preTokens": pre, "durationMs": 52237,
			"preCompactDiscoveredTools": []string{"WebFetch"}},
		"userType": "external", "entrypoint": "cli", "cwd": "/r", "sessionId": "s1", "version": "2.1.295",
	})
	return string(b) + "\n"
}

// A compact_boundary line is a context.compacted event that carries what
// Claude Code measured, keyed on its uuid.
func TestCompactBoundaryBecomesAnEvent(t *testing.T) {
	l, err := ParseLine([]byte(boundaryLine("b-1", "2026-10-11T00:56:49.513Z", "auto", 210092)))
	if err != nil {
		t.Fatal(err)
	}
	evs := l.Events(time.Time{})
	if len(evs) != 1 {
		t.Fatalf("%d events", len(evs))
	}
	ev := evs[0]
	if ev.Kind != event.KindContextCompacted || ev.Key != "compact:b-1" || ev.Source != event.SourceTranscript || ev.SessionID != "s1" {
		t.Fatalf("event %+v", ev)
	}
	var p map[string]any
	_ = json.Unmarshal(ev.Payload, &p)
	if p["trigger"] != "auto" || p["pre_tokens"] != float64(210092) || p["duration_ms"] != float64(52237) {
		t.Fatalf("payload %s", ev.Payload)
	}
	if _, ok := p["post_tokens"]; ok {
		t.Fatalf("no postTokens on the line, yet %s", ev.Payload)
	}
	// Newer Claude Code writes the context after on the boundary itself.
	raw := strings.Replace(boundaryLine("b-2", "2026-10-27T08:00:00.000Z", "manual", 41412),
		`"durationMs":52237`, `"durationMs":4107,"postTokens":10123,"cumulativeDroppedTokens":31289`, 1)
	l, _ = ParseLine([]byte(raw))
	p = nil
	_ = json.Unmarshal(l.Events(time.Time{})[0].Payload, &p)
	if p["post_tokens"] != float64(10123) || p["pre_tokens"] != float64(41412) {
		t.Fatalf("postTokens not kept: %v", p)
	}
	// Other system lines stay informational.
	l, _ = ParseLine([]byte(`{"type":"system","subtype":"turn_duration","durationMs":5,"sessionId":"s1","uuid":"x"}`))
	if evs := l.Events(time.Now()); len(evs) != 0 {
		t.Fatalf("turn_duration became %+v", evs)
	}
}

// Transcripts read before parser v5 give their boundaries once; a second
// run, or the tailer reading the same line, adds nothing.
func TestBackfillCompactions(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	main := filepath.Join(dir, "s1.jsonl")
	body := `{"type":"user","sessionId":"s1","uuid":"u1","timestamp":"2026-10-11T00:00:00Z","message":{"role":"user","content":"hi"}}` + "\n" +
		boundaryLine("b-1", "2026-10-11T00:56:49.513Z", "auto", 210092) +
		boundaryLine("b-2", "2026-10-11T02:00:00.000Z", "manual", 180000)
	if err := os.WriteFile(main, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	for id, p := range map[string]string{"s1": filepath.Join(dir, "s1", "subagents", "agent-a.jsonl"), "gone": filepath.Join(dir, "gone.jsonl")} {
		if err := store.UpsertSession(ctx, st.DB(), id, store.SessionPatch{Cwd: "/r", TranscriptPath: p}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := BackfillCompactions(ctx, st.DB(), nil)
	if err != nil || n != 2 {
		t.Fatalf("added %d, err %v", n, err)
	}
	if n, err := BackfillCompactions(ctx, st.DB(), nil); err != nil || n != 0 {
		t.Fatalf("second run added %d, err %v", n, err)
	}
	c, ok, err := store.LastCompaction(ctx, st.DB(), "s1")
	if err != nil || !ok || c.Trigger != "manual" || c.PreTokens != 180000 {
		t.Fatalf("last %+v %v %v", c, ok, err)
	}
	if !NeedsCompactionBackfill("4") || NeedsCompactionBackfill("5") || NeedsCompactionBackfill("") {
		t.Fatal("NeedsCompactionBackfill reads the stored schema wrong")
	}
}

// summaryLine is the isCompactSummary user message after a boundary, its
// parentUuid a line between the two, as Claude Code 2.1.285 wrote it.
func summaryLine(uuid, ts, text string) string {
	b, _ := json.Marshal(map[string]any{
		"parentUuid": "between-" + uuid, "isSidechain": false, "type": "user", "isCompactSummary": true,
		"isVisibleInTranscriptOnly": true, "uuid": uuid, "timestamp": ts, "sessionId": "s1", "cwd": "/r",
		"message": map[string]any{"role": "user", "content": text},
	})
	return string(b) + "\n"
}

// The tailer records a summary's length on the boundary it follows as the
// lines arrive, the first row of compaction_stats made then.
func TestTailerRecordsCompactionSummary(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-r", "s1.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	body := boundaryLine("b-1", "2026-10-11T00:56:49.513Z", "auto", 210092) +
		summaryLine("u-1", "2026-10-11T00:56:49.000Z", strings.Repeat("s", 1200))
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	tl, st := newTailerAt(t, root)
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	tl.pass(context.Background(), false)
	var chars, toks int64
	if err := st.DB().QueryRow(`SELECT summary_chars, summary_tokens_est FROM compaction_stats`).Scan(&chars, &toks); err != nil {
		t.Fatal(err)
	}
	if chars != 1200 || toks != 300 {
		t.Fatalf("summary %d chars, %d tokens", chars, toks)
	}
}

// Each summary's length goes to the boundary before it in the file — not
// the session's newest — and a second run reads nothing new.
func TestBackfillCompactionSummaries(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	main := filepath.Join(dir, "s1.jsonl")
	body := boundaryLine("b-1", "2026-10-11T00:56:49.513Z", "auto", 210092) +
		summaryLine("u-1", "2026-10-11T00:56:49.000Z", strings.Repeat("é", 4000)) +
		boundaryLine("b-2", "2026-10-11T02:00:00.000Z", "manual", 180000) +
		summaryLine("u-2", "2026-10-11T02:00:00.100Z", strings.Repeat("a", 800))
	if err := os.WriteFile(main, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(ctx, st.DB(), "s1", store.SessionPatch{Cwd: "/r", TranscriptPath: main}); err != nil {
		t.Fatal(err)
	}
	if _, err := BackfillCompactions(ctx, st.DB(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddCompactionBoundaries(ctx, st.DB()); err != nil {
		t.Fatal(err)
	}
	if n, err := BackfillCompactionSummaries(ctx, st.DB()); err != nil || n != 2 {
		t.Fatalf("read %d, err %v", n, err)
	}
	rows, err := st.DB().Query(`SELECT summary_chars, summary_tokens_est FROM compaction_stats ORDER BY at`)
	if err != nil {
		t.Fatal(err)
	}
	var got [][2]int64
	for rows.Next() {
		var chars, toks int64
		_ = rows.Scan(&chars, &toks)
		got = append(got, [2]int64{chars, toks})
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	if len(got) != 2 || got[0] != [2]int64{4000, 1000} || got[1] != [2]int64{800, 200} {
		t.Fatalf("summaries %v", got)
	}
	if n, err := BackfillCompactionSummaries(ctx, st.DB()); err != nil || n != 0 {
		t.Fatalf("second run read %d, err %v", n, err)
	}
}
