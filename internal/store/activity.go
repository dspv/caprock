package store

import "context"

// ActivityBuckets is how many turns and tool calls each session recorded in
// each bucket of [from, from+n*bucket): the sidebar's per-project sparkline.
// One range scan on idx_events_ts over a short window — the last hour by
// default — and only two kinds, so a busy machine reads a few thousand rows.
// Sessions with nothing in the window are absent.
func ActivityBuckets(ctx context.Context, q Querier, from, bucket int64, n int) (map[string][]int, error) {
	if bucket <= 0 || n <= 0 {
		return map[string][]int{}, nil
	}
	rows, err := q.QueryContext(ctx, `
		SELECT (SELECT session_id FROM sessions WHERE sessions.sid = events.sid), (ts - ?) / ?, COUNT(*)
		FROM events INDEXED BY idx_events_ts
		WHERE ts >= ? AND ts < ? AND kind IN ('turn.assistant', 'tool.pre')`+nonInternalEvent+`
		GROUP BY sid, 2`, from, bucket, from, from+bucket*int64(n))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]int{}
	for rows.Next() {
		var id string
		var i int64
		var c int
		if err := rows.Scan(&id, &i, &c); err != nil {
			return nil, err
		}
		if i < 0 || i >= int64(n) {
			continue
		}
		b := out[id]
		if b == nil {
			b = make([]int, n)
			out[id] = b
		}
		b[i] += c
	}
	return out, rows.Err()
}
