package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/modelclass"
)

// partsFixture fills a database with every kind of row a summary reads:
// sessions of four agents in two repositories and a scratch folder, priced,
// unpriced and internal turns, tool calls with and without a message id or
// a file, Cursor's usage records and request counts, Hermes's cost basis,
// spread over ten days.
type partsFixture struct {
	t    *testing.T
	s    *Store
	rng  *rand.Rand
	now  time.Time
	dirs []string
	seq  int
}

func newPartsFixture(t *testing.T) *partsFixture {
	t.Helper()
	s := openTest(t)
	base := t.TempDir()
	var dirs []string
	for _, name := range []string{"alpha", "beta"} {
		d := filepath.Join(base, name)
		if err := os.MkdirAll(filepath.Join(d, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, d)
	}
	dirs = append(dirs, filepath.Join(base, "scratch"))
	now := time.Date(2026, 11, 20, 15, 30, 0, 0, time.UTC)
	prev := nowMs
	nowMs = now.UnixMilli
	t.Cleanup(func() { nowMs = prev })
	return &partsFixture{t: t, s: s, rng: rand.New(rand.NewPCG(5, 9)), now: now, dirs: dirs}
}

func (f *partsFixture) insert(ev *event.Event) {
	f.t.Helper()
	f.seq++
	if ev.Key == "" {
		ev.Key = fmt.Sprintf("k%d", f.seq)
	}
	if _, err := InsertEvent(context.Background(), f.s.DB(), ev); err != nil {
		f.t.Fatal(err)
	}
}

// session writes one session of n turns of the given agent, starting at at.
func (f *partsFixture) session(id, agent string, dir int, at time.Time, n int) {
	f.t.Helper()
	if err := UpsertSession(context.Background(), f.s.DB(), id, SessionPatch{Cwd: f.dirs[dir], Agent: agent, Model: "claude-opus-5",
		StartedAt: at.UnixMilli(), LastEventAt: at.Add(time.Duration(n) * time.Minute).UnixMilli()}); err != nil {
		f.t.Fatal(err)
	}
	for i := range n {
		f.turn(id, agent, dir, at.Add(time.Duration(i)*time.Minute))
	}
}

// turn writes one turn of a session and its tool calls.
func (f *partsFixture) turn(id, agent string, dir int, ts time.Time) {
	f.t.Helper()
	r := f.rng
	f.seq++
	msg := fmt.Sprintf("m%d", f.seq)
	model := []string{"claude-opus-5", "claude-sonnet-5", "mystery-model"}[r.IntN(3)]
	var cost *float64
	if model != "mystery-model" {
		c := 0.01 + r.Float64()
		cost = &c
	}
	source, payload, key := event.SourceTranscript, `{"text":"hi"}`, "msg:"+msg
	switch agent {
	case "cursor":
		source = event.SourceCursor
		payload = fmt.Sprintf(`{"requests":%d}`, 1+r.IntN(4))
		if r.IntN(3) == 0 {
			key = "cu-usage:" + msg
		}
	case "hermes":
		source = event.SourceHermes
		payload = fmt.Sprintf(`{"cost_basis":%q,"hermes_source":%q,"background":%d}`,
			[]string{"actual", "included", "estimated"}[r.IntN(3)], []string{"cli", "cron"}[r.IntN(2)], r.IntN(2))
	}
	if r.IntN(12) == 0 {
		model, cost = modelclass.CodexAutoReview, nil
	}
	ev := &event.Event{SessionID: id, Source: source, Kind: event.KindTurnAssistant, Model: model, MsgID: msg, Key: key,
		Ts: ts, Payload: json.RawMessage(payload), CostUSD: cost,
		Tokens: &event.TokenDelta{In: int64(r.IntN(30)), Out: int64(r.IntN(900)), CacheRead: int64(r.IntN(9000)), CacheWrite: int64(r.IntN(500))}}
	if r.IntN(10) == 0 {
		ev.AgentID = "sub1"
	}
	f.insert(ev)
	for c := range r.IntN(4) {
		tool := []string{"Read", "Edit", "Bash", "Grep", "WebFetch", "mcp__x__y"}[r.IntN(6)]
		input := map[string]any{"command": "ls"}
		if tool == "Read" || tool == "Edit" {
			sub := []string{"api", "ui/src", "docs"}[r.IntN(3)]
			if r.IntN(5) == 0 {
				input = map[string]any{"file_path": "/elsewhere/notes.md"}
			} else {
				input = map[string]any{"file_path": filepath.Join(f.dirs[dir], sub, "f.go")}
			}
		}
		use := fmt.Sprintf("toolu_%s_%d", msg, c)
		m := msg
		if r.IntN(15) == 0 {
			m = ""
		}
		pre, _ := json.Marshal(map[string]any{"tool_name": tool, "tool_input": input, "tool_use_id": use})
		f.insert(&event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: tool, MsgID: m,
			Key: "pre:" + use, Ts: ts.Add(time.Second), Payload: pre})
		post, _ := json.Marshal(map[string]any{"tool_name": tool, "tool_use_id": use, "tool_response": strings.Repeat("y", r.IntN(500))})
		f.insert(&event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindToolPost, Tool: tool,
			Key: "post:" + use, Ts: ts.Add(2 * time.Second), Payload: post})
	}
	if r.IntN(4) == 0 {
		f.insert(&event.Event{SessionID: id, Source: event.SourceHook, Kind: event.KindTurnUser, Ts: ts.Add(-time.Second),
			Payload: json.RawMessage(`{"prompt":"go"}`)})
	}
}

func (f *partsFixture) fill() {
	agents := []string{"claude", "claude", "codex", "cursor", "hermes"}
	for i := range 14 {
		at := f.now.Add(-time.Duration(f.rng.IntN(10*24)) * time.Hour)
		f.session(fmt.Sprintf("s%02d", i), agents[i%len(agents)], i%3, at, 3+f.rng.IntN(12))
	}
	// Today's sessions, one still going.
	f.session("today-a", "claude", 0, f.now.Add(-3*time.Hour), 8)
	f.session("today-b", "codex", 1, f.now.Add(-50*time.Minute), 5)
}

// partsRanges are the ranges and grids every comparison runs over: all
// time, a week by day, a day by hour starting at midnight, and today.
func (f *partsFixture) partsRanges() []struct {
	from  int64
	spark SparkSpec
} {
	day := int64(24 * time.Hour / time.Millisecond)
	midnight := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	week := midnight - 6*day
	return []struct {
		from  int64
		spark SparkSpec
	}{
		{0, SparkSpec{}},
		{week, SparkSpec{Buckets: 7, WidthMs: day, FromMs: week}},
		{week, SparkSpec{}},
		{midnight, SparkSpec{Buckets: 24, WidthMs: 3600000, FromMs: midnight}},
		{midnight - 3*day, SparkSpec{Buckets: 4, WidthMs: day, FromMs: midnight - 3*day}},
	}
}

var partsAgents = []AgentFilter{"", "claude", "codex", "cursor", "hermes", "opencode"}

// sameSummary compares two answers figure by figure: every number within a
// part in a billion (the sums are added in another order), everything else
// exactly.
func sameSummary(t *testing.T, label string, want, got any) {
	t.Helper()
	wb, _ := json.Marshal(want)
	gb, _ := json.Marshal(got)
	var w, g any
	_ = json.Unmarshal(wb, &w)
	_ = json.Unmarshal(gb, &g)
	if diff := compareJSON("", w, g); diff != "" {
		t.Fatalf("%s: %s\nwant %s\ngot  %s", label, diff, wb, gb)
	}
}

func compareJSON(path string, w, g any) string {
	switch wv := w.(type) {
	case float64:
		gv, ok := g.(float64)
		if !ok {
			return fmt.Sprintf("%s: %v vs %v", path, w, g)
		}
		if math.Abs(wv-gv) > 1e-9*math.Max(1, math.Abs(wv)) {
			return fmt.Sprintf("%s: %v vs %v", path, wv, gv)
		}
		return ""
	case map[string]any:
		gv, ok := g.(map[string]any)
		if !ok || len(gv) != len(wv) {
			return fmt.Sprintf("%s: %v vs %v", path, w, g)
		}
		for k := range wv {
			if d := compareJSON(path+"."+k, wv[k], gv[k]); d != "" {
				return d
			}
		}
		return ""
	case []any:
		gv, ok := g.([]any)
		if !ok || len(gv) != len(wv) {
			return fmt.Sprintf("%s: %d items vs %v", path, len(wv), g)
		}
		for i := range wv {
			if d := compareJSON(fmt.Sprintf("%s[%d]", path, i), wv[i], gv[i]); d != "" {
				return d
			}
		}
		return ""
	}
	if !reflect.DeepEqual(w, g) {
		return fmt.Sprintf("%s: %v vs %v", path, w, g)
	}
	return ""
}

// The summary built from per-session parts is the one the per-range
// queries counted, figure by figure, for every range, grid and agent filter;
// and the kept parts give the same answer as parts read afresh.
func TestPartsSummaryMatchesTheRangeQueries(t *testing.T) {
	f := newPartsFixture(t)
	f.fill()
	ctx := context.Background()
	db := f.s.DB()
	cache := NewPartsCache()
	for _, r := range f.partsRanges() {
		for _, agent := range partsAgents {
			label := fmt.Sprintf("from %d spark %+v agent %q", r.from, r.spark, agent)
			want, err := legacySummarizeSparkFor(ctx, db, r.from, r.spark, agent)
			if err != nil {
				t.Fatal(err)
			}
			got, err := SummarizeSparkFor(ctx, db, r.from, r.spark, agent)
			if err != nil {
				t.Fatal(err)
			}
			sameSummary(t, label+" (fresh)", want, got)
			kept, parts, err := cache.Summary(ctx, db, r.from, r.spark, agent)
			if err != nil {
				t.Fatal(err)
			}
			sameSummary(t, label+" (kept)", want, kept)
			wantParts, err := SpendPartsBetween(ctx, db, r.from, 0, agent)
			if err != nil {
				t.Fatal(err)
			}
			sameSummary(t, label+" (cost parts)", wantParts, parts)
		}
		wantTools, err := ToolDistribution(ctx, db, r.from, 40)
		if err != nil {
			t.Fatal(err)
		}
		tools, err := cache.Tools(ctx, db, r.from, 40)
		if err != nil {
			t.Fatal(err)
		}
		// SQL leaves tools with the same count in no particular order; the
		// parts order them by name.
		sort.SliceStable(wantTools, func(i, j int) bool {
			return wantTools[i].Count > wantTools[j].Count || (wantTools[i].Count == wantTools[j].Count && wantTools[i].Tool < wantTools[j].Tool)
		})
		sameSummary(t, fmt.Sprintf("tools from %d", r.from), wantTools, tools)
	}
	if want, _ := legacySummarizeSparkFor(ctx, db, 0, SparkSpec{}, ""); want.Turns == 0 || len(want.Projects) < 2 || want.Cursor == nil ||
		want.Hermes == nil || want.Unpriced == nil || want.Background == nil || len(want.Work) < 3 {
		t.Fatalf("the fixture must exercise every figure: %+v", want)
	}
}

// Every change to the events shows at once in a kept summary — a new turn,
// a new session, a repriced or relinked row, a removed session, rows with no
// session — and only the sessions that moved are read again; with nothing
// moved, nothing but the mark is read.
func TestPartsCacheReadsOnlyWhatMoved(t *testing.T) {
	f := newPartsFixture(t)
	f.fill()
	ctx := context.Background()
	db := f.s.DB()
	cache := NewPartsCache()
	day := int64(24 * time.Hour / time.Millisecond)
	week := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC).UnixMilli()
	spark := SparkSpec{Buckets: 7, WidthMs: day, FromMs: week}
	check := func(step string, wantFull, wantPartial int) {
		t.Helper()
		for _, r := range []struct {
			from  int64
			spark SparkSpec
		}{{0, SparkSpec{}}, {week, spark}} {
			want, err := legacySummarizeSparkFor(ctx, db, r.from, r.spark, "")
			if err != nil {
				t.Fatal(err)
			}
			got, _, err := cache.Summary(ctx, db, r.from, r.spark, "")
			if err != nil {
				t.Fatal(err)
			}
			sameSummary(t, step, want, got)
			kp := cache.ranges[r.from]
			if kp.full != wantFull || kp.partial != wantPartial {
				t.Fatalf("%s, from %d: %d full and %d partial reads, want %d and %d", step, r.from, kp.full, kp.partial, wantFull, wantPartial)
			}
		}
	}
	check("first read", 1, 0)

	// Nothing moved: the mark is read, no event.
	rec := &planRecorder{Querier: db}
	if _, _, err := cache.Summary(ctx, rec, 0, SparkSpec{}, ""); err != nil {
		t.Fatal(err)
	}
	for _, r := range rec.seen {
		if strings.Contains(r.sql, "FROM events INDEXED BY idx_events_attr_work") || strings.Contains(r.sql, "JOIN events") {
			t.Fatalf("nothing moved, yet events were read: %s", r.sql)
		}
	}
	check("nothing moved", 1, 0)

	f.turn("s03", "cursor", 0, f.now.Add(-time.Minute))
	rec = &planRecorder{Querier: db}
	if _, _, err := cache.Summary(ctx, rec, 0, SparkSpec{}, ""); err != nil {
		t.Fatal(err)
	}
	var scans int
	for _, r := range rec.seen {
		if strings.Contains(r.sql, "INDEXED BY idx_events_attr_work") && !strings.Contains(r.sql, "IS NULL") {
			scans++
			if len(r.args) == 0 || r.args[0] != `[4]` {
				t.Fatalf("a new turn in one session read %v, want that session alone", r.args)
			}
			if plan := explainPlan(t, f.s, r); !strings.Contains(plan, "USING COVERING INDEX idx_events_attr_work") {
				t.Fatalf("the session's rows must be read from the index alone: %s", plan)
			}
		}
	}
	if scans != 1 {
		t.Fatalf("%d scans of moved sessions, want 1", scans)
	}
	check("a new turn", 1, 1)

	f.session("new-one", "claude", 1, f.now.Add(-30*time.Minute), 3)
	check("a new session", 1, 2)

	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`UPDATE events SET cost_usd = cost_usd * 3 WHERE id = (SELECT MAX(id) FROM events WHERE kind = 'turn.assistant' AND sid = (SELECT sid FROM sessions WHERE session_id = 's01'))`)
	check("a repriced turn", 1, 3)
	exec(`UPDATE events SET msg_id = NULL WHERE kind = 'tool.pre' AND sid = (SELECT sid FROM sessions WHERE session_id = 's05')`)
	check("unlinked tool calls", 1, 4)
	if _, err := RemoveSession(ctx, db, RemovalCandidate{SessionID: "s07"}, time.UTC, nowMs()); err != nil {
		t.Fatal(err)
	}
	check("a removed session (its row is gone, so the whole range)", 2, 4)
	// A transcript line read late, older than everything in its session.
	f.turn("s02", "codex", 2, f.now.Add(-9*24*time.Hour))
	check("a turn read late", 2, 5)
	exec(`INSERT OR REPLACE INTO meta(k, v) VALUES('events_moved', '7')`)
	check("rows moved in from the legacy table", 3, 5)
}

// A range nobody asks for is dropped once it has been idle, and a range in
// use is kept.
func TestPartsCacheDropsIdleRanges(t *testing.T) {
	f := newPartsFixture(t)
	f.fill()
	ctx := context.Background()
	cache := NewPartsCache()
	at := f.now
	cache.now = func() time.Time { return at }
	if _, err := cache.Tools(ctx, f.s.DB(), 0, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Tools(ctx, f.s.DB(), 5, 10); err != nil {
		t.Fatal(err)
	}
	at = at.Add(partsIdle + time.Minute)
	if _, err := cache.Tools(ctx, f.s.DB(), 0, 10); err != nil {
		t.Fatal(err)
	}
	if _, ok := cache.ranges[5]; ok || len(cache.ranges) != 1 {
		t.Fatalf("an idle range must go and the asked one stay: %d kept", len(cache.ranges))
	}
}
