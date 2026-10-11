package store

import (
	"context"
	"strings"
	"testing"
)

func TestSpendByBranch(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	q := st.DB()
	add := func(id, root, branch, agent string, last int64, cost float64) {
		t.Helper()
		if _, err := q.ExecContext(ctx, `INSERT INTO sessions(session_id, cwd, status, git_branch, repo_root, agent, last_event_at) VALUES(?,?,?,?,?,?,?)`,
			id, root, "ended", branch, root, agent, last); err != nil {
			t.Fatal(err)
		}
		if cost >= 0 {
			if _, err := q.ExecContext(ctx, `INSERT INTO session_stats(session_id, cost_usd) VALUES(?,?)`, id, cost); err != nil {
				t.Fatal(err)
			}
		}
	}
	add("a1", "/r", "feat/x", "claude", 100, 1.25)
	add("a2", "/r", "feat/x", "codex", 300, 0.5)
	add("a3", "/r", "feat/x", "claude", 200, -1) // no stats row yet
	add("b1", "/r", "main", "claude", 50, 2)
	add("c1", "/r", "", "claude", 60, 9)            // no branch recorded
	add("d1", "/other", "feat/x", "claude", 999, 7) // another repository

	got, err := SpendByBranch(ctx, q, "/r")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("branches = %+v, want feat/x and main", got)
	}
	x := got["feat/x"]
	if x.Sessions != 3 || x.CostUSD != 1.75 || x.LastAt != 300 || strings.Join(x.Agents, ",") != "claude,codex" {
		t.Fatalf("feat/x = %+v", x)
	}
	if m := got["main"]; m.Sessions != 1 || m.CostUSD != 2 || len(m.Agents) != 1 {
		t.Fatalf("main = %+v", m)
	}
	if none, _ := SpendByBranch(ctx, q, ""); len(none) != 0 {
		t.Fatalf("no repository summed %+v", none)
	}

	// The read is a range of idx_sessions_repo_branch, not a scan.
	rows, err := q.QueryContext(ctx, `EXPLAIN QUERY PLAN SELECT s.git_branch, COUNT(*) FROM sessions s
		LEFT JOIN session_stats st ON st.session_id = s.session_id
		WHERE s.repo_root = ? AND s.git_branch IS NOT NULL AND s.git_branch <> '' GROUP BY s.git_branch`, "/r")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if p := strings.Join(plan, "\n"); !strings.Contains(p, "idx_sessions_repo_branch") || strings.Contains(p, "SCAN s") {
		t.Fatalf("plan:\n%s", p)
	}
}
