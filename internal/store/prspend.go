package store

import (
	"context"
	"sort"
	"strings"
)

// The PRs & CI board's "agent cost" and the Now screen's cost per pull
// request (owner, 2026-10-14, translated: "a team lead wants to understand
// where the money for tokens goes, how much each PR costs"). Caprock knows a
// pull request's agent work two ways, and a session is charged through one of
// them only, so the per-PR figures add up to what the sessions cost and never
// more (rule 6):
//
//   - Its head branch. A session recorded on the branch (sessions.git_branch)
//     is charged to that branch's pull request whole.
//   - The sessions that worked on it (session_prs: a session that opened,
//     pushed to or merged it). A session not on such a branch is cut at the
//     moments it opened its pull requests — each one, ordered by when it was
//     opened (else last touched), is charged the session's spend since the
//     one before, and the newest also everything after, its fix-ups. A
//     session with one pull request is charged to it whole.
//
// All at API list price, as every cost in Caprock is (session_stats.cost_usd,
// events.cost_usd).

// PRRef names a pull request for SpendByPR: its link and head branch.
type PRRef struct {
	URL    string
	Branch string
}

// PRSpend is the agent work Caprock recorded for one pull request.
type PRSpend struct {
	CostUSD float64 `json:"cost_usd"`
	// Sessions counts the sessions charged to it; Live those of them not
	// ended — for a session cut between several, only the newest one's.
	Sessions int      `json:"sessions"`
	Live     int      `json:"live"`
	Agents   []string `json:"agents"`
	// ByBranch and BySlice say through which way the cost came: the
	// sessions on the head branch, and those cut at their pull requests.
	ByBranch float64 `json:"by_branch"`
	BySlice  float64 `json:"by_slice"`
}

type prSession struct {
	branch, status, agent string
	cost                  float64
	rows                  []prRow
}

type prRow struct {
	url    string
	anchor int64
}

// SpendByPR charges the sessions of repository repoRoot to the pull
// requests prs, keyed by URL. Where two of prs share a head branch, the
// first in prs owns it: pass the open one first, then the newest. Three
// small reads: the repository's sessions with a branch (through
// idx_sessions_repo_branch), the session_prs rows of the sessions that
// worked on one of prs, and, for a session cut between several, one sum per
// slice over its events (through its (session_id, ts) index).
func SpendByPR(ctx context.Context, q Querier, repoRoot string, prs []PRRef) (map[string]PRSpend, error) {
	out := map[string]PRSpend{}
	if len(prs) == 0 {
		return out, nil
	}
	want := map[string]bool{}
	owner := map[string]string{} // branch -> URL
	for _, p := range prs {
		want[p.URL] = true
		if p.Branch != "" && owner[p.Branch] == "" {
			owner[p.Branch] = p.URL
		}
	}
	agents := map[string]map[string]bool{}
	add := func(url, agent string, cost float64, live, branch bool) {
		s := out[url]
		s.CostUSD += cost
		if branch {
			s.ByBranch += cost
		} else {
			s.BySlice += cost
		}
		s.Sessions++
		if live {
			s.Live++
		}
		if agents[url] == nil {
			agents[url] = map[string]bool{}
		}
		agents[url][agent] = true
		out[url] = s
	}

	// The head branches' sessions, charged whole.
	onBranch := map[string]bool{}
	if repoRoot != "" && len(owner) > 0 {
		rows, err := q.QueryContext(ctx, `
			SELECT s.session_id, s.git_branch, s.status, COALESCE(NULLIF(s.agent,''),'claude'), COALESCE(st.cost_usd,0)
			FROM sessions s
			LEFT JOIN session_stats st ON st.session_id = s.session_id
			WHERE s.repo_root = ? AND s.git_branch IS NOT NULL AND s.git_branch <> ''`, repoRoot)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, branch, status, agent string
			var cost float64
			if err := rows.Scan(&id, &branch, &status, &agent, &cost); err != nil {
				rows.Close()
				return nil, err
			}
			if u := owner[branch]; u != "" {
				onBranch[id] = true
				add(u, agent, cost, status != "ended", true)
			}
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}

	// The sessions that worked on one of them, with every pull request each
	// recorded (their cuts need all of them, this repository's or not).
	args := make([]any, 0, len(want))
	for u := range want {
		args = append(args, u)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT p.session_id, p.url, CASE WHEN p.opened_at > 0 THEN p.opened_at ELSE p.last_at END,
		       COALESCE(s.git_branch,''), s.status, COALESCE(NULLIF(s.agent,''),'claude'), COALESCE(st.cost_usd,0)
		FROM session_prs p
		JOIN sessions s ON s.session_id = p.session_id
		LEFT JOIN session_stats st ON st.session_id = p.session_id
		WHERE p.session_id IN (SELECT session_id FROM session_prs WHERE url IN (?`+strings.Repeat(",?", len(args)-1)+`))`, args...)
	if err != nil {
		return nil, err
	}
	sessions := map[string]*prSession{}
	var order []string
	for rows.Next() {
		var id string
		var r prRow
		var x prSession
		if err := rows.Scan(&id, &r.url, &r.anchor, &x.branch, &x.status, &x.agent, &x.cost); err != nil {
			rows.Close()
			return nil, err
		}
		if onBranch[id] {
			continue
		}
		s := sessions[id]
		if s == nil {
			s = &x
			sessions[id] = s
			order = append(order, id)
		}
		s.rows = append(s.rows, r)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, id := range order {
		s := sessions[id]
		sort.SliceStable(s.rows, func(a, b int) bool { return s.rows[a].anchor < s.rows[b].anchor })
		live := s.status != "ended"
		if len(s.rows) == 1 {
			add(s.rows[0].url, s.agent, s.cost, live, false)
			continue
		}
		for i, r := range s.rows {
			if !want[r.url] {
				continue
			}
			lo := int64(-1)
			if i > 0 {
				lo = s.rows[i-1].anchor
			}
			hi := int64(1) << 62
			if i < len(s.rows)-1 {
				hi = r.anchor
			}
			var cost float64
			if err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(cost_usd),0) FROM events WHERE session_id = ? AND ts > ? AND ts <= ? AND internal = 0`, id, lo, hi).Scan(&cost); err != nil {
				return nil, err
			}
			if cost == 0 && i < len(s.rows)-1 {
				continue
			}
			add(r.url, s.agent, cost, live && i == len(s.rows)-1, false)
		}
	}
	for u, s := range out {
		s.Agents = make([]string, 0, len(agents[u]))
		for a := range agents[u] {
			s.Agents = append(s.Agents, a)
		}
		sort.Strings(s.Agents)
		out[u] = s
	}
	return out, nil
}
