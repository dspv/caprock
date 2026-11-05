package store

import (
	"context"
	"sort"
)

// FinishedProject is one project's sessions that ended in a window, for the
// Morning summary (ADR-091). AtLimit and Errored are among Finished.
type FinishedProject struct {
	Project  string
	Finished int
	// AtLimit ended while refused at a plan's usage limit (limit_hit_at set
	// and never cleared by a later reply).
	AtLimit int
	// Errored exited with an error code (1 to 127): a code of 128 or more,
	// or -1, is a signal — a stop the owner or Caprock asked for — and not
	// counted as a failure.
	Errored int
}

// FinishedSince lists, per project, the sessions that ended with their last
// event in [fromMs, toMs) and did work on or after fromDay (a local date,
// daily_sessions.day): the busiest project first. Chats are left out — a
// chat is not work on a project (ADR-071). The day range on daily_sessions'
// key leads, so the statement never reads all of sessions or of events.
func FinishedSince(ctx context.Context, q Querier, fromDay string, fromMs, toMs int64) ([]FinishedProject, error) {
	rows, err := q.QueryContext(ctx, `SELECT COALESCE(s.project, ''), COALESCE(s.exit_code, 0), COALESCE(s.limit_hit_at, 0)
		FROM (SELECT DISTINCT session_id FROM daily_sessions WHERE day >= ?) d
		JOIN sessions s ON s.session_id = d.session_id
		WHERE s.status = 'ended' AND s.last_event_at >= ? AND s.last_event_at < ? AND COALESCE(s.chat, 0) = 0`,
		fromDay, fromMs, toMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	by := map[string]*FinishedProject{}
	for rows.Next() {
		var project string
		var code int
		var limitAt int64
		if err := rows.Scan(&project, &code, &limitAt); err != nil {
			return nil, err
		}
		p := by[project]
		if p == nil {
			p = &FinishedProject{Project: project}
			by[project] = p
		}
		p.Finished++
		if limitAt > 0 {
			p.AtLimit++
		} else if code >= 1 && code <= 127 {
			p.Errored++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]FinishedProject, 0, len(by))
	for _, p := range by {
		out = append(out, *p)
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].Finished != out[b].Finished {
			return out[a].Finished > out[b].Finished
		}
		return out[a].Project < out[b].Project
	})
	return out, nil
}
