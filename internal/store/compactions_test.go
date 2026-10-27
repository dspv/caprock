package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func compactRow(t *testing.T, s *Store, id, key string, at time.Time, pre int64, extra map[string]any) {
	t.Helper()
	p := map[string]any{"trigger": "manual", "pre_tokens": pre, "duration_ms": 5000}
	for k, v := range extra {
		p[k] = v
	}
	raw, _ := json.Marshal(p)
	ev := &event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindContextCompacted, Ts: at, Key: key, Payload: raw}
	if _, err := InsertEvent(context.Background(), s.DB(), ev); err != nil {
		t.Fatal(err)
	}
}

func turnRow(t *testing.T, s *Store, id, key, agent string, at time.Time, in, read, write int64) {
	t.Helper()
	ev := &event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at, Key: key, AgentID: agent,
		Model: "claude-sonnet-4-6", Tokens: &event.TokenDelta{In: in, CacheRead: read, CacheWrite: write}}
	if _, err := InsertEvent(context.Background(), s.DB(), ev); err != nil {
		t.Fatal(err)
	}
}

// The context after a compaction is the first real main-thread turn after
// the boundary: not a subagent's, not one whose usage reads zero, and never
// one that comes after the session's next boundary.
func TestLastCompactionMeasuresTheNextMainTurn(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	turnRow(t, s, "s1", "msg:a", "", t0, 10, 400_000, 1_000)
	compactRow(t, s, "s1", "compact:1", t0.Add(time.Minute), 467_121, nil)
	turnRow(t, s, "s1", "msg:sub", "agent-1", t0.Add(70*time.Second), 5, 9_000, 0)
	turnRow(t, s, "s1", "msg:zero", "", t0.Add(80*time.Second), 0, 0, 0)
	turnRow(t, s, "s1", "msg:b", "", t0.Add(90*time.Second), 8, 50_000, 11_380)
	turnRow(t, s, "s1", "msg:c", "", t0.Add(100*time.Second), 8, 70_000, 0)

	c, ok, err := LastCompaction(ctx, s.DB(), "s1")
	if err != nil || !ok {
		t.Fatalf("last compaction: %v %v", ok, err)
	}
	want := Compaction{At: t0.Add(time.Minute).UnixMilli(), Trigger: "manual", PreTokens: 467_121, PostTokens: 61_388, DurationMs: 5000}
	if c != want {
		t.Fatalf("got %+v, want %+v", c, want)
	}

	// A second boundary with no turn after it yet: measured, not borrowed
	// from the turn before it.
	compactRow(t, s, "s1", "compact:2", t0.Add(5*time.Minute), 300_000, nil)
	c, _, _ = LastCompaction(ctx, s.DB(), "s1")
	if c.PreTokens != 300_000 || c.PostTokens != 0 {
		t.Fatalf("pending boundary: %+v", c)
	}
	// A subagent's own compaction is not the session's.
	compactRow(t, s, "s1", "compact:side", t0.Add(6*time.Minute), 1, map[string]any{"sidechain": true})
	c, _, _ = LastCompaction(ctx, s.DB(), "s1")
	if c.PreTokens != 300_000 {
		t.Fatalf("a sidechain boundary was read as the session's: %+v", c)
	}
	if _, ok, _ := LastCompaction(ctx, s.DB(), "nobody"); ok {
		t.Fatal("a session with no compaction has one")
	}
}

// The machine's figure is the median share kept, over the compactions a
// turn followed; the 90th percentile and the period come with it.
func TestRecentCompactionStats(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	st, err := RecentCompactionStats(ctx, s.DB())
	if err != nil || st.Count != 0 {
		t.Fatalf("empty: %+v %v", st, err)
	}
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	kept := []int64{10, 15, 20, 25, 40} // percent of 100,000
	for i, k := range kept {
		id := "s" + string(rune('a'+i))
		at := t0.Add(time.Duration(i) * time.Hour)
		compactRow(t, s, id, "compact:x", at, 100_000, nil)
		turnRow(t, s, id, "msg:x", "", at.Add(time.Second), 0, k*1000, 0)
	}
	// Not measured: no turn followed.
	compactRow(t, s, "pending", "compact:x", t0.Add(9*time.Hour), 100_000, nil)

	st, err = RecentCompactionStats(ctx, s.DB())
	if err != nil {
		t.Fatal(err)
	}
	if st.Count != 5 || st.MedianKept != 0.20 || st.P90Kept != 0.40 || st.MedianPre != 100_000 || st.MedianPost != 20_000 {
		t.Fatalf("stats %+v", st)
	}
	if st.From != t0.UnixMilli() || st.To != t0.Add(4*time.Hour).UnixMilli() {
		t.Fatalf("period %d–%d", st.From, st.To)
	}
}

// Claude Code that writes postTokens on the boundary says the after itself:
// it is shown at once and preferred to the next reply's prompt, and the
// machine's figure is measured from it.
func TestCompactionPrefersTheBoundarysPostTokens(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 27, 10, 0, 0, 0, time.UTC)
	compactRow(t, s, "s1", "compact:1", t0, 41_412, map[string]any{"post_tokens": 10_123})
	c, _, err := LastCompaction(ctx, s.DB(), "s1")
	if err != nil || c.PostTokens != 10_123 {
		t.Fatalf("before any reply: %+v %v", c, err)
	}
	turnRow(t, s, "s1", "msg:b", "", t0.Add(time.Second), 8, 12_000, 500)
	if c, _, _ = LastCompaction(ctx, s.DB(), "s1"); c.PostTokens != 10_123 {
		t.Fatalf("the reply replaced the boundary's figure: %+v", c)
	}
	for i := range 4 {
		id := "o" + string(rune('a'+i))
		compactRow(t, s, id, "compact:x", t0.Add(time.Duration(i+1)*time.Minute), 100_000, map[string]any{"post_tokens": 20_000})
	}
	st, err := RecentCompactionStats(ctx, s.DB())
	if err != nil || st.Count != 5 || st.MedianKept != 0.20 {
		t.Fatalf("stats %+v %v", st, err)
	}
}
