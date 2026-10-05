package store

import (
	"context"
	"database/sql"
	"errors"
)

// PendingPermission is the stored half of a permission prompt an owned session
// is waiting on (migration 0039). The agents package owns its meaning; the
// store only keeps it across a daemon restart.
type PendingPermission struct {
	SessionID string
	PromptID  string
	Tool      string
	Detail    string
	Always    string
	SinceMs   int64
	Input     string
}

// SavePendingPermission records the prompt a session waits on, replacing any
// earlier one: a session shows one dialog at a time.
func SavePendingPermission(ctx context.Context, q Querier, p PendingPermission) error {
	_, err := q.ExecContext(ctx, `
		INSERT INTO pending_permissions(session_id, prompt_id, tool, detail, always, since, input)
		VALUES(?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
		  prompt_id = excluded.prompt_id, tool = excluded.tool, detail = excluded.detail,
		  always = excluded.always, since = excluded.since, input = excluded.input`,
		p.SessionID, p.PromptID, p.Tool, p.Detail, p.Always, p.SinceMs, p.Input)
	return err
}

// ClearPendingPermission forgets the prompt a session waited on.
func ClearPendingPermission(ctx context.Context, q Querier, sessionID string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM pending_permissions WHERE session_id = ?`, sessionID)
	return err
}

// GetPendingPermission returns the prompt a session waits on, if one is stored.
func GetPendingPermission(ctx context.Context, q Querier, sessionID string) (PendingPermission, bool, error) {
	p := PendingPermission{SessionID: sessionID}
	err := q.QueryRowContext(ctx, `
		SELECT prompt_id, tool, detail, always, since, input FROM pending_permissions WHERE session_id = ?`, sessionID).
		Scan(&p.PromptID, &p.Tool, &p.Detail, &p.Always, &p.SinceMs, &p.Input)
	if errors.Is(err, sql.ErrNoRows) {
		return PendingPermission{}, false, nil
	}
	if err != nil {
		return PendingPermission{}, false, err
	}
	return p, true, nil
}

// PrunePendingPermissions deletes every stored prompt whose session is not in
// keep: a session that ended while no daemon was running is waiting on nothing.
func PrunePendingPermissions(ctx context.Context, q Querier, keep map[string]bool) error {
	rows, err := q.QueryContext(ctx, `SELECT session_id FROM pending_permissions`)
	if err != nil {
		return err
	}
	var drop []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		if !keep[id] {
			drop = append(drop, id)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range drop {
		if err := ClearPendingPermission(ctx, q, id); err != nil {
			return err
		}
	}
	return nil
}

// MovedOnSince reports whether a session recorded anything after sinceMs that
// means a permission dialog drawn then is no longer on screen: a tool
// finishing, a prompt or reply, a turn ending, the session ending, or another
// dialog.
func MovedOnSince(ctx context.Context, q Querier, sessionID string, sinceMs int64) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `
		SELECT 1 FROM events
		 WHERE session_id = ? AND ts > ?
		   AND kind IN ('tool.post', 'turn.user', 'turn.assistant', 'agent.stop', 'session.end', 'permission.prompt')
		 LIMIT 1`, sessionID, sinceMs).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
