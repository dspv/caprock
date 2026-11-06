package store

import "context"

// LimitReturn is a planned return after the reset (migration 0081): the
// session now carrying the work goes back to To at At (unix ms).
type LimitReturn struct {
	SessionID string
	To        string
	At        int64
}

// SetLimitReturn records or replaces session id's return.
func SetLimitReturn(ctx context.Context, q Querier, r LimitReturn) error {
	if r.SessionID == "" || r.To == "" || r.At <= 0 {
		return nil
	}
	_, err := q.ExecContext(ctx, `INSERT INTO limit_returns (session_id, to_target, return_at) VALUES (?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET to_target = excluded.to_target, return_at = excluded.return_at`,
		r.SessionID, r.To, r.At)
	return err
}

// DeleteLimitReturn forgets session id's return, if it has one.
func DeleteLimitReturn(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM limit_returns WHERE session_id = ?`, id)
	return err
}

// RestoreLimitReturns deletes the returns that were due before staleBefore
// (unix ms) or whose session has ended or is unknown, and lists the rest,
// soonest first.
func RestoreLimitReturns(ctx context.Context, q Querier, staleBefore int64) ([]LimitReturn, error) {
	if _, err := q.ExecContext(ctx, `DELETE FROM limit_returns WHERE return_at < ?
		OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = limit_returns.session_id AND s.status != 'ended')`, staleBefore); err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT session_id, to_target, return_at FROM limit_returns ORDER BY return_at`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []LimitReturn
	for rows.Next() {
		var r LimitReturn
		if err := rows.Scan(&r.SessionID, &r.To, &r.At); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
