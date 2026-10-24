package store

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestSpendPartsAddMergeSorted(t *testing.T) {
	var p SpendParts
	p = p.Add("", "", 1).Add("claude", "", 2).Add("codex", "", 4).Add("claude", "ab12", 0)
	if len(p) != 2 || p[0].Agent != "claude" || p[0].CostUSD != 3 {
		t.Fatalf("parts = %+v", p)
	}
	q := SpendParts{{Agent: "claude", Subscription: "ab12", CostUSD: 5}}.Merge(p).Sorted()
	if len(q) != 3 || q[0].Subscription != "ab12" || q[1].Agent != "codex" || q[2].CostUSD != 3 {
		t.Fatalf("merged = %+v", q)
	}
}

// The summary's total split by sign-in sums to the total, keeps each
// subscription apart, and honours the range and the agent filter.
func TestSpendPartsBetween(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	n := 0
	add := func(id, agent, sub string, cost float64, at time.Time, internal bool) {
		t.Helper()
		if err := UpsertSession(ctx, s.db, id, SessionPatch{Cwd: "/x", Agent: agent, Subscription: sub}); err != nil {
			t.Fatal(err)
		}
		n++
		c := cost
		if _, err := InsertEvent(ctx, s.db, &event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "k" + string(rune('a'+n)), Ts: at, CostUSD: &c}); err != nil {
			t.Fatal(err)
		}
		if internal {
			if _, err := s.db.ExecContext(ctx, `UPDATE events SET internal = 1 WHERE session_id = ?`, id); err != nil {
				t.Fatal(err)
			}
		}
	}
	add("a", "claude", "", 1.5, now, false)
	add("b", "claude", "ab12", 2, now, false)
	add("b", "claude", "ab12", 0.5, now, false)
	add("c", "codex", "", 3, now, false)
	add("i", "claude", "", 50, now, true) // internal: never in a cost
	add("old", "claude", "ab12", 100, now.Add(-40*24*time.Hour), false)

	parts, err := SpendPartsBetween(ctx, s.db, now.Add(-24*time.Hour).UnixMilli(), 0, "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, p := range parts {
		got[p.Agent+"|"+p.Subscription] = p.CostUSD
	}
	if len(got) != 3 || got["claude|"] != 1.5 || got["claude|ab12"] != 2.5 || got["codex|"] != 3 {
		t.Fatalf("parts = %+v", parts)
	}
	if parts[0].Agent != "codex" {
		t.Fatalf("not dearest first: %+v", parts)
	}
	parts, _ = SpendPartsBetween(ctx, s.db, now.Add(-24*time.Hour).UnixMilli(), 0, "codex")
	if len(parts) != 1 || parts[0].CostUSD != 3 {
		t.Fatalf("codex only = %+v", parts)
	}
	usd, err := SpendOn(ctx, s.db, "claude", "ab12", now.Add(-50*24*time.Hour).UnixMilli(), now.Add(-24*time.Hour).UnixMilli())
	if err != nil || usd != 100 {
		t.Fatalf("SpendOn = %v, %v", usd, err)
	}
}

// A pull request worked on from two sign-ins carries both parts, summing to
// its cost.
func TestSpendByPRParts(t *testing.T) {
	ctx := context.Background()
	st := openTest(t)
	q := st.DB()
	for _, r := range []struct {
		id, agent, sub string
		cost           float64
	}{{"s1", "claude", "", 3}, {"s2", "claude", "ab12", 2}, {"s3", "codex", "", 1}} {
		if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, git_branch, repo_root, agent, subscription) VALUES(?,?,?,?,?,?,?)`,
			r.id, "/r", "ended", "feat/a", "/r", r.agent, r.sub); err != nil {
			t.Fatal(err)
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO session_stats(session_id, cost_usd) VALUES(?,?)`, r.id, r.cost); err != nil {
			t.Fatal(err)
		}
	}
	const u = "https://github.com/o/r/pull/1"
	got, err := SpendByPR(ctx, q, "/r", []PRRef{{URL: u, Branch: "feat/a"}})
	if err != nil {
		t.Fatal(err)
	}
	p := got[u]
	if p.CostUSD != 6 || len(p.Parts) != 3 || p.Parts[0].CostUSD != 3 || p.Parts[1].Subscription != "ab12" || p.Parts[2].Agent != "codex" {
		t.Fatalf("spend = %+v", p)
	}
}
