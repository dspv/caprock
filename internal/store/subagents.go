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
	// StoppedAt is its SubagentStop (unix ms), for one that finished.
	StoppedAt int64
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

// SubagentsDone returns up to limit subagents of a session that stopped
// since `since` after making at least one tool call, newest stop first: the
// ones SubagentsNow counts as finished. StoppedAt is their SubagentStop.
func SubagentsDone(ctx context.Context, q Querier, sessionID string, since int64, limit int) ([]SubagentActivity, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT agent_id, MIN(ts), MAX(ts),
		       MAX(CASE WHEN kind = 'agent.stop' THEN ts ELSE 0 END) AS stopped,
		       SUM(kind = 'tool.pre') AS calls
		  FROM events
		 WHERE session_id = ? AND ts >= ? AND COALESCE(agent_id, '') <> ''
		 GROUP BY agent_id
		HAVING stopped >= MAX(ts) AND calls > 0
		 ORDER BY stopped DESC
		 LIMIT ?`, sessionID, since, limit)
	if err != nil {
		return nil, err
	}
	var done []SubagentActivity
	for rows.Next() {
		var a SubagentActivity
		var calls int
		if err := rows.Scan(&a.AgentID, &a.StartedAt, &a.LastAt, &a.StoppedAt, &calls); err != nil {
			_ = rows.Close()
			return nil, err
		}
		done = append(done, a)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(done) == 0 {
		return nil, nil
	}
	for i := range done {
		err := q.QueryRowContext(ctx, `
			SELECT COALESCE(json_extract(payload, '$.agent_type'), '') FROM events
			 WHERE session_id = ? AND agent_id = ? AND json_extract(payload, '$.agent_type') <> ''
			 ORDER BY ts DESC LIMIT 1`, sessionID, done[i].AgentID).Scan(&done[i].AgentType)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	if err := countSubagentCalls(ctx, q, sessionID, done); err != nil {
		return nil, err
	}
	if err := describeSubagents(ctx, q, sessionID, done); err != nil {
		return nil, err
	}
	return done, nil
}

// SubagentSpend is what a subagent's own model calls cost, from its
// transcript's turns (each carries its model and usage, and is priced like
// any other turn).
type SubagentSpend struct {
	// Model is its newest turn's model; empty when it has none yet.
	Model string
	// CostUSD sums its turns' costs. Known is false when it has no turn, or
	// a turn the pricing table could not price: a partial sum would
	// understate it, and no figure is better than a wrong one (rule 6).
	CostUSD float64
	Known   bool
}

// SubagentsSpend returns each subagent's spend in a session, keyed by agent
// id, and the total over all of them, Known only when every one is.
// Internal model calls are left out, as every total leaves them out.
func SubagentsSpend(ctx context.Context, q Querier, sessionID string) (map[string]SubagentSpend, SubagentSpend, error) {
	// One MAX() in the select: SQLite takes the bare `model` from its row,
	// the agent's newest turn.
	rows, err := q.QueryContext(ctx, `
		SELECT agent_id, MAX(ts), COALESCE(model, ''), COUNT(*),
		       SUM(cost_usd IS NULL AND tokens_in IS NOT NULL), COALESCE(SUM(cost_usd), 0)
		  FROM events
		 WHERE session_id = ? AND +kind = 'turn.assistant' AND COALESCE(agent_id, '') <> '' AND internal = 0
		 GROUP BY agent_id`, sessionID)
	if err != nil {
		return nil, SubagentSpend{}, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]SubagentSpend{}
	total := SubagentSpend{Known: true}
	for rows.Next() {
		var id, model string
		var last int64
		var turns, unpriced int
		var usd float64
		if err := rows.Scan(&id, &last, &model, &turns, &unpriced, &usd); err != nil {
			return nil, SubagentSpend{}, err
		}
		sp := SubagentSpend{Model: model, CostUSD: usd, Known: turns > 0 && unpriced == 0}
		out[id] = sp
		total.CostUSD += usd
		total.Known = total.Known && sp.Known
	}
	if len(out) == 0 {
		total.Known = false
	}
	return out, total, rows.Err()
}
