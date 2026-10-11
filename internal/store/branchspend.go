package store

import (
	"context"
	"sort"
	"strings"
)

// BranchSpend is what Caprock's sessions on one branch of a repository cost:
// the sessions recorded on it (sessions.git_branch, the branch the session
// was on when Caprock saw it), the agents among them, the sum of their
// session_stats.cost_usd and the newest event of any of them.
type BranchSpend struct {
	Branch   string   `json:"branch"`
	Sessions int      `json:"sessions"`
	Agents   []string `json:"agents"`
	CostUSD  float64  `json:"cost_usd"`
	LastAt   int64    `json:"last_at"`
}

// SpendByBranch sums the sessions of repository repoRoot (sessions.repo_root,
// as ingest resolved it) per branch, read through idx_sessions_repo_branch
// (migration 0050). A session with no branch recorded is left out.
func SpendByBranch(ctx context.Context, q Querier, repoRoot string) (map[string]BranchSpend, error) {
	out := map[string]BranchSpend{}
	if repoRoot == "" {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `
		SELECT s.git_branch, COUNT(*), COALESCE(GROUP_CONCAT(DISTINCT COALESCE(NULLIF(s.agent,''),'claude')),''),
		       COALESCE(SUM(st.cost_usd),0), COALESCE(MAX(s.last_event_at),0)
		FROM sessions s
		LEFT JOIN session_stats st ON st.session_id = s.session_id
		WHERE s.repo_root = ? AND s.git_branch IS NOT NULL AND s.git_branch <> ''
		GROUP BY s.git_branch`, repoRoot)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var b BranchSpend
		var agents string
		if err := rows.Scan(&b.Branch, &b.Sessions, &agents, &b.CostUSD, &b.LastAt); err != nil {
			return nil, err
		}
		b.Agents = []string{}
		for _, a := range strings.Split(agents, ",") {
			if a != "" {
				b.Agents = append(b.Agents, a)
			}
		}
		sort.Strings(b.Agents)
		out[b.Branch] = b
	}
	return out, rows.Err()
}
