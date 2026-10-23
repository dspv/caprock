package store

import (
	"context"
	"math"
	"testing"
)

func openCostliest(t *testing.T) (*Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st, ctx
}

// A list read later never undoes a newer one: a row is rewritten only by a
// header at least as new as the one it holds.
func TestUpsertGitHubPRs(t *testing.T) {
	st, ctx := openCostliest(t)
	const u = "https://github.com/o/r/pull/7"
	if err := st.UpsertGitHubPRs(ctx, "o/r", []GitHubPR{{Number: 7, URL: u, Title: "old", Head: "feat/x", State: "open", UpdatedAt: 100}}, 1); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertGitHubPRs(ctx, "o/r", []GitHubPR{{Number: 7, URL: u, Title: "merged", Head: "feat/x", State: "merged", MergedAt: 200, UpdatedAt: 200}}, 2); err != nil {
		t.Fatal(err)
	}
	// An older list, read late.
	if err := st.UpsertGitHubPRs(ctx, "O/R", []GitHubPR{{Number: 7, URL: u, Title: "old", Head: "feat/x", State: "open", UpdatedAt: 100}, {Number: 0, URL: "x"}}, 3); err != nil {
		t.Fatal(err)
	}
	var title, state string
	var merged, n int64
	if err := st.DB().QueryRowContext(ctx, `SELECT title, state, merged_at, (SELECT COUNT(*) FROM github_prs) FROM github_prs WHERE repo = 'o/r' AND number = 7`).Scan(&title, &state, &merged, &n); err != nil {
		t.Fatal(err)
	}
	if title != "merged" || state != "merged" || merged != 200 || n != 1 {
		t.Fatalf("row %q %q %d, %d rows", title, state, merged, n)
	}
}

// Every pull request of the repository Caprock knows of: the listed headers
// and the agents' own records, one row each, charged as the board charges
// them — a hand-opened pull request by its head branch, which only the kept
// header knows.
func TestKnownPRs(t *testing.T) {
	st, ctx := openCostliest(t)
	q := st.DB()
	sess := func(id, branch, status string, cost float64) {
		t.Helper()
		if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, git_branch, repo_root, agent) VALUES(?,?,?,?,?,?)`, id, "/r", status, branch, "/r", "claude"); err != nil {
			t.Fatal(err)
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO session_stats(session_id, cost_usd) VALUES(?,?)`, id, cost); err != nil {
			t.Fatal(err)
		}
	}
	rec := func(id, url string, n int, title string, opened, merged, last int64) {
		t.Helper()
		if _, err := q.ExecContext(ctx, `INSERT INTO session_prs(session_id, url, number, title, opened_at, merged_at, last_at) VALUES(?,?,?,?,?,?,?)`, id, url, n, title, opened, merged, last); err != nil {
			t.Fatal(err)
		}
	}
	const p1, p2, p3 = "https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2", "https://github.com/o/r/pull/3"
	// #1: opened and merged by an agent, never listed.
	sess("a", "", "ended", 4)
	rec("a", p1, 1, "One", 10, 50, 60)
	// #2: opened by hand; a session worked on its branch. Listed.
	sess("b", "feat/two", "ended", 6)
	// #3: listed and also recorded; listed title wins, state too.
	sess("c", "", "idle", 2)
	rec("c", p3, 3, "agent title", 300, 0, 900)
	// Another repository's record is not this one's.
	sess("d", "", "ended", 9)
	rec("d", "https://github.com/o/other/pull/1", 1, "x", 1, 0, 1)
	if err := st.UpsertGitHubPRs(ctx, "o/r", []GitHubPR{
		{Number: 2, URL: p2, Title: "Two", Head: "feat/two", State: "open", UpdatedAt: 500},
		{Number: 3, URL: p3, Title: "Three", Head: "feat/three", State: "open", UpdatedAt: 400},
	}, 1); err != nil {
		t.Fatal(err)
	}
	got, err := KnownPRs(ctx, q, "/r", "o/r")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Number != 3 || got[1].Number != 2 || got[2].Number != 1 {
		t.Fatalf("order %+v", got)
	}
	three, two, one := got[0], got[1], got[2]
	if three.Title != "Three" || three.State != "open" || three.At != 900 || three.Spend.CostUSD != 2 {
		t.Fatalf("#3 %+v", three)
	}
	if two.Title != "Two" || two.At != 500 || two.Spend.CostUSD != 6 || two.Spend.ByBranch != 6 {
		t.Fatalf("#2 %+v", two)
	}
	if one.Title != "One" || one.State != "merged" || one.At != 50 || one.Spend.CostUSD != 4 || one.Spend.Agents == nil {
		t.Fatalf("#1 %+v", one)
	}
	sum := 0.0
	for _, p := range got {
		sum += p.Spend.CostUSD
	}
	if math.Abs(sum-12) > 1e-9 {
		t.Fatalf("sum %v", sum)
	}
	if got, err := KnownPRs(ctx, q, "/r", ""); err != nil || len(got) != 0 {
		t.Fatalf("no repo: %+v %v", got, err)
	}
}

// An ended session's slices are kept, and summed afresh once its recorded
// total moves (it resumed, or the tailer caught up).
func TestSpendByPRKeepsEndedSlices(t *testing.T) {
	st, ctx := openCostliest(t)
	q := st.DB()
	if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, repo_root, agent) VALUES('o','/r','ended','/r','claude')`); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ExecContext(ctx, `INSERT INTO session_stats(session_id, cost_usd) VALUES('o', 3)`); err != nil {
		t.Fatal(err)
	}
	ev := func(ts int64, cost float64) {
		t.Helper()
		if _, err := q.ExecContext(ctx, `INSERT INTO events(ts, session_id, source, kind, payload, cost_usd, tokens_in) VALUES(?,?,?,?,?,?,?)`, ts, "o", "transcript", "turn.assistant", "{}", cost, 10); err != nil {
			t.Fatal(err)
		}
	}
	ev(50, 1)
	ev(150, 2)
	const a, b = "https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"
	for _, r := range []struct {
		u  string
		at int64
	}{{a, 100}, {b, 200}} {
		if _, err := q.ExecContext(ctx, `INSERT INTO session_prs(session_id, url, number, opened_at, last_at) VALUES('o',?,1,?,?)`, r.u, r.at, r.at); err != nil {
			t.Fatal(err)
		}
	}
	read := func() (float64, float64, int64) {
		t.Helper()
		m, err := SpendByPR(ctx, q, "/r", []PRRef{{URL: a}, {URL: b}})
		if err != nil {
			t.Fatal(err)
		}
		return m[a].CostUSD, m[b].CostUSD, m[b].TokensIn
	}
	if x, y, tok := read(); x != 1 || y != 2 || tok != 10 {
		t.Fatalf("first: %v %v %d", x, y, tok)
	}
	// Kept: a row the total does not show is not seen…
	ev(160, 5)
	if x, y, _ := read(); x != 1 || y != 2 {
		t.Fatalf("kept: %v %v", x, y)
	}
	// …until the total moves.
	if _, err := q.ExecContext(ctx, `UPDATE session_stats SET cost_usd = 8 WHERE session_id = 'o'`); err != nil {
		t.Fatal(err)
	}
	if x, y, tok := read(); x != 1 || y != 7 || tok != 20 {
		t.Fatalf("after the total moved: %v %v %d", x, y, tok)
	}
	// Only the slices asked for are summed and kept; another is summed later.
	m, err := SpendByPR(ctx, q, "/r", []PRRef{{URL: a}})
	if err != nil || m[a].CostUSD != 1 || len(m) != 1 {
		t.Fatalf("one asked: %+v %v", m, err)
	}
}
