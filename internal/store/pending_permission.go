package store

import (
	"context"
	"database/sql"
	"errors"
)

// PendingPermission is the stored half of one permission prompt an owned
// session is waiting on (migrations 0039, 0042). The agents package owns its
// meaning; the store only keeps it across a daemon restart.
type PendingPermission struct {
	SessionID string
	PromptID  string
	Tool      string
	Detail    string
	Always    string
	SinceMs   int64
	Input     string
	ToolUseID string
	AgentID   string
}

// SavePendingPermission records one more prompt a session waits on, behind the
// ones already stored: Claude Code queues its dialogs and shows the oldest.
// Saving a prompt id again updates its row in place.
func SavePendingPermission(ctx context.Context, q Querier, p PendingPermission) error {
	_, err := q.ExecContext(ctx, `
		INSERT INTO pending_permissions(session_id, prompt_id, tool, detail, always, since, input, tool_use_id, agent_id)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id, prompt_id) DO UPDATE SET
		  tool = excluded.tool, detail = excluded.detail, always = excluded.always,
		  since = excluded.since, input = excluded.input,
		  tool_use_id = excluded.tool_use_id, agent_id = excluded.agent_id`,
		p.SessionID, p.PromptID, p.Tool, p.Detail, p.Always, p.SinceMs, p.Input, p.ToolUseID, p.AgentID)
	return err
}

// ReplacePendingPermissions makes the stored queue of a session exactly ps,
// in that order.
func ReplacePendingPermissions(ctx context.Context, q Querier, sessionID string, ps []PendingPermission) error {
	if err := ClearPendingPermission(ctx, q, sessionID); err != nil {
		return err
	}
	for _, p := range ps {
		p.SessionID = sessionID
		if err := SavePendingPermission(ctx, q, p); err != nil {
			return err
		}
	}
	return nil
}

// ClearPendingPermission forgets every prompt a session waited on.
func ClearPendingPermission(ctx context.Context, q Querier, sessionID string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM pending_permissions WHERE session_id = ?`, sessionID)
	return err
}

// ListPendingPermissions returns the prompts a session waits on, oldest first.
func ListPendingPermissions(ctx context.Context, q Querier, sessionID string) ([]PendingPermission, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT prompt_id, tool, detail, always, since, input, tool_use_id, agent_id
		  FROM pending_permissions WHERE session_id = ? ORDER BY since, rowid`, sessionID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []PendingPermission
	for rows.Next() {
		p := PendingPermission{SessionID: sessionID}
		if err := rows.Scan(&p.PromptID, &p.Tool, &p.Detail, &p.Always, &p.SinceMs, &p.Input, &p.ToolUseID, &p.AgentID); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PrunePendingPermissions deletes every stored prompt whose session is not in
// keep: a session that ended while no daemon was running is waiting on nothing.
func PrunePendingPermissions(ctx context.Context, q Querier, keep map[string]bool) error {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT session_id FROM pending_permissions`)
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
// finishing, a prompt or reply, a turn ending, or the session ending. Another
// permission.prompt does not count: Claude Code queues dialogs, so a later
// one leaves the earlier on screen.
func MovedOnSince(ctx context.Context, q Querier, sessionID string, sinceMs int64) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `
		SELECT 1 FROM events
		 WHERE session_id = ? AND ts > ?
		   AND kind IN ('tool.post', 'turn.user', 'turn.assistant', 'agent.stop', 'session.end')
		 LIMIT 1`, sessionID, sinceMs).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
