package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

func TestProjectFromCwd(t *testing.T) {
	for in, want := range map[string]string{"/Users/x/dev/caprock": "caprock", `C:\Users\x\proj\`: "proj", "": "", "solo": "solo"} {
		if got := ProjectFromCwd(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
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

	got, err := SearchNotes(ctx, s.db, "SSO", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !strings.Contains(got[0].Text, "SSO header") {
		t.Fatalf("search for SSO returned %+v", got)
	}

	// Wildcards a user types must be literal, not LIKE syntax.
	if got, _ = SearchNotes(ctx, s.db, "100%", 0); len(got) != 1 {
		t.Fatalf("literal %% search returned %d rows, want 1", len(got))
	}
	if got, _ = SearchNotes(ctx, s.db, "file_name", 0); len(got) != 1 {
		t.Fatalf("literal _ search returned %d rows, want 1", len(got))
	}
	// An underscore as a wildcard would also match "file-name"; it must not.
	if got, _ = SearchNotes(ctx, s.db, "fileXname", 0); len(got) != 0 {
		t.Fatalf("underscore behaved as a wildcard: %+v", got)
	}
	// Empty query returns recent notes rather than nothing.
	if got, _ = SearchNotes(ctx, s.db, "  ", 0); len(got) != 3 {
		t.Fatalf("empty query returned %d rows, want 3", len(got))
	}
}

// files_touched sat in a row of range-filtered stats but ignored the range,
// so "today" reported the lifetime figure — the one number in that row that
// lied, which made the five correct ones beside it suspect too.
func TestHistoryFilesTouchedRespectsRange(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.UnixMilli(1_800_000_000_000)
	old := now.Add(-90 * 24 * time.Hour)

	for _, tc := range []struct {
		id    string
		ts    time.Time
		files int64
	}{
		{"recent", now, 3},
		{"ancient", old, 40},
	} {
		ev := &event.Event{SessionID: tc.id, Source: event.SourceHook, Kind: event.KindToolPre,
			Tool: "Edit", Ts: tc.ts, Key: tc.id + "-k"}
		if _, err := InsertEvent(ctx, s.db, ev); err != nil {
			t.Fatal(err)
		}
		if err := UpsertSession(ctx, s.db, tc.id, SessionPatch{LastEventAt: tc.ts.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO session_stats(session_id, files_touched) VALUES(?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET files_touched = excluded.files_touched`,
			tc.id, tc.files); err != nil {
			t.Fatal(err)
		}
	}

	recent, err := History(ctx, s.db, now.Add(-24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if recent.FilesTouched != 3 {
		t.Fatalf("recent range files_touched = %d, want 3 (the 90-day-old session must not count)", recent.FilesTouched)
	}
	all, err := History(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if all.FilesTouched != 43 {
		t.Fatalf("all-time files_touched = %d, want 43", all.FilesTouched)
	}
}
