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
