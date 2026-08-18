package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestMigrateFromEmptyAndIdempotent(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	v, err := s.SchemaVersion(ctx)
	if err != nil {
		t.Fatal(err)
	}
	migs, _ := loadMigrations()
	if v != len(migs) {
		t.Fatalf("schema version %d, want %d", v, len(migs))
	}
	// Re-running migrate must be a no-op.
	if err := s.migrate(ctx); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	for _, tbl := range []string{"events", "sessions", "session_stats", "daily_stats", "meta", "session_files", "transcript_offsets"} {
		var n int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&n); err != nil || n != 1 {
			t.Fatalf("table %s missing (err=%v)", tbl, err)
		}
	}
}

func TestMigrateOnDiskReopen(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/c.db"
	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(ctx, MetaPricingVersion, "x"); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	s2, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	v, _ := s2.GetMeta(ctx, MetaPricingVersion)
	if v != "x" {
		t.Fatalf("meta lost across reopen: %q", v)
	}
}

func TestInsertEventDedupeAndSessions(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	ev := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Payload: json.RawMessage(`{"a":1}`), Key: "toolu_1", Ts: time.UnixMilli(1000)}
	if _, err := InsertEvent(ctx, s.db, ev); err != nil {
		t.Fatal(err)
	}
	if ev.ID == 0 {
		t.Fatal("id not assigned")
	}
	dup := *ev
	dup.ID = 0
	if _, err := InsertEvent(ctx, s.db, &dup); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("expected ErrDuplicate, got %v", err)
	}
	// Different session, same key → not a dup.
	other := *ev
	other.ID, other.SessionID = 0, "s2"
	if _, err := InsertEvent(ctx, s.db, &other); err != nil {
		t.Fatalf("other session: %v", err)
	}
	// Keyless events are never deduped.
	for range 2 {
		if _, err := InsertEvent(ctx, s.db, &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindTurnUser}); err != nil {
			t.Fatal(err)
		}
	}
	evs, err := ListEvents(ctx, s.db, "s1", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 3 || evs[0].Tool != "Bash" || string(evs[0].Payload) != `{"a":1}` {
		t.Fatalf("unexpected events: %+v", evs)
	}

	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: "/x/proj", Project: "proj", FromHook: true, StartedAt: 1000, LastEventAt: 1000}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Model: "claude-opus-5", FromTranscript: true, LastEventAt: 2000}); err != nil {
		t.Fatal(err)
	}
	got, err := GetSession(ctx, s.db, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Cwd != "/x/proj" || got.Model != "claude-opus-5" || !got.HasHooks || !got.HasTranscript || got.StartedAt != 1000 || got.LastEventAt != 2000 || got.Status != StatusActive {
		t.Fatalf("session merge wrong: %+v", got)
	}
	ids, err := MarkIdleSessions(ctx, s.db, 3000)
	if err != nil || len(ids) != 1 {
		t.Fatalf("mark idle: %v %v", ids, err)
	}
	list, _ := ListSessions(ctx, s.db, true, 0)
	if len(list) != 1 || list[0].Status != StatusIdle {
		t.Fatalf("list: %+v", list)
	}
	if err := SetSessionStatus(ctx, s.db, "s1", StatusEnded); err != nil {
		t.Fatal(err)
	}
	if list, _ := ListSessions(ctx, s.db, true, 0); len(list) != 0 {
		t.Fatalf("ended session listed as active: %+v", list)
	}
}

func TestStatsAndDaily(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	st, err := AddStats(ctx, s.db, Stats{SessionID: "s1", Turns: 1, TokensIn: 10, CostUSD: 0.5})
	if err != nil {
		t.Fatal(err)
	}
	st, err = AddStats(ctx, s.db, Stats{SessionID: "s1", ToolCalls: 2, TokensIn: 5, CostUSD: 0.25})
	if err != nil {
		t.Fatal(err)
	}
	if st.Turns != 1 || st.ToolCalls != 2 || st.TokensIn != 15 || st.CostUSD != 0.75 {
		t.Fatalf("stats: %+v", st)
	}
	for _, ns := range []bool{true, false} {
		if err := AddDaily(ctx, s.db, "2026-08-18", "proj", "m", 100, 1.0, ns); err != nil {
			t.Fatal(err)
		}
	}
	d, err := Daily(ctx, s.db, "2026-08-01")
	if err != nil {
		t.Fatal(err)
	}
	if len(d) != 1 || d[0].TokensTotal != 200 || d[0].Sessions != 1 || d[0].CostUSD != 2.0 {
		t.Fatalf("daily: %+v", d)
	}
	newFile, err := TouchFile(ctx, s.db, "s1", "/a/b.go", 10)
	if err != nil || !newFile {
		t.Fatalf("touch: %v %v", newFile, err)
	}
	newFile, _ = TouchFile(ctx, s.db, "s1", "/a/b.go", 20)
	if newFile {
		t.Fatal("second touch reported as new")
	}
	files, _ := SessionFiles(ctx, s.db, "s1", 0)
	if len(files) != 1 {
		t.Fatalf("files: %v", files)
	}
	if err := SetOffset(ctx, s.db, "/t.jsonl", "s1", 42); err != nil {
		t.Fatal(err)
	}
	if off, _ := GetOffset(ctx, s.db, "/t.jsonl"); off != 42 {
		t.Fatalf("offset %d", off)
	}
}

func TestSummarize(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	cost := 0.02
	for i, m := range []string{"claude-opus-5", "claude-opus-5", "claude-haiku-4-5"} {
		ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: m, Ts: time.UnixMilli(int64(1000 + i)),
			Tokens: &event.TokenDelta{In: 10, Out: 5, CacheRead: 100}, CostUSD: &cost, Key: "u" + string(rune('a'+i))}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	_ = UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: "/p/demo", Project: "demo"})
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Sessions != 1 || sum.Turns != 3 || sum.TokensIn != 30 || sum.CacheRead != 300 || sum.CostUSD < 0.0599 || len(sum.Models) != 2 || sum.Models[0].Model != "claude-opus-5" || len(sum.Projects) != 1 || sum.Projects[0].Project != "demo" {
		t.Fatalf("summary: %+v", sum)
	}
}

func TestProjectFromCwd(t *testing.T) {
	for in, want := range map[string]string{"/Users/x/dev/caprock": "caprock", `C:\Users\x\proj\`: "proj", "": "", "solo": "solo"} {
		if got := ProjectFromCwd(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}
