package store

import (
	"context"
	"math"
	"strings"
	"testing"
)

// A pull request is charged its head branch's sessions whole, and a session
// that opened several is cut at the moments it opened them; each session
// through one way only, so the figures add up to what the sessions cost.
func TestSpendByPR(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	q := st.DB()
	sess := func(id, branch, status, agent string, cost float64) {
		t.Helper()
		if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, git_branch, repo_root, agent) VALUES(?,?,?,?,?,?)`,
			id, "/r", status, branch, "/r", agent); err != nil {
			t.Fatal(err)
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO session_stats(session_id, cost_usd) VALUES(?,?)`, id, cost); err != nil {
			t.Fatal(err)
		}
	}
	rec := func(id, url string, opened, last int64) {
		t.Helper()
		if _, err := q.ExecContext(ctx, `INSERT INTO session_prs(session_id, url, number, opened_at, last_at) VALUES(?,?,?,?,?)`, id, url, 1, opened, last); err != nil {
			t.Fatal(err)
		}
	}
	spend := func(id string, ts int64, cost float64) {
		t.Helper()
		if _, err := q.ExecContext(ctx, `INSERT INTO events(ts, session_id, source, kind, payload, cost_usd) VALUES(?,?,?,?,?,?)`, ts, id, "transcript", "turn.assistant", "{}", cost); err != nil {
			t.Fatal(err)
		}
	}
	const a, b, c = "https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2", "https://github.com/o/r/pull/3"
	// On feat/a: two sessions, one still running, plus one that also
	// recorded #2 — the branch takes it whole, #2 gets nothing from it.
	sess("br1", "feat/a", "ended", "claude", 3)
	sess("br2", "feat/a", "idle", "codex", 1)
	sess("br3", "feat/a", "ended", "claude", 2)
	rec("br3", b, 50, 60)
	// On master, it opened #2 at 100 and #3 at 200 and keeps working.
	sess("orch", "master", "active", "claude", 10)
	spend("orch", 10, 1)
	spend("orch", 100, 2) // up to and including #2's opening: #2's
	spend("orch", 150, 3)
	spend("orch", 200, 1) // #3's
	spend("orch", 900, 3) // after the last: the newest one's fix-ups
	rec("orch", b, 100, 120)
	rec("orch", c, 200, 210)
	// A one-PR session off the branch: charged whole.
	sess("solo", "", "ended", "claude", 4)
	rec("solo", c, 300, 300)
	// A session on no listed pull request is not counted.
	sess("other", "feat/z", "ended", "claude", 99)

	got, err := SpendByPR(ctx, q, "/r", []PRRef{{URL: a, Branch: "feat/a"}, {URL: b, Branch: "feat/b"}, {URL: c, Branch: "feat/c"}})
	if err != nil {
		t.Fatal(err)
	}
	near := func(x, y float64) bool { return math.Abs(x-y) < 1e-9 }
	if x := got[a]; !near(x.CostUSD, 6) || x.Sessions != 3 || x.Live != 1 || strings.Join(x.Agents, ",") != "claude,codex" || !near(x.ByBranch, 6) {
		t.Fatalf("#1 = %+v", x)
	}
	if x := got[b]; !near(x.CostUSD, 3) || x.Sessions != 1 || x.Live != 0 || !near(x.BySlice, 3) {
		t.Fatalf("#2 = %+v (want the orchestrator's 1+2 up to its opening)", x)
	}
	if x := got[c]; !near(x.CostUSD, 11) || x.Sessions != 2 || x.Live != 1 {
		t.Fatalf("#3 = %+v (want 3+1+3 from the orchestrator, 4 whole)", x)
	}
	total := got[a].CostUSD + got[b].CostUSD + got[c].CostUSD
	if !near(total, 3+1+2+10+4) {
		t.Fatalf("charged %v, the sessions cost %v", total, 3+1+2+10+4)
	}
	if none, err := SpendByPR(ctx, q, "/r", nil); err != nil || len(none) != 0 {
		t.Fatalf("no pull requests: %+v %v", none, err)
	}
}
