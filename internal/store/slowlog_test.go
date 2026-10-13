package store

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A statement slower than SlowQuery is logged once, at INFO, naming the code
// that ran it, how long it took and how many rows it returned; a fast one is
// not logged at all.
func TestASlowQueryIsLoggedWithItsCaller(t *testing.T) {
	var buf bytes.Buffer
	var mu sync.Mutex
	log := slog.New(slog.NewTextHandler(&lockedWriter{w: &buf, mu: &mu}, &slog.HandlerOptions{Level: slog.LevelInfo}))
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "c.db"), log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	// A clock that moves 400 ms on every reading: each statement takes
	// longer than SlowQuery.
	var clockMu sync.Mutex
	at := time.Unix(1_800_000_000, 0)
	slowClock = func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		at = at.Add(400 * time.Millisecond)
		return at
	}
	t.Cleanup(func() { slowClock = time.Now })

	if _, err := CountEvents(context.Background(), s.DB()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	out := buf.String()
	buf.Reset()
	mu.Unlock()
	if !strings.Contains(out, `msg="slow query"`) || !strings.Contains(out, "level=INFO") {
		t.Fatalf("no slow-query line: %s", out)
	}
	for _, want := range []string{"caller=github.com/dspv/caprock/internal/store.CountEvents", "ms=400", "rows=1", `query="SELECT COUNT(*) FROM events"`} {
		if !strings.Contains(out, want) {
			t.Errorf("slow-query line lacks %q: %s", want, out)
		}
	}

	slowClock = time.Now
	if _, err := CountEvents(context.Background(), s.DB()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(buf.String(), "slow query") {
		t.Fatalf("a fast query was logged: %s", buf.String())
	}
}

type lockedWriter struct {
	w  *bytes.Buffer
	mu *sync.Mutex
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// The WAL is cut back after a checkpoint, so one big transaction does not
// leave a WAL its size on disk for good.
func TestJournalSizeLimitIsSet(t *testing.T) {
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "c.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int64
	if err := s.DB().QueryRow(`PRAGMA journal_size_limit`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != JournalSizeLimit {
		t.Fatalf("journal_size_limit = %d, want %d", n, JournalSizeLimit)
	}
}

// tool_bytes counts what the tool handed back even when the stored payload
// was capped.
func TestToolBytesCountsTheSizeBeforeTheCap(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	payload, _ := json.Marshal(map[string]any{"tool_response": "[image image/png 900 KB not stored]"})
	ev := &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Read",
		Key: "post:1", Payload: payload, ToolBytes: 1_234_567}
	if _, err := InsertEvent(ctx, s.DB(), ev); err != nil {
		t.Fatal(err)
	}
	// Without a size the stored response is measured, as before.
	ev2 := &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindToolPost, Tool: "Bash",
		Key: "post:2", Payload: json.RawMessage(`{"tool_response":"abc"}`)}
	if _, err := InsertEvent(ctx, s.DB(), ev2); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]int64{"post:1": 1_234_567, "post:2": 5} {
		var got int64
		if err := s.DB().QueryRow(`SELECT tool_bytes FROM events WHERE key = ?`, key).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("%s: tool_bytes %d, want %d", key, got, want)
		}
	}
}

// A Write clipped by the cap still counts every line it wrote.
func TestLineCountReadsTheClipMarker(t *testing.T) {
	full := strings.Repeat("a line\n", 10000)
	clipped := event.ClipString(full, event.MaxToolField)
	if got := lineCount(clipped); got != 10000 {
		t.Fatalf("lineCount of a clipped Write = %d, want 10000", got)
	}
	if got := lineCount("one\ntwo"); got != 2 {
		t.Fatalf("lineCount = %d", got)
	}
}

func TestSessionRanIn(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	if err := UpsertSession(ctx, s.DB(), "s1", SessionPatch{Cwd: "/data/chats/2026-10-01-120000"}); err != nil {
		t.Fatal(err)
	}
	for dir, want := range map[string]bool{"/data/chats/2026-10-01-120000": true, "/data/chats/other": false} {
		got, err := SessionRanIn(ctx, s.DB(), dir)
		if err != nil || got != want {
			t.Errorf("SessionRanIn(%q) = %v, %v; want %v", dir, got, err, want)
		}
	}
}
