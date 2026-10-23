package store

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// Reads land on the local day they finished, every day of the window is
// there even when nothing was read, and a skipped session costs nothing and
// is not counted as a read.
func TestBrainSpendBucketsByLocalDay(t *testing.T) {
	loc := time.FixedZone("UTC+3", 3*3600)
	now := time.Date(2026, 10, 22, 9, 30, 0, 0, loc)
	at := func(d, h int) int64 { return time.Date(2026, 10, d, h, 0, 0, 0, loc).UnixMilli() }
	runs := []BrainSpendRow{
		{FinishedAt: at(8, 23), Tokens: 999, Read: true}, // the day before the window
		{FinishedAt: at(9, 0), Tokens: 100, CostUSD: 0.01, Read: true},
		{FinishedAt: at(9, 23), Tokens: 50, Read: true},
		{FinishedAt: at(20, 12), Tokens: 7, Read: false},
		{FinishedAt: at(22, 0), Tokens: 300, CostUSD: 0.03, Read: true},
		{FinishedAt: at(23, 0), Tokens: 999, Read: true}, // tomorrow
	}
	days := BucketBrainDays(runs, now, 14)
	if len(days) != 14 || days[0].Day != "2026-10-09" || days[13].Day != "2026-10-22" {
		t.Fatalf("days: %d, %s … %s", len(days), days[0].Day, days[len(days)-1].Day)
	}
	if days[0].Start != at(9, 0) {
		t.Errorf("the first day starts at local midnight: %d", days[0].Start)
	}
	if d := days[0]; d.Tokens != 150 || d.Reads != 2 || d.CostUSD != 0.01 {
		t.Errorf("9 Oct: %+v", d)
	}
	if d := days[11]; d.Day != "2026-10-20" || d.Tokens != 7 || d.Reads != 0 {
		t.Errorf("a skipped session spends what it spent and is no read: %+v", d)
	}
	if d := days[13]; d.Tokens != 300 || d.Reads != 1 {
		t.Errorf("today: %+v", d)
	}
	var sum int64
	for _, d := range days {
		sum += d.Tokens
	}
	if sum != 457 {
		t.Errorf("rows outside the window counted: %d", sum)
	}
	if len(BucketBrainDays(nil, now, 0)) != 0 {
		t.Error("no days, no buckets")
	}
}

// A day with a clock change is that day, 23 hours long, not a drift that
// moves every later read onto the wrong date.
func TestBrainSpendDaysFollowTheCalendarAcrossAClockChange(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skip("no zone database")
	}
	now := time.Date(2026, 3, 30, 12, 0, 0, 0, loc)
	runs := []BrainSpendRow{
		{FinishedAt: time.Date(2026, 3, 29, 23, 30, 0, 0, loc).UnixMilli(), Tokens: 1, Read: true},
		{FinishedAt: time.Date(2026, 3, 30, 0, 30, 0, 0, loc).UnixMilli(), Tokens: 2, Read: true},
	}
	days := BucketBrainDays(runs, now, 3)
	if days[1].Day != "2026-03-29" || days[1].Tokens != 1 || days[2].Tokens != 2 {
		t.Fatalf("days: %+v", days)
	}
}

// Each day says whose its tokens were, keyed as the window's projects are:
// most first, a tie by name with the re-tag batches after the projects, no
// entry for a run that spent nothing, and together they make the day.
func TestBrainSpendDaysSplitByProject(t *testing.T) {
	loc := time.FixedZone("UTC", 0)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, loc)
	at := func(d, h int) int64 { return time.Date(2026, 10, d, h, 0, 0, 0, loc).UnixMilli() }
	runs := []BrainSpendRow{
		{FinishedAt: at(21, 1), Tokens: 100, Read: true, Project: "web"},
		{FinishedAt: at(21, 2), Tokens: 300, Read: true, Project: "acme"},
		{FinishedAt: at(21, 3), Tokens: 50, Read: true, Project: "web"},
		{FinishedAt: at(21, 4), Tokens: 150, Read: true, Retag: true},
		{FinishedAt: at(21, 5), Tokens: 150, Read: true, Project: ""},
		{FinishedAt: at(21, 6), Tokens: 0, Read: false, Project: "quiet"},
		{FinishedAt: at(22, 1), Tokens: 7, Read: true, Project: "acme"},
	}
	days := BucketBrainDays(runs, now, 3)
	if len(days[0].Projects) != 0 || days[0].Projects == nil {
		t.Errorf("a day with nothing read has an empty list, not null: %#v", days[0].Projects)
	}
	want := []BrainDayProject{{Project: "acme", Tokens: 300}, {Project: "", Tokens: 150}, {Project: "web", Tokens: 150}, {Retag: true, Tokens: 150}}
	if !slices.Equal(days[1].Projects, want) {
		t.Errorf("21 Oct: %+v, want %+v", days[1].Projects, want)
	}
	var sum int64
	for _, p := range days[1].Projects {
		sum += p.Tokens
	}
	if sum != days[1].Tokens {
		t.Errorf("the parts make %d of %d", sum, days[1].Tokens)
	}
	if !slices.Equal(days[2].Projects, []BrainDayProject{{Project: "acme", Tokens: 7}}) {
		t.Errorf("today: %+v", days[2].Projects)
	}
}

// Per project through the read session; a run whose session is gone is
// "", memories count only from reads that went through, and a project
// with nothing but skipped sessions is not listed.
func TestBrainSpendByProjectJoinsTheSession(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for id, p := range map[string]string{"a1": "acme-api", "a2": "acme-api", "w1": "web", "q1": "quiet"} {
		if err := UpsertSession(ctx, s.db, id, SessionPatch{Project: p, LastEventAt: 1, StartedAt: 1, FromHook: true}); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range []BrainRun{
		{SessionID: "a1", Status: BrainRunOK, TokensIn: 4000, TokensOut: 200, CostUSD: 0.004, Nodes: 3, FinishedAt: 2000},
		{SessionID: "a2", Status: BrainRunFailed, TokensIn: 900, Nodes: 5, FinishedAt: 2100},
		{SessionID: "w1", Status: BrainRunOK, TokensIn: 1000, TokensOut: 100, Nodes: 1, FinishedAt: 2200},
		{SessionID: "gone", Status: BrainRunOK, TokensIn: 10, Nodes: 1, FinishedAt: 2300},
		{SessionID: "q1", Status: BrainRunSkipped, FinishedAt: 2400},
		// A re-tag batch: its own row, never "no project", and no read.
		{SessionID: BrainRetagSession, Status: BrainRunOK, TokensIn: 3000, TokensOut: 100, Nodes: 40, FromEventID: 1, ThroughEventID: 90, FinishedAt: 2500},
		{SessionID: "w1", Status: BrainRunOK, TokensIn: 77777, FinishedAt: 10}, // before the window
	} {
		r.StartedAt = r.FinishedAt
		if _, err := InsertBrainRun(ctx, s.db, r); err != nil {
			t.Fatal(err)
		}
	}
	got, err := BrainSpendByProject(ctx, s.db, 1000)
	if err != nil {
		t.Fatal(err)
	}
	want := []BrainProjectSpend{
		{Project: "acme-api", Reads: 2, Tokens: 5100, CostUSD: 0.004, Memories: 3},
		{Project: "", Retag: true, Reads: 1, Tokens: 3100, Memories: 40},
		{Project: "web", Reads: 1, Tokens: 1100, Memories: 1},
		{Project: "", Reads: 1, Tokens: 10, Memories: 1},
	}
	if len(got) != len(want) {
		t.Fatalf("projects: %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%d: %+v, want %+v", i, got[i], want[i])
		}
	}
	per, n, err := BrainTokensPerRead(ctx, s.db, 1000)
	if err != nil || n != 4 || per != (5100+1100+10)/4 {
		t.Errorf("tokens per read: %d over %d, %v", per, n, err)
	}
	rows, err := BrainSpendRows(ctx, s.db, 1000)
	if err != nil || len(rows) != 6 || rows[4].Read || !rows[0].Read || rows[0].Tokens != 4200 {
		t.Errorf("rows: %+v %v", rows, err)
	}
	if rows[0].Project != "acme-api" || rows[0].Retag || rows[3].Project != "" || !rows[5].Retag || rows[5].Project != "" {
		t.Errorf("rows say whose they were: %+v", rows)
	}
}

// All of Claude Code's tokens in the recorded sessions: every kind of
// token, Claude Code's sessions only, and never an internal event.
func TestClaudeTokensSinceCountsClaudeSessions(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for id, agent := range map[string]string{"c": "claude", "x": "codex"} {
		if err := UpsertSession(ctx, s.db, id, SessionPatch{Agent: agent, LastEventAt: 1, StartedAt: 1, FromHook: true}); err != nil {
			t.Fatal(err)
		}
	}
	turn := func(sess, key string, ts int64, tk event.TokenDelta) {
		ev := event.Event{SessionID: sess, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: time.UnixMilli(ts), Key: key,
			Payload: []byte(`{"text":"x"}`), Tokens: &tk}
		if _, err := InsertEvent(ctx, s.db, &ev); err != nil {
			t.Fatal(err)
		}
	}
	turn("c", "1", 5000, event.TokenDelta{In: 10, Out: 20, CacheRead: 1000, CacheWrite: 300})
	turn("c", "2", 100, event.TokenDelta{In: 99999}) // before
	turn("x", "3", 5000, event.TokenDelta{In: 55555})
	n, err := ClaudeTokensSince(ctx, s.db, 1000)
	if err != nil || n != 1330 {
		t.Fatalf("claude tokens: %d %v", n, err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE events SET internal = 1 WHERE key = '1'`); err != nil {
		t.Fatal(err)
	}
	if n, _ := ClaudeTokensSince(ctx, s.db, 1000); n != 0 {
		t.Errorf("an internal turn counted: %d", n)
	}
}
