package store

import (
	"context"
	"strings"
)

// The Work board's reads (ADR-064): what each live session spent today, and
// the repositories worked in lately. Both read what is already recorded.

// SpendBySessionSince is each given session's priced cost of events at or
// after fromMs (internal model work left out, as every user total does). A
// session with nothing priced since is absent.
//
// One grouped sum over idx_events_attr_work, which leads on (session_id, ts)
// and carries cost_usd and internal, so no table row is read.
func SpendBySessionSince(ctx context.Context, q Querier, ids []string, fromMs int64) (map[string]float64, error) {
	out := map[string]float64{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids)+1)
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, fromMs)
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, COALESCE(SUM(cost_usd), 0)
		  FROM events INDEXED BY idx_events_attr_work
		 WHERE session_id IN (?`+strings.Repeat(", ?", len(ids)-1)+`) AND ts >= ?`+nonInternalEvent+`
		 GROUP BY session_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var usd float64
		if err := rows.Scan(&id, &usd); err != nil {
			return nil, err
		}
		if usd > 0 {
			out[id] = usd
		}
	}
	return out, rows.Err()
}

// RecentRepo is a repository a session worked in, and the newest such
// session.
type RecentRepo struct {
	Root      string
	SessionID string
	LastAt    int64
}

// RecentRepos is the repositories sessions recorded anything in at or after
// fromMs, newest first, at most limit. Sessions outside a repository are not
// counted.
func RecentRepos(ctx context.Context, q Querier, fromMs int64, limit int) ([]RecentRepo, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT repo_root, session_id, MAX(last_event_at)
		  FROM sessions
		 WHERE COALESCE(repo_root, '') <> '' AND last_event_at >= ?
		 GROUP BY repo_root
		 ORDER BY 3 DESC
		 LIMIT ?`, fromMs, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RecentRepo
	for rows.Next() {
		var r RecentRepo
		if err := rows.Scan(&r.Root, &r.SessionID, &r.LastAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
