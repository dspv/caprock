package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func eventForTool(session, tool string, ts int64) event.Event {
	return event.Event{SessionID: session, Source: event.SourceHook, Kind: event.KindToolPre, Tool: tool, Ts: time.UnixMilli(ts), Key: fmt.Sprintf("%s-%d", tool, ts)}
}

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
	for _, tbl := range []string{"events", "sessions", "session_stats", "daily_stats", "meta", "session_files", "transcript_offsets", "throttle_observations", "rate_limit_latest", "rate_limit_history"} {
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
	// session_stats has a foreign key to sessions. In-memory tests used to run
	// with foreign_keys off — weaker than the on-disk database, where this
	// insert would fail — so the session has to exist, as it does in the real
	// ingest path.
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Project: "p", LastEventAt: 1000, StartedAt: 1000}); err != nil {
		t.Fatal(err)
	}
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
	// A real repository on disk, because the project label is now the
	// repository a cwd belongs to rather than the cwd's basename.
	demo := newRepo(t, filepath.Join(t.TempDir(), "demo"))
	_ = UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: demo})
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Sessions != 1 || sum.Turns != 3 || sum.TokensIn != 30 || sum.CacheRead != 300 || sum.CostUSD < 0.0599 || len(sum.Models) != 2 || sum.Models[0].Model != "claude-opus-5" || len(sum.Projects) != 1 || sum.Projects[0].Project != "demo" {
		t.Fatalf("summary: %+v", sum)
	}
}

// Sessions in a ProjectShare must count distinct sessions, not events — the
// panel on Now uses it to say "who is working in this repo".
func TestSummarizeProjectSessions(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	cost := 0.01
	// Two sessions in "alpha" (two events each) and one in "beta".
	for i, tc := range []struct{ sid, project string }{{"a1", "alpha"}, {"a1", "alpha"}, {"a2", "alpha"}, {"a2", "alpha"}, {"b1", "beta"}} {
		ev := &event.Event{SessionID: tc.sid, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: "claude-opus-5",
			Ts: time.UnixMilli(2000), Tokens: &event.TokenDelta{In: 1, Out: 1}, CostUSD: &cost}
		// Unique dedup key per row so both events of a session are stored.
		ev.Key = fmt.Sprintf("%s-%d", tc.sid, i)
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	_ = UpsertSession(ctx, s.db, "a1", SessionPatch{Project: "alpha"})
	_ = UpsertSession(ctx, s.db, "a2", SessionPatch{Project: "alpha"})
	_ = UpsertSession(ctx, s.db, "b1", SessionPatch{Project: "beta"})
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, p := range sum.Projects {
		got[p.Project] = p.Sessions
	}
	if got["alpha"] != 2 || got["beta"] != 1 {
		t.Fatalf("sessions per project = %v, want alpha=2 beta=1 (%+v)", got, sum.Projects)
	}
}

// ProjectFromCwd used to return the cwd's BASENAME, which is what made a
// subdirectory look like a project. It now returns the repository label; the
// derivation itself is covered in repo_test.go.
func TestProjectFromCwd(t *testing.T) {
	clearRepoCache()
	root := newRepo(t, filepath.Join(t.TempDir(), "caprock"))
	sub := filepath.Join(root, "ui")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ProjectFromCwd(sub); got != "caprock" {
		t.Errorf("ProjectFromCwd(%q) = %q, want %q — the basename is not the project", sub, got, "caprock")
	}
	if got := ProjectFromCwd(""); got != "" {
		t.Errorf("ProjectFromCwd(\"\") = %q, want empty", got)
	}
}

func TestOwnedLifecycle(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if err := UpsertSession(ctx, s.db, "o1", SessionPatch{Cwd: "/p"}); err != nil {
		t.Fatal(err)
	}
	if err := MarkOwned(ctx, s.db, "o1", "feature-x", "claude --session-id o1", 4242); err != nil {
		t.Fatal(err)
	}
	got, _ := GetSession(ctx, s.db, "o1")
	if !got.Owned || got.Worktree != "feature-x" || got.PID != 4242 || got.SpawnCommand == "" {
		t.Fatalf("owned: %+v", got)
	}
	list, _ := ListOwnedActive(ctx, s.db)
	if len(list) != 1 {
		t.Fatalf("owned active: %+v", list)
	}
	if err := SetExit(ctx, s.db, "o1", 137); err != nil {
		t.Fatal(err)
	}
	got, _ = GetSession(ctx, s.db, "o1")
	if got.Status != StatusEnded || got.ExitCode == nil || *got.ExitCode != 137 || got.PID != 0 {
		t.Fatalf("exit: %+v", got)
	}
	if err := RecordThrottle(ctx, s.db, 1, "o1", "rate_limit", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryAndToolDistribution(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().UnixMilli()
	_ = UpsertSession(ctx, s.db, "h1", SessionPatch{Cwd: "/p/a", Project: "a", StartedAt: base, LastEventAt: base + 60_000})
	for i, tool := range []string{"Bash", "Bash", "Edit", "Read"} {
		ev := eventForTool("h1", tool, base+int64(i))
		if _, err := InsertEvent(ctx, s.db, &ev); err != nil {
			t.Fatal(err)
		}
	}
	td, err := ToolDistribution(ctx, s.db, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(td) != 3 || td[0].Tool != "Bash" || td[0].Count != 2 {
		t.Fatalf("tool dist: %+v", td)
	}
	h, err := History(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if h.Sessions != 1 || h.ToolCalls != 4 || h.AvgSessionSec < 59 || h.AvgSessionSec > 61 {
		t.Fatalf("history: %+v", h)
	}
}

func TestTasksMirrorAndAttribution(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if err := UpsertTask(ctx, s.db, TaskRow{ID: "t1", Title: "x", Status: "inbox", BudgetUSD: 3}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertTask(ctx, s.db, TaskRow{ID: "t1", Title: "x", Status: "assigned", Assignee: "w1", BudgetUSD: 3}); err != nil {
		t.Fatal(err)
	}
	got, _ := GetTask(ctx, s.db, "t1")
	if got.Status != "assigned" || got.Assignee != "w1" {
		t.Fatalf("task: %+v", got)
	}
	list, _ := ListTasks(ctx, s.db)
	if len(list) != 1 {
		t.Fatalf("list: %+v", list)
	}
	// Forced-continue guard.
	for i := 1; i <= 3; i++ {
		n, err := IncForcedContinue(ctx, s.db, "sess", "t1")
		if err != nil || n != i {
			t.Fatalf("forced continue %d: %d %v", i, n, err)
		}
	}
	_ = ResetForcedContinue(ctx, s.db, "sess", "t1")
	n, _ := IncForcedContinue(ctx, s.db, "sess", "t1")
	if n != 1 {
		t.Fatalf("after reset: %d", n)
	}
	if err := RecordVerification(ctx, s.db, "t1", 1, "go test ./...", 1, "/out"); err != nil {
		t.Fatal(err)
	}
	// Cost attribution: two turns for the assigned session inside the window.
	cost := 0.5
	base := nowMs()
	_ = OpenAssignment(ctx, s.db, "t1", "sess", base)
	for i, k := range []string{"a", "b"} {
		ev := &event.Event{SessionID: "sess", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: "claude-opus-5", CostUSD: &cost, Key: k, Ts: time.UnixMilli(base + int64(i))}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	total, err := AttributeTaskCost(ctx, s.db, "t1")
	if err != nil || total != 1.0 {
		t.Fatalf("attribution: %v %v", total, err)
	}
	got, _ = GetTask(ctx, s.db, "t1")
	if got.CostUSD != 1.0 {
		t.Fatalf("task cost: %v", got.CostUSD)
	}
}

func TestPruneEventsBefore(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	old := time.Now().AddDate(0, 0, -100).UnixMilli()
	recent := time.Now().UnixMilli()
	for i, ts := range []int64{old, old + 1, recent} {
		ev := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Key: fmt.Sprintf("k%d", i), Ts: time.UnixMilli(ts)}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	n, err := CountEvents(ctx, s.db)
	if err != nil || n != 3 {
		t.Fatalf("count: %d %v", n, err)
	}
	removed, err := PruneEventsBefore(ctx, s.db, time.Now().AddDate(0, 0, -50).UnixMilli())
	if err != nil || removed != 2 {
		t.Fatalf("pruned: %d %v", removed, err)
	}
	if n, _ := CountEvents(ctx, s.db); n != 1 {
		t.Fatalf("remaining: %d", n)
	}
}

func TestRateLimitSnapshotsAndPace(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	const reset = int64(1_900_000_000)

	// One snapshot: latest is set, but no pace yet (needs ≥2 same-window samples).
	base := int64(1_000_000)
	_ = RecordRateLimit(ctx, s.db, RateLimitSnapshot{Window: "five_hour", Ts: base, UsedPercentage: 20, ResetsAt: reset}, "s1")
	got, ok, err := LatestRateLimit(ctx, s.db, "five_hour")
	if err != nil || !ok || got.UsedPercentage != 20 || got.ResetsAt != reset {
		t.Fatalf("latest: %+v ok=%v err=%v", got, ok, err)
	}
	if _, ok, _ := RateLimitPace(ctx, s.db, "five_hour", reset); ok {
		t.Fatal("pace reported from a single sample")
	}

	// A second, later, higher sample (>60s apart, rising) → honest positive slope.
	_ = RecordRateLimit(ctx, s.db, RateLimitSnapshot{Window: "five_hour", Ts: base + 120_000, UsedPercentage: 24, ResetsAt: reset}, "s1")
	pace, ok, err := RateLimitPace(ctx, s.db, "five_hour", reset)
	if err != nil || !ok {
		t.Fatalf("pace: ok=%v err=%v", ok, err)
	}
	// +4 points over 120s = 4 / (120/3600) h = 120 pct/hour.
	if pace < 119 || pace > 121 {
		t.Fatalf("pace = %v pct/hour, want ~120", pace)
	}

	// A window with a FLAT slope must not produce a pace (no false forecast).
	_ = RecordRateLimit(ctx, s.db, RateLimitSnapshot{Window: "seven_day", Ts: base, UsedPercentage: 50, ResetsAt: reset}, "s1")
	_ = RecordRateLimit(ctx, s.db, RateLimitSnapshot{Window: "seven_day", Ts: base + 120_000, UsedPercentage: 50, ResetsAt: reset}, "s1")
	if _, ok, _ := RateLimitPace(ctx, s.db, "seven_day", reset); ok {
		t.Fatal("pace reported for a flat (non-rising) usage window")
	}

	// Samples across a reset boundary (different resets_at) do not form a slope.
	if _, ok, _ := RateLimitPace(ctx, s.db, "five_hour", reset+1); ok {
		t.Fatal("pace computed across a reset boundary")
	}

	// A DECLINING window (usage dropping) must not forecast — only a rising slope
	// can hit a limit. reset+2 isolates this window's history.
	_ = RecordRateLimit(ctx, s.db, RateLimitSnapshot{Window: "five_hour", Ts: base, UsedPercentage: 40, ResetsAt: reset + 2}, "s1")
	_ = RecordRateLimit(ctx, s.db, RateLimitSnapshot{Window: "five_hour", Ts: base + 120_000, UsedPercentage: 30, ResetsAt: reset + 2}, "s1")
	if _, ok, _ := RateLimitPace(ctx, s.db, "five_hour", reset+2); ok {
		t.Fatal("pace reported for a declining window")
	}

	// Two rising samples less than 60s apart are too close to trust — no forecast.
	_ = RecordRateLimit(ctx, s.db, RateLimitSnapshot{Window: "seven_day", Ts: base, UsedPercentage: 10, ResetsAt: reset + 3}, "s1")
	_ = RecordRateLimit(ctx, s.db, RateLimitSnapshot{Window: "seven_day", Ts: base + 45_000, UsedPercentage: 18, ResetsAt: reset + 3}, "s1")
	if _, ok, _ := RateLimitPace(ctx, s.db, "seven_day", reset+3); ok {
		t.Fatal("pace reported from samples <60s apart")
	}
}

// Notes are the "what did Claude actually say" queries. Two things must hold or
// the feature misleads: subagent chatter must never be presented as the main
// thread's words (45% of assistant turns are sidechains), and a mid-thought
// aside must be distinguishable from a real conclusion.
func TestSessionNotes(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	summary := strings.Repeat("Here is what changed and what I still need. ", 12)

	rows := []struct {
		key, text, agentID string
		sidechain          bool
	}{
		{"a", summary, "", false},
		{"b", "Let me check that.", "", false},                         // fragment
		{"c", "subagent conclusions here " + summary, "agent-1", true}, // must not surface
		{"d", "", "", false},                                           // pure tool_use turn
	}
	for _, r := range rows {
		payload, _ := json.Marshal(map[string]any{"text": r.text, "sidechain": r.sidechain})
		ev := &event.Event{
			SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Model: "claude-opus-5", Ts: time.UnixMilli(1000), Key: r.key,
			AgentID: r.agentID, Payload: payload,
		}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	_ = UpsertSession(ctx, s.db, "s1", SessionPatch{Project: "demo"})

	notes, err := SessionNotes(ctx, s.db, "s1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 2 {
		t.Fatalf("got %d notes, want 2 (sidechain and empty excluded): %+v", len(notes), notes)
	}
	for _, n := range notes {
		if strings.Contains(n.Text, "subagent") {
			t.Fatal("a sidechain note leaked into the main thread")
		}
		if n.Project != "demo" {
			t.Fatalf("project not joined: %+v", n)
		}
	}
	// Newest first: the fragment was inserted after the summary.
	if !notes[0].Fragment {
		t.Fatalf("short aside should be marked a fragment: %+v", notes[0])
	}
	if notes[1].Fragment {
		t.Fatalf("a full summary must not be marked a fragment: %d runes", len([]rune(notes[1].Text)))
	}
}

func TestSearchNotes(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	texts := []string{
		"The SSO header resolves to user_id, and the suffix is applied after.",
		"Deployed. All tests green, ruff clean.",
		"A discount of 100% would be free, and file_name matched.",
	}
	for i, txt := range texts {
		payload, _ := json.Marshal(map[string]any{"text": txt, "sidechain": false})
		ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Ts: time.UnixMilli(int64(1000 + i)), Key: fmt.Sprintf("k%d", i), Payload: payload}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	_ = UpsertSession(ctx, s.db, "s1", SessionPatch{Project: "demo"})

	got, err := SearchNotes(ctx, s.db, "SSO", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !strings.Contains(got[0].Text, "SSO header") {
		t.Fatalf("search for SSO returned %+v", got)
	}

	// Wildcards a user types must be literal, not LIKE syntax.
	if got, _ = SearchNotes(ctx, s.db, "100%", 0, 0); len(got) != 1 {
		t.Fatalf("literal %% search returned %d rows, want 1", len(got))
	}
	if got, _ = SearchNotes(ctx, s.db, "file_name", 0, 0); len(got) != 1 {
		t.Fatalf("literal _ search returned %d rows, want 1", len(got))
	}
	// An underscore as a wildcard would also match "file-name"; it must not.
	if got, _ = SearchNotes(ctx, s.db, "fileXname", 0, 0); len(got) != 0 {
		t.Fatalf("underscore behaved as a wildcard: %+v", got)
	}
	// Empty query returns recent notes rather than nothing.
	if got, _ = SearchNotes(ctx, s.db, "  ", 0, 0); len(got) != 3 {
		t.Fatalf("empty query returned %d rows, want 3", len(got))
	}
}

// files_touched sat in a row of range-filtered stats but ignored the range.
//
// Two attempts at this. The first counted every session's *lifetime* total if
// the session had said anything in the window — so a fortnight-long session
// that touched 300 files put all 300 into "today" the moment it spoke today.
// Measured on the owner's database, seven days read 417 against a true 144.
//
// The fix is the other table: `session_files` stamps each path with the first
// time it was touched, so the ranged answer counts *files*, not sessions. This
// test therefore writes through `TouchFile`, the real path, rather than
// inserting a total directly — which is how the first version passed while the
// screen was wrong.
func TestHistoryCountsFilesTouchedInTheWindowNotSessionLifetimes(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	old := now.Add(-90 * 24 * time.Hour)

	// One long-running session: two files touched long ago, one today. Its
	// lifetime total is three; today's honest answer is one.
	for _, f := range []struct {
		path string
		ts   time.Time
	}{
		{"/repo/old-a.go", old},
		{"/repo/old-b.go", old},
		{"/repo/today.go", now},
	} {
		if _, err := TouchFile(ctx, s.db, "long-runner", f.path, f.ts.UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	// The session itself is active now, which is what made the old query
	// count all three.
	if err := UpsertSession(ctx, s.db, "long-runner", SessionPatch{LastEventAt: now.UnixMilli()}); err != nil {
		t.Fatal(err)
	}

	recent, err := History(ctx, s.db, now.Add(-24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if recent.FilesTouched != 1 {
		t.Fatalf("files touched in the last day = %d, want 1 — the two 90-day-old files belong to the same session, not to today", recent.FilesTouched)
	}

	all, err := History(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if all.FilesTouched != 3 {
		t.Fatalf("files touched all time = %d, want 3", all.FilesTouched)
	}
}

// History sums per-kind counts from a GROUP BY rather than CASE expressions,
// so this pins that the totals still land in the right fields — an easy thing
// to break when optimising, and one that would silently show wrong numbers.
func TestHistoryCountsByKind(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	cost := 0.25
	rows := []struct {
		kind event.Kind
		n    int
	}{
		{event.KindTurnAssistant, 3},
		{event.KindToolPre, 5},
		{event.KindToolPost, 4}, // counted in neither total, but priced at zero
	}
	for _, r := range rows {
		for i := 0; i < r.n; i++ {
			ev := &event.Event{
				SessionID: "s1", Source: event.SourceTranscript, Kind: r.kind,
				Ts: time.UnixMilli(1000), Key: fmt.Sprintf("%s-%d", r.kind, i),
			}
			if r.kind == event.KindTurnAssistant {
				ev.CostUSD = &cost
			}
			if _, err := InsertEvent(ctx, s.db, ev); err != nil {
				t.Fatal(err)
			}
		}
	}
	_ = UpsertSession(ctx, s.db, "s1", SessionPatch{})

	h, err := History(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if h.Turns != 3 {
		t.Errorf("turns = %d, want 3", h.Turns)
	}
	if h.ToolCalls != 5 {
		t.Errorf("tool calls = %d, want 5 (tool.post must not count)", h.ToolCalls)
	}
	if h.CostUSD < 0.74 || h.CostUSD > 0.76 {
		t.Errorf("cost = %v, want ~0.75", h.CostUSD)
	}
}

// People remember their own question far better than Claude's phrasing of the
// answer, so searching only the reply misses how memory actually works.
func TestSearchNotesMatchesThePrompt(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	add := func(kind event.Kind, key, field, text string) {
		payload, _ := json.Marshal(map[string]any{field: text, "sidechain": false})
		ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: kind,
			Ts: time.UnixMilli(1000), Key: key, Payload: payload}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	// The question mentions SSO; the answer never does.
	add(event.KindTurnUser, "u1", "prompt", "why does the SSO header resolve that way?")
	add(event.KindTurnAssistant, "a1", "text", "Because the room set is checked before the body, and the suffix is applied after.")
	// An unrelated pair, to prove the match is not session-wide.
	add(event.KindTurnUser, "u2", "prompt", "run the tests")
	add(event.KindTurnAssistant, "a2", "text", "All green.")
	_ = UpsertSession(ctx, s.db, "s1", SessionPatch{Project: "demo"})

	got, err := SearchNotes(ctx, s.db, "SSO", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("searching the prompt returned %d notes, want 1: %+v", len(got), got)
	}
	if !strings.Contains(got[0].Text, "room set") {
		t.Fatalf("returned the wrong note: %q", got[0].Text)
	}

	// Matching the answer's own words still works.
	if got, _ = SearchNotes(ctx, s.db, "room set", 0, 0); len(got) != 1 {
		t.Fatalf("searching the answer returned %d notes, want 1", len(got))
	}
	// A word in neither matches nothing.
	if got, _ = SearchNotes(ctx, s.db, "kubernetes", 0, 0); len(got) != 0 {
		t.Fatalf("unrelated term returned %d notes", len(got))
	}
}

// Every /v1/stats/summary computes the model mix, and the Cost screen asks for
// one on an interval. idx_events_cost_cover carries model but leads on kind,
// so a query filtering only on ts cannot use it — SQLite grouped in a temp
// B-tree and read the table for model and cost on every matching row: 146ms
// against 56ms over 30 days on a real 190k-event database.
//
// This asserts the index exists and leads on ts, not that the planner picks
// it. Which plan wins is a function of table size, so asserting a plan on a
// small fixture would encode the fixture rather than the property.
func TestModelMixIndexLeadsOnTs(t *testing.T) {
	s := openTest(t)
	var sql string
	err := s.db.QueryRowContext(context.Background(),
		`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_ts_model'`).Scan(&sql)
	if err != nil {
		t.Fatalf("idx_events_ts_model is missing; the model mix in every summary falls back to a table read per row: %v", err)
	}
	// Leading on ts is the whole point — that is what idx_events_cost_cover,
	// which leads on kind, cannot do for a ts-only filter.
	if !strings.Contains(strings.ReplaceAll(sql, " ", ""), "(ts,model,cost_usd)") {
		t.Errorf("index must lead on ts and carry cost_usd to answer the aggregate, got: %s", sql)
	}
}

// One directory is one project, even when only some of its sessions knew they
// were in a repository.
//
// Claude Code reports repo_root only when it resolves a checkout, so running
// once inside a repo and once where git could not answer produced two rows for
// the same directory — and the rootless one was labelled with its full
// filesystem path, since a label is derived from the path when there is no
// project name. It looked like a second project nobody had.
func TestSummarizeJoinsRootlessSessionsToTheirRepository(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	cost := 0.01
	const dir = "/Users/dev/dev/acme-web"
	for i, sid := range []string{"rooted", "rootless"} {
		ev := &event.Event{SessionID: sid, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Model: "claude-opus-5", Ts: time.UnixMilli(2000),
			Tokens: &event.TokenDelta{In: 1, Out: 1}, CostUSD: &cost}
		ev.Key = fmt.Sprintf("%s-%d", sid, i)
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	// The same directory, reported two ways — which is exactly what happens
	// when one session starts in the checkout and another in a path git does
	// not resolve. repo_root is derived from cwd by SessionPatch, so the
	// rootless form is written directly: that is the state on disk, and it is
	// the state the roll-up has to cope with.
	_ = UpsertSession(ctx, s.db, "rooted", SessionPatch{Cwd: dir})
	if _, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET project='acme-web', repo_root=?, repo_path='' WHERE session_id='rooted'`, dir); err != nil {
		t.Fatal(err)
	}
	_ = UpsertSession(ctx, s.db, "rootless", SessionPatch{Cwd: dir})
	if _, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET project='', repo_root='', repo_path='' WHERE session_id='rootless'`); err != nil {
		t.Fatal(err)
	}

	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 1 {
		labels := make([]string, 0, len(sum.Projects))
		for _, p := range sum.Projects {
			labels = append(labels, p.Project)
		}
		t.Fatalf("one directory produced %d projects: %v", len(sum.Projects), labels)
	}
	if got := sum.Projects[0].Project; got != "acme-web" {
		t.Fatalf("project label = %q, want the repository name", got)
	}
	if got := sum.Projects[0].Sessions; got != 2 {
		t.Fatalf("sessions = %d, want both", got)
	}
}

// The unpriced warning must mean "money you cannot see", not "rows that
// happen to have no cost".
//
// A turn recorded with explicit zero tokens has nothing to price. Warning
// about it tells a user their total is missing money when it is missing
// nothing — the owner's own dashboard showed 38 such turns and a banner
// saying the total was incomplete. It was complete.
func TestUnpricedIgnoresTurnsWithNoTokens(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	zero := 0
	for i, tc := range []struct {
		model string
		in    *int
		out   *int
	}{
		{"ghost-model", &zero, &zero},             // nothing to price
		{"real-model", intPtr(1000), intPtr(500)}, // genuinely unpriced
	} {
		ev := &event.Event{
			SessionID: fmt.Sprintf("s%d", i), Source: event.SourceTranscript,
			Kind: event.KindTurnAssistant, Model: tc.model, Ts: time.UnixMilli(2000),
			Tokens: &event.TokenDelta{In: int64(*tc.in), Out: int64(*tc.out)},
		}
		ev.Key = fmt.Sprintf("k%d", i)
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}
	u, err := queryUnpriced(ctx, s.db, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if u == nil {
		t.Fatal("expected the genuinely unpriced model to be reported")
	}
	for _, m := range u.Models {
		if m == "ghost-model" {
			t.Errorf("warned about a turn with no tokens: %v", u.Models)
		}
	}
	if len(u.Models) != 1 || u.Models[0] != "real-model" {
		t.Errorf("models = %v, want just the one with tokens", u.Models)
	}
}

func intPtr(v int) *int { return &v }

// What a tool handed back is measured; what it cost in tokens is not.
//
// A tool spends no tokens — the turn that reads its output does — so any
// per-tool token figure could only be a turn's tokens divided between its
// calls, which looks measured and is not. The size of the response is the
// honest thing the call count cannot say: on one real machine Bash was called
// 22x more often than Read and handed back a quarter as much text.
func TestToolBytesAreMeasuredFromTheResponse(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	n := 0
	post := func(tool, response string) {
		t.Helper()
		n++
		payload := fmt.Sprintf(`{"tool_name":%q,"tool_response":%q}`, tool, response)
		if _, err := InsertEvent(ctx, s.DB(), &event.Event{
			Ts: time.Unix(1000, 0), SessionID: "s1", Source: event.SourceHook,
			Kind: event.KindToolPost, Tool: tool, Payload: json.RawMessage(payload),
			Key: fmt.Sprintf("post-%d", n),
		}); err != nil {
			t.Fatal(err)
		}
	}
	pre := func(tool, key string) {
		t.Helper()
		if _, err := InsertEvent(ctx, s.DB(), &event.Event{
			Ts: time.Unix(1000, 0), SessionID: "s1", Source: event.SourceHook,
			Kind: event.KindToolPre, Tool: tool, Payload: json.RawMessage(`{}`), Key: key,
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Read: called twice, hands back a lot. Bash: called four times, hands back
	// almost nothing. That inversion is the whole point of the column.
	big := strings.Repeat("x", 4000)
	pre("Read", "r1")
	pre("Read", "r2")
	post("Read", big)
	post("Read", big)
	for i := 0; i < 4; i++ {
		pre("Bash", fmt.Sprintf("b%d", i))
		post("Bash", fmt.Sprintf("ok%d", i))
	}

	got, err := ToolDistribution(ctx, s.DB(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]ToolCount{}
	for _, r := range got {
		by[r.Tool] = r
	}
	if by["Bash"].Count != 4 {
		t.Errorf("Bash calls = %d, want 4", by["Bash"].Count)
	}
	if by["Read"].Count != 2 {
		t.Errorf("Read calls = %d, want 2", by["Read"].Count)
	}
	// The inversion: fewer calls, far more returned.
	if by["Read"].Bytes <= by["Bash"].Bytes {
		t.Errorf("Read returned %d bytes and Bash %d — the column shows nothing the count does not",
			by["Read"].Bytes, by["Bash"].Bytes)
	}
	// Counted from tool.post only: counting the pre as well would double it.
	if by["Read"].Bytes < 8000 {
		t.Errorf("Read bytes = %d, want about 8000 for two 4000-byte responses", by["Read"].Bytes)
	}
}

func TestAToolCallWithNoResponseCountsZeroBytes(t *testing.T) {
	// A pre event, a payload without the field, a payload that is not JSON:
	// none of them is an error, and none of them should invent a size.
	ctx := context.Background()
	s := openTest(t)
	if _, err := InsertEvent(ctx, s.DB(), &event.Event{
		Ts: time.Unix(1000, 0), SessionID: "s1", Source: event.SourceHook,
		Kind: event.KindToolPre, Tool: "Bash", Payload: json.RawMessage(`{"tool_name":"Bash"}`), Key: "k1",
	}); err != nil {
		t.Fatal(err)
	}
	got, err := ToolDistribution(ctx, s.DB(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Bytes != 0 {
		t.Errorf("a call with no response reported %+v", got)
	}
}

// The unpriced warning belongs to the agent whose total it warns about.
//
// Unfiltered, it told someone looking at the OpenCode figures that tokens were
// missing from their total — tokens that were Claude's, and that were not in
// that total at all. A warning about the wrong money is worse than no warning:
// it sends the reader looking for a hole in a number that has none.
func TestUnpricedIsScopedToTheAgentAsked(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	for _, tc := range []struct{ session, agent, model string }{
		{"claude-1", "claude", "claude-ghost"},
		{"oc-1", "opencode", "opencode-ghost"},
	} {
		if err := UpsertSession(ctx, s.db, tc.session, SessionPatch{Agent: tc.agent}); err != nil {
			t.Fatal(err)
		}
		ev := &event.Event{
			SessionID: tc.session, Source: event.SourceTranscript,
			Kind: event.KindTurnAssistant, Model: tc.model, Ts: time.UnixMilli(2000),
			Tokens: &event.TokenDelta{In: 1000, Out: 500},
			Key:    "k-" + tc.session,
		}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}

	for _, tc := range []struct {
		name   string
		agent  AgentFilter
		models []string
	}{
		{"no filter sees both", "", []string{"claude-ghost", "opencode-ghost"}},
		{"opencode sees only its own", "opencode", []string{"opencode-ghost"}},
		{"claude sees only its own", "claude", []string{"claude-ghost"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u, err := queryUnpriced(ctx, s.db, 0, tc.agent)
			if err != nil {
				t.Fatal(err)
			}
			if u == nil {
				t.Fatalf("expected %v, got no warning at all", tc.models)
			}
			if len(u.Models) != len(tc.models) {
				t.Fatalf("models = %v, want %v", u.Models, tc.models)
			}
			for _, want := range tc.models {
				found := false
				for _, got := range u.Models {
					if got == want {
						found = true
					}
				}
				if !found {
					t.Errorf("models = %v, missing %q", u.Models, want)
				}
			}
		})
	}
}

// The handoff a returning session is given: the last substantial thing said in
// this repository, and nothing from the session now starting.
//
// Recency rather than retrieval, and that is a measured choice. Searching prior
// prose by the terms of the opening prompt answered 4 of 15 resumed sessions on
// the owner's database and missed the clearest case — "напомни что мы последний
// раз изучали" found nothing among 384 candidate passages, because an opening
// question shares no words with its own answer. Taking the last passage answers
// 12 of 19.
func TestWhereWeLeftOffHandsBackTheLastSubstantialTurn(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	base := time.Now().Add(-time.Hour)

	// Three sessions in one repository, plus one elsewhere.
	for _, tc := range []struct {
		id, project, text string
		at                time.Time
	}{
		{"old", "alpha", strings.Repeat("an early conclusion. ", 30), base},
		{"mid", "alpha", strings.Repeat("the thing we actually settled on. ", 30), base.Add(10 * time.Minute)},
		{"tiny", "alpha", "Done.", base.Add(20 * time.Minute)}, // too short to be a handoff
		{"other", "beta", strings.Repeat("a different repository entirely. ", 30), base.Add(30 * time.Minute)},
	} {
		if err := UpsertSession(ctx, s.db, tc.id, SessionPatch{Project: tc.project}); err != nil {
			t.Fatal(err)
		}
		ev := &event.Event{
			SessionID: tc.id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Key: "k-" + tc.id, Ts: tc.at,
			Payload: json.RawMessage(`{"text":` + strconvQuote(tc.text) + `}`),
		}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
	}

	got, err := WhereWeLeftOff(ctx, s.db, "alpha", base.Add(time.Hour).UnixMilli(), 400)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.Text, "actually settled on") {
		t.Fatalf("handed back %q — want the last substantial turn, not the one-liner after it", got.Text[:60])
	}

	// A session must never be handed its own output: `before` is what stops a
	// resume from quoting the very thing it is about to say again.
	earlier, err := WhereWeLeftOff(ctx, s.db, "alpha", base.Add(5*time.Minute).UnixMilli(), 400)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(earlier.Text, "an early conclusion") {
		t.Fatalf("ignored the time bound: got %q", earlier.Text[:60])
	}

	// Another repository's work is not this repository's handoff.
	if _, err := WhereWeLeftOff(ctx, s.db, "gamma", base.Add(time.Hour).UnixMilli(), 400); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("a repo with no history returned %v, want sql.ErrNoRows", err)
	}
}

// strconvQuote is json-safe quoting for the fixtures above.
func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
