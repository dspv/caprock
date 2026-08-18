package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

type expected struct {
	Turns          int64   `json:"turns"`
	ToolPre        int64   `json:"tool_pre"`
	ToolPost       int64   `json:"tool_post"`
	UserPrompts    int64   `json:"user_prompts"`
	TokensIn       int64   `json:"tokens_in"`
	TokensOut      int64   `json:"tokens_out"`
	CacheRead      int64   `json:"cache_read"`
	CacheWrite     int64   `json:"cache_write"`
	CacheWrite1h   int64   `json:"cache_write_1h"`
	FilesTouched   int64   `json:"files_touched"`
	CostUSDOpus5   float64 `json:"cost_usd_opus5"`
	MalformedLines int64   `json:"malformed_lines"`
}

func fixturesDir() string { return filepath.Join("..", "..", "testdata", "transcripts") }

func loadExpected(t *testing.T) map[string]expected {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixturesDir(), "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]expected
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func newTailer(t *testing.T, root string) (*Tailer, *store.Store) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	rec := rollup.New(st, tb, bus.New(), nil)
	tl := New(root, rec, st, nil)
	tl.BackfillWindow = 0 // treat everything as live in tests
	return tl, st
}

// copyFixture copies a fixture into a temp "projects" tree and returns the root.
func copyFixture(t *testing.T, name string) (root, path string) {
	t.Helper()
	root = t.TempDir()
	dir := filepath.Join(root, "-home-u-proj")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(fixturesDir(), name))
	if err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return root, path
}

func kindCount(t *testing.T, st *store.Store, kind event.Kind) int64 {
	t.Helper()
	var n int64
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM events WHERE kind = ?`, string(kind)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestGoldenFixtures(t *testing.T) {
	exp := loadExpected(t)
	for name, want := range exp {
		t.Run(name, func(t *testing.T) {
			root, _ := copyFixture(t, name)
			tl, st := newTailer(t, root)
			ctx := context.Background()
			if err := tl.discover(nil); err != nil {
				t.Fatal(err)
			}
			tl.pass(ctx, false)
			// Second pass must be a no-op (nothing new): totals unchanged.
			tl.pass(ctx, false)

			var sessionID string
			if err := st.DB().QueryRow(`SELECT session_id FROM sessions LIMIT 1`).Scan(&sessionID); err != nil {
				t.Fatalf("no session recorded: %v", err)
			}
			stats, err := store.GetStats(ctx, st.DB(), sessionID)
			if err != nil {
				t.Fatal(err)
			}
			if stats.Turns != want.Turns || stats.TokensIn != want.TokensIn || stats.TokensOut != want.TokensOut ||
				stats.CacheRead != want.CacheRead || stats.CacheWrite != want.CacheWrite || stats.FilesTouched != want.FilesTouched {
				t.Errorf("stats mismatch:\n got %+v\nwant %+v", stats, want)
			}
			if got := kindCount(t, st, event.KindToolPre); got != want.ToolPre {
				t.Errorf("tool.pre %d want %d", got, want.ToolPre)
			}
			if got := kindCount(t, st, event.KindToolPost); got != want.ToolPost {
				t.Errorf("tool.post %d want %d", got, want.ToolPost)
			}
			if got := kindCount(t, st, event.KindTurnUser); got != want.UserPrompts {
				t.Errorf("turn.user %d want %d", got, want.UserPrompts)
			}
			var cw1h int64
			_ = st.DB().QueryRow(`SELECT COALESCE(SUM(cache_write_1h),0) FROM events`).Scan(&cw1h)
			if cw1h != want.CacheWrite1h {
				t.Errorf("cache_write_1h %d want %d", cw1h, want.CacheWrite1h)
			}
			if want.CostUSDOpus5 > 0 && math.Abs(stats.CostUSD-want.CostUSDOpus5) > 0.001 {
				t.Errorf("cost %.6f want %.6f (±0.001)", stats.CostUSD, want.CostUSDOpus5)
			}
			ts := tl.Stats()
			if ts.LinesMalformed != want.MalformedLines {
				t.Errorf("malformed lines %d want %d", ts.LinesMalformed, want.MalformedLines)
			}
			// Session metadata came through.
			s, _ := store.GetSession(ctx, st.DB(), sessionID)
			if s.Cwd != "/home/u/proj" || s.Project != "proj" || s.GitBranch != "master" || s.Version == "" || !s.HasTranscript || s.TranscriptPath == "" {
				t.Errorf("session metadata: %+v", s)
			}
		})
	}
}

func TestTailAppendsAndResumesOffsets(t *testing.T) {
	root, path := copyFixture(t, "normal.jsonl")
	tl, st := newTailer(t, root)
	ctx := context.Background()
	_ = tl.discover(nil)
	tl.pass(ctx, false)
	before := tl.Stats()

	// Append one more assistant turn without a trailing newline (writer mid-flush).
	extra := `{"type":"assistant","uuid":"a-9","sessionId":"11111111-2222-3333-4444-555555555555","cwd":"/home/u/proj","timestamp":"2026-08-18T10:01:00.000Z","message":{"model":"claude-opus-5","id":"msg-9","role":"assistant","content":[{"type":"text","text":"tail"}],"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(extra)
	_ = f.Close()
	tl.pass(ctx, false)
	if tl.Stats().EventsStored != before.EventsStored {
		t.Fatal("partial line was consumed before its newline")
	}
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString("\n")
	_ = f.Close()
	tl.pass(ctx, false)
	if tl.Stats().EventsStored != before.EventsStored+1 {
		t.Fatalf("appended turn not stored: %+v", tl.Stats())
	}
	stats, _ := store.GetStats(ctx, st.DB(), "11111111-2222-3333-4444-555555555555")
	if stats.Turns != 4 {
		t.Fatalf("turns %d", stats.Turns)
	}

	// A fresh tailer over the same store resumes from the persisted offset and stores nothing new.
	tb, _ := cost.Embedded()
	tl2 := New(root, rollup.New(st, tb, bus.New(), nil), st, nil)
	tl2.BackfillWindow = 0
	_ = tl2.discover(nil)
	tl2.pass(ctx, false)
	if s := tl2.Stats(); s.EventsStored != 0 || s.LinesParsed != 0 {
		t.Fatalf("resume re-read the file: %+v", s)
	}
	off, _ := store.GetOffset(ctx, st.DB(), path)
	fi, _ := os.Stat(path)
	if off != fi.Size() {
		t.Fatalf("offset %d, size %d", off, fi.Size())
	}
}

func TestHookAndTranscriptDedupeByKey(t *testing.T) {
	root, _ := copyFixture(t, "normal.jsonl")
	tl, st := newTailer(t, root)
	ctx := context.Background()
	// Simulate the hook plane having already delivered the PreToolUse for toolu_1.
	hookEv := &event.Event{SessionID: "11111111-2222-3333-4444-555555555555", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Edit", Key: "pre:toolu_1",
		Payload: json.RawMessage(`{"tool_name":"Edit","tool_input":{"file_path":"/home/u/proj/main.go"}}`), Ts: time.Now()}
	if _, err := tl.Recorder.Record(ctx, hookEv, rollup.SessionInfo{Cwd: "/home/u/proj"}); err != nil {
		t.Fatal(err)
	}
	_ = tl.discover(nil)
	tl.pass(ctx, false)
	if got := kindCount(t, st, event.KindToolPre); got != 2 {
		t.Fatalf("tool.pre count %d, want 2 (hook copy + transcript's other tool)", got)
	}
	stats, _ := store.GetStats(ctx, st.DB(), "11111111-2222-3333-4444-555555555555")
	if stats.ToolCalls != 2 || stats.FilesTouched != 1 {
		t.Fatalf("stats after dedupe: %+v", stats)
	}
	if tl.Stats().EventsDeduped < 1 {
		t.Fatalf("expected dedupes: %+v", tl.Stats())
	}
}

func TestParseLineTolerance(t *testing.T) {
	if _, err := ParseLine([]byte("")); !errors.Is(err, ErrSkip) {
		t.Fatal("blank should skip")
	}
	if _, err := ParseLine([]byte("\xef\xbb\xbf{\"type\":\"user\",\"sessionId\":\"s\"}")); err != nil {
		t.Fatalf("BOM line: %v", err)
	}
	if _, err := ParseLine([]byte("[1,2]")); !errors.Is(err, ErrMalformed) {
		t.Fatal("array should be malformed")
	}
	if _, err := ParseLine([]byte(`{"type":"user"}`)); !errors.Is(err, ErrSkip) {
		t.Fatal("no session id should skip")
	}
	l, err := ParseLine([]byte(`{"type":"user","sessionId":"s","timestamp":"garbage"}`))
	if err != nil {
		t.Fatal(err)
	}
	fb := time.Unix(5, 0)
	if !l.Ts(fb).Equal(fb) {
		t.Fatal("bad timestamp should fall back")
	}
	if len(l.Events(fb)) != 0 {
		t.Fatal("user line without message produced events")
	}
}
