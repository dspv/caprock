package store

import (
	"context"
	"strings"
)

// LivePID is a session that has not ended and the process it runs in.
type LivePID struct {
	SessionID string
	PID       int
}

// LivePIDs lists the sessions not ended that have a process id: the ones the
// resource meter can measure. Sessions without one (an older shim's rows, a
// transcript with no process behind it) are left out.
func LivePIDs(ctx context.Context, q Querier) ([]LivePID, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT session_id, pid FROM sessions WHERE status != 'ended' AND pid IS NOT NULL AND pid > 0`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []LivePID
	for rows.Next() {
		var l LivePID
		if err := rows.Scan(&l.SessionID, &l.PID); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// EndedPID is an ended session that ran in a process: when it started and
// when it was last heard from, unix ms.
type EndedPID struct {
	SessionID   string
	PID         int
	StartedAt   int64
	LastEventAt int64
}

// EndedByPID is, for each pid given, the most recently heard-from ended
// session that ran in it. The orphan scan asks it about the few claude
// processes that have no terminal, so the IN list is short.
func EndedByPID(ctx context.Context, q Querier, pids []int) (map[int]EndedPID, error) {
	out := map[int]EndedPID{}
	if len(pids) == 0 {
		return out, nil
	}
	args := make([]any, len(pids))
	marks := make([]string, len(pids))
	for i, p := range pids {
		args[i], marks[i] = p, "?"
	}
	rows, err := q.QueryContext(ctx,
		`SELECT session_id, pid, COALESCE(started_at, 0), COALESCE(last_event_at, 0) FROM sessions
		 WHERE status = 'ended' AND pid IN (`+strings.Join(marks, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var e EndedPID
		if err := rows.Scan(&e.SessionID, &e.PID, &e.StartedAt, &e.LastEventAt); err != nil {
			return nil, err
		}
		if prev, ok := out[e.PID]; !ok || e.LastEventAt > prev.LastEventAt {
			out[e.PID] = e
		}
	}
	return out, rows.Err()
}
