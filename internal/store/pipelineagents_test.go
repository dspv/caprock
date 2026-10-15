package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// turnIn records one priced assistant turn of a session, or of one of its
// subagents when sub is set.
func turnIn(t *testing.T, s *Store, sid, sub string, at time.Time, tokens int64, usd float64) {
	t.Helper()
	ev := &event.Event{
		SessionID: sid, AgentID: sub, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Model: "claude-opus-5", Ts: at, Tokens: &event.TokenDelta{In: tokens}, CostUSD: &usd,
		Key: fmt.Sprintf("%s-%s-%d-%f", sid, sub, at.UnixMilli(), usd),
	}
	if _, err := InsertEvent(context.Background(), s.db, ev); err != nil {
		t.Fatal(err)
	}
}

func inRepo(t *testing.T, s *Store, sid, root, agent string) {
	t.Helper()
	if _, err := s.db.Exec(`INSERT INTO sessions(session_id, cwd, status, repo_root, agent) VALUES(?,?,'active',?,?)`, sid, root, root, agent); err != nil {
		t.Fatal(err)
	}
}

// An hour of work is an active agent-hour, the burn's own rule: a session's
// clock hour with at least five priced calls. A session's subagents work in
// its hour, two sessions in one clock hour are two agent-hours, and an hour
// touched in passing is in the cost but not the rate.
func TestRepoRateActiveAgentHours(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	loc := time.FixedZone("test", 2*3600)
	now := time.Date(2026, 10, 15, 12, 30, 0, 0, loc)
	at := func(daysAgo, h, m int) time.Time { return time.Date(2026, 10, 15-daysAgo, h, m, 0, 0, loc) }
	five := func(sid, sub string, base time.Time, usd float64) {
		for i := range 5 {
			turnIn(t, s, sid, sub, base.Add(time.Duration(i)*time.Minute), 1000, usd/5)
		}
	}
	// Today 10:00: session a, three calls of its own and two of a subagent
	// = one active hour, $6. Session b in the same clock hour, $4 = a second
	// agent-hour; one wall-clock hour.
	for i := range 3 {
		turnIn(t, s, "a", "", at(0, 10, i), 1000, 1.2)
	}
	turnIn(t, s, "a", "sub-1", at(0, 10, 5), 1000, 1.2)
	turnIn(t, s, "a", "sub-1", at(0, 10, 6), 1000, 1.2)
	five("b", "", at(0, 10, 10), 4)
	// Today 11:00: a touches it in passing, two calls, $1: cost, no rate.
	turnIn(t, s, "a", "", at(0, 11, 0), 500, 0.5)
	turnIn(t, s, "a", "", at(0, 11, 1), 500, 0.5)
	// The previous days: one active hour a day at $2/h on three days.
	for _, d := range []int{2, 3, 5} {
		five("old", "", at(d, 9, 0), 2)
	}
	// Another repository the same hour: not ours.
	five("other", "", at(0, 10, 0), 50)
	for _, sid := range []string{"a", "b", "old"} {
		inRepo(t, s, sid, "/r", "claude")
	}
	inRepo(t, s, "other", "/elsewhere", "claude")

	got, err := RepoAgentsAt(ctx, s.db, now, []string{"/r"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := got.Rate
	if len(r.Series) != RepoAgentDays+1 || r.Series[RepoAgentDays].Day != "2026-10-15" {
		t.Fatalf("series = %+v", r.Series)
	}
	l := r.Last24
	if l.ActiveHours != 2 || l.ActiveCostUSD < 9.999 || l.ActiveCostUSD > 10.001 || l.CostUSD < 10.999 || l.CostUSD > 11.001 || l.WallHours != 2 {
		t.Fatalf("last 24h = %+v, want 2 agent-hours costing $10 of $11, 2 wall hours", l)
	}
	if l.ActiveTokens != 10000 || l.Tokens != 11000 {
		t.Fatalf("tokens = %d of %d, want 10000 of 11000", l.ActiveTokens, l.Tokens)
	}
	if r.Usual == nil || r.Usual.ActiveHours != 3 || r.Usual.Days != 3 || r.Usual.ActiveCostUSD < 5.999 || r.Usual.ActiveCostUSD > 6.001 {
		t.Fatalf("usual = %+v, want 3 hours on 3 days, $6", r.Usual)
	}
	if d := r.Series[RepoAgentDays-2]; d.Day != "2026-10-13" || d.ActiveHours != 1 {
		t.Fatalf("two days ago = %+v", d)
	}
	if q := r.Series[RepoAgentDays-1]; q.ActiveHours != 0 || q.CostUSD != 0 {
		t.Fatalf("a quiet day = %+v", q)
	}
}

// Without an active hour before the last 24 there is no usual at all.
func TestRepoRateNoHistory(t *testing.T) {
	s := openTest(t)
	loc := time.FixedZone("test", 0)
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, loc)
	turnIn(t, s, "a", "", now.Add(-time.Hour), 100, 1)
	inRepo(t, s, "a", "/r", "claude")
	got, err := RepoAgentsAt(context.Background(), s.db, now, []string{"/r"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Rate.Usual != nil || got.Rate.Last24.ActiveHours != 0 || got.Rate.Last24.CostUSD != 1 {
		t.Fatalf("rate = %+v", got.Rate)
	}
}

// The team counts every main session and every subagent once a day, by
// agent kind; the peak is the busiest five minutes; now is the last ten.
func TestRepoTeamContributors(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	loc := time.FixedZone("test", -5*3600)
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, loc)
	at := func(daysAgo, h, m int) time.Time { return time.Date(2026, 10, 15-daysAgo, h, m, 0, 0, loc) }
	// Today: a claude session with two subagents at 11:00 (three agents in
	// one bucket), a codex session at 11:56 (now), the same subagent again
	// at 11:30 (still one subagent).
	turnIn(t, s, "c1", "", at(0, 11, 0), 10, 0.1)
	turnIn(t, s, "c1", "s1", at(0, 11, 1), 10, 0.1)
	turnIn(t, s, "c1", "s2", at(0, 11, 2), 10, 0.1)
	turnIn(t, s, "c1", "s1", at(0, 11, 30), 10, 0.1)
	turnIn(t, s, "x1", "", at(0, 11, 56), 10, 0)
	// Yesterday: a gemini and an opencode session, apart.
	turnIn(t, s, "g1", "", at(1, 9, 0), 10, 0.1)
	turnIn(t, s, "o1", "", at(1, 15, 0), 10, 0.1)
	// Thirty-one days ago: outside the chart.
	turnIn(t, s, "old", "", at(31, 9, 0), 10, 0.1)
	inRepo(t, s, "c1", "/r", "claude")
	inRepo(t, s, "x1", "/r2", "codex")
	inRepo(t, s, "g1", "/r", "gemini")
	inRepo(t, s, "o1", "/r", "opencode")
	inRepo(t, s, "old", "/r", "claude")

	got, err := RepoAgentsAt(ctx, s.db, now, []string{"/r", "/r2"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	tm := got.Team
	if len(tm.Series) != RepoTeamDays+1 {
		t.Fatalf("series has %d days", len(tm.Series))
	}
	today := tm.Series[RepoTeamDays]
	if today.Sessions != 2 || today.Subagents != 2 || today.Peak != 3 || tm.PeakToday != 3 {
		t.Fatalf("today = %+v, want 2 sessions, 2 subagents, peak 3", today)
	}
	if c := today.ByKind["claude"]; c.Sessions != 1 || c.Subagents != 2 {
		t.Fatalf("claude today = %+v", c)
	}
	if c := today.ByKind["codex"]; c.Sessions != 1 || c.Subagents != 0 {
		t.Fatalf("codex today = %+v", c)
	}
	y := tm.Series[RepoTeamDays-1]
	if y.Sessions != 2 || y.Peak != 1 || y.ByKind["gemini"].Sessions != 1 || y.ByKind["opencode"].Sessions != 1 {
		t.Fatalf("yesterday = %+v", y)
	}
	if tm.Now.Sessions != 1 || tm.Now.Subagents != 0 {
		t.Fatalf("now = %+v, want the codex session alone", tm.Now)
	}
	for _, d := range tm.Series[:RepoTeamDays-1] {
		if d.Sessions != 0 {
			t.Fatalf("%s = %+v, want nobody (the 31-day-old session is outside)", d.Day, d)
		}
	}
}
