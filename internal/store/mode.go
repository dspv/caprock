package store

import (
	"context"
	"database/sql"
	"errors"
)

// modeWindow is how many of a session's newest hook events are read for its
// permission mode. Claude Code puts permission_mode on every hook payload, so
// the newest one answers; the window only bounds the cost for a session whose
// hooks somehow never carried it.
const modeWindow = 50

// LastPermissionMode is the permission mode a session was last running in, as
// Claude Code's own hook payloads state it (`permission_mode`, common to every
// hook event), or "" when no stored hook carries one — a session observed from
// its transcript alone, or an agent without hooks.
//
// It reads the stored payloads rather than a column, because every hook
// payload is already stored verbatim and the mode changes mid-session (⇧Tab
// cycles it), so the newest event is the answer and a column would be one
// more thing to keep in step. PostToolUse is skipped: its payload carries the
// tool's whole output, and it states the same mode as the PreToolUse before it.
// The value is Claude Code's word for the mode, unvalidated; the caller decides
// which words it passes on.
func LastPermissionMode(ctx context.Context, q Querier, sessionID string) (string, error) {
	var mode string
	err := q.QueryRowContext(ctx, `
		SELECT mode FROM (
		  SELECT ts, id,
		         CASE WHEN json_valid(payload) THEN json_extract(payload, '$.permission_mode') END AS mode
		  FROM events INDEXED BY idx_events_session_ts
		  WHERE session_id = ? AND source = 'hook' AND kind <> 'tool.post'
		  ORDER BY ts DESC, id DESC
		  LIMIT ?)
		WHERE typeof(mode) = 'text' AND mode <> ''
		ORDER BY ts DESC, id DESC
		LIMIT 1`, sessionID, modeWindow).Scan(&mode)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return mode, err
}
