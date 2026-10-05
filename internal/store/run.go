package store

import (
	"context"
	"database/sql"
)

// Run is what a session did since its owner's last prompt, up to a moment:
// what a "finished" phone alert reports (ADR-036).
type Run struct {
	// PromptAt is the last main-thread prompt at or before the end, unix ms;
	// 0 when the session has none, and then the run is the whole session.
	PromptAt  int64
	CostUSD   float64
	ToolCalls int
	// Files are the paths edited in the run, first edited first.
	Files []string
}

// LastRun reads the run of a session that ended at until (unix ms). Subagents'
// turns and tool calls are counted with the session's: they are work the run
// paid for.
func LastRun(ctx context.Context, q Querier, sessionID string, until int64) (Run, error) {
	var r Run
	err := q.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(e.ts), 0) FROM events e INDEXED BY idx_events_user_turn
		WHERE e.session_id = ? AND e.kind = 'turn.user' AND e.ts <= ? AND `+MainThreadWhere,
		sessionID, until).Scan(&r.PromptAt)
	if err != nil {
		return r, err
	}
	err = q.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(CASE WHEN kind = 'turn.assistant' THEN cost_usd END), 0),
		       COUNT(CASE WHEN kind = 'tool.pre' THEN 1 END)
		FROM events WHERE session_id = ? AND ts >= ? AND ts <= ? AND internal = 0`,
		sessionID, r.PromptAt, until).Scan(&r.CostUSD, &r.ToolCalls)
	if err != nil {
		return r, err
	}
	r.Files, err = runFiles(ctx, q, sessionID, r.PromptAt, until)
	return r, err
}

// runFiles is the distinct paths edited in [from, until], in the order first
// edited. The tools are the ones rollup counts as touching a file.
func runFiles(ctx context.Context, q Querier, sessionID string, from, until int64) ([]string, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT p FROM (
			SELECT COALESCE(json_extract(payload, '$.tool_input.file_path'),
			                json_extract(payload, '$.tool_input.notebook_path'), '') AS p,
			       MIN(ts) AS first
			FROM events
			WHERE session_id = ? AND kind = 'tool.pre' AND ts >= ? AND ts <= ? AND internal = 0
			  AND tool IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')
			GROUP BY 1
		) WHERE p <> '' ORDER BY first, p`, sessionID, from, until)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var p sql.NullString
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p.String)
	}
	return out, rows.Err()
}
