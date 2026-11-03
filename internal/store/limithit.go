package store

import "context"

// SetLimitHit records that session id's model call at hit.At was refused at
// its plan's usage limit (migration 0078). An older refusal never replaces a
// newer one: a transcript read again from the start must not move it back.
func SetLimitHit(ctx context.Context, q Querier, id string, hit LimitHit) error {
	if id == "" || hit.At <= 0 {
		return nil
	}
	_, err := q.ExecContext(ctx, `UPDATE sessions SET limit_hit_at = ?, limit_resets_at = ?, limit_window = ?
		WHERE session_id = ? AND limit_hit_at <= ?`, hit.At, max(hit.ResetsAt, 0), hit.Window, id, hit.At)
	return err
}

// OwnedAtLimit lists the sessions Caprock started that are not ended and
// whose last call was refused at a limit, oldest limit first.
func OwnedAtLimit(ctx context.Context, q Querier) ([]Session, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+sessionCols+` FROM sessions
		WHERE limit_hit_at > 0 AND owned = 1 AND status != 'ended' ORDER BY limit_hit_at`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ClearLimitHit forgets a limit the session has got past: a real reply
// written at or after it (at, unix ms). Reports whether one was cleared.
func ClearLimitHit(ctx context.Context, q Querier, id string, at int64) (bool, error) {
	if id == "" {
		return false, nil
	}
	res, err := q.ExecContext(ctx, `UPDATE sessions SET limit_hit_at = 0, limit_resets_at = 0, limit_window = ''
		WHERE session_id = ? AND limit_hit_at > 0 AND limit_hit_at <= ?`, id, at)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
