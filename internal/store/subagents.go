package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// maxSubagentsShown bounds the working subagents read in detail: each costs
// a few indexed lookups, and a panel shows a handful.
const maxSubagentsShown = 12

// SubagentActivity is one subagent working in a session now: who it is and
// what it is doing, read from the hooks fired inside it (they carry its
// agent_id) — Claude Code sends no event when a subagent starts.
type SubagentActivity struct {
	AgentID string
	// AgentType is the hook's agent_type ("general-purpose", "Explore"); empty
	// when no hook named one.
	AgentType string
	// Description is what the parent asked it to do, from the Agent call
	// that launched it, when its result names the agent (a background launch
	// does at once; a foreground one only when it finishes).
	Description string
	// ToolCalls is how many tool calls it has made in all.
	ToolCalls int
	// StartedAt and LastAt are its first and newest events in the window, unix ms.
	StartedAt, LastAt int64
	// Tool, Input and ToolAt are its newest call; empty when it made none.
	Tool   string
	Input  json.RawMessage
	ToolAt int64
	// Running is true while that call has no result.
	Running bool
	// Asking is true when its newest event is a permission prompt: a
	// subagent waiting on a dialog records nothing else.
	Asking bool
}

// SubagentsNow returns the subagents working in a session — each agent id
// heard from since `since` whose newest event is not its SubagentStop, the
// rule LiveSubagents counts by — newest activity first, and how many stopped
// within the window after making at least one tool call. Claude Code also
// fires SubagentStop for small internal agents that run no tools; they are
// not counted.
func SubagentsNow(ctx context.Context, q Querier, sessionID string, since int64) ([]SubagentActivity, int, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT agent_id, MIN(ts), MAX(ts),
		       MAX(CASE WHEN kind = 'agent.stop' THEN ts ELSE 0 END),
		       SUM(kind = 'tool.pre')
		  FROM events
		 WHERE session_id = ? AND ts >= ? AND COALESCE(agent_id, '') <> ''
		 GROUP BY agent_id
		 ORDER BY MAX(ts) DESC`, sessionID, since)
	if err != nil {
		return nil, 0, err
	}
	var working []SubagentActivity
	finished := 0
	for rows.Next() {
		var a SubagentActivity
		var stopped int64
		var calls int
		if err := rows.Scan(&a.AgentID, &a.StartedAt, &a.LastAt, &stopped, &calls); err != nil {
			_ = rows.Close()
			return nil, 0, err
		}
		switch {
		case stopped < a.LastAt:
			working = append(working, a)
		case calls > 0:
			finished++
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	if len(working) > maxSubagentsShown {
		working = working[:maxSubagentsShown]
	}
	if len(working) == 0 {
		return nil, finished, nil
	}
	for i := range working {
		if err := fillSubagent(ctx, q, sessionID, &working[i]); err != nil {
			return nil, 0, err
		}
	}
	if err := countSubagentCalls(ctx, q, sessionID, working); err != nil {
		return nil, 0, err
	}
	if err := describeSubagents(ctx, q, sessionID, working); err != nil {
		return nil, 0, err
	}
	return working, finished, nil
}

// Every query here names `+kind`, so SQLite walks the session's own rows
// (idx_events_session_ts) instead of every tool.pre in the database
// (idx_events_kind_*): on the owner's database that was 1.1 s against 13 ms
// for a 16,000-event session.

// countSubagentCalls fills ToolCalls for all of them in one pass. Each call is
// on the hook plane and, often, again in the transcript: counted on one plane,
// the one that saw more.
func countSubagentCalls(ctx context.Context, q Querier, sessionID string, working []SubagentActivity) error {
	args := []any{sessionID}
	for _, a := range working {
		args = append(args, a.AgentID)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT agent_id, SUM(source = 'hook'), SUM(source <> 'hook')
		  FROM events WHERE session_id = ? AND +kind = 'tool.pre'
		   AND agent_id IN (?`+strings.Repeat(`, ?`, len(working)-1)+`)
		 GROUP BY agent_id`, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	n := map[string]int{}
	for rows.Next() {
		var id string
		var hook, other int
		if err := rows.Scan(&id, &hook, &other); err != nil {
			return err
		}
		n[id] = max(hook, other)
	}
	for i := range working {
		working[i].ToolCalls = n[working[i].AgentID]
	}
	return rows.Err()
}

// describeSubagents fills Description from the parent's Agent calls whose
// result names the agent.
func describeSubagents(ctx context.Context, q Querier, sessionID string, working []SubagentActivity) error {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(json_extract(payload, '$.tool_response.agentId'), ''),
		       COALESCE(json_extract(payload, '$.tool_response.description'), '')
		  FROM events WHERE session_id = ? AND +kind = 'tool.post' AND tool IN ('Agent', 'Task')`, sessionID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	desc := map[string]string{}
	for rows.Next() {
		var id, d string
		if err := rows.Scan(&id, &d); err != nil {
			return err
		}
		if id != "" && d != "" {
			desc[id] = d
		}
	}
	for i := range working {
		working[i].Description = desc[working[i].AgentID]
	}
	return rows.Err()
}

func fillSubagent(ctx context.Context, q Querier, sessionID string, a *SubagentActivity) error {
	var kind string
	err := q.QueryRowContext(ctx, `
		SELECT kind FROM events WHERE session_id = ? AND agent_id = ?
		 ORDER BY ts DESC, id DESC LIMIT 1`, sessionID, a.AgentID).Scan(&kind)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	a.Asking = kind == "permission.prompt"

	var payload []byte
	var use sql.NullString
	err = q.QueryRowContext(ctx, `
		SELECT COALESCE(tool, ''), ts, payload, json_extract(payload, '$.tool_use_id')
		  FROM events WHERE session_id = ? AND agent_id = ? AND +kind = 'tool.pre'
		 ORDER BY ts DESC, id DESC LIMIT 1`, sessionID, a.AgentID).Scan(&a.Tool, &a.ToolAt, &payload, &use)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return err
	default:
		var p struct {
			AgentType string          `json:"agent_type"`
			ToolInput json.RawMessage `json:"tool_input"`
		}
		_ = json.Unmarshal(payload, &p)
		a.AgentType, a.Input = p.AgentType, p.ToolInput
		a.Running = true
		if use.String != "" {
			var one int
			err := q.QueryRowContext(ctx, `
				SELECT 1 FROM events WHERE session_id = ? AND agent_id = ? AND +kind = 'tool.post' AND ts >= ?
				   AND json_extract(payload, '$.tool_use_id') = ? LIMIT 1`, sessionID, a.AgentID, a.ToolAt, use.String).Scan(&one)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			a.Running = err != nil
		}
	}
	if a.AgentType == "" {
		// A subagent that made no call yet: its type is on whatever it sent.
		_ = q.QueryRowContext(ctx, `
			SELECT COALESCE(json_extract(payload, '$.agent_type'), '') FROM events
			 WHERE session_id = ? AND agent_id = ? AND ts >= ? AND json_extract(payload, '$.agent_type') <> ''
			 ORDER BY ts DESC LIMIT 1`, sessionID, a.AgentID, a.StartedAt).Scan(&a.AgentType)
	}
	return nil
}
