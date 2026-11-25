package store

import "context"

// apiErrorCols are migration 0095's columns as scanSession reads them.
const apiErrorCols = `COALESCE(sessions.api_error_at,0), COALESCE(sessions.api_error,''), COALESCE(sessions.api_error_retry,0), ` +
	`COALESCE(sessions.api_resume_tries,0), COALESCE(sessions.api_resume_at,0), COALESCE(sessions.api_resume_for,0), COALESCE(sessions.api_resume_state,'')`

// The values of sessions.api_resume_state (migration 0095, ADR-105).
const (
	ResumeNone      = ""
	ResumeResumed   = "resumed"
	ResumeRecovered = "recovered"
	ResumeGaveUp    = "gave_up"
	ResumeStopped   = "stopped"
)

// SetAPIError records that session id's turn ended on an API error at e.At
// (unix ms), after Claude Code's own retries. An older error never replaces
// a newer one: a transcript read again from the start must not move it back.
func SetAPIError(ctx context.Context, q Querier, id string, e APIError) error {
	if id == "" || e.At <= 0 {
		return nil
	}
	retry := 0
	if e.Retryable {
		retry = 1
	}
	_, err := q.ExecContext(ctx, `UPDATE sessions SET api_error_at = ?, api_error = ?, api_error_retry = ?
		WHERE session_id = ? AND api_error_at < ?`, e.At, e.Reason, retry, id, e.At)
	return err
}

// ClearAPIError forgets an API error the session has got past: a real reply
// written at or after it (at, unix ms). A resume that was in flight becomes
// "recovered", which the session keeps to say so; a give-up is forgotten,
// since the reply came from the user's own message. Reports whether one was
// cleared.
func ClearAPIError(ctx context.Context, q Querier, id string, at int64) (bool, error) {
	if id == "" {
		return false, nil
	}
	res, err := q.ExecContext(ctx, `UPDATE sessions SET api_error_at = 0, api_error = '', api_error_retry = 0,
		api_resume_state = CASE api_resume_state WHEN 'resumed' THEN 'recovered' WHEN 'gave_up' THEN '' WHEN 'stopped' THEN '' ELSE api_resume_state END
		WHERE session_id = ? AND api_error_at > 0 AND api_error_at <= ?`, id, at)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// OwnedAtAPIError lists the sessions Caprock started that are not ended and
// whose last turn ended on an API error, oldest error first.
func OwnedAtAPIError(ctx context.Context, q Querier) ([]Session, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+sessionCols+` FROM sessions
		WHERE api_error_at > 0 AND owned = 1 AND status != 'ended' ORDER BY api_error_at`)
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

// SetAPIResume records what Caprock did about the API error at forAt: the
// state, the tries in the incident and, for a try, when it went in (at, unix
// ms; 0 keeps the one stored). Written only while the session still stands
// on that error, so a reply that cleared it in the meantime wins.
func SetAPIResume(ctx context.Context, q Querier, id string, forAt int64, state string, tries int, at int64) (bool, error) {
	res, err := q.ExecContext(ctx, `UPDATE sessions SET api_resume_state = ?, api_resume_tries = ?, api_resume_for = ?,
		api_resume_at = CASE WHEN ? > 0 THEN ? ELSE api_resume_at END
		WHERE session_id = ? AND api_error_at = ?`, state, tries, forAt, at, at, id, forAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
