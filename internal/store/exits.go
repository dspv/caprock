package store

import (
	"context"
	"database/sql"
	"errors"
)

// SessionExit is how an owned session's program ended (migration 0072).
type SessionExit struct {
	SessionID string
	Code      int
	RanMs     int64
	Early     bool
	Tail      string
	At        int64
}

// RecordExit stores how an owned session ended; a later exit under the same
// id (a permission-mode restart, a resume under its own id) replaces it.
func RecordExit(ctx context.Context, q Querier, e SessionExit) error {
	_, err := q.ExecContext(ctx, `INSERT INTO session_exits(session_id, code, ran_ms, early, tail, at) VALUES(?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET code = excluded.code, ran_ms = excluded.ran_ms, early = excluded.early, tail = excluded.tail, at = excluded.at`,
		e.SessionID, e.Code, e.RanMs, b2i(e.Early), e.Tail, e.At)
	return err
}

// GetExit is how a session ended; ok is false when nothing was recorded.
func GetExit(ctx context.Context, q Querier, id string) (SessionExit, bool, error) {
	var e SessionExit
	var early int
	err := q.QueryRowContext(ctx, `SELECT session_id, code, ran_ms, early, tail, at FROM session_exits WHERE session_id = ?`, id).
		Scan(&e.SessionID, &e.Code, &e.RanMs, &early, &e.Tail, &e.At)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionExit{}, false, nil
	}
	if err != nil {
		return SessionExit{}, false, err
	}
	e.Early = early != 0
	return e, true, nil
}
